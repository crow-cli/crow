import { describe, test, expect, afterEach } from "bun:test";
import { FakeAgent } from "../fake-agent.js";
import { TestClient, makeBackend, waitFor } from "../helpers.js";
import type { ClientBridge } from "../../src/backend.js";
import { handleMcp } from "../../src/mcp.js";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const text = (t: string) => [{ type: "text", text: t }];

/** The bridge the extension provides, exercised here with a real client
 * connection standing in for the webview: attach binds the session, send
 * delivers the prompt through that client's own socket — never the shim's
 * control connection. */
async function setup(opts: { autoTurn?: boolean } = {}) {
  const agent = new FakeAgent({ autoTurn: opts.autoTurn ?? true });
  await agent.listening();
  let visible: TestClient;
  const calls = { attach: [] as (string | undefined)[], send: [] as { sessionId: string; prompt: any }[] };
  const bridge: ClientBridge = {
    async attach(sessionId) {
      calls.attach.push(sessionId);
      if (sessionId) return sessionId;
      const r = await visible.request("session/new", { cwd: "/tmp/headed-new", mcpServers: [] });
      return r.sessionId;
    },
    async send(sessionId, prompt) {
      calls.send.push({ sessionId, prompt });
      await visible.request("session/prompt", { sessionId, prompt });
    },
  };
  const { backend, start } = makeBackend({ external: agent.url, clientBridge: bridge });
  const endpoint = await start();
  visible = new TestClient(endpoint);
  cleanups.push(async () => {
    visible.close();
    backend.dispose();
    await agent.close();
  });
  return { agent, backend, visible, calls, bridge };
}

describe("headed delegation", () => {
  test("prompt rides the visible client; the control connection is never opened", async () => {
    const { agent, backend, visible, calls } = await setup();
    const s = await visible.request("session/new", { cwd: "/tmp/headed", mcpServers: [] });
    const result = await backend.prompt({ sessionId: s.sessionId, prompt: text("hello") });
    expect(result).toEqual({ stopReason: "end_turn", sessionId: s.sessionId });
    expect(calls.attach).toEqual([s.sessionId]);
    expect(calls.send).toEqual([{ sessionId: s.sessionId, prompt: text("hello") }]);
    const frames = agent.framesOf("session/prompt");
    expect(frames.length).toBe(1);
    expect(frames[0].frame.params.prompt).toEqual(text("hello"));
    expect((backend.status() as any).control.connected).toBe(false);
    expect((backend.status() as any).proxy.headed).toBe(true);
  });

  test("prompt without sessionId mints a fresh visible session", async () => {
    const { agent, backend, calls } = await setup();
    const result = await backend.prompt({ prompt: text("fresh pane") });
    expect(result.stopReason).toBe("end_turn");
    expect(typeof result.sessionId).toBe("string");
    expect(calls.attach).toEqual([undefined]);
    expect(calls.send[0].sessionId).toBe(result.sessionId);
    const frames = agent.framesOf("session/prompt");
    expect(frames[0].frame.params.sessionId).toBe(result.sessionId);
    expect((backend.status() as any).control.connected).toBe(false);
  });

  test("MCP crow_prompt without sessionId returns the new session and its exact reply", async () => {
    const { backend } = await setup();
    const reply = await handleMcp(backend, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "crow_prompt", arguments: { prompt: "say ok" } },
    });
    const body = JSON.parse((reply.body as any).result.content[0].text);
    expect(body.status).toBe("running");
    expect(typeof body.sessionId).toBe("string");
    await waitFor(() => (backend.status() as any).sessions.find((s: any) => s.sessionId === body.sessionId)?.lastAssistantMessage === "ok", "reply published");
  });

  test("prompt_worker delivers through the visible client", async () => {
    const { agent, backend, visible, calls } = await setup({ autoTurn: false });
    const c = await visible.request("session/new", { cwd: "/tmp/headed-c", mcpServers: [] });
    const w = await visible.request("session/new", { cwd: "/tmp/headed-w", mcpServers: [] });
    await visible.request("_crow/backend/loop/arm", { conductorSessionId: c.sessionId, workerSessionId: w.sessionId });
    const ack = await backend.promptWorker({ prompt: "do work" });
    expect(ack).toEqual({ accepted: true });
    expect(calls.attach).toContain(w.sessionId);
    const workerPrompts = agent.framesOf("session/prompt").filter((f) => f.frame.params.sessionId === w.sessionId);
    expect(workerPrompts.length).toBe(1);
    expect(workerPrompts[0].frame.params.prompt).toEqual(text("do work"));
    expect((backend.status() as any).control.connected).toBe(false);
  });

  test("loop handoff reaches the conductor through the visible client with the worker's exact text", async () => {
    const { agent, backend, visible, calls } = await setup({ autoTurn: false });
    const c = await visible.request("session/new", { cwd: "/tmp/headed-c", mcpServers: [] });
    const w = await visible.request("session/new", { cwd: "/tmp/headed-w", mcpServers: [] });
    await visible.request("_crow/backend/loop/arm", { conductorSessionId: c.sessionId, workerSessionId: w.sessionId });
    await backend.promptWorker({ prompt: "work" });
    const sockOf = (sid: string) =>
      agent.received.find((r) => r.frame.method === "session/new" && r.frame.params.cwd === (sid === c.sessionId ? "/tmp/headed-c" : "/tmp/headed-w"))!.conn;
    agent.chunk(sockOf(w.sessionId), w.sessionId, "worker-answer-42");
    agent.state(sockOf(w.sessionId), w.sessionId, "idle", "end_turn");
    await waitFor(() => calls.send.some((s) => s.sessionId === c.sessionId), "handoff sent to conductor");
    const handoff = calls.send.find((s) => s.sessionId === c.sessionId)!;
    expect(handoff.prompt).toEqual(text("worker-answer-42"));
    expect((backend.status() as any).loop.cycles).toBe(1);
    expect((backend.status() as any).control.connected).toBe(false);
  });
});
