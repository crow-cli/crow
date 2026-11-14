import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import { watchPid, pidForPort, type PidWatcher } from "./pidfd.js";
import { attachMcp } from "./mcp.js";
import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

/** What the shim knows about one agent session, from state_update alone. */
export type SessionInfo = {
  sessionId: string;
  state: string;
  stopReason?: string;
  cwd?: string;
  /** The turn's final assistant text, published on idle with a stop reason. */
  lastAssistantMessage?: string;
  updatedAt: number;
};

export type BackendOptions = {
  log: (line: string) => void;
  /** argv that runs crow-cli, e.g. ["uv", "--project", "<src>", "run", "crow-cli"]. */
  cliCommand: string[];
  firstPort: number;
  /** Proxy this daemon instead of spawning one. */
  external?: string;
  /** Extra argv appended after `acp2 --http --host --port` (e.g. --model). */
  extraArgs?: string[];
  /** Visible-chat seam. When present, prompts are delivered through the
   * webview that owns the session (or a freshly opened editor pane) instead
   * of the headless control connection — every delegated turn is on screen. */
  clientBridge?: ClientBridge;
};

export type ClientBridge = {
  /** Bind a visible chat client to the session, opening an editor pane when
   * no open window owns it. Omit sessionId to mint a fresh visible session.
   * Resolves with the sessionId once the client is attached, BEFORE any
   * prompt is sent, so the shim can register its turn waiter first. */
  attach(sessionId?: string): Promise<string>;
  /** Deliver the prompt through the attached client's own ACP connection —
   * the same path a typed message takes. */
  send(sessionId: string, prompt: unknown): Promise<void>;
};

class Emitter<T> {
  private listeners = new Set<(value: T) => void>();
  readonly event = (cb: (value: T) => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  fire(value: T): void {
    for (const cb of [...this.listeners]) cb(value);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

class MethodError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

type Pending = { resolve: (value: any) => void; reject: (err: Error) => void };
type TurnWaiter = Pending & { cancel: () => void };

/**
 * One upstream daemon connection, optionally paired with a downstream webview
 * socket. Frames pass through verbatim; the backend parses copies to track
 * sessions. Shim-originated requests use string ids (`crow-shim-N`) so they
 * cannot collide with the webview's numeric id counter, and their responses
 * are consumed here instead of reaching the webview.
 */
class Conn {
  private upOpen = false;
  private queue: string[] = [];
  readonly pending = new Map<string, Pending>();
  readonly pendingNew = new Map<number | string, string | undefined>();
  readonly pendingResume = new Map<number | string, string>();
  readonly pendingClose = new Map<number | string, string>();
  private nextId = 0;
  closed = false;
  readonly owned = new Set<string>();

  constructor(
    private readonly backend: Backend,
    readonly down: WebSocket | null,
    readonly up: WebSocket,
  ) {
    up.on("open", () => {
      this.upOpen = true;
      for (const frame of this.queue) this.up.send(frame);
      this.queue.length = 0;
    });
    up.on("message", (data) => this.backend.onUpstreamFrame(this, data.toString()));
    up.on("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("connection closed"));
      this.pending.clear();
      this.backend.onConnClosed(this);
      this.down?.close(1011, "crow daemon connection closed");
    });
    up.on("error", (err) => {
      this.backend.log(`upstream error: ${err.message}`);
      if (this.down?.readyState === WebSocket.OPEN) this.down.close(1011, "crow daemon unreachable");
    });
    if (down) {
      down.on("message", (data) => this.backend.onDownstreamFrame(this, data.toString()));
      down.on("close", () => {
        this.backend.clients.delete(down);
        this.up.close();
      });
      down.on("error", () => this.up.close());
    }
  }

  opened(): Promise<void> {
    if (this.upOpen) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.up.once("open", resolve);
      this.up.once("error", reject);
    });
  }

  sendText(text: string): void {
    if (this.upOpen) this.up.send(text);
    else this.queue.push(text);
  }

  request(method: string, params: unknown): Promise<any> {
    const id = `crow-shim-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendText(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params: unknown): void {
    this.sendText(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  respond(id: number | string, result: unknown): void {
    this.up.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  respondError(id: number | string, code: number, message: string): void {
    this.up.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }
}

/**
 * The window's coordination shim. Spawns one multi-tenant `crow-cli acp2
 * --http` daemon (cycling ports until one binds) and proxies every webview
 * ACP connection through itself, because ACP only sends session updates to
 * the owning connection — a shim off to the side would see nothing.
 *
 * Coordination rides extension methods, answered here in both directions:
 * `_crow/backend/status`, `_crow/backend/prompt` (a session/prompt wrapper
 * that settles on the turn's idle state_update) and `_crow/backend/cancel`
 * (session/cancel). Prompts route through the connection that owns the
 * session so its webview keeps seeing updates; orphaned sessions are resumed
 * on a shim-held control connection. The daemon lives and dies with the
 * window: dispose() kills it.
 */
export class Backend {
  private child?: ChildProcess;
  private daemonPort?: number;
  private daemonWatcher?: PidWatcher;
  private externalPid?: number;
  private externalDead = false;
  private upstreamUrl?: string;
  private wss?: WebSocketServer;
  private httpServer?: http.Server;
  private proxyPort?: number;
  private controlConn?: Conn;
  private controlStarting?: Promise<Conn>;
  private starting?: Promise<string>;
  private disposed = false;
  readonly clients = new Set<WebSocket>();
  readonly conns = new Set<Conn>();
  private readonly owners = new Map<string, Conn>();
  private readonly sessions = new Map<string, SessionInfo>();
  /** Per-session assistant text for the current turn. A new messageId starts
   * a new message; `running` clears it; idle(end_turn) publishes it. */
  private readonly transcripts = new Map<string, { messageId?: string; text: string }>();
  private loop?: { conductor: string; worker: string; cycles: number; workerCalledThisTurn: boolean };
  private readonly turnWaiters = new Map<string, TurnWaiter[]>();
  private readonly idle = new Emitter<SessionInfo>();
  /** Fires when a working session goes idle with a stop reason. */
  readonly onSessionIdle = this.idle.event;

  constructor(private readonly opts: BackendOptions) {}

  get endpoint(): string | undefined {
    return this.proxyPort ? `ws://127.0.0.1:${this.proxyPort}/acp` : undefined;
  }

  get mcpEndpoint(): string | undefined {
    return this.proxyPort ? `http://127.0.0.1:${this.proxyPort}/mcp` : undefined;
  }

  start(): Promise<string> {
    this.starting ??= this.doStart().catch((err) => {
      this.starting = undefined;
      throw err;
    });
    return this.starting;
  }

  status(): Record<string, unknown> {
    return {
      daemon: this.opts.external
        ? {
            external: this.opts.external,
            pid: this.externalPid,
            port: Number(new URL(this.opts.external).port),
            running: this.externalPid != null ? !this.externalDead : undefined,
          }
        : { pid: this.child?.pid, port: this.daemonPort, running: this.child != null && this.child.exitCode === null },
      proxy: { port: this.proxyPort, endpoint: this.endpoint, mcp: this.mcpEndpoint, headed: this.opts.clientBridge != null },
      control: { connected: this.controlConn != null && !this.controlConn.closed },
      sessions: [...this.sessions.values()],
      loop: this.loopStatus(),
    };
  }

  private async doStart(): Promise<string> {
    this.upstreamUrl = this.opts.external ?? (await this.spawnDaemon());
    if (this.disposed) throw new Error("backend disposed during startup");
    if (this.opts.external) {
      const port = Number(new URL(this.opts.external).port);
      this.externalPid = pidForPort(port);
      if (this.externalPid != null) {
        this.daemonWatcher = watchPid(this.externalPid, () => this.onExternalDeath(), {
          onError: (err) => this.log(`pidfd watcher: ${err.message}`),
        });
        this.log(`watching external daemon pid ${this.externalPid} on port ${port}`);
      } else {
        this.log(`no readable listener for external endpoint ${this.opts.external}; death detection falls back to the socket`);
      }
    }
    const httpServer = http.createServer();
    attachMcp(httpServer, this);
    const wss = new WebSocketServer({ server: httpServer, path: "/acp" });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    this.httpServer = httpServer;
    this.wss = wss;
    this.proxyPort = (httpServer.address() as net.AddressInfo).port;
    wss.on("connection", (down) => {
      this.clients.add(down);
      const conn = new Conn(this, down, new WebSocket(this.upstreamUrl!));
      this.conns.add(conn);
    });
    this.log(`proxy listening on ${this.endpoint} -> ${this.upstreamUrl}`);
    return this.endpoint!;
  }

  private async spawnDaemon(): Promise<string> {
    const [cmd, ...prefix] = this.opts.cliCommand;
    if (!cmd) throw new Error("cliCommand is empty");
    const last = this.opts.firstPort + PORT_ATTEMPTS - 1;
    for (let port = this.opts.firstPort; port <= last; port++) {
      if (this.disposed) throw new Error("backend disposed during startup");
      if (!(await portFree(port))) {
        this.log(`port ${port} busy, trying next`);
        continue;
      }
      const argv = [...prefix, "acp2", "--http", "--host", "127.0.0.1", "--port", String(port), ...(this.opts.extraArgs ?? [])];
      const child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
      let spawnError: Error | undefined;
      child.once("error", (err) => { spawnError = err; });
      child.stdout!.on("data", (d) => this.log(`[daemon] ${d.toString().trimEnd()}`));
      child.stderr!.on("data", (d) => this.log(`[daemon] ${d.toString().trimEnd()}`));
      const ready = await waitReady(port, child);
      if (spawnError) throw new Error(`cannot spawn ${cmd}: ${spawnError.message}`);
      if (!ready || this.disposed) {
        child.kill("SIGKILL");
        if (this.disposed) throw new Error("backend disposed during startup");
        this.log(`daemon on port ${port} never became ready, trying next`);
        continue;
      }
      this.child = child;
      this.daemonPort = port;
      child.once("exit", (code, signal) => {
        this.log(`daemon exited (code=${code} signal=${signal})`);
        this.child = undefined;
        for (const ws of this.clients) ws.close(1011, "crow daemon exited");
      });
      this.log(`daemon pid ${child.pid} on port ${port}`);
      return `ws://127.0.0.1:${port}/acp`;
    }
    throw new Error(`no free port for the crow daemon in ${this.opts.firstPort}..${last}`);
  }

  private onExternalDeath(): void {
    this.externalDead = true;
    this.log(`external daemon pid ${this.externalPid} exited`);
    for (const ws of this.clients) ws.close(1011, "crow daemon exited");
  }

  // -- frame paths ---------------------------------------------------------

  /** @internal */ onDownstreamFrame(conn: Conn, text: string): void {
    let msg: any;
    try { msg = JSON.parse(text); } catch { conn.sendText(text); return; }
    if (typeof msg?.method === "string" && msg.method.startsWith("_crow/backend/")) {
      if (msg.id == null) return;
      void this.dispatch(msg.method, msg.params).then(
        (result) => conn.down?.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })),
        (err) => conn.down?.send(JSON.stringify({
          jsonrpc: "2.0", id: msg.id,
          error: { code: err instanceof MethodError ? err.code : -32603, message: String(err?.message ?? err) },
        })),
      );
      return;
    }
    this.observeClient(conn, msg);
    conn.sendText(text);
  }

  /** @internal */ onUpstreamFrame(conn: Conn, text: string): void {
    let msg: any;
    try { msg = JSON.parse(text); } catch { if (conn.down?.readyState === WebSocket.OPEN) conn.down.send(text); return; }
    if (msg?.id != null && conn.pending.has(msg.id)) {
      const p = conn.pending.get(msg.id)!;
      conn.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "request failed"));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg?.method === "string" && msg.method.startsWith("_crow/backend/") && msg.id != null) {
      void this.dispatch(msg.method, msg.params).then(
        (result) => conn.respond(msg.id, result),
        (err) => conn.respondError(msg.id, err instanceof MethodError ? err.code : -32603, String(err?.message ?? err)),
      );
      return;
    }
    this.observeAgent(conn, msg);
    if (conn.down?.readyState === WebSocket.OPEN) conn.down.send(text);
  }

  /** @internal */ onConnClosed(conn: Conn): void {
    this.conns.delete(conn);
    if (conn === this.controlConn) this.controlConn = undefined;
    for (const sessionId of conn.owned) {
      if (this.owners.get(sessionId) === conn) this.owners.delete(sessionId);
      this.rejectTurns(sessionId, "owning connection closed");
    }
    conn.owned.clear();
  }

  private async dispatch(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "_crow/backend/status": return this.status();
      case "_crow/backend/prompt": return await this.prompt(params ?? {});
      case "_crow/backend/cancel": return await this.cancel(params ?? {});
      case "_crow/backend/loop/arm": return this.loopArm(params ?? {});
      case "_crow/backend/loop/disarm": return this.loopDisarm();
      case "_crow/backend/loop/status": return this.loopStatus();
      default: throw new MethodError(-32601, `Method not supported: ${method}`);
    }
  }

  // -- coordination wrappers -----------------------------------------------

  /** Wrap session/prompt: route through the owning connection (or resume the
   * session on the control connection), ack, then settle on the turn's idle
   * state_update. Park idles carry no stopReason and do not settle it. */
  async prompt(params: { sessionId?: string; prompt?: unknown; cwd?: string }): Promise<{ stopReason: string; sessionId: string }> {
    if (params.prompt == null) throw new MethodError(-32602, "prompt requires prompt");
    const bridge = this.opts.clientBridge;
    if (bridge) {
      const sessionId = await bridge.attach(typeof params.sessionId === "string" ? params.sessionId : undefined);
      const turn = this.waitForTurnEnd(sessionId);
      // The waiter can reject (dispose, owner drop) while send is still in
      // flight; keep that rejection handled until the await below claims it.
      turn.promise.catch(() => {});
      try {
        await bridge.send(sessionId, params.prompt);
      } catch (err) {
        turn.cancel();
        throw err;
      }
      return { ...(await turn.promise), sessionId };
    }
    const sessionId = params?.sessionId;
    if (typeof sessionId !== "string") throw new MethodError(-32602, "prompt requires sessionId");
    const conn = await this.routeSession(sessionId, params.cwd);
    const turn = this.waitForTurnEnd(sessionId);
    turn.promise.catch(() => {});
    try {
      await conn.request("session/prompt", { sessionId, prompt: params.prompt });
    } catch (err) {
      turn.cancel();
      throw err;
    }
    return { ...(await turn.promise), sessionId };
  }

  /** Wrap session/cancel. The confirmation is the idle(cancelled)
   * state_update, which also settles any pending prompt wrapper. */
  async cancel(params: { sessionId?: string }): Promise<Record<string, never>> {
    const sessionId = params?.sessionId;
    if (typeof sessionId !== "string") throw new MethodError(-32602, "cancel requires sessionId");
    const conn = this.owners.get(sessionId) ?? (this.controlConn && !this.controlConn.closed ? this.controlConn : undefined);
    if (!conn || conn.closed) throw new MethodError(-32602, `session ${sessionId} has no live connection`);
    conn.notify("session/cancel", { sessionId });
    return {};
  }

  private async routeSession(sessionId: string, cwd?: string): Promise<Conn> {
    let conn = this.owners.get(sessionId);
    if (!conn || conn.closed) {
      conn = await this.control();
      const dir = cwd ?? this.sessions.get(sessionId)?.cwd;
      if (!dir) throw new MethodError(-32602, `no cwd known for session ${sessionId}; pass cwd`);
      await conn.request("session/resume", { sessionId, cwd: dir });
      this.owners.set(sessionId, conn);
      conn.owned.add(sessionId);
    }
    return conn;
  }

  // -- conductor/worker loop -------------------------------------------------

  loopArm(params: { conductorSessionId?: string; workerSessionId?: string }): Record<string, unknown> {
    const conductor = params?.conductorSessionId;
    const worker = params?.workerSessionId;
    if (typeof conductor !== "string" || typeof worker !== "string")
      throw new MethodError(-32602, "arm requires conductorSessionId and workerSessionId");
    if (conductor === worker) throw new MethodError(-32602, "conductor and worker must be different sessions");
    for (const sid of [conductor, worker])
      if (!this.sessions.has(sid)) throw new MethodError(-32602, `unknown session ${sid}`);
    this.loop = { conductor, worker, cycles: 0, workerCalledThisTurn: false };
    this.log(`loop armed: conductor ${conductor} worker ${worker}`);
    return this.loopStatus();
  }

  loopDisarm(): Record<string, never> {
    if (this.loop) this.log(`loop disarmed after ${this.loop.cycles} cycles`);
    this.loop = undefined;
    return {};
  }

  loopStatus(): Record<string, unknown> {
    const loop = this.loop;
    if (!loop) return { armed: false };
    return {
      armed: true,
      conductor: { sessionId: loop.conductor, state: this.sessions.get(loop.conductor)?.state },
      worker: { sessionId: loop.worker, state: this.sessions.get(loop.worker)?.state },
      cycles: loop.cycles,
      workerCalledThisTurn: loop.workerCalledThisTurn,
    };
  }

  /** The conductor's MCP tool: hand work to the worker, return on the worker's
   * ack. The answer travels back as a fresh conductor prompt when the worker's
   * turn ends — the loop carries it, not the tool result. */
  async promptWorker(params: { prompt?: unknown }): Promise<{ accepted: true }> {
    const loop = this.loop;
    if (!loop) throw new MethodError(-32602, "no loop armed");
    if (params?.prompt == null) throw new MethodError(-32602, "prompt_worker requires prompt");
    const prompt = typeof params.prompt === "string" ? [{ type: "text", text: params.prompt }] : params.prompt;
    const bridge = this.opts.clientBridge;
    if (bridge) {
      const sid = await bridge.attach(loop.worker);
      await bridge.send(sid, prompt);
    } else {
      const conn = await this.routeSession(loop.worker);
      await conn.request("session/prompt", { sessionId: loop.worker, prompt });
    }
    if (this.loop === loop) loop.workerCalledThisTurn = true;
    return { accepted: true };
  }

  private onLoopIdle(info: SessionInfo): void {
    const loop = this.loop;
    if (!loop || info.stopReason !== "end_turn") return;
    if (info.sessionId === loop.worker) {
      loop.cycles += 1;
      const message = this.transcripts.get(loop.worker)?.text ?? "";
      this.log(`loop cycle ${loop.cycles}: worker -> conductor`);
      void this.prompt({ sessionId: loop.conductor, prompt: [{ type: "text", text: message }] })
        .catch((err) => this.log(`loop handoff failed: ${err.message}`));
    } else if (info.sessionId === loop.conductor) {
      const called = loop.workerCalledThisTurn;
      loop.workerCalledThisTurn = false;
      if (!called) {
        this.log("loop: conductor ended a turn without prompt_worker — reprimand");
        void this.prompt({ sessionId: loop.conductor, prompt: [{ type: "text", text: REPRIMAND }] })
          .catch((err) => this.log(`loop reprimand failed: ${err.message}`));
      }
    }
  }

  private async control(): Promise<Conn> {
    if (this.controlConn && !this.controlConn.closed) return this.controlConn;
    this.controlStarting ??= (async () => {
      const conn = new Conn(this, null, new WebSocket(this.upstreamUrl!));
      this.conns.add(conn);
      this.controlConn = conn;
      await conn.opened();
      await conn.request("initialize", { protocolVersion: 2, info: { name: "crow-backend", version: "0.1.0" } });
      return conn;
    })().catch((err) => {
      this.controlStarting = undefined;
      throw err;
    });
    return this.controlStarting;
  }

  private waitForTurnEnd(sessionId: string): { promise: Promise<{ stopReason: string }>; cancel: () => void } {
    let waiter!: TurnWaiter;
    const promise = new Promise<{ stopReason: string }>((resolve, reject) => {
      waiter = {
        resolve: (v) => resolve(v),
        reject,
        cancel: () => {
          const list = this.turnWaiters.get(sessionId);
          if (!list) return;
          const i = list.indexOf(waiter);
          if (i >= 0) list.splice(i, 1);
        },
      };
      const list = this.turnWaiters.get(sessionId) ?? [];
      list.push(waiter);
      this.turnWaiters.set(sessionId, list);
    });
    return { promise, cancel: () => waiter.cancel() };
  }

  private settleTurn(sessionId: string, stopReason: string): void {
    const list = this.turnWaiters.get(sessionId);
    const waiter = list?.shift();
    if (waiter) waiter.resolve({ stopReason });
  }

  private rejectTurns(sessionId: string, reason: string): void {
    const list = this.turnWaiters.get(sessionId) ?? [];
    this.turnWaiters.delete(sessionId);
    for (const w of list) w.reject(new Error(reason));
  }

  // -- observation ----------------------------------------------------------

  private observeClient(conn: Conn, msg: any): void {
    if (msg?.id == null || typeof msg.method !== "string") return;
    if (msg.method === "session/new") conn.pendingNew.set(msg.id, msg.params?.cwd);
    else if (msg.method === "session/resume") conn.pendingResume.set(msg.id, msg.params?.sessionId);
    else if (msg.method === "session/close") conn.pendingClose.set(msg.id, msg.params?.sessionId);
  }

  private observeAgent(conn: Conn, msg: any): void {
    if (msg?.id != null) {
      if (conn.pendingNew.has(msg.id)) {
        const cwd = conn.pendingNew.get(msg.id);
        conn.pendingNew.delete(msg.id);
        const sessionId = msg.result?.sessionId;
        if (typeof sessionId === "string") {
          this.owners.set(sessionId, conn);
          conn.owned.add(sessionId);
          this.setState(sessionId, "idle", undefined, typeof cwd === "string" ? cwd : undefined);
        }
        return;
      }
      if (conn.pendingResume.has(msg.id)) {
        const sessionId = conn.pendingResume.get(msg.id)!;
        conn.pendingResume.delete(msg.id);
        if (!msg.error && typeof sessionId === "string") {
          this.owners.set(sessionId, conn);
          conn.owned.add(sessionId);
        }
        return;
      }
      if (conn.pendingClose.has(msg.id)) {
        const sessionId = conn.pendingClose.get(msg.id)!;
        conn.pendingClose.delete(msg.id);
        if (!msg.error && typeof sessionId === "string") {
          if (this.owners.get(sessionId) === conn) this.owners.delete(sessionId);
          conn.owned.delete(sessionId);
          this.sessions.delete(sessionId);
          this.transcripts.delete(sessionId);
        }
        return;
      }
      return;
    }
    if (msg?.method !== "session/update") return;
    const { sessionId, update } = msg.params ?? {};
    if (typeof sessionId !== "string") return;
    if (update?.sessionUpdate === "state_update") {
      this.setState(sessionId, update.state, update.stopReason ?? undefined);
    } else if (update?.sessionUpdate === "agent_message_chunk") {
      this.appendAssistant(sessionId, update.messageId, update.content);
    } else if (update?.sessionUpdate === "agent_message") {
      this.wholeAssistant(sessionId, update.messageId, update.content);
    }
  }

  /** One streamed piece of assistant text. Chunks of one message concatenate;
   * a new messageId is a new assistant message within the turn. Non-text
   * blocks are ignored. */
  private appendAssistant(sessionId: string, messageId: unknown, content: any): void {
    if (content?.type !== "text" || typeof content.text !== "string") return;
    const id = typeof messageId === "string" ? messageId : undefined;
    const cur = this.transcripts.get(sessionId);
    if (!cur || cur.messageId !== id) this.transcripts.set(sessionId, { messageId: id, text: content.text });
    else cur.text += content.text;
  }

  /** A whole assistant message (the replay upsert): content is a block array.
   * It replaces the accumulation and is immediately the last assistant
   * message — replay must not corrupt, nor be corrupted by, live turns. */
  private wholeAssistant(sessionId: string, messageId: unknown, content: unknown): void {
    const blocks = Array.isArray(content) ? content : [];
    const text = blocks
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
    const id = typeof messageId === "string" ? messageId : undefined;
    this.transcripts.set(sessionId, { messageId: id, text });
    const info = this.sessions.get(sessionId);
    if (info) info.lastAssistantMessage = text;
  }

  private setState(sessionId: string, state: string, stopReason?: string, cwd?: string): void {
    const prev = this.sessions.get(sessionId);
    if (state === "running") this.transcripts.delete(sessionId);
    const info: SessionInfo = {
      sessionId, state, stopReason,
      cwd: cwd ?? prev?.cwd,
      lastAssistantMessage: prev?.lastAssistantMessage,
      updatedAt: Date.now(),
    };
    if (state === "idle" && stopReason != null) {
      info.lastAssistantMessage = this.transcripts.get(sessionId)?.text ?? "";
    }
    this.sessions.set(sessionId, info);
    if (state !== "idle") return;
    if (stopReason != null) this.settleTurn(sessionId, stopReason);
    if (prev != null && prev.state !== "idle") {
      this.log(`session ${sessionId} idle${stopReason ? ` (${stopReason})` : ""}`);
      this.idle.fire(info);
      this.onLoopIdle(info);
    }
  }

  log(line: string): void {
    this.opts.log(`[backend] ${line}`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loop = undefined;
    for (const conn of this.conns) {
      conn.down?.close(1001, "window closed");
      conn.up.close();
    }
    this.conns.clear();
    for (const ws of this.clients) ws.close(1001, "window closed");
    this.clients.clear();
    this.wss?.close();
    this.httpServer?.close();
    this.daemonWatcher?.stop();
    for (const sessionId of [...this.turnWaiters.keys()]) this.rejectTurns(sessionId, "backend disposed");
    this.idle.dispose();
    const child = this.child;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3000);
      force.unref();
    }
  }
}

const REPRIMAND = "[System reminder] you have to prompt worker with the prompt_worker tool to continue the loop.";

const PORT_ATTEMPTS = 64;
const READY_TIMEOUT_MS = 30_000;

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/** True once the daemon accepts TCP; false if it exits or errors first. */
function waitReady(port: number, child: ChildProcess): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      child.removeListener("exit", finishFalse);
      child.removeListener("error", finishFalse);
      resolve(ok);
    };
    const finishFalse = () => finish(false);
    child.once("exit", finishFalse);
    child.once("error", finishFalse);
    const timer = setInterval(() => {
      if (Date.now() > deadline) return finish(false);
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); finish(true); });
      sock.once("error", () => sock.destroy());
    }, 150);
  });
}
