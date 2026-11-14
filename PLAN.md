 1→## **DO NOT ASK USER FOR FEEDBACK — THIS IS THE USER FEEDBACK.**
 2→## **DO NOT ASK USER FOR NEXT STEPS — THESE ARE THE NEXT STEPS.**
 3→
 4→# PLAN — coordination backend, phases 1-3
 5→
 6→Build/gate (run from /home/thomas/src/crow-backend/packages/vscode-acp):
 7→
 8→    bun run build && bun run typecheck && bun test test/unit
 9→
10→Integration gate (real daemon from source, local model):
11→
12→    LLAMACPP_API_KEY=... bun test test/integration --timeout 120000
13→
14→Trajectory: 1 -> 2 -> 3. Commit at each phase boundary, trailer Session-Id: impartial-gabby-mole-of-dignity.

LANES (two live streams of this session are working the sprint; coordinate here, not by guessing):
- Stream A (original turn, "Agent-3"): phase 1 commit, then src/mcp.ts transport + tools (2.2), then 2.3 integration, then phase 3.
- Stream B (goal continuation, "verification stream"): 2.1 transcript accumulation — owns test/unit/transcript.test.ts (pre-staged, skipped until implemented) and the backend.ts observation edits for it.
- Rule: stage only your own files; never commit the other lane's in-progress files; re-read PLAN.md and git status before committing. Wire-up edits to backend.ts happen after the other lane's commit lands.
15→
16→## Phase 1 — pidfd death watcher
17→
18→- [x] 1.1 src/pidfd.ts (vscode-free): watchPid(pid) spawns python3 -c helper (os.pidfd_open + select.select), fires onDeath when helper exits 0; helper exit nonzero = watch failure (pid gone -> fire death immediately if ESRCH). stop() kills helper. pidForPort(port): /proc/net/tcp listener inode -> /proc/*/fd scan.
19→  Verify: NEW unit tests — watch spawned `sleep 30`, SIGKILL it, onDeath < 2s; already-dead pid fires immediately; stop() leaves no helper; pidForPort finds a real listener's pid. Existing 18 unit tests stay green; typecheck green.
20→- [x] 1.2 Backend external mode: on start, pidForPort(endpoint port), watchPid; on death close all clients (1011), mark daemon dead in status ({pid, port, running:false}), log. Spawn mode keeps child-exit path.
21→  Verify: NEW unit tests — external Backend against standalone FakeAgent process, SIGKILL -> clients closed, status running:false; integration: external mode vs real source daemon, kill -9, status flips. Commit phase 1.
  DONE 2026-11-13: unit 25/25 (5 pidfd + 2 external), integration 5/5 incl. external SIGKILL death in 1.9s; build+typecheck green.
22→
23→## Phase 2 — transcript accumulation + coordination MCP
24→
25→- [ ] 2.1 Proxy accumulates per-session assistant text (agent_message_chunk concatenation; reset when state goes running; user_message replay arrays handled). status().sessions rows gain lastAssistantMessage.
26→  Verify: NEW unit tests — chunked reply accumulates exactly; new turn resets; replay-shaped updates don't corrupt. Existing suites green.
27→- [ ] 2.2 http.Server under the proxy WSS; MCP Streamable HTTP at /mcp: initialize, tools/list, tools/call for crow_status, crow_prompt {sessionId, prompt} -> {stopReason, message} (waits turn end, returns accumulated final assistant text), crow_cancel {sessionId}. JSON-RPC over POST, session header per MCP spec.
28→  Verify: NEW unit tests — real HTTP round-trips against Backend+FakeAgent: initialize handshake, tools/list names, crow_prompt returns worker's exact final text, crow_cancel stops held turn. Existing suites green.
29→- [ ] 2.3 Integration: conductor session with shim MCP configured delegates to worker session via crow_prompt through the real daemon; result contains worker's answer; both sessions visible in shim status.
30→  Verify: new integration test green vs source daemon + glm-5.3-flash. Commit phase 2.
31→
32→## Phase 3 — conductor/worker ping-pong
33→
34→- [ ] 3.1 Loop state + methods: _crow/backend/loop/arm {conductorSessionId, workerSessionId}, loop/disarm, loop/status; MCP tool prompt_worker {prompt} (records the call for the conductor's current turn, prompts worker via wrapper). State: who called who, running/idle from session table, armed pair.
35→  Verify: unit — arm/disarm/status round-trip; prompt_worker routes to worker and is recorded; unknown session rejected.
36→- [ ] 3.2 Auto-handoff + reprimand: worker idle(end_turn) while armed -> conductor gets worker's last assistant message via prompt wrapper; conductor idle(end_turn) with no prompt_worker that turn -> reprimand prompt ("[System reminder] you have to prompt worker..."). No ceiling; disarm/dispose stop; handoff turns don't re-trigger reprimand loops when disarmed mid-flight.
37→  Verify: unit over FakeAgent — >= 6 ping-pong cycles, handoff text equals worker's last message exactly, reprimand fires on tool-less conductor turn, disarm halts. Existing suites green.
38→- [ ] 3.3 Integration: real daemon, arm loop, >= 3 live cycles with local model, then disarm; sessions stay usable.
39→  Verify: new integration test green.
40→- [ ] 3.4 E2E: recreate smoke (kernel smoke_v2), extend — second session via proxy WS, arm loop, prompt conductor in webview, observe >= 2 cycles via shim status, reload kills daemon. Run to green vs repo-tree server (8088, grace 0).
41→  Verify: smoke prints SMOKE PASS; no orphan daemons after. Commit phase 3.
42→
43→## Done
44→
45→- [ ] Final gate: build + typecheck + full unit + full integration green; TODO/PLAN all checked; goal_done.