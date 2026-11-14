import { chromium, type Frame } from "playwright";
import { WebSocket } from "ws";
import { mkdirSync, writeFileSync } from "node:fs";

// Regression: the sidebar's view/title controls must drive the SIDEBAR client
// and the editor tab's controls must drive that editor pane — never cross over
// when both are open. Bug being regressed: a single command id resolved its
// target via a focus heuristic (activeChat), so with an editor pane open every
// sidebar button mutated the editor pane instead.
const WORKSPACE = `/tmp/crow-ide-sidebar-${Date.now()}`;
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
const log = (...a: unknown[]) => console.log("[sidebar-e2e]", ...a);

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
    const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("backend status timeout")); }, 5000);
    ws.on("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "_crow/backend/status" })));
    ws.on("message", (d) => {
      clearTimeout(timer);
      try { const msg = JSON.parse(d.toString()); ws.close(); resolve(msg.result); }
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
    const status = await backend(frame);
    const sess = (status.sessions as any[]).find((s) => s.state === "idle" && s.stopReason === "end_turn" && match(s));
    if (sess) return sess;
    if (Date.now() > deadline) throw new Error("turn never ended");
    await page.waitForTimeout(1500);
  }
}

const userText = (frame: Frame, text: string) =>
  frame.locator('[data-role="user"]').getByText(text, { exact: false });

// the same view/title action renders in the composite toolbar and the section
// header; both invoke the same command, so either copy is a valid click target
const sidebarNew = page.locator('.part.sidebar a.action-label[aria-label="New Session"]').first();
const sidebarSwitch = page.locator('.part.sidebar a.action-label[aria-label="Switch Session"]').first();
const editorNew = page.locator('.part.editor a.action-label[aria-label="New Session"]').first();

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

// 1. sidebar client with its own turn
await palette("Crow ACP: Open Sidebar");
const sidebar = await findChatFrame();
log("sidebar chat frame found");
await send(sidebar, "Reply with exactly: sidebar-one");
const sOne = await waitSession(sidebar, (s) => (s.lastAssistantMessage ?? "").includes("sidebar-one"));
log("sidebar session:", sOne.sessionId);

// 2. editor pane client with its own turn; opening it makes it the active tab
await palette("Crow ACP: Open Chat");
let editor: Frame | undefined;
const edDeadline = Date.now() + 30000;
while (Date.now() < edDeadline && !editor) {
  editor = (await chatFrames()).find((f) => f !== sidebar);
  if (!editor) await page.waitForTimeout(1000);
}
if (!editor) throw new Error("editor chat frame never appeared");
// a freshly opened pane restores the latest session on connect; mint the
// pane its own session through its own control before the first turn
await editorNew.click();
let eNewId: string | undefined;
const mintDeadline = Date.now() + 30000;
while (Date.now() < mintDeadline && !eNewId) {
  const ids = ((await backend(editor)).sessions as any[]).map((s) => s.sessionId);
  eNewId = ids.find((id) => id !== sOne.sessionId);
  if (!eNewId) await page.waitForTimeout(500);
}
if (!eNewId) throw new Error("editor New Session never minted its own session");
await send(editor, "Reply with exactly: editor-one");
const eOne = await waitSession(editor, (s) => s.sessionId === eNewId && (s.lastAssistantMessage ?? "").includes("editor-one"));
log("editor session:", eOne.sessionId);
await page.screenshot({ path: "/tmp/sidebar-1-before.png" });

await sidebarNew.waitFor({ timeout: 15000 });
await sidebarSwitch.waitFor({ timeout: 15000 });
await editorNew.waitFor({ timeout: 15000 });

// 3. REGRESSION: sidebar New Session must mint the session in the SIDEBAR
const idsBefore = ((await backend(sidebar)).sessions as any[]).map((s) => s.sessionId);
await sidebarNew.click();
await page.waitForTimeout(3000);
const idsAfter = ((await backend(sidebar)).sessions as any[]).map((s) => s.sessionId);
const fresh = idsAfter.filter((id) => !idsBefore.includes(id));
if (fresh.length !== 1) throw new Error(`expected one new session, got ${JSON.stringify(fresh)}`);
if (await userText(sidebar, "sidebar-one").count() !== 0)
  throw new Error("sidebar New Session left the sidebar on its old thread (control hit another client)");
if (await userText(editor, "editor-one").count() === 0)
  throw new Error("sidebar New Session mutated the EDITOR pane (its transcript is gone)");
log("sidebar New Session minted", fresh[0], "in the sidebar; editor untouched");
await page.screenshot({ path: "/tmp/sidebar-2-after-new.png" });

// the new sidebar thread actually works
await send(sidebar, "Reply with exactly: sidebar-two");
const sTwo = await waitSession(sidebar, (s) => s.sessionId === fresh[0]);
log("sidebar two replied:", sTwo.lastAssistantMessage);
if (await userText(editor, "editor-one").count() === 0) throw new Error("editor transcript lost after sidebar turn");
if (await userText(editor, "sidebar-two").count() !== 0) throw new Error("sidebar turn leaked into the editor pane");

// 4. REGRESSION: sidebar Switch Session lists and loads SIDEBAR sessions only
await sidebarSwitch.click();
const pick = page.locator(".quick-input-widget");
await pick.waitFor({ timeout: 15000 });
// the picker mirrors the agent's whole session list (shared history); the
// regression property is WHERE the selected session loads, not list filtering
const row = pick.locator(".monaco-list-row", { hasText: sOne.sessionId }).first();
await row.waitFor({ timeout: 15000 });
await row.click();
await userText(sidebar, "sidebar-one").first().waitFor({ timeout: 30000 });
if (await userText(sidebar, "sidebar-two").count() !== 0) throw new Error("sidebar still shows session two after switching");
if (await userText(editor, "editor-one").count() === 0) throw new Error("sidebar Switch Session mutated the editor pane");
log("sidebar Switch Session loaded the sidebar's own previous session");
await page.screenshot({ path: "/tmp/sidebar-3-after-switch.png" });

// 5. editor controls still drive the editor pane, not the sidebar
await page.locator(".part.editor .tab", { hasText: "Crow ACP Chat" }).first().click();
await page.waitForTimeout(1000);
await editorNew.click();
await page.waitForTimeout(3000);
if (await userText(editor, "editor-one").count() !== 0) throw new Error("editor New Session did not reset the editor pane");
if (await userText(sidebar, "sidebar-one").count() === 0) throw new Error("editor New Session mutated the SIDEBAR");
log("editor New Session reset only the editor pane");
await page.screenshot({ path: "/tmp/sidebar-4-editor-new.png" });

log("PAGEERRORS:", JSON.stringify(errors));
if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
await browser.close();
log("SIDEBAR CONTROLS PASS");
