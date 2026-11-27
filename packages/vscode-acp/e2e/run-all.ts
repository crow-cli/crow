import { spawnSync } from "node:child_process";

// Playwright gate: every suite drives the real repo-built REH server on 8088
// (--without-connection-token --reconnection-grace-time 0) with a hermetic
// workspace and source-spawned daemons on qwen4-max. Start the server first
// (see PLAN.md); each suite is independent and order-free.
const SUITES = ["sidebar-controls", "editor-sessions", "delegation-panes", "ide-smoke", "scroll-to-bottom", "error-bubble"];
const probe = await fetch("http://127.0.0.1:8088/").catch(() => undefined);
if (!probe) {
  console.error("[e2e] REH server not reachable on 127.0.0.1:8088 — start it first (PLAN.md gate)");
  process.exit(1);
}
let failed = 0;
for (const suite of SUITES) {
  console.log(`[e2e] === ${suite} ===`);
  const r = spawnSync("bun", [`e2e/${suite}.ts`], { stdio: "inherit", cwd: `${import.meta.dir}/..` });
  if (r.status === 0) console.log(`[e2e] PASS ${suite}`);
  else { failed++; console.error(`[e2e] FAIL ${suite} (exit ${r.status})`); }
}
console.log(failed ? `[e2e] ${failed}/${SUITES.length} suites failed` : `[e2e] ALL ${SUITES.length} SUITES PASS`);
process.exit(failed ? 1 : 0);
