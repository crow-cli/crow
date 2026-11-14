## **DO NOT ASK USER FOR FEEDBACK — THIS IS THE USER FEEDBACK.**
## **DO NOT ASK USER FOR NEXT STEPS — THESE ARE THE NEXT STEPS.**

# PLAN — coordination backend, phases 1-3

Build/gate (run from /home/thomas/src/crow-backend/packages/vscode-acp):

    bun run build && bun run typecheck && bun test test/unit

Integration gate (real daemon from source, model qwen4-max — user directive; crow-cli config resolves the key, no env needed):

    bun test test/integration --timeout 600000

Trajectory: 1 -> 2 -> 3. Commit at each phase boundary, trailer Session-Id: impartial-gabby-mole-of-dignity.

LANES (two live streams of this session are working the sprint; coordinate here, not by guessing):
- Stream A (original turn, "Agent-3"): phase 1 commit, then src/mcp.ts transport + tools (2.2), then 2.3 integration, then phase 3.
- Stream B (goal continuation, "verification stream"): 2.1 transcript accumulation — owns test/unit/transcript.test.ts (pre-staged, skipped until implemented) and the backend.ts observation edits for it.
- Rule: stage only your own files; never commit the other lane's in-progress files; re-read PLAN.md and git status before committing. Wire-up edits to backend.ts happen after the other lane's commit lands.
- NOTE 2026-11-13 20:59 (stream A): stream B's e2e/ide-smoke.ts was declared DONE+GREEN in the CLAIM above but left untracked; stream A re-ran it (SMOKE PASS, exit 0) and committed it with attribution so no finished sprint work sits uncommitted. Stream B: nothing of yours remains uncommitted.
- REPAIR 2026-11-13 (stream B, twice): PLAN.md and TODO.md keep getting fs-read line-number prefixes (" 1→"...) written into them verbatim — it was in b61b365 AND 5cee4b3. Stripped both times; content unchanged. THIS IS NOT STREAM B DOING IT — stream B uses edit on exact strings. The corruption comes from writing fs("read") output back to disk. RULE: edit these files with the edit subtool only; if you must rewrite wholesale, strip /^\s*\d+\u2192/ from every line first and assert no \u2192 remains before writing.
- CLAIM 2026-11-13 (stream B): 3.4 e2e smoke, in packages/vscode-acp/e2e/ide-smoke.ts. Base reconstructed from memory (no dump needed, stream A) and GREEN vs the phase-2 build. Loop extension LIVE-VERIFIED: 2 cycles, exact ping-2 handoff, disarm, reload-kill, zero page errors. Only the final orphan check failed — findProxy had grabbed stream A's concurrent test daemon (port 35995); fixed to match the window's daemon port range 2771..2834. Stream A keeps 3.1-3.3.
- MODEL SERVER: superseded 2026-11-13 by user directive — live tests now use qwen4-max (remote, crow-cli config resolves credentials). The single-slot llamacpp lane constraint is GONE; parallel live runs are fine. Keep prompts trivially simple, no runaway loops. Stream B's 3.4 smoke rerun was GREEN (SMOKE PASS, 2 cycles, no orphans) on the local model before the switch.

## Phase 1 — pidfd death watcher

- [x] 1.1 src/pidfd.ts (vscode-free): watchPid(pid) spawns python3 -c helper (os.pidfd_open + select.select), fires onDeath when helper exits 0; helper exit nonzero = watch failure (pid gone -> fire death immediately if ESRCH). stop() kills helper. pidForPort(port): /proc/net/tcp listener inode -> /proc/*/fd scan.
  Verify: NEW unit tests — watch spawned `sleep 30`, SIGKILL it, onDeath < 2s; already-dead pid fires immediately; stop() leaves no helper; pidForPort finds a real listener's pid. Existing 18 unit tests stay green; typecheck green.
- [x] 1.2 Backend external mode: on start, pidForPort(endpoint port), watchPid; on death close all clients (1011), mark daemon dead in status ({pid, port, running:false}), log. Spawn mode keeps child-exit path.
  Verify: NEW unit tests — external Backend against standalone FakeAgent process, SIGKILL -> clients closed, status running:false; integration: external mode vs real source daemon, kill -9, status flips. Commit phase 1.
  DONE 2026-11-13: unit 25/25 (5 pidfd + 2 external), integration 5/5 incl. external SIGKILL death in 1.9s; build+typecheck green.

## Phase 2 — transcript accumulation + coordination MCP

- [x] 2.1 Proxy accumulates per-session assistant text (agent_message_chunk concatenation; reset when state goes running; user_message replay arrays handled). status().sessions rows gain lastAssistantMessage.
  Verify: NEW unit tests — chunked reply accumulates exactly; new turn resets; replay-shaped updates don't corrupt. Existing suites green.
  DONE 2026-11-13 (stream B): 5 transcript unit tests green (exact accumulation, reset, replay upserts, messageId boundaries, non-text blocks); full unit 30/30, build+typecheck green. A new messageId starts a new message, so the published text is the turn's LAST assistant message (phase 3 exact-match handoff).
- [x] 2.2 http.Server under the proxy WSS; MCP Streamable HTTP at /mcp: initialize, tools/list, tools/call for crow_status, crow_prompt {sessionId, prompt} -> {stopReason, message} (waits turn end, returns accumulated final assistant text), crow_cancel {sessionId}. JSON-RPC over POST, session header per MCP spec.
  Verify: NEW unit tests — real HTTP round-trips against Backend+FakeAgent: initialize handshake, tools/list names, crow_prompt returns worker's exact final text, crow_cancel stops held turn. Existing suites green.
  REVIEW (stream B): mcp.test.ts's crow_prompt test only asserts typeof message === 'string' — the criterion says EXACT final text; assert toBe('answer'). Also verify the wire-up: /mcp must answer on the PROXY port itself (2.3 proves it end-to-end).
- [x] 2.3 Integration: conductor session with shim MCP configured delegates to worker session via crow_prompt through the real daemon; result contains worker's answer; both sessions visible in shim status.
  Verify: new integration test green vs source daemon + glm-5.3-flash. Commit phase 2.
  DONE 2026-11-13 (stream A): integration 7/7 (580s) — crow_prompt returns worker's exact final message; conductor delegates through the shim MCP via the real fastmcp client (188s). Unit 37/37 incl. exact-text assertion (stream B review addressed) and /mcp-on-proxy-port wire-up test.
- [x] 2.4 Webview auto-injection of the shim MCP url (discovered scope): Backend.mcpEndpoint getter, extension settings carry it, chat webview appends the crow-backend http server unless the user config already names it.
  DONE 2026-11-13 (stream A): typecheck + build green; LIVE PROOF 20:58 — 3.4 smoke on qwen4-max: webview conductor called prompt_worker via the auto-injected crow-backend MCP server (2 cycles, exact handoff).


MODEL-SERVER LANE: obsolete — qwen4-max is remote and parallel-safe (see LANES). Stream A is running the FULL integration gate (daemon+mcp+loop) on qwen4-max; stream B may run 3.4 e2e concurrently. Loop build is in dist/ for your deploy.

## Phase 3 — conductor/worker ping-pong

- [x] 3.1 Loop state + methods: _crow/backend/loop/arm {conductorSessionId, workerSessionId}, loop/disarm, loop/status; MCP tool prompt_worker {prompt} (records the call for the conductor's current turn, prompts worker via wrapper). State: who called who, running/idle from session table, armed pair.
  Verify: unit — arm/disarm/status round-trip; prompt_worker routes to worker and is recorded; unknown session rejected.
  DONE 2026-11-13 (stream A): loop unit tests green (arm validation incl. unknown/same-session rejection, prompt_worker routing + per-turn recording); full unit 42/42.
- [x] 3.2 Auto-handoff + reprimand: worker idle(end_turn) while armed -> conductor gets worker's last assistant message via prompt wrapper; conductor idle(end_turn) with no prompt_worker that turn -> reprimand prompt ("[System reminder] you have to prompt worker..."). No ceiling; disarm/dispose stop; handoff turns don't re-trigger reprimand loops when disarmed mid-flight.
  Verify: unit over FakeAgent — >= 6 ping-pong cycles, handoff text equals worker's last message exactly, reprimand fires on tool-less conductor turn, disarm halts. Existing suites green.
  DONE 2026-11-13 (stream A): 6-cycle exact-handoff unit test, reprimand test, disarm-halts test green; full unit 42/42, build+typecheck green.
- [x] 3.3 Integration: real daemon, arm loop, >= 3 live cycles, then disarm; sessions stay usable.
  Verify: new integration test green.
  DONE 2026-11-13 (stream A): FULL integration gate 8/8 in 89s on qwen4-max — loop 3 live cycles + disarm + worker still usable (39s); daemon 5/5 incl. cancel (sleep 67 started, turn cancelled, session usable) and external SIGKILL death; mcp 2/2 incl. conductor delegating through the shim MCP via fastmcp client (10s).
- [x] 3.4 E2E: recreate smoke (kernel smoke_v2), extend — second session via proxy WS, arm loop, prompt conductor in webview, observe >= 2 cycles via shim status, reload kills daemon. Run to green vs repo-tree server (8088, grace 0).
  Verify: smoke prints SMOKE PASS; no orphan daemons after. Commit phase 3.
  DONE 2026-11-13: stream B built e2e/ide-smoke.ts and ran it GREEN on the local model (20:33, screenshots + server-log reload/dispose sequence). Stream A RE-RAN it on qwen4-max vs the committed+deployed phase-3 build (1a3c1bf): SMOKE PASS exit 0 — port cycle 2771->2772, webview turn smoke-ok observed by shim, 2 loop cycles with exact ping-2 handoff, disarm, reload killed daemon 1103016 and spawned 1103400, PAGEERRORS [], no orphans. This run also proves 2.4 live: the webview conductor called prompt_worker through the auto-injected shim MCP.

## Done

- [x] Final gate: build + typecheck + full unit + full integration green; TODO/PLAN all checked; goal_done.
  DONE 2026-11-13 (stream A): build+typecheck green (20:56), unit 42/42, integration 8/8 in 89s on qwen4-max, e2e SMOKE PASS exit 0 vs deployed 1a3c1bf. Commits: 49b833b base, b61b365 phase 1, 7331b32+5cee4b3 phase 2, 1a3c1bf phase 3 — all with Session-Id trailer.