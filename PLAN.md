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

- [x] 2.1 DONE 4d96115: crate 5.6.1; features stdio, process, unstable_protocol_v2, unstable_end_turn_token_usage; dropped unstable_session_compaction (fork not called via typed Rust SDK).
- [x] 2.2 DONE 4d96115: v1::schema/v2::schema; root ErrorCode struct + consts; From<v1::Error> conversions.
- [x] 2.3 DONE 4d96115: (Channel, Option<ConnectionDriver>); non_exhaustive configs; RawJsonRpcId/RawJsonRpcResponse; raw Builder::new guard-free. Verify: cargo test -j 2 960 passed.
  Verify 2.x: cargo test green, no UX change; commit.
- [x] 3.1 DONE c60e32b: palette reads name/description raw -> typed command + flat alpha.7 both land; characterization test.
- [x] 3.2 DONE c60e32b: is_replay_complete closes window; resume-response fallback kept; test.
- [x] 3.3 DONE c60e32b (Error arm landed in 4d96115): bare word + {error:{...}} -> error; unknown/future states never idle; tests.
- [x] 3.4 DONE c60e32b: apply_setup reads availableCommands; compaction omitted-unchanged/null->in_progress; paused/background tolerated; tests. Verify: cargo test -j 2 966 passed.
- [x] 4.1 DONE ba3d8f8.
- [x] 4.2 DONE ba3d8f8.
- [x] 5.1 DONE fb23db0.
- [x] 5.2 DONE c4b8646 (eyeball at Phase 6).
- [x] 6.1/6.2 DONE: beta.4 client <-> alpha.7 agent wire proof (/tmp/interop_wire.jsonl) + real crow-agent TUI PTY spawn of worktree crow-cli acp2 (/tmp/tui_pane.txt PONG). Web e2e error bubble green 7/7 x3, /tmp/error_bubble.png red bubble + copy top right (light+dark).
- [x] 6.3 DONE: gates re-run, files marked, commits complete.
