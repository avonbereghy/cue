# Tests Findings

## Summary
Both suites pass clean: 374 Rust unit tests (1 `#[ignore]` — a documented live-`claude`-binary smoke test, intentional) and 80 Python hook tests, no skips/xfails. The pure state predicates (`should_resolve_waiting`, `should_demote_stalled_turn`, `resolve_liveness`, `should_demote_turn_ended`, `is_promotable_to_waiting`) are each well unit-tested, and the Python hook side is strong. The systemic gap is at the **orchestration boundary**: `poll_status` — which wires the JSONL signals into the four demote/promote passes in a specific order — has only a no-crash smoke test, so the freshly-restored permission-prompt `waiting` path (the exact behavior the `cd2a32b` regression broke) is locked only at the predicate level, never end-to-end, and several new error-recovery arms are completely untested.

## Findings

### F-tests-001: Permission-prompt `waiting` survival is locked only as a pure predicate, never through `poll_status` — the regression that already shipped could recur via a wiring change
- **Severity:** high
- **Confidence:** 85
- **Files:** cue-desktop/src-tauri/src/session_monitor.rs:504-575 (waiting promote/resolve arm), :1269 (`should_resolve_waiting`), :1811-1818 (`test_poll_status_no_crash` — the only `poll_status` test)
- **What:** The dual-source waiting fix gates the demote on `should_resolve_waiting(awaiting, pending) = !awaiting && !pending`. The pure predicate is tested (`test_resolve_waiting_holds_open_permission_prompt` etc.), but nothing exercises `poll_status` with a seeded `state="waiting"` session whose `metrics_cache` carries `pending_tool_use=true, awaiting_user_prompt=false`. `metrics_cache` is private and never pre-populated by a test. The `cd2a32b` regression was exactly a wiring error in this arm (demoting on `!awaiting` alone); the same class of mistake — reading the wrong flag, inverting the gate, or reordering passes so a later pass stomps the seed — would NOT be caught. `test_poll_status_no_crash` only asserts "does not panic".
- **Why it matters:** This is the most common Claude Code block ("Allow Bash?"). A regression here reships the user-visible "permission prompt shows as `working`" bug, and the predicate-only test gives false confidence it's locked.
- **Suggested fix:** Add an end-to-end test driving `poll_status` via a testable seam (e.g. extract `poll_status_at(status_path, projects_path)`): write a fixture sessions.json with one `state:"waiting"` session + a transcript whose tail is an unresolved tool_use (real parser yields `pending=true, awaiting=false`); assert it stays `"waiting"`. Append the matching `tool_result`, re-poll, assert `"idle"`. Mirror case for `AskUserQuestion` → answer → `idle`.
- **Verification:** Temporarily revert the gate to the old `should_resolve_waiting(_,_) = !awaiting` form — the new integration test must FAIL (card demotes while `pending=true`); restore and it passes. Existing predicate tests pass under both, proving they don't cover this.

### F-tests-002: `pending_tool_use` clearing on `tool_result` arrival — the demote signal for permission prompts — is never asserted at the parser level
- **Severity:** high
- **Confidence:** 80
- **Files:** cue-desktop/src-tauri/src/jsonl_parser.rs:1068-1082 (backward scan: `if entry.is_tool_result { break }` then `m.pending_tool_use=true`)
- **What:** Every `assert!(!m.pending_tool_use)` in the suite reaches false via end_turn or no-tool paths. No test feeds the canonical resolve sequence `assistant(tool_use id=X) → user(tool_result tool_use_id=X)` and asserts `pending_tool_use == false`. That `break` on `is_tool_result` is the exact mechanism demoting a permission-prompt `waiting` card the instant approval lands. `test_tool_result_user_entry_not_counted` only checks the entry isn't a user prompt — it never builds metrics.
- **Why it matters:** A refactor of the backward scan that changed the `break`/`pending` interplay would pin permission cards on `waiting` forever after approval with no failing test. This is the resolve half of the permission-prompt seed→resolve pair.
- **Suggested fix:** Add `test_pending_tool_use_clears_when_tool_result_lands` (tool_use then matching tool_result → assert `!pending_tool_use`) and the negative twin `test_pending_tool_use_set_when_tool_result_for_other_id` (parallel tool: result for a different id → assert `pending_tool_use` stays true).
- **Verification:** Change line 1070 `if entry.is_tool_result { break }` to `if false { break }` — the new test must fail; revert.

### F-tests-003: `poll_status` read-error and parse-failure recovery arms (repair threshold, transient-grace, FileTooLarge) are entirely untested
- **Severity:** high
- **Confidence:** 82
- **Files:** cue-desktop/src-tauri/src/session_monitor.rs:158-262 (parse-failure counter :177, FileTooLarge arm :224, read-failure transient-grace counter :235)
- **What:** `poll_status` reads the hardcoded `paths::sessions_json_path()` with no injection seam, so its error branches can't be hit by a test. Untested: (a) `REPAIR_THRESHOLD=5` parse-failure counter that holds prior state then renames-aside; (b) the new read-failure transient-grace arm whose comment says it was added to stop a "one-frame 0 sessions flash" (a prior regression fix with no lock); (c) the `FileTooLarge` arm that must KEEP prior state, not clear. `read_to_string_bounded` is unit-tested but the consumer's reaction to each outcome is not; `consecutive_parse_failures` is private and never observed.
- **Why it matters:** Reverting the transient-grace arm to "clear on first read error" reintroduces the UI flash silently; inverting the FileTooLarge arm to clear blanks every card on a bloated file silently.
- **Suggested fix:** Extract `poll_status_at(&self, status_path, projects_path)`; add `test_poll_keeps_prior_state_on_transient_read_error` (missing path, poll < threshold preserves, past threshold clears), `test_poll_keeps_prior_state_on_parse_failure` (malformed JSON, `.corrupt-*` rename only after threshold), `test_poll_keeps_prior_state_on_oversized_file` (>4 MiB file, list unchanged, NOT cleared).
- **Verification:** Make the FileTooLarge arm fall through to clear — the oversized test fails; revert. Make the read-error arm clear on first failure — the transient test fails; revert.

### F-tests-004: No cross-language schema-contract test — a hook-written sessions.json is never round-tripped through the Rust `StatusData`/`SessionInfo` serde structs
- **Severity:** high
- **Confidence:** 78
- **Files:** cue-desktop/src-tauri/src/models.rs:12-83 (`SessionInfo` with `rename_all="camelCase"` + renames `inputTokens`/`outputTokens`/`model`; `StatusData`), hooks/cue-hook:278-307 and :928-942 (the entry dicts the hook writes)
- **What:** The hook writes camelCase keys (`stateChangedAt`, `lastActivity`, `inputTokens`, `activeSubagents`, `permissionMode`, `errorType`, `pid`); Rust maps them via serde rename. No test constructs a hook-shaped JSON and asserts it deserializes into `StatusData` with correct values. `SessionInfo` has no `deny_unknown_fields` and most fields are `#[serde(default)]`, so a rename drift silently deserializes to the default and is invisible. Existing serde tests (models.rs:1325/1355) cover `PermissionRequest`/`PermissionLogEntry`, not the session entry.
- **Why it matters:** Python-writes/Rust-reads is the highest-leverage contract in the app, exercised every poll. A camelCase/snake_case mismatch on a load-bearing field (`stateChangedAt` → active-duration timer + turn-ended demote, or `pid` → liveness) degrades silently with zero failing tests, despite CLAUDE.md mandating both sides conform.
- **Suggested fix:** Add Rust `test_hook_written_sessions_json_round_trips` embedding a realistic full-field entry, asserting `from_str::<StatusData>` yields the right `state`, `state_changed_at`, `hook_input_tokens`, `active_subagents`, `permission_mode`, `error_type`, `pid`. Optionally check in a golden `fixtures/sessions.golden.json` loaded by both a Python reader test and the Rust test so one file locks both ends.
- **Verification:** Remove `#[serde(rename="inputTokens")]` (models.rs:32) — the round-trip test must fail (field reads 0); revert. Rename a key in the embedded JSON to snake_case — it must fail.

## Out of scope
- **Brittleness:** no real `thread::sleep`, no wall-clock `now()` inside Rust predicate tests (all inject `now`), no HashMap-order assertions. Python tests use `time.time()` relative offsets with ≥60 s grace windows — deterministic, not flaky.
- **`#[ignore]`:** `model_context.rs:781 live_binary_resolves_opus_4_8_to_1m` is correctly ignored (needs a real `claude` binary), documented, run via `--ignored`.
- **Sidechain filter (LOW):** `test_sidechain_entries_do_not_corrupt_main_state` (jsonl_parser.rs:2173) covers the full-parse path; the same `isSidechain` drop in `parse_jsonl_to_session_metrics_cached` (incremental) isn't separately asserted. Below the HIGH floor — single shared function.
- **Predicate coverage is genuinely strong** (not flagged): `should_demote_stalled_turn` (7 tests), `should_resolve_waiting` (3), `resolve_liveness` (pid-reuse/gone/name-match), `should_demote_stuck_active` (compacting-only 60 s), `should_demote_turn_ended` incl. waiting-extension, and Python subagent counter balance (increment/decrement/clamp/no-negative/preserve-waiting). The gap is exclusively the untested seam composing these inside `poll_status`.
- **Deprecated field (LOW):** `SessionInfo.pending_permission` (models.rs:77) is kept for back-compat; the hook no longer writes it. Python locks the hook side (`test_legacy_pending_permission_is_dropped_by_next_event`); no Rust assertion that a stale `pendingPermission` deserializes harmlessly — minor, below floor.
