## **DO NOT ASK USER FOR FEEDBACK — THIS IS THE USER FEEDBACK.**
## **DO NOT ASK USER FOR NEXT STEPS — THESE ARE THE NEXT STEPS.**

# TODO — crow coordination backend (worktree /home/thomas/src/crow-backend, branch acp-backend)

Base committed: 49b833b (shim + prompt/cancel wrappers, 18 unit / 4 integration green, e2e smoke green).

## Scope

- [x] pidfd process watcher for the daemon (os.pidfd_open validated in Python: pidfd readable ~0.5s after exit, works on non-child processes). Node has no pidfd API — spawn a tiny python3 stdlib helper (os.pidfd_open + select) and watch its exit. Primary consumer: external backend mode, which today has NO death detection (status().daemon is just {external: url}).
- [x] External-mode daemon identity: resolve listening pid from endpoint port via /proc/net/tcp inode -> /proc/*/fd scan (pure Node fs, no ss dependency).
- [x] Transcript accumulation in the proxy: per-session assistant text from agent_message_chunk, reset on running; last assistant message available for handoff/delegation results. (Whiteboard: backend owns state — who called who, who is running/idle, who needs prompting when X finishes.) DONE 2026-11-13: unit 30/30 incl. 5 transcript tests (stream B).
- [x] Coordination MCP served BY the shim over HTTP (Streamable HTTP at /mcp on the proxy's http server): crow_status, crow_prompt (rlm-style delegation: prompt another session, settle on its idle, return its final assistant message), crow_cancel. Same internals as _crow/backend/*.
- [x] Conductor/worker ping-pong on the shim: loop state (armed conductor+worker sessions, who-called-who, per-turn tool tracking), prompt_worker MCP tool, auto-handoff of worker's last assistant message to conductor on worker idle(end_turn), reprimand prompt when conductor ends a turn without prompt_worker, no iteration ceiling, disarm stops. DONE 2026-11-13: unit 42/42 (6-cycle exact handoff, reprimand, disarm), integration 8/8 on qwen4-max (3 live cycles in 39s).
- [x] Webview auto-injection of the shim MCP url (discovered scope: the proxy port is per-window, so crowAcp.mcpConfig cannot name it; extension passes mcpEndpoint, chat webview appends the crow-backend http server). Needed for the phase-3 e2e conductor.
- [x] Tests for all of the above: unit over FakeAgent (deterministic), integration over real source-spawned daemon + qwen4-max, e2e smoke extension for the loop. DONE 2026-11-13: unit 42/42, integration 8/8 (89s), e2e SMOKE PASS (e2e/ide-smoke.ts, stream B authored, stream A verified on phase-3 build).
- [x] Commit each phase with Session-Id trailer. DONE: 49b833b base, b61b365 phase 1, 7331b32 + 5cee4b3 phase 2, 1a3c1bf phase 3 (+ e2e commit).

## Interpretation note (derived, not asked)

"task/rlm MCP servers through the shim" = delegation tools backed by the shim's own state (crow_prompt/crow_cancel/crow_status + prompt_worker), served from the shim's HTTP endpoint — NOT crow-cli's v1 sqlite task system. mcp2's execute kernel already carries rlm ambient; the shim-side tools are what lets one IDE session drive another through the backend that owns the state.

## Environment facts (e2e)

- Repo-built server: $ROOT/packages/crow-gui/vscodium/vscode-reh-web-linux-x64/bin/crow-server, port 8088, --without-connection-token --reconnection-grace-time 0 (grace flag takes SECONDS; 0 makes reload/disconnect dispose the ext host, which kills the daemon).
- Workspace /tmp/crow-ide-test, settings: crowAcp.cliCommand = [uv, --project, /home/thomas/.agents/crow/src/crow-cli, run, crow-cli], port 2771.
- Manual daemon pid 15853 holds 2771 (prior session) -> shim must cycle to 2772.
- Trust is browser-side: Manage -> getByText("Trust", {exact:true}).
- Smoke script: packages/vscode-acp/e2e/ide-smoke.ts (stream B; run with `bun e2e/ide-smoke.ts` from packages/vscode-acp). SMOKE PASS on qwen4-max 2026-11-13 20:58.
- Integration model: qwen4-max (user directive 2026-11-13; crow-cli config resolves credentials, no env key needed; remote, parallel-safe). Never system crow binaries, never Astra.

## Deferred (reason recorded)

- Killing tool children on ACP cancel (sleep survives cancel): crow-cli driver work, outside the shim's turn contract. Observed, not a shim bug.