import { chromium, type Frame } from "playwright";
import { execSync } from "node:child_process";
import { WebSocket } from "ws";

const IDE_URL = "http://127.0.0.1:8088/?folder=/tmp/crow-ide-test";
const browser = await chromium.launch({ channel: "chromium" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
const log = (...a: unknown[]) => console.log("[smoke]", ...a);

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

async function findProxy(frame: Frame): Promise<{ port: number; status: any }> {
  // The window's OWN backend: the chat frame's settings carry its proxy endpoint.
  // Scanning listening ports would grab another window's backend when several
  // IDE windows share the server.
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
      try {
        const msg = JSON.parse(d.toString());
        ws.close();
        resolve({ port, status: msg.result });
      } catch (e) { ws.close(); reject(e); }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

await page.goto(IDE_URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".monaco-workbench", { timeout: 60000 });

// 1. trust the workspace if the banner shows (trust is browser-side in web)
const manage = page.locator("a:has-text('Manage')").first();
const banner = await manage.waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
if (banner) {
  await manage.click();
  const trust = page.getByText("Trust", { exact: true }).first();
  await trust.waitFor({ timeout: 15000 });
  await trust.click();
  log("workspace trusted");
  await page.waitForTimeout(5000);
} else {
  log("no trust banner");
}

// 2. open the Crow sidebar
await page.keyboard.press("Control+Shift+P");
await page.waitForTimeout(600);
await page.keyboard.type("Crow ACP: Open Sidebar", { delay: 5 });
await page.waitForTimeout(600);
await page.keyboard.press("Enter");
log("opened sidebar command");

// 3. chat frame + backend
let chat = await findChatFrame();
log("chat frame found:", chat.url().slice(0, 60));
const { port, status } = await findProxy(chat);
log("proxy on port", port, "daemon:", JSON.stringify(status.daemon));
if (!status.daemon.running) throw new Error("daemon not running");
if (!(status.daemon.port >= 2772 && status.daemon.port < 2771 + 64)) throw new Error(`expected port cycling past busy 2771, got ${status.daemon.port}`);
const daemonPid = status.daemon.pid as number;
const cmdline = execSync(`cat /proc/${daemonPid}/cmdline`).toString().replace(/\0/g, " ");
log("daemon cmdline:", cmdline);
if (!cmdline.includes("crow-cli")) throw new Error("daemon is not crow-cli");
await page.screenshot({ path: "/tmp/smoke-final-chat.png" });

// 4. real prompt through the webview -> backend -> daemon; the backend's status is
// the authoritative turn-end signal (the echoed prompt is not a reply)
await chat.locator("textarea").first().fill("Reply with exactly: smoke-ok");
await chat.locator("textarea").first().press("Enter");
log("prompt sent, polling backend for turn end");
let turnSession: any;
const turnDeadline = Date.now() + 180000;
for (;;) {
  const st = await findProxy(chat);
  const sess = st.status.sessions as any[];
  log("sessions:", sess.map((s) => `${s.state}:${s.stopReason ?? "-"}`).join(", "));
  turnSession = sess.find((s) => s.state === "idle" && s.stopReason === "end_turn");
  if (turnSession) break;
  if (Date.now() > turnDeadline) throw new Error("turn never ended");
  await page.waitForTimeout(1500);
}
log("turn ended:", JSON.stringify(turnSession));
await chat.locator('[data-role="assistant"]').getByText("smoke-ok", { exact: false }).first().waitFor({ timeout: 30000 });
log("assistant reply visible in chat");
await page.screenshot({ path: "/tmp/smoke-final-reply.png" });

// 5. backend observed the turn
await page.waitForTimeout(1500);
const after = await findProxy(chat);
const sess = after.status.sessions as any[];
log("sessions after turn:", JSON.stringify(sess));
if (!sess.some((s) => s.state === "idle" && s.stopReason === "end_turn")) throw new Error("backend did not observe idle(end_turn)");


// 5.6 HEADED delegation: crow_prompt must land in the VISIBLE chat. The
// prompt goes through the webview's own client (composer), appears in the
// pane as a user message, and the reply streams there — not headless.
const mcpUrl = `http://127.0.0.1:${port}/mcp`;
const mcpInit = await fetch(mcpUrl, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-headed", version: "0" } } }),
});
const mcpSid = mcpInit.headers.get("mcp-session-id")!;
const mcpCall = async (name: string, args: Record<string, unknown>) => {
  const res = await fetch(mcpUrl, {
    method: "POST", headers: { "content-type": "application/json", "mcp-session-id": mcpSid },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(180000),
  });
  const body = await res.json() as any;
  if (body.result?.isError) throw new Error(`MCP ${name}: ${body.result.content[0].text}`);
  return JSON.parse(body.result.content[0].text);
};
const headed = await mcpCall("crow_prompt", { sessionId: turnSession.sessionId, prompt: "Reply with exactly: headed-ok" });
log("headed crow_prompt:", JSON.stringify(headed));
if (headed.status !== "running" || headed.sessionId !== turnSession.sessionId) throw new Error("headed crow_prompt did not accept asynchronously");
const headedDeadline = Date.now() + 180000;
for (;;) {
  const st = await mcpCall("crow_status", {});
  const row = (st.sessions as any[]).find((s) => s.sessionId === turnSession.sessionId);
  if (row?.state === "idle" && row?.stopReason === "end_turn") break;
  if (Date.now() > headedDeadline) throw new Error("headed turn never ended");
  await page.waitForTimeout(1500);
}
// delegation to a sidebar session opens the called agent's own editor pane;
// the prompt + reply must be visible there (any chat frame, not the sidebar)
let headedFrame: Frame | undefined;
const headedVisibleDeadline = Date.now() + 30000;
while (Date.now() < headedVisibleDeadline && !headedFrame) {
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      if (await f.locator('[data-role="user"]').getByText("Reply with exactly: headed-ok", { exact: false }).first().isVisible()) { headedFrame = f; break; }
    } catch {}
  }
  if (!headedFrame) await page.waitForTimeout(1000);
}
if (!headedFrame) throw new Error("headed prompt not visible in any chat pane");
await headedFrame.locator('[data-role="assistant"]').getByText("headed-ok", { exact: false }).first().waitFor({ timeout: 60000 });
log("headed prompt + reply visible in the called agent's pane");
await page.screenshot({ path: "/tmp/smoke-headed.png" });

// 5.7 crow_prompt WITHOUT sessionId opens a NEW editor-pane chat and the
// prompt runs there, visibly.
const fresh = await mcpCall("crow_prompt", { prompt: "Reply with exactly: pane-ok" });
log("fresh-pane crow_prompt:", JSON.stringify(fresh));
if (fresh.status !== "running" || typeof fresh.sessionId !== "string") throw new Error("fresh visible session did not accept");
let paneFrame: Frame | undefined;
const paneDeadline = Date.now() + 30000;
while (Date.now() < paneDeadline && !paneFrame) {
  for (const f of page.frames()) {
    if (f === page.mainFrame() || f === chat) continue;
    try {
      if (await f.locator('[data-role="user"]').getByText("Reply with exactly: pane-ok", { exact: false }).first().isVisible()) { paneFrame = f; break; }
    } catch {}
  }
  if (!paneFrame) await page.waitForTimeout(1000);
}
if (!paneFrame) throw new Error("crow_prompt without sessionId did not open a visible editor pane");
await paneFrame.locator('[data-role="assistant"]').getByText("pane-ok", { exact: false }).first().waitFor({ timeout: 60000 });
log("fresh editor pane shows the prompt and the reply");
await page.screenshot({ path: "/tmp/smoke-headed-pane.png" });

// 5.5 conductor/worker loop: on hold while the prompt_worker tool is disabled;
// async crow_prompt delegation is covered by e2e/delegation-panes.ts.

// 6. reload window: old daemon must die, a new one must spawn
await page.keyboard.press("Control+Shift+P");
await page.waitForTimeout(600);
await page.keyboard.type("Developer: Reload Window", { delay: 5 });
await page.waitForTimeout(600);
await page.keyboard.press("Enter");
log("reloading window");
await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
const deadline = Date.now() + 30000;
while (alive(daemonPid) && Date.now() < deadline) await page.waitForTimeout(500);
if (alive(daemonPid)) throw new Error(`old daemon ${daemonPid} survived window reload`);
log("old daemon", daemonPid, "is dead");
chat = await findChatFrame();
const reborn = await findProxy(chat);
log("new daemon:", JSON.stringify(reborn.status.daemon));
if (!reborn.status.daemon.running || reborn.status.daemon.pid === daemonPid) throw new Error("no fresh daemon after reload");
await page.screenshot({ path: "/tmp/smoke-final-reload.png" });

log("PAGEERRORS:", JSON.stringify(errors));
const rebornPid = reborn.status.daemon.pid as number;
await browser.close();
// grace 0: disconnect disposes the extension host, which must kill the daemon
const orphanDeadline = Date.now() + 20000;
while (alive(rebornPid) && Date.now() < orphanDeadline) await new Promise((r) => setTimeout(r, 500));
if (alive(rebornPid)) throw new Error(`orphan daemon ${rebornPid} survived browser close`);
log("no orphan daemons");
log("SMOKE PASS");
