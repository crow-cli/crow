## **DO NOT ASK USER FOR FEEDBACK — THIS IS THE USER FEEDBACK.**
## **DO NOT ASK USER FOR NEXT STEPS — THESE ARE THE NEXT STEPS.**

# TODO — v2-preview sprint (crow side; master in ../crow-cli-v2-preview/TODO.md)

Worktree /home/thomas/.agents/crow/src/crow-v2-preview, branch v2-preview.
Master sprint files (full scope, phases 1-6) live in
/home/thomas/.agents/crow/src/crow-cli-v2-preview/{TODO,PLAN}.md — read them
first. This file mirrors the crow-side items; mark BOTH when done.
(The previous coordination-backend sprint recorded here is complete; its
files are preserved in git history on main.)

## Scope (crow side)

- [x] 2.x Rust crate 2.2.0 -> 5.6.1 behavior-preserving migration. DONE crow 4d96115: features stdio/process/unstable_protocol_v2/unstable_end_turn_token_usage (dropped unstable_session_compaction), v1::schema/v2::schema, root ErrorCode struct, StopReason Error arm, Malformed-frame batch scan, raw Builder::new guard-free entry; profile.dev split-debuginfo=unpacked fixes the >4GiB DWARF link overflow. cargo test -j 2: 960 passed, 0 failed.
- [x] 3.x beta.4 adoption + alpha.7 tolerance. DONE crow c60e32b: replay_complete closes ReplayWindow (response fallback kept), compaction status patch (omitted unchanged / null->in_progress), setup-response availableCommands, error stopReason string|object -> error, unknown/paused/background states never settle a turn, typed+flat palette. 6 characterization tests; cargo test -j 2: 966 passed, 0 failed.
- [x] 4.x TS vendored v2 types alpha.2 -> beta.4 (@agentclientprotocol/sdk 2.12.0); error stopReason in acpThreadState. Gate: typecheck + acp tests. DONE ba3d8f8: stable beta.4 types.gen.ts (ClientOptions artifact stripped), fork tolerance cast, AcpStopReason+error, reducer lifts 'agent error: …' into status.error on all three settle paths; chat typecheck clean, 110/110 tests (8 new).
- [x] 5.1 crowAcp.server paste-able JSON settings entry (spawn|external), old settings fallback, backend keeps owning state + spawning. Gate: unit tests. DONE fb23db0: resolveServerEntry + configError seam; 6 new tests, unit 70/70, build+typecheck green.
- [x] 5.2 Red error bubble, copy-click top right, in chat webview. Gate: test + eyeball. DONE c4b8646: message-error.aui.tsx; 3 component tests, chat 113/113. Eyeball pending Phase 6.
- [ ] 6.x Interop gate vs ../crow-cli-v2-preview daemon (alpha.7 agent, beta.4 clients). Gate: observed live runs.
- [ ] Commits with Session-Id: economic-urchin-of-easy-pleasure.

## Key interop facts

- crow-cli agent tops out at v2 alpha.7 (python-sdk ceiling): flat AvailableCommand (no type), no replay_complete, stopReason "error" as open string.
- beta.4 clients must tolerate all three; characterization tests are the gate.
