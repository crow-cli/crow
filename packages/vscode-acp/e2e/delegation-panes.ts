import { chromium, type Frame } from "playwright";
import { WebSocket } from "ws";
import { mkdirSync, writeFileSync } from "node:fs";

// Regression: crow_prompt delegation must run the called agent in its OWN
// editor pane chat. It must never switch the sidebar (or any pane that is not
// already the called session's own) to the called session. Bug being
// regressed: webviewForSession matched on thread-list membership, and every
// client mirrors the agent's full session list, so the sidebar — registered
// first — always won and got taken over by the delegated turn.
const WORKSPACE = `/tmp/crow-ide-delegation-${Date.now()}`;
mkdirSync(`${WORKSPACE}/.vscode`, { recursive: true });
writeFileSync(`${WORKSPACE}/.vscode/settings.json`, JSON.stringify({
  "crowAcp.cliCommand": ["/home/thomas/.cargo/bin/uv", "--project", "/home/thomas/.agents/crow/src/crow-cli", "run", "crow-cli"],
  "crowAcp.port": 2771,
  "crowAcp.model": "qwen4-max",
}, null, 2));
const IDE_URL = `http://127.0.0.1:8088/?folder=${WORKSPACE}`;
const browser = await chromium.launch({ channel: "chromium" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
const log = (...a: unknown[]) => console.log("[delegation-e2e]", ...a);

async function chatFrames(): Promise<Frame[]> {
  const out: Frame[] = [];
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      if (await f.locator("textarea").first().isVisible()) out.push(f);
    } catch {}
  }
  return out;
}
async function findChatFrame(timeoutMs = 90000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = await chatFrames();
    if (frames.length) return frames[0];
    await page.waitForTimeout(1000);
  }
  throw new Error("no chat frame with a textarea");
}
async function backend(frame: Frame): Promise<any> {
  const settings = await frame.evaluate(() =>
    JSON.parse(document.getElementById("crow-acp-settings")!.textContent!));
  const port = Number(new URL(settings.endpoint).port);
  return await new Promise<any>((resolve, reject) => {
    const u = new URL(settings.endpoint); u.hostname = "127.0.0.1";
    const ws = new WebSocket(u.toString());
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("backend status timeout")); }, 5000);
    ws.on("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "_crow/backend/status" })));
    ws.on("message", (d) => {
      clearTimeout(timer);
      try { const msg = JSON.parse(d.toString()); ws.close(); resolve({ port, status: msg.result }); }
      catch (e) { ws.close(); reject(e); }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
async function palette(command: string) {
  await page.keyboard.press("Control+Shift+P");
  await page.waitForTimeout(600);
  await page.keyboard.type(command, { delay: 5 });
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
}
async function send(frame: Frame, text: string) {
  await frame.locator("textarea").first().fill(text);
  await frame.locator("textarea").first().press("Enter");
}
async function waitSession(frame: Frame, match: (s: any) => boolean, timeoutMs = 180000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { status } = await backend(frame);
    const sess = (status.sessions as any[]).find((s) => s.state === "idle" && s.stopReason === "end_turn" && match(s));
    if (sess) return sess;
    if (Date.now() > deadline) throw new Error("turn never ended");
    await page.waitForTimeout(1500);
  }
}
async function mintNew(frame: Frame, known: string[], button: ReturnType<typeof page.locator>): Promise<string> {
  await button.click();
  const deadline = Date.now() + 30000;
  for (;;) {
    const ids = ((await backend(frame)).status.sessions as any[]).map((s) => s.sessionId);
    const fresh = ids.find((id) => !known.includes(id));
    if (fresh) return fresh;
    if (Date.now() > deadline) throw new Error("New Session never minted a session");
    await page.waitForTimeout(500);
  }
}
async function mcpPrompt(port: number, args: Record<string, unknown>): Promise<any> {
  const url = `http://127.0.0.1:${port}/mcp`;
  const init = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "delegation-e2e", version: "0" } } }),
  });
  const sid = init.headers.get("mcp-session-id")!;
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "crow_prompt", arguments: args } }),
    signal: AbortSignal.timeout(180000),
  });
  const body = await res.json() as any;
  if (body.result?.isError) throw new Error(`crow_prompt: ${body.result.content[0].text}`);
  return JSON.parse(body.result.content[0].text);
}
const userText = (frame: Frame, text: string) =>
  frame.locator('[data-role="user"]').getByText(text, { exact: false });
async function findFrameWith(text: string, exclude: Frame[], timeoutMs = 60000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of await chatFrames()) {
      if (exclude.includes(f)) continue;
      try {
        if (await userText(f, text).first().isVisible()) return f;
      } catch {}
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`no pane shows ${text}`);
}

await page.goto(IDE_URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
const manage = page.locator("a:has-text('Manage')").first();
const banner = await manage.waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
if (banner) {
  await manage.click();
  const trust = page.getByText("Trust", { exact: true }).first();
  await trust.waitFor({ timeout: 15000 });
  await trust.click();
  log("workspace trusted");
  await page.waitForTimeout(5000);
}

// sidebar client with its own session
await palette("Crow ACP: Open Sidebar");
const sidebar = await findChatFrame();
await send(sidebar, "Reply with exactly: sidebar-one");
const sOne = await waitSession(sidebar, (s) => (s.lastAssistantMessage ?? "").includes("sidebar-one"));
log("sidebar session:", sOne.sessionId);

// caller editor pane with two sessions; the first ends up inactive everywhere
await palette("Crow ACP: Open Chat");
let caller: Frame | undefined;
const cDeadline = Date.now() + 30000;
while (Date.now() < cDeadline && !caller) {
  caller = (await chatFrames()).find((f) => f !== sidebar);
  if (!caller) await page.waitForTimeout(1000);
}
if (!caller) throw new Error("caller editor frame never appeared");
const editorNew = page.locator('.part.editor a.action-label[aria-label="New Session"]').first();
const e1 = await mintNew(caller, [sOne.sessionId], editorNew);
await send(caller, "Reply with exactly: editor-one");
await waitSession(caller, (s) => s.sessionId === e1 && (s.lastAssistantMessage ?? "").includes("editor-one"));
const e2 = await mintNew(caller, [sOne.sessionId, e1], editorNew);
await send(caller, "Reply with exactly: editor-two");
await waitSession(caller, (s) => s.sessionId === e2 && (s.lastAssistantMessage ?? "").includes("editor-two"));
log("caller sessions:", e1, "(inactive) and", e2, "(active)");
const { port } = await backend(caller);

// A. delegate to a session NO pane is active on: must open its OWN new pane,
// load the called transcript there, and leave sidebar + caller untouched
const a = await mcpPrompt(port, { sessionId: e1, prompt: "Reply with exactly: delegated-one", callerSessionId: e2 });
if (a.sessionId !== e1) throw new Error(`delegation returned ${a.sessionId}, expected ${e1}`);
if (await userText(sidebar, "delegated-one").count() !== 0) {
  await page.screenshot({ path: "/tmp/delegation-repro-sidebar-hijack.png" });
  throw new Error("DELEGATION TOOK OVER THE SIDEBAR");
}
if (await userText(caller, "Reply with exactly: delegated-one").count() !== 0) {
  await page.screenshot({ path: "/tmp/delegation-repro-caller-hijack.png" });
  throw new Error("delegation switched the CALLER pane to the called session");
}
const paneA = await findFrameWith("delegated-one", [sidebar, caller]);
await paneA.locator('[data-role="assistant"]').getByText("delegated-one", { exact: false }).first().waitFor({ timeout: 60000 });
if (await userText(paneA, "editor-one").count() === 0) throw new Error("delegation pane did not load the called session's transcript");
if (await userText(sidebar, "delegated-one").count() !== 0) throw new Error("DELEGATION TOOK OVER THE SIDEBAR");
if (await userText(sidebar, "sidebar-one").count() === 0) throw new Error("sidebar lost its own session");
if (await userText(caller, "Reply with exactly: delegated-one").count() !== 0) throw new Error("delegation switched the CALLER pane to the called session");
if (await userText(caller, "editor-two").count() === 0) throw new Error("caller lost its own session");
// the callee's final message travels back to the caller as a new prompt
await userText(caller, "[delegation result]").first().waitFor({ timeout: 90000 });
const delivery = await userText(caller, "[delegation result]").first().textContent();
if (!delivery?.includes("delegated-one")) throw new Error("delivery to caller missing the callee's answer");
if (!delivery?.includes(e1)) throw new Error("delivery does not name the called session");
log("A: inactive-session delegation ran in its own new pane; result delivered back to the caller");
await page.screenshot({ path: "/tmp/delegation-a-inactive.png" });

// B. delegate to the caller's ACTIVE session: runs in that pane (its own
// agent), no new pane, sidebar untouched
const before = (await chatFrames()).length;
const b = await mcpPrompt(port, { sessionId: e2, prompt: "Reply with exactly: delegated-two" });
if (b.sessionId !== e2) throw new Error(`delegation B returned ${b.sessionId}, expected ${e2}`);
if (await userText(sidebar, "delegated-two").count() !== 0) throw new Error("delegation B took over the sidebar");
await userText(caller, "delegated-two").first().waitFor({ timeout: 60000 });
await caller.locator('[data-role="assistant"]').getByText("delegated-two", { exact: false }).first().waitFor({ timeout: 60000 });
if ((await chatFrames()).length !== before) throw new Error("delegation to an active pane spawned a redundant pane");
if (await userText(sidebar, "delegated-two").count() !== 0) throw new Error("delegation B took over the sidebar");
log("B: active-session delegation ran in the called agent's own pane");

// C. no sessionId: brand-new agent in a brand-new pane, nobody else touched
const c = await mcpPrompt(port, { prompt: "Reply with exactly: delegated-fresh" });
const paneC = await findFrameWith("delegated-fresh", [sidebar, caller, paneA]);
await paneC.locator('[data-role="assistant"]').getByText("delegated-fresh", { exact: false }).first().waitFor({ timeout: 60000 });
for (const stray of ["sidebar-one", "editor-one", "editor-two", "delegated-one"]) {
  if (await userText(paneC, stray).count() !== 0) throw new Error(`fresh delegation pane shows stray history (${stray})`);
}
if (await userText(sidebar, "sidebar-one").count() === 0) throw new Error("sidebar lost its session during C");
if (await userText(caller, "editor-two").count() === 0) throw new Error("caller lost its session during C");
log("C: fresh delegation opened its own clean pane");
await page.screenshot({ path: "/tmp/delegation-c-fresh.png" });

log("PAGEERRORS:", JSON.stringify(errors));
if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
await browser.close();
log("DELEGATION PANES PASS");
