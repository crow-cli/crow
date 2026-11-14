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
      firstPort: 32000 + Math.floor(Math.random() * 2000),
      extraArgs: ["--model", MODEL, "--no-default-tool"],
    });
    const endpoint = await backend.start();
    const server = http.createServer();
    attachMcp(server, backend);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    mcpUrl = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
    void endpoint;
  })();
  return starting;
}

async function connect(): Promise<TestClient> {
  await ensureStarted();
  const client = new TestClient(backend!.endpoint!);
  await client.opened();
  clients.push(client);
  await client.request("initialize", { protocolVersion: 2, info: { name: "mcp-it", version: "0" } });
  return client;
}

const text = (t: string) => [{ type: "text", text: t }];
const tmpCwd = () => fs.mkdtempSync(path.join(os.tmpdir(), "crow-mcp-it-"));

async function mcpCall(name: string, args: unknown): Promise<any> {
  const init = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "it", version: "0" } } }),
  });
  const sid = init.headers.get("mcp-session-id")!;
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json() as any;
  if (body.result?.isError) throw new Error(body.result.content[0].text);
  return JSON.parse(body.result.content[0].text);
}

afterAll(async () => {
  for (const c of clients) c.close();
  backend?.dispose();
  await sleep(300);
});

describe("coordination MCP against the real daemon", () => {
  test("crow_prompt delegates to another session and returns its final message", async () => {
    const caller = await connect();
    const worker = await connect();
    const w = await worker.request("session/new", { cwd: tmpCwd(), mcpServers: [] });
    const result = await mcpCall("crow_prompt", { sessionId: w.sessionId, prompt: "Reply with exactly: direct-ok" });
    expect(result).toMatchObject({ sessionId: w.sessionId, status: "running" });
    const deadline = Date.now() + 120000;
    for (;;) {
      const status = await mcpCall("crow_status", {});
      const row = status.sessions.find((s: any) => s.sessionId === w.sessionId);
      if (row?.state === "idle" && (row.lastAssistantMessage ?? "").toLowerCase().includes("direct-ok")) break;
      if (Date.now() > deadline) throw new Error("delegated turn never settled");
      await sleep(1500);
    }
  }, 180000);

  test("a conductor session delegates through the shim MCP and reports the answer", async () => {
    const conductor = await connect();
    const worker = await connect();
    const w = await worker.request("session/new", { cwd: tmpCwd(), mcpServers: [] });
    const c = await conductor.request("session/new", {
      cwd: tmpCwd(),
      mcpServers: [{ type: "http", name: "crow-backend", url: mcpUrl, headers: [] }],
    });
    const result = await conductor.request("_crow/backend/prompt", {
      sessionId: c.sessionId,
      prompt: text(
        `Use the crow_prompt tool with sessionId="${w.sessionId}", prompt="Reply with exactly: pong", ` +
        `and callerSessionId="${c.sessionId}". The tool returns immediately. ` +
        `When the delegation result arrives as a new prompt, reply with exactly the answer it contains.`,
      ),
    });
    expect(result).toMatchObject({ stopReason: "end_turn" });
    const deadline = Date.now() + 240000;
    for (;;) {
      const st = await mcpCall("crow_status", {});
      const row = st.sessions.find((s: any) => s.sessionId === c.sessionId);
      if ((row?.lastAssistantMessage ?? "").toLowerCase().includes("pong")) break;
      if (Date.now() > deadline) throw new Error("delegation result never reached the conductor");
      await sleep(2000);
    }
    const status = await mcpCall("crow_status", {});
    const byId = Object.fromEntries(status.sessions.map((s: any) => [s.sessionId, s]));
    expect(byId[w.sessionId].state).toBe("idle");
    expect(byId[w.sessionId].lastAssistantMessage.toLowerCase()).toContain("pong");
  }, 300000);
});
