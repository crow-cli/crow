import { chromium, type Frame } from "playwright";
import { WebSocket } from "ws";
import { mkdirSync, writeFileSync } from "node:fs";

// A unique workspace per run: session lists are per-cwd, so a fresh folder
// guarantees no persisted history can masquerade as this run's turns.
const WORKSPACE = `/tmp/crow-ide-editor-${Date.now()}`;
mkdirSync(`${WORKSPACE}/.vscode`, { recursive: true });
writeFileSync(`${WORKSPACE}/.vscode/settings.json`, JSON.stringify({
  "crowAcp.cliCommand": ["/home/thomas/.cargo/bin/uv", "--project", "/home/thomas/.agents/crow/src/crow-cli", "run", "crow-cli"],
  "crowAcp.port": 2771,
  "crowAcp.model": "qwen4-max",
}, null, 2));
const IDE_URL = `http://127.0.0.1:8088/?folder=${WORKSPACE}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
const log = (...a: unknown[]) => console.log("[editor-e2e]", ...a);

async function findChatFrame(timeoutMs = 90000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      try {
        if (await f.locator("textarea").first().isVisible()) return f;
      } catch {}
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("no chat frame with a textarea");
}

async function shim(frame: Frame): Promise<{ port: number; status: any }> {
  const settings = await frame.evaluate(() =>
    JSON.parse(document.getElementById("crow-acp-settings")!.textContent!));
  const port = Number(new URL(settings.endpoint).port);
  return await new Promise<any>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("shim status timeout")); }, 5000);
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

async function waitTurnEnd(frame: Frame, timeoutMs = 180000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { status } = await shim(frame);
    const sess = (status.sessions as any[]).find((s) => s.state === "idle" && s.stopReason === "end_turn");
    if (sess) return sess;
    if (Date.now() > deadline) throw new Error("turn never ended");
    await page.waitForTimeout(1500);
  }
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

// 1. open the EDITOR pane chat (no sidebar in this test)
await palette("Crow ACP: Open Chat");
const chat = await findChatFrame();
log("editor chat frame found");
await page.waitForTimeout(3000);
const { port } = await shim(chat);
log("shim on port", port);
await page.screenshot({ path: "/tmp/editor-1-open.png" });

// the tab title must carry the session actions
const newBtn = page.locator('a.action-label[aria-label="New Session"]').first();
const switchBtn = page.locator('a.action-label[aria-label="Switch Session"]').first();
await newBtn.waitFor({ timeout: 15000 });
await switchBtn.waitFor({ timeout: 15000 });
log("editor tab title shows New Session + Switch Session buttons");

// 2. first turn in the pane's own client
await chat.locator("textarea").first().fill("Reply with exactly: editor-one");
await chat.locator("textarea").first().press("Enter");
const one = await waitTurnEnd(chat);
log("session one:", one.sessionId, one.lastAssistantMessage);
await chat.locator('[data-role="assistant"]').getByText("editor-one", { exact: false }).first().waitFor({ timeout: 30000 });
await page.screenshot({ path: "/tmp/editor-2-first-turn.png" });

// 3. NEW SESSION via the tab title button
const idsBefore = ((await shim(chat)).status.sessions as any[]).map((s) => s.sessionId);
await newBtn.click();
await page.waitForTimeout(3000);
const st2 = await shim(chat);
const ids2 = (st2.status.sessions as any[]).map((s) => s.sessionId);
const freshIds = ids2.filter((id) => !idsBefore.includes(id));
if (freshIds.length !== 1) throw new Error(`expected exactly one new session, got ${JSON.stringify(freshIds)}`);
const twoId = freshIds[0];
log("new session minted in the pane:", twoId);
await chat.locator("textarea").first().fill("Reply with exactly: editor-two");
await chat.locator("textarea").first().press("Enter");
const deadline2 = Date.now() + 180000;
let two: any;
for (;;) {
  const { status } = await shim(chat);
  two = (status.sessions as any[]).find((s) => s.sessionId === twoId && s.state === "idle" && s.stopReason === "end_turn");
  if (two) break;
  if (Date.now() > deadline2) throw new Error("session two turn never ended");
  await page.waitForTimeout(1500);
}
log("session two replied:", two.lastAssistantMessage);
await chat.locator('[data-role="assistant"]').getByText("editor-two", { exact: false }).first().waitFor({ timeout: 30000 });
await page.screenshot({ path: "/tmp/editor-3-new-session.png" });

// 4. LOAD PREVIOUS SESSION via the tab title history button -> quick pick
await switchBtn.click();
const pick = page.locator(".quick-input-widget");
await pick.waitFor({ timeout: 15000 });
const row = pick.locator(".monaco-list-row", { hasText: one.sessionId }).first();
await row.waitFor({ timeout: 15000 });
log("quick pick lists the previous session");
await page.screenshot({ path: "/tmp/editor-4-picker.png" });
await row.click();
await chat.locator('[data-role="user"]').getByText("Reply with exactly: editor-one", { exact: false }).first().waitFor({ timeout: 30000 });
const twoGone = await chat.locator('[data-role="user"]').getByText("Reply with exactly: editor-two", { exact: false }).count();
if (twoGone !== 0) throw new Error("pane still shows session two after switching to one");
log("pane loaded session one's transcript");
await page.screenshot({ path: "/tmp/editor-5-loaded.png" });

// 5. headed crow_prompt without sessionId opens ANOTHER visible pane with a
// clean single-turn transcript (fresh workspace, no persisted history)
const mcpUrl = `http://127.0.0.1:${port}/mcp`;
const init = await fetch(mcpUrl, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "editor-e2e", version: "0" } } }),
});
const mcpSid = init.headers.get("mcp-session-id")!;
const res = await fetch(mcpUrl, {
  method: "POST", headers: { "content-type": "application/json", "mcp-session-id": mcpSid },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "crow_prompt", arguments: { prompt: "Reply with exactly: pane-fresh" } } }),
  signal: AbortSignal.timeout(180000),
});
const body = await res.json() as any;
if (body.result?.isError) throw new Error(`crow_prompt: ${body.result.content[0].text}`);
const fresh = JSON.parse(body.result.content[0].text);
log("fresh pane session:", JSON.stringify(fresh));
let paneFrame: Frame | undefined;
const paneDeadline = Date.now() + 30000;
while (Date.now() < paneDeadline && !paneFrame) {
  for (const f of page.frames()) {
    if (f === page.mainFrame() || f === chat) continue;
    try {
      if (await f.locator('[data-role="user"]').getByText("Reply with exactly: pane-fresh", { exact: false }).first().isVisible()) { paneFrame = f; break; }
    } catch {}
  }
  if (!paneFrame) await page.waitForTimeout(1000);
}
if (!paneFrame) throw new Error("no second visible pane for the fresh session");
await paneFrame.locator('[data-role="assistant"]').getByText("pane-fresh", { exact: false }).first().waitFor({ timeout: 60000 });
for (const strayText of ["editor-one", "editor-two"]) {
  const stray = await paneFrame.locator('[data-role="user"]').getByText(strayText, { exact: false }).count();
  if (stray !== 0) throw new Error(`fresh pane shows another session's history (${strayText})`);
}
log("second editor pane shows ONLY the fresh prompt + reply");
await page.screenshot({ path: "/tmp/editor-6-fresh-pane.png" });

log("PAGEERRORS:", JSON.stringify(errors));
if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
await browser.close();
log("EDITOR SESSIONS PASS");
