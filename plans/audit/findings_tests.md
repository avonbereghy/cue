# Tests Findings

## Summary
Pure state predicates have strong inline coverage. Serious gaps: `poll_status` pipeline stages wired together (dedup, team-idle, post-demotion sweep, compacting-floor write side, latched rescue) have only smoke coverage; the 751-line Python hook has zero automated tests; `is_recently_live` (the gate driving subagent rescue) is untested; every time-threshold is tested with comfortable margins, never at the strict boundary.

## Findings

### F-tests-001: Python `cue-hook` has zero test coverage
- **Severity:** critical
- **Confidence:** 100
- **Files:** hooks/cue-hook (751 lines, no test files anywhere in repo)
- **What:** Hook contains the canonical subagent counter, the override rules, `_quick_state_write`, `/clear` detection via transcript size, stateChangedAt carry-forward, cross-platform locking. None covered. CLAUDE.md mandates Rust unit tests but no equivalent rule for the hook even though it is the only writer of sessions.json.
- **Why it matters:** Every state Rust reasons about originates here. Regressions ship undetected.
- **Suggested fix:** Add `tests/hooks/test_cue_hook.py` importing `cue-hook` via `importlib`. Cover: counter increments/decrements, double-stop clamp, override-while-positive, waiting-not-overridden, stateChangedAt carry-forward, /clear detection, pid-is-parent-pid, quick-write preserves activeSubagents.
- **Verification:** `python -m pytest tests/hooks/ -v` runs the new suite.

### F-tests-002: `is_recently_live` (10s rescue window) has no direct test
- **Severity:** high
- **Confidence:** 95
- **Files:** cue-desktop/src-tauri/src/models.rs:190-194 (no tests)
- **What:** Drives the rescue latch at session_monitor.rs:475. Two compound conditions and `unwrap_or(false)` for `ended_at: None`. None of the branches exercised.
- **Why it matters:** Clock-skew bug silently disables entire rescue latch. Off-by-one at 10s boundary lets stale entries re-rescue.
- **Suggested fix:** Add tests in models.rs `mod tests`: returns_false_without_ended_at, returns_true_inside_window, returns_false_at_window_boundary (strict `<` semantics), returns_true_just_inside, returns_false_for_future_ended_at.
- **Verification:** `cargo test --lib is_recently_live` shows 5 passing tests.

### F-tests-003: Subagent rescue latch in `poll_status` is untested
- **Severity:** high
- **Confidence:** 92
- **Files:** cue-desktop/src-tauri/src/session_monitor.rs:459-499
- **What:** Most complex predicate in the pipeline. Has bounce-prevention via latch (`(latest_ended - already).abs() > 0.001`). No test constructs a state, runs poll twice, asserts rescue fires once.
- **Why it matters:** A regression that drops the latch insert re-rescues every poll — exactly what the latch exists to prevent.
- **Suggested fix:** Extract pure `rescue_decision(state, active_subagents, subagents, rescued_for, now) -> Option<RescueAction>`. Test: fires for fresh ended_at + live subagent, does not refire for same ended_at, fires for newer ended_at, skipped when no live subagents, skipped when active_subagents > 0, skipped for ended_at > 10s.
- **Verification:** `cargo test --lib rescue_` shows 6 new tests.

### F-tests-004: Session dedup has no test coverage
- **Severity:** high
- **Confidence:** 95
- **Files:** cue-desktop/src-tauri/src/session_monitor.rs:171-216
- **What:** Three behavioral rules (team-agent exemption, state-priority, stable-id preservation). None tested.
- **Why it matters:** Only protection against agent-team phantom startup. Regression silently merges parallel team agents, drops error/compacting visibility (cf. F-correctness-003), or breaks every per-id latch.
- **Suggested fix:** Extract `dedup_sessions(sessions, team_ids) -> Vec<SessionInfo>`. Tests: collapses same-ws within 3s, keeps team agents untouched, uses metrics cache fallback for team_name, keeps started_at > 3s apart (boundary 2.99 vs 3.01), state-priority working > idle, tie-break by last_activity, stable-id preservation.
- **Verification:** `cargo test --lib dedup_` shows 7 new tests.

### F-tests-005: Team-agent idle→done 30s promotion has no test
- **Severity:** high
- **Confidence:** 93
- **Files:** cue-desktop/src-tauri/src/session_monitor.rs:218-242
- **What:** `is_teammate && (now - last_activity) > 30.0`. Strict `>`. No coverage.
- **Why it matters:** Finished team agents linger as idle forever without this promotion.
- **Suggested fix:** Extract `promote_team_idle(session, metrics, now) -> Option<String>`. Tests: promotes after 30s (last_activity = now-30.1), holds at exact boundary (now-30.0), not promoted when not team-agent, uses metrics fallback, not promoted for non-idle.
- **Verification:** `cargo test --lib promote_team_idle` shows 5 tests.

### F-tests-006: Compacting-floor write/insert path is untested
- **Severity:** high
- **Confidence:** 90
- **Files:** cue-desktop/src-tauri/src/session_monitor.rs:418-426
- **What:** `floor_extends` predicate has 4 tests, but the imperative block USING it (insert-on-compacting / extend-by-rewriting-state / remove-when-expired) has none. A regression in the remove branch expires the floor one tick early.
- **Why it matters:** 1.5s floor is the only thing keeping the compacting dot visible for fast `/compact`s.
- **Suggested fix:** Extract `apply_compacting_floor(state, floor_until, now) -> (new_state, new_floor_until)`. Tests: inserts on compacting, extends keeps state compacting, removes when idle and expired, keeps compacting with existing floor.
- **Verification:** `cargo test --lib apply_compacting_floor` shows 4 tests.

### F-tests-007: Time-threshold boundaries (15s / 30s / 10s / 1.5s) tested only with comfortable margins
- **Severity:** high
- **Confidence:** 88
- **Files:** cue-desktop/src-tauri/src/session_monitor.rs:1505-1616, 1320-1339, 1273-1284
- **What:** Every threshold tested "well inside" and "well outside" but never AT the boundary. `<` vs `<=` regressions at exact threshold silently change behavior.
- **Why it matters:** Off-by-one regressions go uncaught.
- **Suggested fix:** Add boundary tests for stale-subagent at exactly now-15.0 (strict < → false) and now-15.001 (true); floor_extends at u == now → false; promote_decision with text_ts == prompt_ts → promote.
- **Verification:** `cargo test --lib -- boundary` shows new tests.

### F-tests-008: Subagent counter clamp / out-of-order paths in Python hook untested
- **Severity:** high
- **Confidence:** 96
- **Files:** hooks/cue-hook:632, 648-662
- **What:** `max(0, active_subs - 1)` is the ONLY guard against negative counters when stop fires without start (legal under crash-retry, lost hook). Three terminal arms reachable from clamped-zero, none tested.
- **Why it matters:** Per MEMORY.md "lead with deterministic signals" — the counter IS the deterministic signal. Regression dropping the clamp suppresses the entire subagent override.
- **Suggested fix:** As part of F-tests-001: stop without prior start (no negative), double-stop stays at zero, stop routes to working when turn not finished, stop routes to idle when turn finished, stop does not clobber waiting.
- **Verification:** `pytest tests/hooks/test_cue_hook.py::test_subagent_stop` shows 5 tests.

### F-tests-009: JSONL parser malformed.jsonl fixture exists but no test loads it
- **Severity:** high
- **Confidence:** 90
- **Files:** cue-desktop/src-tauri/tests/fixtures/malformed.jsonl (unreferenced)
- **What:** Fixture exists alongside others. No test loads it. Inline `test_malformed_line_skipped` uses a 1-line inline string. No coverage for: embedded null byte, >1MB line, valid-JSON wrong shape, UTF-8 boundary corruption, leading malformed line.
- **Why it matters:** JSONL is untrusted input. A malformed line that crashes parser empties SessionMetrics, leaves metrics_cache absent, suppresses both `should_demote_turn_ended` and `should_demote_stale_subagent` (both gate on Some(metrics)), pinning cards in working forever.
- **Suggested fix:** Add tests in jsonl_parser.rs `mod tests` loading the fixture and asserting valid entries parse / bad lines skipped. Add embedded-null, oversized-line, wrong-shape, leading-malformed cases.
- **Verification:** `cargo test --lib parse_loads_malformed` finds 5 new tests.

### F-tests-010: `test_metrics_pending_tool_use_suppresses_end_turn` leans on aggregator short-circuit
- **Severity:** high
- **Confidence:** 75
- **Files:** cue-desktop/src-tauri/src/jsonl_parser.rs:1544-1563
- **What:** Test asserts aggregator-level outcome but never the per-entry contract that a stop_reason=tool_use entry must not set `has_end_turn`. A future refactor flipping the flag still passes today; once `pending_tool_use` resolves on next poll the stale ts becomes load-bearing and `should_demote_turn_ended` fires on a working session.
- **Why it matters:** Foundation invariant of turn-ended demote path is unanchored.
- **Suggested fix:** Add `test_pending_tool_use_entry_does_not_flag_end_turn`: parse one pending entry, assert `!entries[0].has_end_turn` and `entries[0].has_pending_tool_use`.
- **Verification:** `cargo test --lib test_pending_tool_use_entry_does_not_flag_end_turn` finds the new test.

## Out of scope
- Frontend tests — outside Rust/Python target.
- Adequately covered: liveness PID-reuse + never-alive, admit_session, bypasses_launch_gate, is_liveness_sensitive, promote_decision (7 tests), models derivations.
- Medium: multiple JSONLs in same encoded-ws dir, equal-started_at sort tie-break, active_since prune wiring, entry_cache_* boundary cases.
- Post-demotion launch-gate sweep — predicate-anchored.
