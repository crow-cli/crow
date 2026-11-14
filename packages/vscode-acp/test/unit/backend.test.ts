import { describe, test, expect, afterEach } from "bun:test";
import * as net from "node:net";
import * as path from "node:path";
import { FakeAgent } from "../fake-agent.js";
import { TestClient, makeBackend, waitFor, sleep } from "../helpers.js";
import type { Backend } from "../../src/backend.js";

const FAKE_AGENT_PATH = path.join(import.meta.dir, "..", "fake-agent.ts");

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function setup(opts: { acceptDelayMs?: number; autoTurn?: boolean } = {}) {
  const agent = new FakeAgent(opts);
  await agent.listening();
  const { backend, logs, start } = makeBackend({ external: agent.url });
  const endpoint = await start();
  cleanups.push(async () => {
    backend.dispose();
    await agent.close();
  });
  return { agent, backend, logs, endpoint };
}

async function connect(endpoint: string): Promise<TestClient> {
  const client = new TestClient(endpoint);
  await client.opened();
  cleanups.push(() => client.close());
  return client;
}

async function newSession(client: TestClient, cwd = "/tmp/fake-cwd"): Promise<string> {
  const res = await client.request("session/new", { cwd, mcpServers: [] });
  return res.sessionId;
}

function ownerSocket(agent: FakeAgent): import("ws").WebSocket {
  expect(agent.sockets.size).toBe(1);
  return [...agent.sockets][0];
}

describe("proxy forwarding", () => {
  test("frames pass through verbatim both directions", async () => {
    const { agent, endpoint } = await setup();
    const client = await connect(endpoint);
    const params = { protocolVersion: 2, info: { name: "test", version: "0" } };
    const result = await client.request("initialize", params);
    expect(result.protocolVersion).toBe(2);
    const seen = agent.framesOf("initialize");
    expect(seen.length).toBe(1);
    expect(seen[0].frame.params).toEqual(params);
  });

  test("frames sent before the upstream opens are queued in order", async () => {
    const { agent, endpoint } = await setup({ acceptDelayMs: 200 });
    const client = await connect(endpoint);
    client.notify("session/cancel", { sessionId: "s1" });
    client.notify("session/cancel", { sessionId: "s2" });
    client.notify("session/cancel", { sessionId: "s3" });
    await waitFor(() => agent.framesOf("session/cancel").length === 3, "queued cancels to arrive");
    expect(agent.framesOf("session/cancel").map((r) => r.frame.params.sessionId)).toEqual(["s1", "s2", "s3"]);
  });

  test("daemon death closes the webview connection", async () => {
    const base = 28000 + Math.floor(Math.random() * 2000);
    const { backend, start } = makeBackend({ cliCommand: ["bun", FAKE_AGENT_PATH], firstPort: base });
    cleanups.push(() => backend.dispose());
    const endpoint = await start();
    const client = await connect(endpoint);
    const pid = (backend.status().daemon as any).pid as number;
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, "SIGKILL");
    await waitFor(() => client.isClosed, "client close after daemon death");
  });
});

describe("session observation", () => {
  test("session/new registers the session with cwd and idle state", async () => {
    const { endpoint } = await setup();
    const client = await connect(endpoint);
    const sessionId = await newSession(client, "/tmp/some-cwd");
    const status = await client.request("_crow/backend/status");
    expect(status.sessions).toEqual([
      expect.objectContaining({ sessionId, state: "idle", cwd: "/tmp/some-cwd" }),
    ]);
  });

  test("state_update drives the table; onSessionIdle fires only on work->idle", async () => {
    const { agent, backend, endpoint } = await setup();
    const client = await connect(endpoint);
    const sessionId = await newSession(client);
    await waitFor(() => agent.sockets.size === 1, "upstream socket");
    const sock = ownerSocket(agent);
    const idles: any[] = [];
    backend.onSessionIdle((info) => idles.push(info));

    agent.state(sock, sessionId, "running");
    await waitFor(() => (backend.status().sessions as any[])[0]?.state === "running", "running state");
    expect(idles.length).toBe(0);

    agent.state(sock, sessionId, "idle", "end_turn");
    await waitFor(() => idles.length === 1, "idle event");
    expect(idles[0]).toMatchObject({ sessionId, state: "idle", stopReason: "end_turn" });

    agent.state(sock, sessionId, "idle"); // park idle: no transition, no event
    await sleep(80);
    expect(idles.length).toBe(1);
  });

  test("two clients get independent sessions in one table", async () => {
    const { agent, endpoint } = await setup({ autoTurn: true });
    const a = await connect(endpoint);
    const b = await connect(endpoint);
    const s1 = await newSession(a, "/tmp/one");
    const s2 = await newSession(b, "/tmp/two");
    const result = await b.request("_crow/backend/prompt", { sessionId: s1, prompt: [{ type: "text", text: "go" }] });
    expect(result).toMatchObject({ stopReason: "end_turn" });
    const sessions = (await a.request("_crow/backend/status")).sessions as any[];
    expect(sessions.length).toBe(2);
    const byId = Object.fromEntries(sessions.map((s) => [s.sessionId, s]));
    expect(byId[s1]).toMatchObject({ state: "idle", stopReason: "end_turn", cwd: "/tmp/one" });
    expect(byId[s2]).toMatchObject({ state: "idle", cwd: "/tmp/two" });
    expect(byId[s2].stopReason).toBeUndefined();
  });
});

describe("backend extension methods", () => {
  test("status is answered by the backend, never forwarded to the agent", async () => {
    const { agent, endpoint } = await setup();
    const client = await connect(endpoint);
    const status = await client.request("_crow/backend/status");
    expect(status.proxy.endpoint).toBe(endpoint);
    expect(status.daemon.external).toBe(agent.url);
    expect(agent.framesOf("_crow/backend/status").length).toBe(0);
  });

  test("unknown backend method is -32601", async () => {
    const { endpoint } = await setup();
    const client = await connect(endpoint);
    await expect(client.request("_crow/backend/nope")).rejects.toMatchObject({ code: -32601 });
  });

  test("agent-originated backend request is answered upstream, not shown to the webview", async () => {
    const { agent, endpoint } = await setup();
    const client = await connect(endpoint);
    await newSession(client);
    await waitFor(() => agent.sockets.size === 1, "upstream socket");
    const sock = ownerSocket(agent);
    agent.send(sock, { jsonrpc: "2.0", id: 999, method: "_crow/backend/status" });
    await waitFor(
      () => agent.received.some((r) => r.frame.id === 999 && r.frame.result),
      "backend answer to agent request",
    );
    const answer = agent.received.find((r) => r.frame.id === 999 && r.frame.result)!.frame;
    expect(answer.result.sessions.length).toBe(1);
    expect(client.frames.some((f) => f.id === 999 || f.method === "_crow/backend/status")).toBe(false);
  });
});

describe("prompt wrapper", () => {
  test("routes through the owning connection and settles on idle(end_turn)", async () => {
    const { agent, endpoint } = await setup();
    const owner = await connect(endpoint);
    const caller = await connect(endpoint);
    const sessionId = await newSession(owner);
    await waitFor(() => agent.sockets.size === 2, "both upstream sockets");

    const pending = caller.request("_crow/backend/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
    await waitFor(() => agent.framesOf("session/prompt").length === 1, "prompt at agent");
    const promptFrame = agent.framesOf("session/prompt")[0];
    const newFrame = agent.framesOf("session/new")[0];
    expect(promptFrame.conn).toBe(newFrame.conn); // routed via the owner, not the caller
    expect(String(promptFrame.frame.id).startsWith("crow-backend-")).toBe(true); // no id collision

    const sock = promptFrame.conn;
    agent.chunk(sock, sessionId, "hello");
    agent.state(sock, sessionId, "idle", "end_turn");
    expect(await pending).toMatchObject({ stopReason: "end_turn" });
    // the owning webview saw the whole turn
    const updates = owner.frames.filter((f) => f.method === "session/update" && f.params.sessionId === sessionId);
    expect(updates.map((u) => u.params.update.sessionUpdate)).toEqual(["state_update", "agent_message_chunk", "state_update"]);
    expect(updates[2].params.update.stopReason).toBe("end_turn");
  });

  test("park idle without stopReason does not settle a pending prompt", async () => {
    const { agent, endpoint } = await setup();
    const owner = await connect(endpoint);
    const caller = await connect(endpoint);
    const sessionId = await newSession(owner);
    let settled = false;
    const pending = caller.request("_crow/backend/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] }).then((v) => {
      settled = true;
      return v;
    });
    await waitFor(() => agent.framesOf("session/prompt").length === 1, "prompt at agent");
    const sock = agent.framesOf("session/prompt")[0].conn;
    agent.state(sock, sessionId, "idle"); // park
    await sleep(120);
    expect(settled).toBe(false);
    agent.state(sock, sessionId, "idle", "end_turn");
    expect(await pending).toMatchObject({ stopReason: "end_turn" });
  });

  test("orphaned session is resumed on the control connection with its cwd", async () => {
    const { agent, endpoint } = await setup({ autoTurn: true });
    const owner = await connect(endpoint);
    const sessionId = await newSession(owner, "/tmp/orphan-cwd");
    owner.close();
    await waitFor(() => agent.framesOf("session/new").length === 1 && agent.sockets.size === 0, "owner upstream gone");

    const caller = await connect(endpoint);
    const result = await caller.request("_crow/backend/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
    expect(result).toMatchObject({ stopReason: "end_turn" });

    const resumes = agent.framesOf("session/resume");
    expect(resumes.length).toBe(1);
    expect(resumes[0].frame.params).toMatchObject({ sessionId, cwd: "/tmp/orphan-cwd" });
    const controlSock = resumes[0].conn;
    // initialize, resume and prompt all happened on the one control connection
    expect(agent.framesOf("initialize").some((r) => r.conn === controlSock)).toBe(true);
    expect(agent.framesOf("session/prompt")[0].conn).toBe(controlSock);
  });

  test("prompt for an unknown session without cwd is -32602", async () => {
    const { endpoint } = await setup();
    const client = await connect(endpoint);
    await expect(
      client.request("_crow/backend/prompt", { sessionId: "ghost", prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

describe("cancel wrapper", () => {
  test("cancel reaches the owning connection and settles the turn cancelled", async () => {
    const { agent, endpoint } = await setup();
    const owner = await connect(endpoint);
    const caller = await connect(endpoint);
    const sessionId = await newSession(owner);
    const pending = caller.request("_crow/backend/prompt", { sessionId, prompt: [{ type: "text", text: "long work" }] });
    await waitFor(() => agent.framesOf("session/prompt").length === 1, "prompt at agent");

    const ack = await caller.request("_crow/backend/cancel", { sessionId });
    expect(ack).toEqual({});
    await waitFor(() => agent.framesOf("session/cancel").length === 1, "cancel at agent");
    const cancelFrame = agent.framesOf("session/cancel")[0];
    expect(cancelFrame.frame.id).toBeUndefined(); // notification, not request
    expect(cancelFrame.conn).toBe(agent.framesOf("session/new")[0].conn);
    expect(await pending).toMatchObject({ stopReason: "cancelled" });
  });

  test("cancel without a live connection is -32602", async () => {
    const { endpoint } = await setup();
    const client = await connect(endpoint);
    await expect(client.request("_crow/backend/cancel", { sessionId: "ghost" })).rejects.toMatchObject({ code: -32602 });
  });
});

describe("daemon lifecycle", () => {
  test("port cycling skips a busy port", async () => {
    const base = 28000 + Math.floor(Math.random() * 2000);
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(base, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const { backend, start } = makeBackend({ cliCommand: ["bun", FAKE_AGENT_PATH], firstPort: base });
    cleanups.push(() => backend.dispose());
    await start();
    const daemon = backend.status().daemon as any;
    expect(daemon.port).toBe(base + 1);
    expect(daemon.running).toBe(true);
  });

  test("dispose kills the spawned daemon", async () => {
    const base = 28000 + Math.floor(Math.random() * 2000);
    const { backend, start } = makeBackend({ cliCommand: ["bun", FAKE_AGENT_PATH], firstPort: base });
    await start();
    const pid = (backend.status().daemon as any).pid as number;
    backend.dispose();
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, "daemon process exit");
  });

  test("spawn failure surfaces a clear error", async () => {
    const { backend, start } = makeBackend({ cliCommand: ["/nonexistent/crow-cli"], firstPort: 29500 });
    cleanups.push(() => backend.dispose());
    await expect(start()).rejects.toThrow("cannot spawn /nonexistent/crow-cli");
  });
});
