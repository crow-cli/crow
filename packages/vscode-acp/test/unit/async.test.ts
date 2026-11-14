import { describe, test, expect, afterEach } from "bun:test";
import { FakeAgent } from "../fake-agent.js";
import { TestClient, makeBackend, waitFor, sleep } from "../helpers.js";
import type { ClientBridge } from "../../src/backend.js";
import { handleMcp } from "../../src/mcp.js";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const text = (t: string) => [{ type: "text", text: t }];
const sentText = (p: any) => (Array.isArray(p) ? p.map((b: any) => b.text ?? "").join("") : String(p));

async function setup() {
  const agent = new FakeAgent({ autoTurn: false });
  await agent.listening();
  let visible: TestClient;
  const calls = { send: [] as { sessionId: string; prompt: any }[] };
  const bridge: ClientBridge = {
    async attach(sessionId) {
      if (sessionId) return sessionId;
      const r = await visible.request("session/new", { cwd: "/tmp/async-new", mcpServers: [] });
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
  const sockOf = (sid: string) =>
    agent.received.find((r) => r.frame.method === "session/new" && r.frame.params.sessionId === undefined && r.conn)?.conn;
  return { agent, backend, visible, calls, sockOf };
}

const mcp = (backend: any, name: string, args: unknown) =>
  handleMcp(backend, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const bodyOf = (r: any) => JSON.parse(r.body.result.content[0].text);

describe("async delegation", () => {
  test("crow_prompt returns while the called session is still running", async () => {
    const { backend, visible, calls } = await setup();
    const c = await visible.request("session/new", { cwd: "/tmp/async-c", mcpServers: [] });
    const w = await visible.request("session/new", { cwd: "/tmp/async-w", mcpServers: [] });
    const body = bodyOf(await mcp(backend, "crow_prompt", { sessionId: w.sessionId, prompt: "work", callerSessionId: c.sessionId }));
    expect(body).toMatchObject({ sessionId: w.sessionId, status: "running", callerSessionId: c.sessionId });
    expect((backend.status() as any).sessions.find((s: any) => s.sessionId === w.sessionId).state).toBe("running");
    expect(calls.send).toEqual([{ sessionId: w.sessionId, prompt: text("work") }]);
    expect((backend.status() as any).control.connected).toBe(false);
  });

  test("the result travels back to the idle caller as a new prompt", async () => {
    const { agent, backend, visible, calls } = await setup();
    const c = await visible.request("session/new", { cwd: "/tmp/async-c", mcpServers: [] });
    const w = await visible.request("session/new", { cwd: "/tmp/async-w", mcpServers: [] });
    await mcp(backend, "crow_prompt", { sessionId: w.sessionId, prompt: "work", callerSessionId: c.sessionId });
    const sock = agent.received.find((r) => r.frame.method === "session/new" && r.frame.params.cwd === "/tmp/async-w")!.conn;
    agent.chunk(sock, w.sessionId, "answer-42");
    agent.state(sock, w.sessionId, "idle", "end_turn");
    await waitFor(() => calls.send.some((s) => s.sessionId === c.sessionId), "result delivered to caller");
    const delivery = calls.send.find((s) => s.sessionId === c.sessionId)!;
    const t = sentText(delivery.prompt);
    expect(t).toContain("[delegation result]");
    expect(t).toContain(w.sessionId);
    expect(t).toContain("answer-42");
    expect((backend.status() as any).control.connected).toBe(false);
  });

  test("results queue while the caller runs and land one per caller idle", async () => {
    const { agent, backend, visible, calls } = await setup();
    const c = await visible.request("session/new", { cwd: "/tmp/async-c", mcpServers: [] });
    const w1 = await visible.request("session/new", { cwd: "/tmp/async-w1", mcpServers: [] });
    const w2 = await visible.request("session/new", { cwd: "/tmp/async-w2", mcpServers: [] });
    await visible.request("session/prompt", { sessionId: c.sessionId, prompt: text("caller busy") });
    await mcp(backend, "crow_prompt", { sessionId: w1.sessionId, prompt: "one", callerSessionId: c.sessionId });
    await mcp(backend, "crow_prompt", { sessionId: w2.sessionId, prompt: "two", callerSessionId: c.sessionId });
    const sockOf = (cwd: string) => agent.received.find((r) => r.frame.method === "session/new" && r.frame.params.cwd === cwd)!.conn;
    agent.chunk(sockOf("/tmp/async-w1"), w1.sessionId, "r1");
    agent.state(sockOf("/tmp/async-w1"), w1.sessionId, "idle", "end_turn");
    agent.chunk(sockOf("/tmp/async-w2"), w2.sessionId, "r2");
    agent.state(sockOf("/tmp/async-w2"), w2.sessionId, "idle", "end_turn");
    await sleep(300);
    expect(calls.send.filter((s) => s.sessionId === c.sessionId).length).toBe(0);
    const cSock = sockOf("/tmp/async-c");
    agent.state(cSock, c.sessionId, "idle", "end_turn");
    await waitFor(() => calls.send.filter((s) => s.sessionId === c.sessionId).length === 1, "first delivery");
    expect(sentText(calls.send.filter((s) => s.sessionId === c.sessionId)[0].prompt)).toContain("r1");
    await sleep(200);
    expect(calls.send.filter((s) => s.sessionId === c.sessionId).length).toBe(1);
    agent.state(cSock, c.sessionId, "idle", "end_turn");
    await waitFor(() => calls.send.filter((s) => s.sessionId === c.sessionId).length === 2, "second delivery");
    expect(sentText(calls.send.filter((s) => s.sessionId === c.sessionId)[1].prompt)).toContain("r2");
  });

  test("without callerSessionId nothing is delivered back", async () => {
    const { agent, backend, visible, calls } = await setup();
    const w = await visible.request("session/new", { cwd: "/tmp/async-w", mcpServers: [] });
    const body = bodyOf(await mcp(backend, "crow_prompt", { sessionId: w.sessionId, prompt: "work" }));
    expect(body.callerSessionId).toBeUndefined();
    const sock = agent.received.find((r) => r.frame.method === "session/new" && r.frame.params.cwd === "/tmp/async-w")!.conn;
    agent.chunk(sock, w.sessionId, "solo");
    agent.state(sock, w.sessionId, "idle", "end_turn");
    await sleep(300);
    expect(calls.send.map((s) => s.sessionId)).toEqual([w.sessionId]);
  });

  test("prompt_worker is disabled: absent from tools/list, rejected on call", async () => {
    const { backend } = await setup();
    const list = await handleMcp(backend, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((list.body as any).result.tools.map((t: any) => t.name)).toEqual(["crow_status", "crow_prompt", "crow_cancel"]);
    const r = await mcp(backend, "prompt_worker", { prompt: "x" });
    expect((r.body as any).result.isError).toBe(true);
  });
});
