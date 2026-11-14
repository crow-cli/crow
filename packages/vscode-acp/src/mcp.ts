import * as http from "node:http";
import { randomUUID } from "node:crypto";

/** The slice of Backend the MCP tools need; Backend satisfies it structurally. */
export type McpBackend = {
  status(): Record<string, unknown>;
  prompt(params: { sessionId?: string; prompt?: unknown; cwd?: string }): Promise<{ stopReason: string; sessionId: string }>;
  cancel(params: { sessionId?: string }): Promise<Record<string, never>>;
  promptWorker(params: { prompt?: unknown }): Promise<{ accepted: true }>;
};

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "crow-backend", version: "0.1.0" };

const TOOLS = [
  {
    name: "crow_status",
    description:
      "Status of this window's crow backend: the daemon, the proxy, and every agent session with its state, stop reason and last assistant message.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "crow_prompt",
    description:
      "Prompt an agent session through its VISIBLE IDE chat and wait for its turn to end. The prompt is delivered through the chat client that owns the session: it appears in the open window and the reply streams there. Omit sessionId to open a new editor-pane chat. Returns the stop reason, the session id, and the session's final assistant message.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Target session id (see crow_status). Omit to open a new visible chat pane." },
        prompt: { type: "string", description: "The prompt text." },
        cwd: { type: "string", description: "Working directory; needed only when the backend has never seen the session (headless mode)." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "prompt_worker",
    description:
      "Conductor/worker loop: send a prompt to the worker session and return once it accepts. The worker's answer comes back to you automatically as a new prompt when its turn ends — call this tool every turn to keep the loop going.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string", description: "The instruction for the worker." } },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "crow_cancel",
    description: "Cancel the running turn of another agent session. The turn ends with stop reason cancelled.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string", description: "Session whose turn to cancel." } },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
];

type RpcReply = { status: number; body?: unknown; newSession?: string };

const ok = (id: unknown, result: unknown): RpcReply => ({ status: 200, body: { jsonrpc: "2.0", id, result } });

async function callTool(backend: McpBackend, name: string, args: any): Promise<unknown> {
  switch (name) {
    case "crow_status":
      return backend.status();
    case "crow_prompt": {
      const prompt = typeof args.prompt === "string" ? [{ type: "text", text: args.prompt }] : args.prompt;
      const { stopReason, sessionId } = await backend.prompt({ sessionId: args.sessionId, prompt, cwd: args.cwd });
      const row = (backend.status().sessions as any[]).find((s) => s.sessionId === sessionId);
      return { stopReason, sessionId, message: row?.lastAssistantMessage ?? "" };
    }
    case "crow_cancel":
      return backend.cancel({ sessionId: args.sessionId });
    case "prompt_worker":
      return backend.promptWorker({ prompt: args.prompt });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** One JSON-RPC message -> one reply. Pure enough to test without a socket. */
export async function handleMcp(backend: McpBackend, msg: any): Promise<RpcReply> {
  const method = msg?.method;
  if (method === "initialize") {
    return {
      status: 200,
      newSession: randomUUID(),
      body: {
        jsonrpc: "2.0", id: msg.id,
        result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
      },
    };
  }
  if (method === "notifications/initialized") return { status: 202 };
  if (method === "ping") return ok(msg.id, {});
  if (method === "tools/list") return ok(msg.id, { tools: TOOLS });
  if (method === "tools/call") {
    const { name, arguments: args } = msg.params ?? {};
    try {
      const result = await callTool(backend, name, args ?? {});
      return ok(msg.id, { content: [{ type: "text", text: JSON.stringify(result) }] });
    } catch (err) {
      return ok(msg.id, {
        content: [{ type: "text", text: String(err instanceof Error ? err.message : err) }],
        isError: true,
      });
    }
  }
  return { status: 200, body: { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32601, message: `Method not found: ${method}` } } };
}

/** MCP Streamable HTTP on an existing http.Server (the proxy's). POST carries
 * JSON-RPC; initialize mints the Mcp-Session-Id every later request must bear.
 * GET/DELETE (server-initiated streams, session teardown) are not offered. */
export function attachMcp(server: http.Server, backend: McpBackend, path = "/mcp"): void {
  const sessions = new Set<string>();
  server.on("request", (req, res) => {
    if ((req.url ?? "").split("?")[0] !== path) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const header = req.headers["mcp-session-id"];
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", async () => {
      let msg: any;
      try { msg = JSON.parse(body); } catch {
        res.writeHead(400).end();
        return;
      }
      if (msg?.method !== "initialize" && (typeof header !== "string" || !sessions.has(header))) {
        res.writeHead(404).end();
        return;
      }
      const reply = await handleMcp(backend, msg);
      if (reply.newSession) sessions.add(reply.newSession);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (reply.newSession) headers["mcp-session-id"] = reply.newSession;
      if (reply.body === undefined) {
        res.writeHead(reply.status, headers).end();
        return;
      }
      res.writeHead(reply.status, headers).end(JSON.stringify(reply.body));
    });
  });
}
