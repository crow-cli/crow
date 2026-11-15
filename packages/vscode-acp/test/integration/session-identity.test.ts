import { describe, test, expect, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AcpClientV2 } from "../../../aui/acp/src/AcpClientV2.js";
import { AcpThreadController } from "../../../aui/acp/src/AcpThreadController.js";

/** Regression: restore-on-connect racing an explicit switchToNewThread used to
 * interleave their reset-thread + mint/replay, leaving a pane showing a
 * transcript that belongs to a DIFFERENT session id — two sessions side by
 * side that are not forks of one another. The switch lock in
 * AcpThreadController serializes those operations; this drives the race
 * against a real daemon and asserts a pane's transcript always matches its id.
 *
 * Runs from the crow-cli source checkout, never an installed crow binary. */
const CLI_SRC = process.env.CROW_CLI_SOURCE ?? "/home/thomas/.agents/crow/src/crow-cli";
const MODEL = process.env.CROW_TEST_MODEL ?? "qwen4-max";
const UV = process.env.UV_PATH ?? "/home/thomas/.cargo/bin/uv";

let child: ReturnType<typeof spawn> | undefined;
let url: string;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crow-identity-"));
const controllers: AcpThreadController[] = [];

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
  });
}
async function waitReady(port: number): Promise<void> {
  const deadline = Date.now() + 30000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("daemon never became ready");
    const ok = await new Promise<boolean>((r) => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => { s.destroy(); r(true); });
      s.once("error", () => { s.destroy(); r(false); });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}
async function ensureDaemon(): Promise<void> {
  if (url) return;
  const port = await freePort();
  child = spawn(UV, ["--project", CLI_SRC, "run", "crow-cli", "acp2", "--http", "--host", "127.0.0.1", "--port", String(port), "--model", MODEL, "--no-default-tool"], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", () => {});
  child.stdout!.on("data", () => {});
  await waitReady(port);
  url = `ws://127.0.0.1:${port}/acp`;
}
function makeController(): AcpThreadController {
  const client = new AcpClientV2({ url, cwd });
  const ctrl = new AcpThreadController({ client, restoreOnConnect: true, autoConnect: true, permissions: "auto-allow" });
  controllers.push(ctrl);
  return ctrl;
}
function transcript(ctrl: AcpThreadController): string {
  const s = ctrl.getState();
  return s.messageOrder.map((id) => {
    const c = (s.messagesById[id] as any).content;
    return Array.isArray(c) ? c.map((b: any) => b.text ?? "").join("") : "";
  }).join("|");
}
async function prompt(ctrl: AcpThreadController, text: string): Promise<void> {
  await ctrl.append({ role: "user", content: [{ type: "text", text }], attachments: [], createdAt: new Date(), parentId: null } as any);
  const deadline = Date.now() + 60000;
  while (ctrl.getState().run.type === "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

afterAll(async () => {
  for (const c of controllers) await c.dispose().catch(() => {});
  child?.kill("SIGKILL");
});

describe("session identity under restore/switch race", () => {
  test("a pane's transcript never belongs to a different session id", async () => {
    await ensureDaemon();
    const side = makeController();
    await side.attach();
    await side.load();
    await prompt(side, "Reply with exactly: identity-sidebar");
    const sideId = side.getState().sessionId;
    expect(sideId).toBeTruthy();
    expect(transcript(side)).toContain("identity-sidebar");

    for (let i = 0; i < 10; i++) {
      const ed = makeController();
      await ed.attach();
      const loading = ed.load();                 // restore-on-connect in flight
      await new Promise((r) => setTimeout(r, i % 4));
      const switching = ed.switchToNewThread();  // race it
      await Promise.all([loading, switching]);
      await new Promise((r) => setTimeout(r, 100));
      await prompt(ed, "Reply with exactly: identity-editor");
      const edId = ed.getState().sessionId;
      const edText = transcript(ed);
      expect(edId).toBeTruthy();
      // The invariant the bug broke: a pane on a DIFFERENT session must not
      // carry the sidebar's conversation. Before the switch lock, the restore
      // replay landed inside the freshly minted session and this failed.
      if (edId !== sideId) {
        expect(edText).not.toContain("identity-sidebar");
      }
      expect(edText).toContain("identity-editor");
    }
  }, 240000);
});
