import { describe, test, expect, afterAll } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Backend } from "../../src/backend.js";
import { TestClient, waitFor, sleep } from "../helpers.js";

/** Everything runs from the crow-cli source checkout — never an installed
 * crow binary. The model is the local llamacpp server by default. */
const CLI_SRC = process.env.CROW_CLI_SOURCE ?? "/home/thomas/.agents/crow/src/crow-cli";
const MODEL = process.env.CROW_TEST_MODEL ?? "glm-5.3-flash";
const UV = process.env.UV_PATH ?? "/home/thomas/.cargo/bin/uv";

const clients: TestClient[] = [];
let backend: Backend | undefined;
let endpoint: string;
let starting: Promise<void> | undefined;
const logs: string[] = [];

function mcpServers(tools: "none" | "exec" = "none") {
  if (tools === "none") return [];
  return [{
    type: "stdio",
    name: "crow-mcp",
    command: UV,
    args: ["--project", CLI_SRC, "run", "crow-cli", "mcp2"],
    env: [],
  }];
}

function sleepPids(): string[] {
  return spawnSync("pgrep", ["-f", "sleep 67"]).stdout.toString().trim().split("\n").filter(Boolean);
}

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crow-backend-it-"));
}

async function ensureStarted(): Promise<void> {
  starting ??= (async () => {
    if (!process.env.LLAMACPP_API_KEY) throw new Error("LLAMACPP_API_KEY must be set for the local model");
    backend = new Backend({
      log: (l) => logs.push(l),
      cliCommand: [UV, "--project", CLI_SRC, "run", "crow-cli"],
      firstPort: 28000 + Math.floor(Math.random() * 2000),
      extraArgs: ["--model", MODEL, "--no-default-tool"],
    });
    endpoint = await backend.start();
  })();
  return starting;
}

async function connect(): Promise<TestClient> {
  await ensureStarted();
  const client = new TestClient(endpoint);
  await client.opened();
  clients.push(client);
  await client.request("initialize", { protocolVersion: 2, info: { name: "integration-test", version: "0" } });
  return client;
}

async function newSession(client: TestClient, tools: "none" | "exec" = "none"): Promise<{ sessionId: string; cwd: string }> {
  const cwd = tmpCwd();
  const res = await client.request("session/new", { cwd, mcpServers: mcpServers(tools) });
  return { sessionId: res.sessionId, cwd };
}

const text = (t: string) => [{ type: "text", text: t }];

afterAll(async () => {
  for (const c of clients) c.close();
  backend?.dispose();
  await sleep(300);
});

describe("real daemon from source", () => {
  test("spawns, handshakes, creates and lists a session", async () => {
    const client = await connect();
    const daemon = backend!.status().daemon as any;
    expect(daemon.running).toBe(true);
    expect(daemon.pid).toBeGreaterThan(0);
    const { sessionId, cwd } = await newSession(client);
    expect(typeof sessionId).toBe("string");
    const list = await client.request("session/list", { cwd });
    expect(list.sessions.some((s: any) => s.sessionId === sessionId)).toBe(true);
  }, 120000);

  test("prompt wrapper completes a real turn; updates reach the owner; tenants stay isolated", async () => {
    const owner = await connect();
    const caller = await connect();
    const { sessionId } = await newSession(owner);
    const idle = await newSession(caller); // second tenant, never prompted

    const result = await caller.request("_crow/backend/prompt", {
      sessionId,
      prompt: text("Reply with exactly: ok"),
    });
    expect(result).toEqual({ stopReason: "end_turn" });

    const updates = owner.frames.filter((f) => f.method === "session/update" && f.params.sessionId === sessionId);
    const states = updates.filter((u) => u.params.update.sessionUpdate === "state_update").map((u) => u.params.update.state);
    expect(states).toContain("running");
    expect(states[states.length - 1]).toBe("idle");
    expect(states.lastIndexOf("running")).toBeLessThan(states.length - 1);
    const chunks = updates.filter((u) => u.params.update.sessionUpdate === "agent_message_chunk");
    expect(chunks.length).toBeGreaterThan(0);
    const reply = chunks.map((c) => c.params.update.content?.text ?? "").join("");
    expect(reply.toLowerCase()).toContain("ok");

    const sessions = (await caller.request("_crow/backend/status")).sessions as any[];
    const byId = Object.fromEntries(sessions.map((s) => [s.sessionId, s]));
    expect(byId[sessionId]).toMatchObject({ state: "idle", stopReason: "end_turn" });
    expect(byId[idle.sessionId]).toMatchObject({ state: "idle" });
    expect(byId[idle.sessionId].stopReason).toBeUndefined();
  }, 120000);

  test("cancel stops a running turn; the session stays usable", async () => {
    const owner = await connect();
    const caller = await connect();
    const { sessionId } = await newSession(owner, "exec");

    const pending = caller.request("_crow/backend/prompt", {
      sessionId,
      prompt: text("Use the execute tool to run the shell command `sleep 67` (for example with proc run). Wait for it to finish, then reply done."),
    });
    // ground truth: the sleep process exists, so the model call is finished
    // and the turn is waiting on the tool — cancelling now leaves no
    // abandoned generation occupying the local model server
    const deadline = Date.now() + 120000;
    while (sleepPids().length === 0) {
      if (Date.now() > deadline) throw new Error("sleep 67 never started");
      await sleep(500);
    }
    console.log("sleep pids before cancel:", sleepPids().join(","));

    const ack = await caller.request("_crow/backend/cancel", { sessionId });
    expect(ack).toEqual({});
    expect(await pending).toEqual({ stopReason: "cancelled" });
    console.log("sleep pids after cancel:", sleepPids().join(",") || "(none)");

    // the session survived the cancel and takes another turn
    const result = await caller.request("_crow/backend/prompt", { sessionId, prompt: text("Reply with exactly: alive") });
    expect(result).toEqual({ stopReason: "end_turn" });
  }, 180000);

  test("orphaned session resumes on the control connection with its transcript", async () => {
    const owner = await connect();
    const caller = await connect();
    const { sessionId, cwd } = await newSession(owner);
    const first = await caller.request("_crow/backend/prompt", { sessionId, prompt: text("Reply with exactly: first") });
    expect(first).toEqual({ stopReason: "end_turn" });

    owner.close();
    await sleep(300);

    const second = await caller.request("_crow/backend/prompt", { sessionId, prompt: text("Reply with exactly: second") });
    expect(second).toEqual({ stopReason: "end_turn" });
    expect((backend!.status().control as any).connected).toBe(true);

    // a fresh webview resumes the session and gets the whole transcript back
    const fresh = await connect();
    await fresh.request("session/resume", { sessionId, cwd, replayFrom: { type: "start" } });
    await waitFor(
      () => fresh.frames.some((f) => f.method === "session/update" && f.params.update.sessionUpdate === "state_update" && f.params.update.state === "idle"),
      "replay to finish with park idle",
      30000,
    );
    const replayed = fresh.frames.filter((f) => f.method === "session/update" && f.params.sessionId === sessionId);
    const userText = replayed
      .filter((f) => f.params.update.sessionUpdate === "user_message")
      .flatMap((f) => f.params.update.content ?? [])
      .map((b: any) => b.text ?? "")
      .join("");
    expect(userText).toContain("first");
    expect(userText).toContain("second");
  }, 180000);

  test("external mode detects death of a daemon it did not spawn", async () => {
    if (!process.env.LLAMACPP_API_KEY) throw new Error("LLAMACPP_API_KEY must be set for the local model");
    const port = 30000 + Math.floor(Math.random() * 2000);
    const daemon = spawn(UV, [
      "--project", CLI_SRC, "run", "crow-cli",
      "acp2", "--http", "--host", "127.0.0.1", "--port", String(port),
      "--model", MODEL, "--no-default-tool",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const deadline = Date.now() + 60000;
      for (;;) {
        const ok = await new Promise<boolean>((resolve) => {
          const sock = net.connect(port, "127.0.0.1");
          sock.once("connect", () => { sock.destroy(); resolve(true); });
          sock.once("error", () => { sock.destroy(); resolve(false); });
        });
        if (ok) break;
        if (Date.now() > deadline) throw new Error("external daemon never became ready");
        await sleep(300);
      }
      const ext = new Backend({
        log: (l) => logs.push(l),
        cliCommand: [UV],
        firstPort: port,
        external: `ws://127.0.0.1:${port}/acp`,
      });
      const endpoint = await ext.start();
      const client = new TestClient(endpoint);
      clients.push(client);
      await client.request("initialize", { protocolVersion: 2, info: { name: "external-it", version: "0" } });
      await newSession(client);
      const st = ext.status() as any;
      // the listener is uv's python child, not uv itself
      expect(st.daemon.pid).toBeGreaterThan(0);
      expect(st.daemon.running).toBe(true);
      process.kill(st.daemon.pid, "SIGKILL");
      await waitFor(() => (ext.status() as any).daemon.running === false, "external daemon death", 5000);
      await waitFor(() => client.isClosed, "external client closed on death", 5000);
      ext.dispose();
    } finally {
      if (daemon.exitCode === null) daemon.kill("SIGKILL");
    }
  }, 120000);
});

