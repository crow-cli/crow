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

- [ ] 2.x Rust crate 2.2.0 -> 5.6.1 behavior-preserving migration (features, v1::schema/v2::schema, Option<ConnectionDriver>, Error). Gate: cargo test green.
- [ ] 3.x beta.4 adoption + alpha.7 tolerance: flat AvailableCommand shim, replay_complete, error stopReason string|object, unknown state, setup-response availableCommands, compaction status patch, paused/background. Gate: characterization tests.
- [x] 4.x TS vendored v2 types alpha.2 -> beta.4 (@agentclientprotocol/sdk 2.12.0); error stopReason in acpThreadState. Gate: typecheck + acp tests. DONE ba3d8f8: stable beta.4 types.gen.ts (ClientOptions artifact stripped), fork tolerance cast, AcpStopReason+error, reducer lifts 'agent error: …' into status.error on all three settle paths; chat typecheck clean, 110/110 tests (8 new).
- [ ] 5.1 crowAcp.server paste-able JSON settings entry (spawn|external), old settings fallback, backend keeps owning state + spawning. Gate: unit tests.
- [ ] 5.2 Red error bubble, copy-click top right, in chat webview. Gate: test + eyeball.
- [ ] 6.x Interop gate vs ../crow-cli-v2-preview daemon (alpha.7 agent, beta.4 clients). Gate: observed live runs.
- [ ] Commits with Session-Id: economic-urchin-of-easy-pleasure.

## Key interop facts

- crow-cli agent tops out at v2 alpha.7 (python-sdk ceiling): flat AvailableCommand (no type), no replay_complete, stopReason "error" as open string.
- beta.4 clients must tolerate all three; characterization tests are the gate.
