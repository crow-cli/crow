import { describe, test, expect, afterAll } from "bun:test";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Backend } from "../../src/backend.js";
import { attachMcp } from "../../src/mcp.js";
import { TestClient, waitFor, sleep } from "../helpers.js";

const CLI_SRC = process.env.CROW_CLI_SOURCE ?? "/home/thomas/.agents/crow/src/crow-cli";
const MODEL = process.env.CROW_TEST_MODEL ?? "qwen4-max";
const UV = process.env.UV_PATH ?? "/home/thomas/.cargo/bin/uv";

const clients: TestClient[] = [];
let backend: Backend | undefined;
let mcpUrl: string;
let starting: Promise<void> | undefined;
const logs: string[] = [];

async function ensureStarted(): Promise<void> {
  starting ??= (async () => {
    backend = new Backend({
      log: (l) => logs.push(l),
      cliCommand: [UV, "--project", CLI_SRC, "run", "crow-cli"],
      firstPort: 34000 + Math.floor(Math.random() * 2000),
      extraArgs: ["--model", MODEL, "--no-default-tool"],
    });
    await backend.start();
    const server = http.createServer();
    attachMcp(server, backend);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    mcpUrl = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
  })();
  return starting;
}

async function connect(): Promise<TestClient> {
  await ensureStarted();
  const client = new TestClient(backend!.endpoint!);
  await client.opened();
  clients.push(client);
  await client.request("initialize", { protocolVersion: 2, info: { name: "loop-it", version: "0" } });
  return client;
}

const text = (t: string) => [{ type: "text", text: t }];
const tmpCwd = () => fs.mkdtempSync(path.join(os.tmpdir(), "crow-loop-it-"));

afterAll(async () => {
  for (const c of clients) c.close();
  backend?.dispose();
  await sleep(300);
});

describe("live conductor/worker loop", () => {
  test("three ping-pong cycles through the real daemon, then disarm", async () => {
    const conductorClient = await connect();
    const workerClient = await connect();
    const w = await workerClient.request("session/new", { cwd: tmpCwd(), mcpServers: [] });
    const c = await conductorClient.request("session/new", {
      cwd: tmpCwd(),
      mcpServers: [{ type: "http", name: "crow-backend", url: mcpUrl, headers: [] }],
    });
    const armed = await conductorClient.request("_crow/backend/loop/arm", {
      conductorSessionId: c.sessionId, workerSessionId: w.sessionId,
    });
    expect(armed.armed).toBe(true);

    void conductorClient.request("session/prompt", {
      sessionId: c.sessionId,
      prompt: text(
        "Call the prompt_worker tool with prompt: Reply with exactly: pong. " +
        "Do this every turn. Never answer yourself.",
      ),
    });

    const deadline = Date.now() + 780000;
    let cycles = 0;
    while (Date.now() < deadline) {
      const st = (await conductorClient.request("_crow/backend/loop/status")) as any;
      if (st.cycles > cycles) {
        cycles = st.cycles;
        console.log(`loop cycle ${cycles}, conductor=${st.conductor.state} worker=${st.worker.state}`);
      }
      if (cycles >= 3) break;
      await sleep(3000);
    }
    expect(cycles).toBeGreaterThanOrEqual(3);

    expect(await conductorClient.request("_crow/backend/loop/disarm")).toEqual({});
    const after = await conductorClient.request("_crow/backend/prompt", {
      sessionId: w.sessionId, prompt: text("Reply with exactly: still-alive"),
    });
    expect(after).toMatchObject({ stopReason: "end_turn" });
    const status = backend!.status() as any;
    const workerRow = status.sessions.find((s: any) => s.sessionId === w.sessionId);
    expect(workerRow.lastAssistantMessage.toLowerCase()).toContain("still-alive");
  }, 900000);
});
