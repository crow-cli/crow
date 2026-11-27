
import { chromium, type Frame } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { WebSocket } from "ws";
import { startStubAgent } from "../../web/dev/stub-agent";
const WT = "/home/thomas/.agents/crow/src/crow-cli-v2-preview";
const WS = `/tmp/crow-v2-spin-${Date.now()}`;
mkdirSync(`${WS}/.vscode`, { recursive: true });
const setModel = (m: string) => writeFileSync(`${WS}/.vscode/settings.json`, JSON.stringify({
  "crowAcp.server": { command: "/home/thomas/.cargo/bin/uv",
    args: ["--project", WT, "run", "crow-cli"], model: m, port: 2790 },
}, null, 2));
setModel("qwen3.8-max");
const browser = await chromium.launch({ channel: "chromium" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const log = (...a: unknown[]) => console.log("[v2-spin]", ...a);
async function chatFrame(timeoutMs = 90000): Promise<Frame> {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      try { if (await f.locator("textarea").first().isVisible()) return f; } catch {}
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("no chat frame");
}
async function proxy(frame: Frame): Promise<any> {
  const settings = await frame.evaluate(() => JSON.parse(document.getElementById("crow-acp-settings")!.textContent!));
  const u = new URL(settings.endpoint);
  u.hostname = "127.0.0.1";
  return await new Promise<any>((res, rej) => {
    const ws = new WebSocket(u.toString());
    const t = setTimeout(() => { ws.terminate(); rej(new Error("status timeout")); }, 5000);
    ws.on("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "_crow/backend/status" })));
    ws.on("message", (d) => { clearTimeout(t); const m = JSON.parse(d.toString()); ws.close(); res(m.result); });
    ws.on("error", (e) => { clearTimeout(t); rej(e); });
  });
}
async function rpc(frame: Frame, method: string, params: any): Promise<any> {
  const settings = await frame.evaluate(() => JSON.parse(document.getElementById("crow-acp-settings")!.textContent!));
  const u = new URL(settings.endpoint); u.hostname = "127.0.0.1";
  return await new Promise<any>((res, rej) => {
    const ws = new WebSocket(u.toString());
    const t = setTimeout(() => { ws.terminate(); rej(new Error("rpc timeout " + method)); }, 8000);
    let step = 0;
    ws.on("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2, info: { name: "v2-spin", version: "0" } } })));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (step === 0) { step = 1; ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method, params })); return; }
      clearTimeout(t); ws.close(); if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
    });
    ws.on("error", (e) => { clearTimeout(t); rej(e); });
  });
}
async function trustAndOpen() {
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
  const manage = page.locator("a:has-text('Manage')").first();
  if (await manage.waitFor({ timeout: 8000 }).then(() => true).catch(() => false)) {
    await manage.click();
    const trust = page.getByText("Trust", { exact: true }).first();
    await trust.waitFor({ timeout: 15000 });     await trust.click();
    await page.waitForTimeout(4000);
    const close = page.locator('a[aria-label="Close Modal Editor (Escape)"]').first();
    if (await close.isVisible().catch(() => false)) await close.click();
    else await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
  }
  await page.keyboard.press("Control+Shift+P"); await page.waitForTimeout(600);
  await page.keyboard.type("Crow ACP: Open Sidebar", { delay: 5 }); await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
}
async function turnEnd(frame: Frame, want: string, timeoutMs = 180000): Promise<any> {
  const dl = Date.now() + timeoutMs;
  for (;;) {
    const st = await proxy(frame);
    const s = (st.sessions as any[]).find((x) => x.state === "idle" && x.stopReason === want);
    if (s) return s;
    if (Date.now() > dl) throw new Error(`turn never reached idle(${want}); last=` + JSON.stringify(st.sessions));
    await page.waitForTimeout(1500);
  }
}
await page.goto(`http://127.0.0.1:8088/?folder=${WS}`, { waitUntil: "domcontentloaded" });
await trustAndOpen();
let chat = await chatFrame();
let st = await proxy(chat);
log("daemon:", JSON.stringify(st.daemon));
if (!st.daemon.running) throw new Error("daemon not running");
const cmdline = execSync(`cat /proc/${st.daemon.pid}/cmdline`).toString().replace(/\0/g, " ");
log("daemon cmdline:", cmdline);
if (!cmdline.includes("crow-cli-v2-preview")) throw new Error("daemon is not the v2-preview worktree agent");
await chat.locator("textarea").first().fill("Reply with exactly: spin-ok");
await chat.locator("textarea").first().press("Enter");
await turnEnd(chat, "end_turn");
await chat.locator('[data-role="assistant"]').getByText("spin-ok", { exact: false }).first().waitFor({ timeout: 30000 });
log("NORMAL TURN OK in real webview");
await page.screenshot({ path: "/tmp/v2_spin_reply.png" });
// error turn: bogus model through the same crowAcp.server entry
// Error turn through the shipped EXTERNAL crowAcp.server entry: the backend
// proxies a daemon that emits crow-cli's exact failed-turn shape (running ->
// "agent error: …" -> idle stopReason error). A fresh workspace = fresh backend.
const stub = startStubAgent({ port: 0, delay: 10, quiet: true });
const WS2 = `/tmp/crow-v2-spin-err-${Date.now()}`;
mkdirSync(`${WS2}/.vscode`, { recursive: true });
writeFileSync(`${WS2}/.vscode/settings.json`, JSON.stringify({
  "crowAcp.server": { endpoint: stub.url },
}, null, 2));
await page.goto(`http://127.0.0.1:8088/?folder=${WS2}`, { waitUntil: "domcontentloaded" });
await trustAndOpen();
chat = await chatFrame();
await chat.locator("textarea").first().fill("hello from the spin");
await chat.locator("textarea").first().press("Enter");
await turnEnd(chat, "end_turn");
const sid = stub.snapshot().at(-1)!.sessionId;
stub.fail(sid, "provider exploded: 404 Model not exist");
log("error turn injected on", sid);
await turnEnd(chat, "error");
const bubble = chat.locator(".aui-message-error-root");
await bubble.waitFor({ timeout: 30000 });
const btxt = await bubble.textContent();
log("ERROR BUBBLE TEXT:", btxt);
if (!btxt || !btxt.includes("provider exploded")) throw new Error("bubble missing error text");
const copy = bubble.getByRole("button", { name: "Copy error" });
await copy.waitFor({ timeout: 10000 });
log("COPY BUTTON PRESENT in real webview");
await page.screenshot({ path: "/tmp/v2_spin_error.png" });
log("ALL REAL-PRODUCT CHECKS PASS");
await browser.close();
process.exit(0);
