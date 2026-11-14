import { spawn } from "node:child_process";
import * as fs from "node:fs";

const WATCHER = `import os, select, sys
try:
    fd = os.pidfd_open(int(sys.argv[1]))
except ProcessLookupError:
    sys.exit(0)
select.select([fd], [], [])
`;

export type PidWatcher = { stop(): void };

/** Death notification for any process, child or not, via a pidfd held open
 * by a python3 stdlib helper: the fd turns readable when the target exits,
 * the helper exits 0, and PID reuse cannot fool it. Exit 0 covers a target
 * that was already gone (ProcessLookupError). A nonzero helper exit is a
 * watcher failure, reported through onError — never mistaken for a death. */
export function watchPid(
  pid: number,
  onDeath: () => void,
  opts: { python?: string; onError?: (err: Error) => void } = {},
): PidWatcher {
  let stopped = false;
  let fired = false;
  const child = spawn(opts.python ?? "python3", ["-c", WATCHER, String(pid)], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (d) => { stderr += d.toString(); });
  child.once("error", (err) => { if (!stopped) opts.onError?.(err); });
  child.once("exit", (code) => {
    if (stopped || fired) return;
    if (code === 0) { fired = true; onDeath(); }
    else opts.onError?.(new Error(`pidfd watcher for ${pid} exited ${code}: ${stderr.trim()}`));
  });
  return {
    stop() {
      stopped = true;
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

/** The pid listening on a localhost TCP port, from /proc/net/tcp{,6} socket
 * inodes matched against /proc/<pid>/fd links. Undefined when nothing listens
 * or the owner is unreadable. */
export function pidForPort(port: number): number | undefined {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set<string>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== "0A") continue;
      if (f[1].split(":")[1] === hex) inodes.add(f[9]);
    }
  }
  if (inodes.size === 0) return undefined;
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let fds: string[];
    try { fds = fs.readdirSync(`/proc/${entry}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link: string;
      try { link = fs.readlinkSync(`/proc/${entry}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m && inodes.has(m[1])) return Number(entry);
    }
  }
  return undefined;
}
