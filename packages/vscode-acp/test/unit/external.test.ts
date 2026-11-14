import { describe, test, expect, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { makeBackend, TestClient, waitFor, sleep } from "../helpers.js";

const FAKE = path.join(import.meta.dir, "..", "fake-agent.ts");
const children: ChildProcess[] = [];

function spawnFake(): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [FAKE, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let out = "";
    const timer = setTimeout(() => reject(new Error("fake agent never listened")), 10000);
    child.stdout!.on("data", (d) => {
      out += d.toString();
      const m = /listening on (ws:\/\/\S+)/.exec(out);
      if (m) { clearTimeout(timer); resolve({ child, url: m[1] }); }
    });
    child.once("error", reject);
  });
}

afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
});

describe("external daemon mode", () => {
  test("proxies, reports the daemon pid, detects SIGKILL via pidfd", async () => {
    const { child, url } = await spawnFake();
    const { backend, start } = makeBackend({ external: url });
    await start();
    const client = new TestClient(backend.endpoint!);
    await client.request("initialize", { protocolVersion: 2, info: { name: "t", version: "0" } });
    const res = await client.request("session/new", { cwd: "/tmp" });
    expect(typeof res.sessionId).toBe("string");
    const st = backend.status() as any;
    expect(st.daemon.pid).toBe(child.pid);
    expect(st.daemon.running).toBe(true);
    child.kill("SIGKILL");
    await waitFor(() => (backend.status() as any).daemon.running === false, "external death", 3000);
    await waitFor(() => client.isClosed, "client closed on daemon death", 3000);
    backend.dispose();
  });

  test("dispose stops the watcher", async () => {
    const { child, url } = await spawnFake();
    const { backend, logs, start } = makeBackend({ external: url });
    await start();
    backend.dispose();
    const before = logs.length;
    child.kill("SIGKILL");
    await sleep(700);
    expect(logs.length).toBe(before);
  });
});
