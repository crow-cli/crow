import { describe, test, expect, afterEach } from "bun:test";
import * as http from "node:http";
import { FakeAgent } from "../fake-agent.js";
import { TestClient, makeBackend, waitFor } from "../helpers.js";
import { attachMcp } from "../../src/mcp.js";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function setup() {
  const agent = new FakeAgent();
  await agent.listening();
  const { backend, start } = makeBackend({ external: agent.url });
  const endpoint = await start();
  const server = http.createServer();
  attachMcp(server, backend);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const mcpUrl = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
  cleanups.push(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    backend.dispose();
    await agent.close();
  });
  const client = new TestClient(endpoint);
  cleanups.push(() => client.close());
  const res = await client.request("session/new", { cwd: "/tmp/mcp-cwd", mcpServers: [] });
  await waitFor(() => agent.sockets.size === 1, "upstream socket");
  const sock = [...agent.sockets][0];
  return { agent, backend, client, sock, sessionId: res.sessionId as string, mcpUrl };
}

async function rpc(url: string, msg: unknown, session?: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify(msg),
  });
  const text = await res.text();
  return { status: res.status, session: res.headers.get("mcp-session-id"), body: text ? JSON.parse(text) : undefined };
}

async function init(url: string): Promise<string> {
  const r = await rpc(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "unit", version: "0" } } });
  expect(r.status).toBe(200);
  expect(r.body.result.protocolVersion).toBe("2025-06-18");
  expect(r.session).toBeTruthy();
  const ack = await rpc(url, { jsonrpc: "2.0", method: "notifications/initialized" }, r.session!);
  expect(ack.status).toBe(202);
  return r.session!;
}

const call = (url: string, sid: string, id: number, name: string, args: unknown) =>
  rpc(url, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, sid);

describe("MCP streamable HTTP endpoint", () => {
  test("initialize, session header, tools/list", async () => {
    const { mcpUrl } = await setup();
    const sid = await init(mcpUrl);
    const r = await rpc(mcpUrl, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
    expect(r.status).toBe(200);
    expect(r.body.result.tools.map((t: any) => t.name)).toEqual(["crow_status", "crow_prompt", "crow_cancel"]);
  });

  test("requests without a live session are 404; GET is 405", async () => {
    const { mcpUrl } = await setup();
    const noHeader = await rpc(mcpUrl, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(noHeader.status).toBe(404);
    const bogus = await rpc(mcpUrl, { jsonrpc: "2.0", id: 2, method: "tools/list" }, "not-a-session");
    expect(bogus.status).toBe(404);
    const get = await fetch(mcpUrl);
    expect(get.status).toBe(405);
  });

  test("crow_status reports the daemon and the session table", async () => {
    const { mcpUrl, sessionId } = await setup();
    const sid = await init(mcpUrl);
    const r = await call(mcpUrl, sid, 3, "crow_status", {});
    const status = JSON.parse(r.body.result.content[0].text);
    expect(status.proxy.endpoint).toBeTruthy();
    expect(status.sessions.some((s: any) => s.sessionId === sessionId)).toBe(true);
  });

  test("crow_prompt drives a turn through the owning connection", async () => {
    const { agent, sock, sessionId, mcpUrl } = await setup();
    const sid = await init(mcpUrl);
    const r = await call(mcpUrl, sid, 4, "crow_prompt", { sessionId, prompt: "go" });
    const result = JSON.parse(r.body.result.content[0].text);
    expect(result).toMatchObject({ sessionId, status: "running" });
    await waitFor(() => agent.framesOf("session/prompt").length === 1, "prompt forwarded");
    expect(agent.framesOf("session/prompt")[0].frame.params.prompt).toEqual([{ type: "text", text: "go" }]);
    agent.chunk(sock, sessionId, "answer");
    agent.state(sock, sessionId, "idle", "end_turn");
    await waitFor(async () => {
      const st = JSON.parse((await call(mcpUrl, sid, 9, "crow_status", {})).body.result.content[0].text);
      return st.sessions.find((s: any) => s.sessionId === sessionId)?.lastAssistantMessage === "answer";
    }, "final message published");
  });

  test("crow_cancel stops a held turn and settles the pending prompt", async () => {
    const { agent, sock, sessionId, mcpUrl } = await setup();
    const sid = await init(mcpUrl);
    const held = await call(mcpUrl, sid, 5, "crow_prompt", { sessionId, prompt: "hold" });
    expect(JSON.parse(held.body.result.content[0].text).status).toBe("running");
    await waitFor(() => agent.framesOf("session/prompt").length === 1, "prompt forwarded");
    const cancelled = call(mcpUrl, sid, 6, "crow_cancel", { sessionId });
    await waitFor(() => agent.framesOf("session/cancel").length === 1, "cancel forwarded");
    agent.state(sock, sessionId, "idle", "cancelled");
    expect(JSON.parse((await cancelled).body.result.content[0].text)).toEqual({});
    await waitFor(async () => {
      const st = JSON.parse((await call(mcpUrl, sid, 9, "crow_status", {})).body.result.content[0].text);
      return st.sessions.find((s: any) => s.sessionId === sessionId)?.stopReason === "cancelled";
    }, "cancelled published");
  });

  test("the proxy itself serves /mcp alongside /acp", async () => {
    const agent = new FakeAgent();
    await agent.listening();
    const { backend, start } = makeBackend({ external: agent.url });
    const endpoint = await start();
    cleanups.push(async () => {
      backend.dispose();
      await agent.close();
    });
    const status = backend.status() as any;
    expect(status.proxy.mcp).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const sid = await init(status.proxy.mcp);
    const r = await rpc(status.proxy.mcp, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
    expect(r.body.result.tools.length).toBe(3);
    const client = new TestClient(endpoint);
    cleanups.push(() => client.close());
    const res = await client.request("session/new", { cwd: "/tmp", mcpServers: [] });
    expect(typeof res.sessionId).toBe("string");
  });

  test("tool errors are isError results; unknown methods are -32601", async () => {
    const { mcpUrl } = await setup();
    const sid = await init(mcpUrl);
    const bad = await call(mcpUrl, sid, 7, "no_such_tool", {});
    expect(bad.body.result.isError).toBe(true);
    const unknown = await rpc(mcpUrl, { jsonrpc: "2.0", id: 8, method: "no/such/method" }, sid);
    expect(unknown.body.error.code).toBe(-32601);
  });
});
