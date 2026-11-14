import { chromium, type Frame } from "playwright";
import { execSync } from "node:child_process";
import { WebSocket } from "ws";

const IDE_URL = "http://127.0.0.1:8088/?folder=/tmp/crow-ide-test";
const browser = await chromium.launch();
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
  // The window's OWN shim: the chat frame's settings carry its proxy endpoint.
  // Scanning listening ports would grab another window's shim when several
  // IDE windows share the server.
  const settings = await frame.evaluate(() =>
    JSON.parse(document.getElementById("crow-acp-settings")!.textContent!));
  const port = Number(new URL(settings.endpoint).port);
  return await new Promise<any>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("shim status timeout")); }, 5000);
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

// 4. real prompt through the webview -> shim -> daemon; the shim's status is
// the authoritative turn-end signal (the echoed prompt is not a reply)
await chat.locator("textarea").first().fill("Reply with exactly: smoke-ok");
await chat.locator("textarea").first().press("Enter");
log("prompt sent, polling shim for turn end");
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

// 5. shim observed the turn
await page.waitForTimeout(1500);
const after = await findProxy(chat);
const sess = after.status.sessions as any[];
log("sessions after turn:", JSON.stringify(sess));
if (!sess.some((s) => s.state === "idle" && s.stopReason === "end_turn")) throw new Error("shim did not observe idle(end_turn)");


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
if (headed.stopReason !== "end_turn" || headed.sessionId !== turnSession.sessionId) throw new Error("headed turn did not settle on the target session");
await chat.locator('[data-role="user"]').getByText("Reply with exactly: headed-ok", { exact: false }).first().waitFor({ timeout: 30000 });
await chat.locator('[data-role="assistant"]').getByText("headed-ok", { exact: false }).first().waitFor({ timeout: 30000 });
log("headed prompt + reply visible in the open chat");
await page.screenshot({ path: "/tmp/smoke-headed.png" });

// 5.7 crow_prompt WITHOUT sessionId opens a NEW editor-pane chat and the
// prompt runs there, visibly.
const fresh = await mcpCall("crow_prompt", { prompt: "Reply with exactly: pane-ok" });
log("fresh-pane crow_prompt:", JSON.stringify(fresh));
if (fresh.stopReason !== "end_turn" || typeof fresh.sessionId !== "string") throw new Error("fresh visible session did not settle");
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

// 5.5 conductor/worker loop: second session over the proxy WS, arm, drive the
// conductor from the webview, observe >= 2 cycles in shim status, disarm.
function wsRequest(ws: WebSocket, method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = (d: any) => {
      const msg = JSON.parse(d.toString());
      if (msg.id !== id) return;
      ws.off("message", onMsg);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}
const workerWs = new WebSocket(`ws://127.0.0.1:${port}/acp`);
await new Promise<void>((resolve, reject) => { workerWs.once("open", resolve); workerWs.once("error", reject); });
await wsRequest(workerWs, "initialize", { protocolVersion: 2, info: { name: "smoke-worker", version: "0" } });
const workerSession = await wsRequest(workerWs, "session/new", { cwd: "/tmp/crow-ide-test", mcpServers: [] });
log("worker session:", workerSession.sessionId);
const armed = await wsRequest(workerWs, "_crow/backend/loop/arm", {
  conductorSessionId: turnSession.sessionId,
  workerSessionId: workerSession.sessionId,
});
log("loop armed:", JSON.stringify(armed));
if (!armed.armed) throw new Error("loop did not arm");

await chat.locator("textarea").first().fill(
  "Use the prompt_worker tool with prompt=\"Reply with exactly: ping-1\". " +
  "The worker's answer will arrive as a new user message (short, like ping-1). " +
  "Every time such an answer arrives, immediately call prompt_worker again with the next number: ping-2, then ping-3. " +
  "Never reply with plain text; always call prompt_worker. Do at least two rounds."
);
await chat.locator("textarea").first().press("Enter");
log("conductor prompted, polling loop cycles");
let cycles = 0;
const loopDeadline = Date.now() + 420000;
for (;;) {
  const st = await findProxy(chat);
  const loop = st.status.loop as any;
  cycles = loop?.cycles ?? 0;
  log("loop:", JSON.stringify(loop));
  if (cycles >= 2) break;
  if (Date.now() > loopDeadline) throw new Error(`loop reached only ${cycles} cycles`);
  await page.waitForTimeout(3000);
}
log("loop cycles observed:", cycles);
const stFinal = await findProxy(chat);
const workerRow = (stFinal.status.sessions as any[]).find((s) => s.sessionId === workerSession.sessionId);
log("worker last message:", JSON.stringify(workerRow?.lastAssistantMessage));
if (!workerRow?.lastAssistantMessage?.toLowerCase().includes("ping")) throw new Error("worker never answered with ping");
await page.screenshot({ path: "/tmp/smoke-loop.png" });
const disarmed = await wsRequest(workerWs, "_crow/backend/loop/disarm");
log("loop disarmed:", JSON.stringify(disarmed));
const stDisarmed = await findProxy(chat);
if ((stDisarmed.status.loop as any).armed) throw new Error("loop still armed after disarm");
workerWs.close();

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
