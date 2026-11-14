import { describe, test, expect, afterEach } from "bun:test";
import * as http from "node:http";
import { FakeAgent } from "../fake-agent.js";
import { TestClient, makeBackend, waitFor, sleep } from "../helpers.js";
import { attachMcp } from "../../src/mcp.js";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const text = (t: string) => [{ type: "text", text: t }];

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
  const conductorClient = new TestClient(endpoint);
  const workerClient = new TestClient(endpoint);
  cleanups.push(() => { conductorClient.close(); workerClient.close(); });
  const c = await conductorClient.request("session/new", { cwd: "/tmp/loop-c", mcpServers: [] });
  const w = await workerClient.request("session/new", { cwd: "/tmp/loop-w", mcpServers: [] });
  await waitFor(() => agent.sockets.size === 2, "both upstream sockets");
  const socks = [...agent.sockets];
  const init = await fetch(mcpUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "loop-test", version: "0" } } }),
  });
  const mcpSid = init.headers.get("mcp-session-id")!;
  // prompt_worker is disabled as an MCP tool while the loop is on hold; the
  // machinery stays covered here by driving the backend method directly.
  const promptWorker = async (prompt: string) => {
    try {
      const ack = await backend.promptWorker({ prompt });
      return { result: { content: [{ type: "text", text: JSON.stringify(ack) }] } };
    } catch (err) {
      return { result: { isError: true, content: [{ type: "text", text: String(err) }] } };
    }
  };
  const promptsOf = (sid: string) => agent.framesOf("session/prompt").filter((f) => f.frame.params.sessionId === sid);
  const loopStatus = () => (backend.status() as any).loop;
  const arm = () => conductorClient.request("_crow/backend/loop/arm", { conductorSessionId: c.sessionId, workerSessionId: w.sessionId });
  const endTurn = (sid: string, reply: string) => {
    agent.chunk(sockOf(sid), sid, reply);
    agent.state(sockOf(sid), sid, "idle", "end_turn");
  };
  const sockOf = (sid: string) => {
    const frame = agent.received.find((r) => r.frame.method === "session/new" && r.frame.params.cwd === (sid === c.sessionId ? "/tmp/loop-c" : "/tmp/loop-w"));
    return frame!.conn;
  };
  return { agent, backend, conductorClient, workerClient, conductor: c.sessionId as string, worker: w.sessionId as string, promptWorker, promptsOf, loopStatus, arm, endTurn };
}

describe("conductor/worker loop", () => {
  test("arm validates sessions; status reports the armed pair", async () => {
    const { backend, conductor, worker, conductorClient, arm, loopStatus } = await setup();
    await expect(conductorClient.request("_crow/backend/loop/arm", { conductorSessionId: conductor, workerSessionId: "nope" })).rejects.toThrow("unknown session");
    await expect(conductorClient.request("_crow/backend/loop/arm", { conductorSessionId: conductor, workerSessionId: conductor })).rejects.toThrow("different sessions");
    const st = await arm();
    expect(st.armed).toBe(true);
    expect(st.conductor.sessionId).toBe(conductor);
    expect(st.worker.sessionId).toBe(worker);
    expect(loopStatus().armed).toBe(true);
    expect(await conductorClient.request("_crow/backend/loop/disarm")).toEqual({});
    expect(loopStatus().armed).toBe(false);
  });

  test("six ping-pong cycles with exact handoff text", async () => {
    const { conductorClient, conductor, worker, promptWorker, promptsOf, loopStatus, arm, endTurn } = await setup();
    await arm();
    for (let i = 1; i <= 6; i++) {
      if (i === 1) {
        void conductorClient.request("session/prompt", { sessionId: conductor, prompt: text("start") });
        await waitFor(() => promptsOf(conductor).length === 1, "first conductor prompt");
      }
      const ack = await promptWorker(`work ${i}`);
      expect(ack.result.isError).toBeFalsy();
      await waitFor(() => promptsOf(worker).length === i, `worker prompt ${i}`);
      expect(promptsOf(worker)[i - 1].frame.params.prompt).toEqual(text(`work ${i}`));
      endTurn(conductor, `delegated ${i}`);
      endTurn(worker, `answer ${i}`);
      await waitFor(() => promptsOf(conductor).length === i + 1, `handoff ${i}`);
      expect(promptsOf(conductor)[i].frame.params.prompt).toEqual(text(`answer ${i}`));
      expect(loopStatus().cycles).toBe(i);
    }
  });

  test("conductor turn without prompt_worker draws a reprimand", async () => {
    const { conductorClient, conductor, promptWorker, promptsOf, arm, endTurn } = await setup();
    await arm();
    void conductorClient.request("session/prompt", { sessionId: conductor, prompt: text("start") });
    await waitFor(() => promptsOf(conductor).length === 1, "first prompt");
    endTurn(conductor, "I will just answer myself");
    await waitFor(() => promptsOf(conductor).length === 2, "reprimand");
    expect(promptsOf(conductor)[1].frame.params.prompt[0].text).toContain("[System reminder]");
    expect(promptsOf(conductor)[1].frame.params.prompt[0].text).toContain("prompt_worker");
    await promptWorker("work after reprimand");
    endTurn(conductor, "delegated");
    await sleep(400);
    expect(promptsOf(conductor).length).toBe(2);
  });

  test("disarm stops handoffs", async () => {
    const { conductorClient, workerClient, conductor, worker, promptWorker, promptsOf, arm, endTurn, loopStatus } = await setup();
    await arm();
    void conductorClient.request("session/prompt", { sessionId: conductor, prompt: text("start") });
    await waitFor(() => promptsOf(conductor).length === 1, "first prompt");
    await promptWorker("work 1");
    endTurn(conductor, "delegated");
    endTurn(worker, "answer 1");
    await waitFor(() => promptsOf(conductor).length === 2, "handoff 1");
    await conductorClient.request("_crow/backend/loop/disarm");
    void workerClient.request("session/prompt", { sessionId: worker, prompt: text("more work") });
    await waitFor(() => promptsOf(worker).length === 2, "second worker prompt");
    endTurn(worker, "answer 2");
    await sleep(500);
    expect(promptsOf(conductor).length).toBe(2);
    expect(loopStatus().armed).toBe(false);
  });

  test("prompt_worker without an armed loop is an error", async () => {
    const { promptWorker } = await setup();
    const res = await promptWorker("anyone there?");
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("no loop armed");
  });
});
