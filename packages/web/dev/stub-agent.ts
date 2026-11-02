/**
 * The stub agent every browser proof in `packages/web` runs against.
 *
 * ACP v2 JSON-RPC over a WebSocket and nothing else: no model, no Python, no
 * network. It answers exactly the methods `AcpClientV2` sends — `initialize`,
 * `session/new`, `session/list`, `session/resume`, `session/prompt`,
 * `session/cancel`, `session/delete`, `session/set_config_option` — and replies
 * to anything else with -32601, so a client that grows a new request fails
 * loudly here instead of hanging until the 30s timeout.
 *
 * Two details are load-bearing for the proofs, and both are protocol behaviour
 * rather than stub convenience:
 *
 * - Sessions live in the agent, not in the socket. A page reload still finds
 *   them through `session/list`, which is what makes the sidebar a real
 *   sidebar rather than a list of the current connection.
 * - `session/resume` streams the stored transcript as `session/update`
 *   notifications BEFORE it answers, because the client's replay window spans
 *   the request itself (`AcpThreadController.switchToThread` opens it on the
 *   way in and closes it in a `finally`). Answering first would replay into a
 *   closed window and show an empty thread.
 *
 * Standalone:
 *
 *   bun dev/stub-agent.ts --port 2799 [--host 127.0.0.1] [--delay 40] [--quiet]
 *
 * In-process (what `e2e/browser.test.ts` does, so it can ask for port 0 and
 * read back the port the OS chose):
 *
 *   const agent = startStubAgent({ port: 0 });
 *   ... agent.url, agent.snapshot(), agent.reset(), agent.stop()
 */

import type { ServerWebSocket } from "bun";

type Json = unknown;

type Conn = { initialized: boolean };

type Turn = { role: "user" | "agent"; text: string };

type Session = {
  sessionId: string;
  cwd: string;
  title: string | undefined;
  updatedAt: string;
  model: string;
  transcript: Turn[];
  /** Timers for the turn in flight, so `session/cancel` and a closed socket
   * can both stop a reply that is still streaming. */
  timers: Set<ReturnType<typeof setTimeout>>;
  owner: ServerWebSocket<Conn> | undefined;
};

export type StubOptions = {
  host?: string;
  /** 0 asks the OS for a free port; read it back off `agent.port`. */
  port?: number;
  /** Milliseconds between streamed chunks. 0 makes a turn synchronous-ish. */
  delay?: number;
  /** Characters per `agent_message_chunk`. */
  chunk?: number;
  name?: string;
  quiet?: boolean;
};

export type StubSessionSnapshot = {
  sessionId: string;
  cwd: string;
  title: string | undefined;
  model: string;
  turns: number;
};

export type StubAgent = {
  url: string;
  port: number;
  snapshot(): StubSessionSnapshot[];
  reset(): void;
  stop(): void;
};

/** The two models the stub advertises. `stub:terse` replies without the
 * footer, so a `session/set_config_option` round-trip is visible in the thread
 * and not only in the picker. */
const MODELS = [
  { value: "stub:echo", name: "Stub Echo" },
  { value: "stub:terse", name: "Stub Terse" },
] as const;

const PROTOCOL_VERSION = 2;

function promptText(blocks: Json): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as { type?: Json }).type === "text" &&
      typeof (block as { text?: Json }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

function titleFrom(text: string): string {
  const head = (text.trim().split("\n")[0] ?? "").trim();
  if (head === "") return "New session";
  return head.length > 48 ? `${head.slice(0, 45)}...` : head;
}

function chunkText(text: string, size: number): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
  return out.length === 0 ? [""] : out;
}

export function startStubAgent(options: StubOptions = {}): StubAgent {
  const host = options.host ?? "127.0.0.1";
  const delay = options.delay ?? 40;
  const chunkSize = Math.max(1, options.chunk ?? 24);
  const agentName = options.name ?? "crow-stub-agent";
  const quiet = options.quiet ?? false;

  const sessions = new Map<string, Session>();
  let sessionSeq = 0;
  let messageSeq = 0;

  const log = (...args: unknown[]): void => {
    if (!quiet) console.log("[stub-agent]", ...args);
  };

  const send = (ws: ServerWebSocket<Conn>, frame: Json): void => {
    // A turn outlives its socket when the page navigates mid-reply; dropping
    // the frame is the whole of the cleanup.
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(frame));
  };

  const answer = (ws: ServerWebSocket<Conn>, id: Json, result: Json): void =>
    send(ws, { jsonrpc: "2.0", id, result });

  const refuse = (
    ws: ServerWebSocket<Conn>,
    id: Json,
    code: number,
    message: string,
  ): void => send(ws, { jsonrpc: "2.0", id, error: { code, message } });

  const notify = (ws: ServerWebSocket<Conn>, sessionId: string, update: Json): void =>
    send(ws, {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    });

  const configOptions = (session: Session) => [
    {
      configId: "model",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: session.model,
      options: MODELS.map((model) => ({ value: model.value, name: model.name })),
    },
  ];

  const clearTimers = (session: Session): void => {
    for (const timer of session.timers) clearTimeout(timer);
    session.timers.clear();
  };

  const replyFor = (session: Session, text: string): string => {
    const body = text.trim() === "" ? "(an empty prompt)" : text.trim();
    if (session.model === "stub:terse") return `You said: ${body}`;
    return (
      `You said: ${body}\n\n` +
      `[crow stub agent - session ${session.sessionId} - model ${session.model}]`
    );
  };

  /** Acknowledge, then stream. The ack carries only `messageId` in v2 — the
   * turn ends on the idle `state_update`, which is what resolves the client's
   * prompt promise. */
  const runTurn = (
    ws: ServerWebSocket<Conn>,
    session: Session,
    text: string,
  ): string => {
    const userMessageId = `u${++messageSeq}`;
    const agentMessageId = `a${messageSeq}`;
    const reply = replyFor(session, text);
    session.transcript.push({ role: "user", text });
    session.owner = ws;

    let at = 0;
    const step = (fn: () => void): void => {
      const timer = setTimeout(() => {
        session.timers.delete(timer);
        fn();
      }, at);
      session.timers.add(timer);
      at += delay;
    };

    step(() =>
      notify(ws, session.sessionId, {
        sessionUpdate: "state_update",
        state: "running",
      }),
    );
    // The protocol wants the accepted prompt echoed back. Live, the reducer
    // drops it (the controller already put the user's turn on screen); in a
    // replay it is the only copy there is.
    step(() =>
      notify(ws, session.sessionId, {
        sessionUpdate: "user_message_chunk",
        messageId: userMessageId,
        content: { type: "text", text },
      }),
    );
    for (const piece of chunkText(reply, chunkSize)) {
      step(() =>
        notify(ws, session.sessionId, {
          sessionUpdate: "agent_message_chunk",
          messageId: agentMessageId,
          content: { type: "text", text: piece },
        }),
      );
    }
    step(() => {
      session.transcript.push({ role: "agent", text: reply });
      session.updatedAt = new Date().toISOString();
      session.owner = undefined;
      notify(ws, session.sessionId, {
        sessionUpdate: "session_info_update",
        title: session.title,
        updatedAt: session.updatedAt,
      });
      notify(ws, session.sessionId, {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      });
    });
    return userMessageId;
  };

  /** The transcript, as notifications, before the `session/resume` answer. */
  const replay = (ws: ServerWebSocket<Conn>, session: Session): void => {
    for (const turn of session.transcript) {
      const messageId =
        turn.role === "user" ? `u${++messageSeq}` : `a${messageSeq}`;
      notify(ws, session.sessionId, {
        sessionUpdate:
          turn.role === "user" ? "user_message_chunk" : "agent_message_chunk",
        messageId,
        content: { type: "text", text: turn.text },
      });
    }
  };

  const requireSession = (
    ws: ServerWebSocket<Conn>,
    id: Json,
    params: Record<string, any>,
  ): Session | undefined => {
    const session = sessions.get(String(params.sessionId ?? ""));
    if (session === undefined) {
      refuse(
        ws,
        id,
        -32602,
        `Unknown session: ${JSON.stringify(params.sessionId ?? null)}`,
      );
    }
    return session;
  };

  const dispatch = (
    ws: ServerWebSocket<Conn>,
    id: Json,
    method: string,
    params: Record<string, any>,
  ): void => {
    log(method, JSON.stringify(params).slice(0, 200));
    switch (method) {
      case "initialize":
        answer(ws, id, {
          protocolVersion: PROTOCOL_VERSION,
          info: {
            name: agentName,
            version: "0.1.0",
            title: "Crow Stub Agent",
          },
          capabilities: {
            // `session` present at all is what tells the client
            // `session/resume` exists; `delete` is what makes the sidebar's
            // delete button render instead of hiding.
            session: { prompt: { image: {}, embeddedContext: {} }, delete: {} },
          },
        });
        return;

      case "session/new": {
        const cwd =
          typeof params.cwd === "string" && params.cwd !== "" ? params.cwd : "/";
        const session: Session = {
          sessionId: `s${++sessionSeq}`,
          cwd,
          title: undefined,
          updatedAt: new Date().toISOString(),
          model: MODELS[0]!.value,
          transcript: [],
          timers: new Set(),
          owner: undefined,
        };
        sessions.set(session.sessionId, session);
        answer(ws, id, {
          sessionId: session.sessionId,
          configOptions: configOptions(session),
        });
        return;
      }

      case "session/list": {
        const cwd =
          typeof params.cwd === "string" && params.cwd !== ""
            ? params.cwd
            : undefined;
        const listed = [...sessions.values()]
          .filter((session) => cwd === undefined || session.cwd === cwd)
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
          .map((session) => ({
            sessionId: session.sessionId,
            cwd: session.cwd,
            ...(session.title !== undefined && { title: session.title }),
            updatedAt: session.updatedAt,
          }));
        answer(ws, id, { sessions: listed });
        return;
      }

      case "session/resume": {
        const session = requireSession(ws, id, params);
        if (session === undefined) return;
        replay(ws, session);
        answer(ws, id, { configOptions: configOptions(session) });
        return;
      }

      case "session/prompt": {
        const session = requireSession(ws, id, params);
        if (session === undefined) return;
        const text = promptText(params.prompt);
        if (session.title === undefined) session.title = titleFrom(text);
        const messageId = runTurn(ws, session, text);
        answer(ws, id, { messageId });
        return;
      }

      case "session/delete": {
        const session = requireSession(ws, id, params);
        if (session === undefined) return;
        clearTimers(session);
        sessions.delete(session.sessionId);
        answer(ws, id, {});
        return;
      }

      case "session/set_config_option": {
        const session = requireSession(ws, id, params);
        if (session === undefined) return;
        if (params.configId !== "model") {
          refuse(
            ws,
            id,
            -32602,
            `Unknown config option: ${JSON.stringify(params.configId ?? null)}`,
          );
          return;
        }
        const value = String(params.value ?? "");
        if (!MODELS.some((model) => model.value === value)) {
          refuse(ws, id, -32602, `Unknown model: ${value}`);
          return;
        }
        session.model = value;
        answer(ws, id, { configOptions: configOptions(session) });
        return;
      }

      default:
        refuse(ws, id, -32601, `Method not supported: ${method}`);
    }
  };

  const server = Bun.serve<Conn>({
    hostname: host,
    port: options.port ?? 0,
    fetch(request, srv) {
      if (srv.upgrade(request, { data: { initialized: false } })) {
        return undefined;
      }
      return new Response(
        `crow stub agent: this is an ACP v2 WebSocket endpoint ` +
          `(ws://${host}:${srv.port}/acp)\n`,
        { status: 426 },
      );
    },
    websocket: {
      open(ws) {
        log("client connected");
        ws.data.initialized = false;
      },
      message(ws, raw) {
        let frame: any;
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (frame === null || typeof frame !== "object") return;
        if (typeof frame.method !== "string") return;

        // Notifications: only `session/cancel` exists in this dialect.
        if (frame.id === undefined) {
          if (frame.method === "session/cancel") {
            const session = sessions.get(String(frame.params?.sessionId ?? ""));
            log("session/cancel", session?.sessionId ?? "(unknown)");
            if (session === undefined) return;
            clearTimers(session);
            session.owner = undefined;
            notify(ws, session.sessionId, {
              sessionUpdate: "state_update",
              state: "idle",
              stopReason: "cancelled",
            });
          }
          return;
        }

        if (frame.method === "initialize") ws.data.initialized = true;
        dispatch(
          ws,
          frame.id,
          frame.method,
          (frame.params ?? {}) as Record<string, any>,
        );
      },
      close(ws) {
        log("client disconnected");
        // The sessions stay — that is the point of `session/list` — but a reply
        // still streaming into a dead socket stops here.
        for (const session of sessions.values()) {
          if (session.owner !== ws) continue;
          clearTimers(session);
          session.owner = undefined;
        }
      },
    },
  });

  // `Server.port` is typed optional; a stub that cannot say which port it
  // bound is useless to the test that started it, so fail instead of guessing.
  const port = server.port;
  if (port === undefined) throw new Error("Bun.serve reported no port");

  return {
    url: `ws://${host}:${port}/acp`,
    port,
    snapshot: () =>
      [...sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: session.title,
        model: session.model,
        turns: session.transcript.length,
      })),
    reset: () => {
      for (const session of sessions.values()) clearTimers(session);
      sessions.clear();
      sessionSeq = 0;
    },
    stop: () => server.stop(true),
  };
}

const argv = process.argv.slice(2);

function option(name: string, fallback: string): string {
  const at = argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : argv[at + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
}

if (import.meta.main) {
  const agent = startStubAgent({
    host: option("host", process.env.STUB_HOST ?? "127.0.0.1"),
    port: Number(option("port", process.env.STUB_PORT ?? "2799")),
    delay: Number(option("delay", process.env.STUB_DELAY ?? "40")),
    chunk: Number(option("chunk", "24")),
    quiet: argv.includes("--quiet"),
  });
  console.log(`crow stub agent listening on ${agent.url}`);
}
