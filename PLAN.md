## **DO NOT ASK USER FOR FEEDBACK — THIS IS THE USER FEEDBACK.**
## **DO NOT ASK USER FOR NEXT STEPS — THESE ARE THE NEXT STEPS.**

# PLAN — v2-preview sprint (crow side mirror)

Master: /home/thomas/.agents/crow/src/crow-cli-v2-preview/PLAN.md (phases 1-6,
item numbers identical). Work here on phases 2-5; phase 1 is the sibling
worktree; phase 6 is both together. Mark both mirrors when an item completes.

Build/gates:
    cargo test                       # crates/crow-client
    bun run typecheck && bun test test/unit   # packages/vscode-acp
    bun test                         # packages/aui/acp (where tests live)

Trajectory: 2 -> 3 -> 4 -> 5 -> 6 (after master phase 1 lands).

- [ ] 2.1 Cargo.toml -> crate 5.6.1; features stdio, process, unstable_protocol_v2, unstable_end_turn_token_usage (+unstable_session_fork if used); drop unstable_session_compaction.
- [ ] 2.2 schema::v1 -> v1::schema, schema::v2 -> v2::schema across the 8 using files; ProtocolVersion/Error paths.
- [ ] 2.3 ConnectTo driver -> Option<ConnectionDriver>; AcpAgent config; raw response type if touched.
  Verify 2.x: cargo test green, no UX change; commit.
- [ ] 3.1 AvailableCommand union + flat-alpha.7 tolerance shim; characterization test.
- [ ] 3.2 replay_complete closes ReplayWindow; response fallback kept; tests.
- [ ] 3.3 error stopReason string|object -> transcript error; unknown state; tests.
- [ ] 3.4 setup-response availableCommands; compaction status patch; paused/background tolerance; tests.
- [ ] 4.1 Vendor beta.4 types.gen.ts (TS SDK v2.12.0); typecheck green; commit.
- [ ] 4.2 acpThreadState error stopReason -> error status + text; tolerate new updates; tests.
- [ ] 5.1 crowAcp.server paste-able entry; fallbacks; unit tests; build+typecheck green.
- [ ] 5.2 Red error bubble + copy top right in chat webview; test + eyeball.
- [ ] 6.1/6.2 Interop live runs vs sibling worktree; evidence captured.
- [ ] 6.3 Gates re-run, files marked, commits complete.
