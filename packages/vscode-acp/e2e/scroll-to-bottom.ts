import { chromium, type Frame } from "playwright";
import { WebSocket } from "ws";
import { mkdirSync, writeFileSync } from "node:fs";

// The scroll-to-bottom affordance must be present, clearly visible, and
// functional in BOTH chat hosts (sidebar and editor pane). Each host gets a
// long counting reply so the viewport genuinely overflows, then we assert:
// hidden at bottom -> visible when scrolled up (solid surface, >=32px, inside
// the viewport) -> click returns to bottom -> hidden again -> repeat stable.
const WORKSPACE = `/tmp/crow-scroll-${Date.now()}`;
mkdirSync(`${WORKSPACE}/.vscode`, { recursive: true });
writeFileSync(`${WORKSPACE}/.vscode/settings.json`, JSON.stringify({
  "crowAcp.cliCommand": ["/home/thomas/.cargo/bin/uv", "--project", "/home/thomas/.agents/crow/src/crow-cli", "run", "crow-cli"],
  "crowAcp.port": 2771,
  "crowAcp.model": "qwen4-max",
}, null, 2));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
const log = (...a: unknown[]) => console.log("[scroll-e2e]", ...a);

async function frameByHost(host: string, timeoutMs = 90000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      try {
        const h = await f.evaluate(() => {
          const el = document.getElementById("crow-acp-settings");
          return el ? JSON.parse(el.textContent!).host : null;
        });
        if (h === host && await f.locator("textarea").first().isVisible()) return f;
      } catch {}
    }
    await page.waitForTimeout(800);
  }
  throw new Error("no frame for host " + host);
}

async function palette(command: string) {
  await page.keyboard.press("Control+Shift+P");
  await page.waitForTimeout(600);
  await page.keyboard.type(command, { delay: 5 });
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
}

async function sessions(frame: Frame): Promise<any[]> {
  const settings = await frame.evaluate(() =>
    JSON.parse(document.getElementById("crow-acp-settings")!.textContent!));
  const port = Number(new URL(settings.endpoint).port);
  return await new Promise<any>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("backend status timeout")); }, 5000);
    ws.on("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "_crow/backend/status" })));
    ws.on("message", (d) => {
      clearTimeout(timer);
      try { const msg = JSON.parse(d.toString()); ws.close(); resolve(msg.result.sessions); }
      catch (e) { ws.close(); reject(e); }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

const vpState = (frame: Frame) => frame.evaluate(() => {
  const vp = document.querySelector('[data-slot="aui_thread-viewport"]') as HTMLElement;
  const btn = document.querySelector(".aui-thread-scroll-to-bottom") as HTMLButtonElement | null;
  const cs = btn ? getComputedStyle(btn) : null;
  const r = btn?.getBoundingClientRect();
  const v = vp.getBoundingClientRect();
  return {
    scrollTop: vp.scrollTop, scrollHeight: vp.scrollHeight, clientHeight: vp.clientHeight,
    atBottom: vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 8,
    btn: btn && r && cs ? {
      disabled: btn.disabled, opacity: cs.opacity, visibility: cs.visibility,
      bg: cs.backgroundColor, shadow: cs.boxShadow,
      w: r.width, h: r.height,
      inside: r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom,
    } : null,
  };
});

function assertVisible(host: string, s: any) {
  if (!s.btn) throw new Error(`${host}: scroll-to-bottom button missing from DOM`);
  if (s.btn.disabled || s.btn.opacity !== "1" || s.btn.visibility === "hidden")
    throw new Error(`${host}: button not shown while scrolled up: ${JSON.stringify(s.btn)}`);
  if (s.btn.w < 32 || s.btn.h < 32)
    throw new Error(`${host}: button too small to notice: ${s.btn.w}x${s.btn.h}`);
  if (!s.btn.inside) throw new Error(`${host}: button outside the viewport: ${JSON.stringify(s.btn)}`);
  if (s.btn.bg === "rgba(0, 0, 0, 0)" || s.btn.shadow === "none")
    throw new Error(`${host}: button lacks a solid surface/shadow: ${JSON.stringify(s.btn)}`);
}

async function waitHidden(host: string, frame: Frame) {
  const deadline = Date.now() + 4000;
  for (;;) {
    const s = await vpState(frame);
    if (s.atBottom && s.btn && s.btn.disabled && s.btn.opacity === "0") return s;
    if (Date.now() > deadline)
      throw new Error(`${host}: button not hidden at bottom: ${JSON.stringify({ top: s.scrollTop, sh: s.scrollHeight, ch: s.clientHeight, btn: s.btn })}`);
    await page.waitForTimeout(200);
  }
}

async function checkHost(host: string, frame: Frame) {
  const prompts = [
    "Write a detailed essay of at least 1500 words about the history of the internet, from ARPANET to the modern web. Use many paragraphs. Do not summarize or shorten it.",
    "Count from 1 to 150. Put each number on its own line. Output nothing else.",
    "Write a detailed essay of at least 1500 words about the history of aviation, from the Wright brothers to modern jet aircraft. Use many paragraphs. Do not summarize or shorten it.",
  ];
  const snap = async () => new Map((await sessions(frame)).map((s) =>
    [s.sessionId, JSON.stringify([s.state, s.stopReason, s.lastAssistantMessage])]));
  const settledSince = async (before: Map<string, string>) =>
    (await sessions(frame)).find((s) => s.state === "idle" &&
      JSON.stringify([s.state, s.stopReason, s.lastAssistantMessage]) !== before.get(s.sessionId));

  let overflowed = false;
  let lastSnap = await snap();
  for (let attempt = 0; attempt < prompts.length && !overflowed; attempt++) {
    const before = await snap();
    const prompt = prompts[attempt];
    let sent = false;
    for (let t = 0; t < 3 && !sent; t++) {
      await frame.locator("textarea").first().fill(prompt);
      await frame.locator("textarea").first().press("Enter");
      try {
        await frame.locator('[data-role="user"]').getByText(prompt.slice(0, 40), { exact: false }).first().waitFor({ timeout: 15000 });
        sent = true;
      } catch { log(host, `send attempt ${t + 1} did not land, retrying`); }
    }
    if (!sent) throw new Error(`${host}: prompt never landed in the transcript`);
    const deadline = Date.now() + 180000;
    for (;;) {
      const st = await vpState(frame);
      if (st.scrollHeight > st.clientHeight + 150) { overflowed = true; lastSnap = before; break; }
      const done = await settledSince(before);
      if (done) { log(host, `turn settled without overflow (sh=${st.scrollHeight} ch=${st.clientHeight}, stop=${done.stopReason}), trying next prompt`); break; }
      if (Date.now() > deadline) {
        const dump = (await sessions(frame)).map((s) => ({ id: s.sessionId, state: s.state, stop: s.stopReason, msg: String(s.lastAssistantMessage ?? "").slice(0, 120) }));
        throw new Error(`${host}: turn never settled: ${JSON.stringify(dump)}`);
      }
      await page.waitForTimeout(1500);
    }
  }
  if (!overflowed) {
    const st = await vpState(frame);
    throw new Error(`${host}: transcript never overflowed after ${prompts.length} prompts (sh=${st.scrollHeight} ch=${st.clientHeight})`);
  }
  // let the reply finish so the idle-state assertions below are stable
  const settleDeadline = Date.now() + 180000;
  while (!(await settledSince(lastSnap))) {
    if (Date.now() > settleDeadline) throw new Error(`${host}: reply never finished after overflow`);
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(800);
  log(host, "overflowed and idle");

  const waitBottom = async () => {
    const deadline = Date.now() + 6000;
    for (;;) {
      const st = await vpState(frame);
      if (st.atBottom) return st;
      if (Date.now() > deadline) throw new Error(`${host}: never reached bottom: ${JSON.stringify({ top: st.scrollTop, sh: st.scrollHeight, ch: st.clientHeight })}`);
      await page.waitForTimeout(300);
    }
  };

  // Either auto-scroll pinned us to the bottom (button hidden there), or the
  // long reply outran it — then the button must be offered and must work.
  let st = await vpState(frame);
  if (!st.atBottom) {
    const pinDeadline = Date.now() + 5000;
    while (!st.atBottom && Date.now() < pinDeadline) { await page.waitForTimeout(400); st = await vpState(frame); }
  }
  if (st.atBottom) {
    await waitHidden(host, frame);
    log(host, "auto-scroll pinned to bottom; button hidden there");
  } else {
    assertVisible(host, st);
    log(host, "reply outran auto-scroll; button offered");
    await frame.locator(".aui-thread-scroll-to-bottom").click();
    await waitBottom();
    await waitHidden(host, frame);
  }

  for (let round = 1; round <= 2; round++) {
    await frame.evaluate(() => {
      (document.querySelector('[data-slot="aui_thread-viewport"]') as HTMLElement).scrollTo({ top: 0, behavior: "instant" });
    });
    const topDeadline = Date.now() + 5000;
    let up;
    for (;;) {
      up = await vpState(frame);
      if (up.scrollTop <= 40 && up.btn && !up.btn.disabled && up.btn.opacity === "1") break;
      if (Date.now() > topDeadline) throw new Error(`${host}: button never appeared after scrolling up: ${JSON.stringify(up)}`);
      await page.waitForTimeout(200);
    }
    if (up.atBottom) throw new Error(`${host}: viewport still at bottom after scrolling up`);
    assertVisible(host, up);
    if (round === 1) await page.screenshot({ path: `/tmp/scroll-bottom-${host}.png` });
    await frame.locator(".aui-thread-scroll-to-bottom").click();
    await waitBottom();
    await waitHidden(host, frame);
    log(host, `round ${round}: visible scrolled up -> click -> bottom -> hidden`);
  }
}

await page.goto(`http://127.0.0.1:8088/?folder=${WORKSPACE}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
const manage = page.locator("a:has-text('Manage')").first();
if (await manage.waitFor({ timeout: 8000 }).then(() => true).catch(() => false)) {
  await manage.click();
  const trust = page.getByText("Trust", { exact: true }).first();
  await trust.waitFor({ timeout: 15000 });
  await trust.click();
  log("workspace trusted");
  await page.waitForTimeout(5000);
}

await palette("Crow ACP: Open Sidebar");
const sidebar = await frameByHost("sidebar");
log("sidebar frame found");
await palette("Crow ACP: Open Chat");
const editor = await frameByHost("editor");
log("editor frame found");

await checkHost("sidebar", sidebar);
await checkHost("editor", editor);

log("PAGEERRORS:", JSON.stringify(errors));
if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
await browser.close();
log("SCROLL TO BOTTOM PASS (both hosts)");
