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

## Headed coordination (user correction 2026-11-13: delegation must run THROUGH THE VISIBLE CLIENT, never headless)

The original mandate, restated by the user: MCP tools that delegate must run HEADED inside the IDE via the extension — the prompt goes through the frontend chat client, visibly. The headless control-connection path built in phases 2-3 was wrong for the product path (kept only as the test/fallback seam).

- [x] crow_prompt lands in the visible chat: ClientBridge seam (backend.ts) + extension bridge (attach binds the owning webview or opens a new editor pane; send delivers via composer.setText+send — the typed-message path). crow_prompt without sessionId opens a NEW editor-pane chat. prompt_worker + loop handoff ride the same bridge. DONE 2026-11-13: unit 47/47 incl. 5 headed tests (control connection never opened); integration 8/8; e2e SMOKE PASS with live headed proof — crow_prompt to the open window's session shows prompt+reply in that chat, crow_prompt without sessionId opens a NEW editor pane and runs there (fixed the pane's restore-on-connect hijacking the attach: send re-verifies the session and waits for composer readiness).
- [x] Editor-pane session controls (user request 2026-11-13): New Session / Switch Session / Collapse All / Settings in the editor tab title (`editor/title` menus scoped to `activeWebviewPanelId == 'crowAcp.chat'`); activeChat tracking (editor view-state + sidebar visibility) so commands drive the focused pane; chat attach waits out restore-on-connect (`connected && !isLoading`) before switching so a fresh pane can't be hijacked onto a stale transcript. DONE: e2e/editor-sessions.ts hermetic PASS, screenshots vision-verified (new session in pane, switch loads prior transcript, crow_prompt fresh pane shows only its own turn); ide-smoke re-run SMOKE PASS (2 loop cycles, reload lifecycle, no orphans).
- [x] Per-client control routing (user bug 2026-11-13: with an editor chat open, ALL sidebar controls mutated the editor pane): one command id per host resolved through a focus heuristic (activeChat) that pinned to the editor pane and never cleared on sidebar clicks. Fix: separate command sets (`crowAcp.*` sidebar, `crowAcp.editor.*` tab title, palette-hidden) resolved deterministically to the client the menus sit above; webview new-thread/switch-thread wait out restore-on-connect like the attach path so early clicks stick. Regression e2e/sidebar-controls.ts reproduced the misrouting on the old build (exit 1) and passes both directions after the fix; editor-sessions + ide-smoke re-run green; unit 47/47; screenshots vision-verified.
- [ ] Split rlm (session/fork) and task (session/new) into their own MCP servers that run headed inside the IDE via the extension — each delegation opens/forks a VISIBLE chat pane.
- [ ] MCP scheduling server: wake the agent from idle when a long-running command (real process/PID/command, NOT a subagent) finishes — rio-style notification, celery-like scheduling through the MCP. "I'm running this command and I will wake when it finishes."
- [ ] Bring crow-research back-and-forth capabilities back into the extension.
- [ ] Extension API backend for the MCP to interact with (the ClientBridge is the first piece; generalize into a proper extension API surface).

## Deferred (reason recorded)

- Killing tool children on ACP cancel (sleep survives cancel): crow-cli driver work, outside the shim's turn contract. Observed, not a shim bug.