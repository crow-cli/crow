/**
 * The browser proof of Phase 19.5, as a check anyone can re-run.
 *
 * Everything the page needs is started here: the stub agent on a free port,
 * `dist` on another, and a headless chromium between them. Nothing reaches the
 * network and nothing reaches a model — the only thing under test is the built
 * page talking ACP v2 to an agent, in a real browser.
 *
 * `bun run web:e2e` needs `bun run web:build` to have run and a chromium
 * Playwright knows (`bunx playwright install chromium` once per machine). It is
 * deliberately not in the root gate: neither CI workflow installs browsers, so
 * a gate that needs them is a gate that only ever runs on a laptop.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { startDistServer, type DistServer } from "../dev/serve-dist";
import { startStubAgent, type StubAgent } from "../dev/stub-agent";

const DIST = resolve(import.meta.dir, "..", "dist");
if (!existsSync(resolve(DIST, "index.html"))) {
  throw new Error("packages/web/dist is not built — run `bun run web:build` before `bun run web:e2e`.");
}

const TIMEOUT = 60_000;

let agent: StubAgent;
let site: DistServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];
const pageErrors: string[] = [];

const composer = () => page.getByRole("textbox", { name: "Message input" });
const rows = () => page.locator('[data-testid="thread-row"]');
const rowTitled = (title: string) => rows().filter({ hasText: title }).first();
const replyTo = (text: string) => page.getByText(`You said: ${text}`, { exact: true });
const themeOf = () => page.evaluate(() => document.documentElement.dataset.theme);

/** Playwright's locators auto-wait on the DOM, but half of what this file
 *  asserts lives in the agent, in localStorage or in computed style, where
 *  nothing is waiting for us — so those probes get their own retry loop. */
async function waitFor<T>(
  probe: () => T | Promise<T>,
  want: (value: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + TIMEOUT;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await probe();
    if (want(last)) return last;
    await new Promise((settle) => setTimeout(settle, 100));
  }
  throw new Error(`timed out waiting for ${label} — last value ${JSON.stringify(last)}`);
}

const until = <T>(probe: () => T | Promise<T>, value: T, label = JSON.stringify(value)) =>
  waitFor(probe, (seen) => seen === value, label);

const connected = () => until(() => page.getByTestId("connection-state").textContent(), "connected");

async function prompt(text: string): Promise<void> {
  await composer().fill(text);
  await composer().press("Enter");
  await replyTo(text).waitFor({ timeout: TIMEOUT });
}

describe("the built page, as an ACP client", () => {
  beforeAll(async () => {
    agent = startStubAgent({ port: 0, delay: 10, quiet: true });
    site = startDistServer({ port: 0, quiet: true });
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.goto(`${site.url}?url=${encodeURIComponent(agent.url)}`);
    await connected();
  }, TIMEOUT);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    site?.stop();
    agent?.stop();
  }, TIMEOUT);

  test("a prompt round-trips into the thread", async () => {
    await prompt("hello from the e2e");
    // The reply is streamed in chunks; the footer proves they accumulated into
    // one assistant message and names the session that answered.
    await page.getByText("[crow stub agent - session s1 - model stub:echo]").waitFor({ timeout: TIMEOUT });
  }, TIMEOUT);

  test("the sidebar lists sessions, and switching replays their transcript", async () => {
    await rowTitled("hello from the e2e").waitFor({ timeout: TIMEOUT });
    await page.getByTestId("new-thread").click();
    await until(() => rows().count(), 2, "two session rows");
    await prompt("second transcript");

    // Back to the first thread: its transcript is not in this page any more, so
    // what appears now came out of the agent over `session/resume`.
    await rowTitled("hello from the e2e").click();
    await replyTo("hello from the e2e").waitFor({ timeout: TIMEOUT });
    await until(() => rowTitled("hello from the e2e").getAttribute("data-active"), "true");
    await until(() => replyTo("second transcript").count(), 0, "the other thread's transcript to clear");
  }, TIMEOUT);

  test("the theme toggle changes the CSS and survives a reload", async () => {
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.getByTestId("theme-toggle").click();
    await page.getByTestId("theme-option").filter({ hasText: "dark" }).click();
    await until(themeOf, "dark");
    const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(dark).not.toBe(light);

    await page.reload();
    await connected();
    await until(themeOf, "dark");
  }, TIMEOUT);

  test("a saved setting survives a reload", async () => {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("setting-cwd").fill("/tmp/crow-e2e");
    await page.getByTestId("settings-save").click();
    await until(() => page.evaluate(() => localStorage.getItem("crow-web.cwd")), "/tmp/crow-e2e");
    // Saving remounts the session, and the new directory reached the agent.
    await until(() => agent.snapshot().some((session) => session.cwd === "/tmp/crow-e2e"), true, "a session in the saved directory");

    // A bare URL: the query is gone, so storage is the only source left.
    await page.goto(site.url);
    await connected();
    await until(() => page.getByTestId("endpoint").getAttribute("title"), agent.url);
  }, TIMEOUT);

  test("the page ran without a console error", () => {
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  }, TIMEOUT);
});
