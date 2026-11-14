import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import * as net from "node:net";
import { watchPid, pidForPort } from "../../src/pidfd.js";
import { waitFor, sleep } from "../helpers.js";

describe("pidfd watcher", () => {
  test("fires when the watched process is killed", async () => {
    const child = spawn("sleep", ["30"]);
    let died = false;
    const w = watchPid(child.pid!, () => { died = true; });
    await sleep(400);
    expect(died).toBe(false);
    child.kill("SIGKILL");
    await waitFor(() => died, "pidfd death", 2000);
    w.stop();
  });

  test("fires for an already-dead pid", async () => {
    const child = spawn("sleep", ["0.05"]);
    await new Promise((r) => child.once("exit", r));
    let died = false;
    const w = watchPid(child.pid!, () => { died = true; });
    await waitFor(() => died, "pidfd death of dead pid", 2000);
    w.stop();
  });

  test("stop() kills the helper and suppresses the death", async () => {
    const child = spawn("sleep", ["30"]);
    let died = false;
    const w = watchPid(child.pid!, () => { died = true; });
    await sleep(300);
    w.stop();
    child.kill("SIGKILL");
    await sleep(600);
    expect(died).toBe(false);
  });

  test("watcher failure is an error, not a death", async () => {
    let err: Error | undefined;
    let died = false;
    const w = watchPid(process.pid, () => { died = true; }, {
      python: "/nonexistent-python",
      onError: (e) => { err = e; },
    });
    await waitFor(() => err != null, "watcher error", 2000);
    expect(died).toBe(false);
    w.stop();
  });

  test("pidForPort finds the listener and loses it on close", async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    expect(pidForPort(port)).toBe(process.pid);
    await new Promise<void>((r) => server.close(() => r()));
    expect(pidForPort(port)).toBeUndefined();
  });
});
