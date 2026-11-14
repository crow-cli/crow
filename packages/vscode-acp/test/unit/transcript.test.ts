// Phase 2.1 contract tests (PLAN 2.1 criteria): exact chunk accumulation,
// reset on running, replay-shaped upserts don't corrupt, message boundaries.
import { describe, test, expect, afterEach } from "bun:test";
import { FakeAgent } from "../fake-agent.js";
import { TestClient, makeBackend, waitFor } from "../helpers.js";

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
  cleanups.push(async () => {
    backend.dispose();
    await agent.close();
  });
  const client = new TestClient(endpoint);
  await client.opened();
  cleanups.push(() => client.close());
  const res = await client.request("session/new", { cwd: "/tmp/transcript-cwd", mcpServers: [] });
  await waitFor(() => agent.sockets.size === 1, "upstream socket");
  const sock = [...agent.sockets][0];
  return { agent, backend, client, sock, sessionId: res.sessionId as string };
}

const row = (backend: any, sessionId: string) =>
  (backend.status().sessions as any[]).find((s) => s.sessionId === sessionId);

describe("transcript accumulation", () => {
  test("chunked reply accumulates exactly into lastAssistantMessage", async () => {
    const { agent, backend, client, sock, sessionId } = await setup();
    expect(row(backend, sessionId).lastAssistantMessage).toBeFalsy();
    const pending = client.request("_crow/backend/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
    await waitFor(() => agent.framesOf("session/prompt").length === 1, "prompt forwarded");
    agent.chunk(sock, sessionId, "Hel");
    agent.chunk(sock, sessionId, "lo ");
    agent.chunk(sock, sessionId, "world");
    agent.state(sock, sessionId, "idle", "end_turn");
    expect(await pending).toMatchObject({ stopReason: "end_turn" });
    expect(row(backend, sessionId).lastAssistantMessage).toBe("Hello world");
  });

  test("a new turn resets the accumulation", async () => {
    const { agent, backend, client, sock, sessionId } = await setup();
    const p1 = client.request("_crow/backend/prompt", { sessionId, prompt: [{ type: "text", text: "one" }] });
    await waitFor(() => agent.framesOf("session/prompt").length === 1, "first prompt");
    agent.chunk(sock, sessionId, "first answer");
    agent.state(sock, sessionId, "idle", "end_turn");
    await p1;
    expect(row(backend, sessionId).lastAssistantMessage).toBe("first answer");

    const p2 = client.request("_crow/backend/prompt", { sessionId, prompt: [{ type: "text", text: "two" }] });
    await waitFor(() => agent.framesOf("session/prompt").length === 2, "second prompt");
    agent.chunk(sock, sessionId, "second");
    agent.state(sock, sessionId, "idle", "end_turn");
    await p2;
    expect(row(backend, sessionId).lastAssistantMessage).toBe("second");
  });

  test("replay-shaped updates do not corrupt the next live turn", async () => {
    const { agent, backend, client, sock, sessionId } = await setup();
    // a completed live turn
    const p1 = client.request("_crow/backend/prompt", { sessionId, prompt: [{ type: "text", text: "one" }] });
    await waitFor(() => agent.framesOf("session/prompt").length === 1, "first prompt");
    agent.chunk(sock, sessionId, "live one");
    agent.state(sock, sessionId, "idle", "end_turn");
    await p1;
    // resume-style replay: whole-message upserts with content ARRAYS
    agent.update(sock, sessionId, { sessionUpdate: "user_message", messageId: "r1", content: [{ type: "text", text: "old question" }] });
    agent.update(sock, sessionId, { sessionUpdate: "agent_message", messageId: "r2", content: [{ type: "text", text: "old answer" }] });
    agent.update(sock, sessionId, { sessionUpdate: "agent_thought_chunk", messageId: "r3", content: { type: "text", text: "hmm" } });
    // then a fresh live turn must accumulate cleanly
    const p2 = client.request("_crow/backend/prompt", { sessionId, prompt: [{ type: "text", text: "two" }] });
    await waitFor(() => agent.framesOf("session/prompt").length === 2, "second prompt");
    agent.chunk(sock, sessionId, "live ");
    agent.chunk(sock, sessionId, "two");
    agent.state(sock, sessionId, "idle", "end_turn");
    await p2;
    expect(row(backend, sessionId).lastAssistantMessage).toBe("live two");
  });

  test("a new assistant message within the turn replaces the accumulation", async () => {
    const { agent, backend, client, sock, sessionId } = await setup();
    const pending = client.request("_crow/backend/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
    await waitFor(() => agent.framesOf("session/prompt").length === 1, "prompt forwarded");
    agent.update(sock, sessionId, { sessionUpdate: "agent_message_chunk", messageId: "a", content: { type: "text", text: "thinking aloud " } });
    agent.update(sock, sessionId, { sessionUpdate: "agent_message_chunk", messageId: "b", content: { type: "text", text: "final " } });
    agent.update(sock, sessionId, { sessionUpdate: "agent_message_chunk", messageId: "b", content: { type: "text", text: "answer" } });
    agent.state(sock, sessionId, "idle", "end_turn");
    await pending;
    expect(row(backend, sessionId).lastAssistantMessage).toBe("final answer");
  });

  test("non-text chunk content is ignored, text still accumulates", async () => {
    const { agent, backend, client, sock, sessionId } = await setup();
    const pending = client.request("_crow/backend/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
    await waitFor(() => agent.framesOf("session/prompt").length === 1, "prompt forwarded");
    agent.update(sock, sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "image", data: "xxx", mimeType: "image/png" } });
    agent.chunk(sock, sessionId, "text only");
    agent.state(sock, sessionId, "idle", "end_turn");
    await pending;
    expect(row(backend, sessionId).lastAssistantMessage).toBe("text only");
  });
});
