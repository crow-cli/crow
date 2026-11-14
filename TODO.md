## **DO NOT ASK USER FOR FEEDBACK — THIS IS THE USER FEEDBACK.**
## **DO NOT ASK USER FOR NEXT STEPS — THESE ARE THE NEXT STEPS.**

# TODO — crow coordination backend (worktree /home/thomas/src/crow-backend, branch acp-backend)

Base committed: 49b833b (shim + prompt/cancel wrappers, 18 unit / 4 integration green, e2e smoke green).

## Scope

- [x] pidfd process watcher for the daemon (os.pidfd_open validated in Python: pidfd readable ~0.5s after exit, works on non-child processes). Node has no pidfd API — spawn a tiny python3 stdlib helper (os.pidfd_open + select) and watch its exit. Primary consumer: external backend mode, which today has NO death detection (status().daemon is just {external: url}).
- [x] External-mode daemon identity: resolve listening pid from endpoint port via /proc/net/tcp inode -> /proc/*/fd scan (pure Node fs, no ss dependency).
- [x] Transcript accumulation in the proxy: per-session assistant text from agent_message_chunk, reset on running; last assistant message available for handoff/delegation results. (Whiteboard: backend owns state — who called who, who is running/idle, who needs prompting when X finishes.) DONE 2026-11-13: unit 30/30 incl. 5 transcript tests (stream B).
- [ ] Coordination MCP served BY the shim over HTTP (Streamable HTTP at /mcp on the proxy's http server): crow_status, crow_prompt (rlm-style delegation: prompt another session, settle on its idle, return its final assistant message), crow_cancel. Same internals as _crow/backend/*.
- [ ] Conductor/worker ping-pong on the shim: loop state (armed conductor+worker sessions, who-called-who, per-turn tool tracking), prompt_worker MCP tool, auto-handoff of worker's last assistant message to conductor on worker idle(end_turn), reprimand prompt when conductor ends a turn without prompt_worker, no iteration ceiling, disarm stops.
- [ ] Tests for all of the above: unit over FakeAgent (deterministic), integration over real source-spawned daemon + local model, e2e smoke extension for the loop.
- [ ] Commit each phase with Session-Id trailer.

## Interpretation note (derived, not asked)

"task/rlm MCP servers through the shim" = delegation tools backed by the shim's own state (crow_prompt/crow_cancel/crow_status + prompt_worker), served from the shim's HTTP endpoint — NOT crow-cli's v1 sqlite task system. mcp2's execute kernel already carries rlm ambient; the shim-side tools are what lets one IDE session drive another through the backend that owns the state.

## Environment facts (e2e)

- Repo-built server: $ROOT/packages/crow-gui/vscodium/vscode-reh-web-linux-x64/bin/crow-server, port 8088, --without-connection-token --reconnection-grace-time 0 (grace flag takes SECONDS; 0 makes reload/disconnect dispose the ext host, which kills the daemon).
- Workspace /tmp/crow-ide-test, settings: crowAcp.cliCommand = [uv, --project, /home/thomas/.agents/crow/src/crow-cli, run, crow-cli], port 2771.
- Manual daemon pid 15853 holds 2771 (prior session) -> shim must cycle to 2772.
- Trust is browser-side: Manage -> getByText("Trust", {exact:true}).
- Smoke script lives in kernel as smoke_v2 (was packages/web/e2e/ide-smoke.ts, deleted after green run; recreate to rerun).
- Integration needs LLAMACPP_API_KEY; model glm-5.3-flash; never system crow binaries, never Astra.

## Deferred (reason recorded)

- Killing tool children on ACP cancel (sleep survives cancel): crow-cli driver work, outside the shim's turn contract. Observed, not a shim bug.