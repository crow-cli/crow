import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "node:net";

export type FakeAgentOptions = {
  port?: number;
  /** Hold the HTTP upgrade this long before accepting (exercises pre-open queuing). */
  acceptDelayMs?: number;
  /** prompt -> running -> chunk -> idle(end_turn) without further prodding. */
  autoTurn?: boolean;
};

/** A deterministic ACP v2 agent over real WebSocket: enough of the protocol
 * to exercise the backend without a model. Mirrors the daemon's turn contract —
 * prompt acknowledges, states travel as session/update, park idles carry no
 * stopReason, cancel is answered with idle(cancelled). */
export class FakeAgent {
  readonly wss: WebSocketServer;
  readonly sockets = new Set<WebSocket>();
  readonly received: { conn: WebSocket; frame: any }[] = [];
  autoTurn: boolean;
  private nextSession = 0;
  private held = new Map<string, WebSocket>();

  constructor(opts: FakeAgentOptions = {}) {
    this.autoTurn = opts.autoTurn ?? false;
    const delay = opts.acceptDelayMs ?? 0;
    this.wss = new WebSocketServer({
      host: "127.0.0.1",
      port: opts.port ?? 0,
      path: "/acp",
      verifyClient: (_info, cb) => setTimeout(() => cb(true), delay),
    });
    this.wss.on("connection", (ws) => {
      this.sockets.add(ws);
      ws.on("message", (data) => {
        let frame: any;
        try { frame = JSON.parse(data.toString()); } catch { return; }
        this.received.push({ conn: ws, frame });
        this.onFrame(ws, frame);
      });
      ws.on("close", () => this.sockets.delete(ws));
    });
  }

  listening(): Promise<void> {
    return new Promise((resolve) => {
      if (this.wss.address()) return resolve();
      this.wss.once("listening", resolve);
    });
  }

  get port(): number {
    return (this.wss.address() as AddressInfo).port;
  }
  get url(): string {
    return `ws://127.0.0.1:${this.port}/acp`;
  }

  send(conn: WebSocket, frame: unknown): void {
    if (conn.readyState === WebSocket.OPEN) conn.send(JSON.stringify(frame));
  }
  update(conn: WebSocket, sessionId: string, update: unknown): void {
    this.send(conn, { jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }
  state(conn: WebSocket, sessionId: string, state: string, stopReason?: string): void {
    this.update(conn, sessionId, { sessionUpdate: "state_update", state, ...(stopReason ? { stopReason } : {}) });
  }
  chunk(conn: WebSocket, sessionId: string, text: string): void {
    this.update(conn, sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  }
  framesOf(method: string): { conn: WebSocket; frame: any }[] {
    return this.received.filter((r) => r.frame.method === method);
  }

  private onFrame(ws: WebSocket, msg: any): void {
    if (typeof msg.method !== "string") return; // response frame, nothing to answer
    if (msg.id == null) {
      if (msg.method === "session/cancel") {
        const sid = msg.params?.sessionId;
        if (this.held.get(sid) === ws) {
          this.held.delete(sid);
          this.state(ws, sid, "idle", "cancelled");
        }
      }
      return;
    }
    const reply = (result: unknown) => this.send(ws, { jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "initialize":
        reply({ protocolVersion: 2, agentInfo: { name: "fake-agent", version: "0" }, agentCapabilities: {} });
        return;
      case "session/new":
        reply({ sessionId: `fake-${this.nextSession++}` });
        return;
      case "session/resume":
        reply({});
        this.state(ws, msg.params.sessionId, "idle");
        return;
      case "session/prompt": {
        const sid = msg.params.sessionId;
        reply({ messageId: `m-${sid}` });
        this.state(ws, sid, "running");
        if (this.autoTurn) {
          queueMicrotask(() => {
            this.chunk(ws, sid, "ok");
            this.state(ws, sid, "idle", "end_turn");
          });
        } else {
          this.held.set(sid, ws);
        }
        return;
      }
      case "session/list":
        reply({ sessions: [] });
        return;
      case "session/close":
        reply({});
        return;
      default:
        this.send(ws, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
    }
  }

  async close(): Promise<void> {
    for (const ws of this.sockets) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

if (import.meta.main) {
  const i = process.argv.indexOf("--port");
  const port = i >= 0 ? Number(process.argv[i + 1]) : 0;
  const agent = new FakeAgent({ port, autoTurn: true });
  await agent.listening();
  console.log(`fake agent listening on ${agent.url}`);
}
