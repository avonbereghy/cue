# Test Findings

## Summary
Pure Rust predicates (`promote_decision`, `floor_extends`, `should_demote_*`, `dedup_*`, `resolve_liveness`, `is_recently_live`, `admit_session`) are now exhaustively tested after the recent audit tracks. The remaining gaps are concentrated in **Claude Code event handling** and **state-transition wiring**: the hook only maps 13 of Claude Code's ~30 documented event names (the other ~17 silently no-op), `SessionEnd → "ended"` and the `/clear` detection branch have zero tests, `PermissionRequest`-with-`tool_name` (the quick-write + HTTP-forward path) is uncovered, several user-attention transitions (`_last_tool_was_ask_question`, `_turn_has_finished` routing) have no end-to-end coverage, and the `clearing` state is documented in the schema but never emitted by the hook (yet the Rust pipeline treats it as a first-class state with 60s caps, latches, and dedup priority).

## Coverage Tables

### Hook event coverage (pytest)
Source of truth for "what the hook maps" is `cue-desktop/src-tauri/src/env_detect.rs:165-179` (HOOK_EVENTS). Anything not in that table is **silently dropped** by the hook because `valid_actions` rejects unknown CLI args (`hooks/cue-hook:575-577`).

| Event | Subtype/source | Hook maps? | Tested via pytest? | Test name(s) |
| --- | --- | --- | --- | --- |
| SessionStart | startup | yes → `idle` | no | — |
| SessionStart | resume | yes → `idle` | no | — |
| SessionStart | clear (`/clear`) | yes → `idle` + `is_clear` reset path | **no — entire branch untested** | — |
| SessionStart | compact (`/compact`) | yes → `idle` + `is_clear` reset path | no | — |
| Setup | n/a | no (not in HOOK_EVENTS) | n/a | — |
| UserPromptSubmit | n/a | yes → `thinking` | partial | `test_thinking_propagates_through_active_subagents` |
| UserPromptExpansion | n/a | no | n/a | — |
| PreToolUse | n/a | yes → `working` | indirect | `test_working_still_overridden_to_subagent` |
| PostToolUse | n/a | yes → `working` | indirect | same as above |
| PostToolUseFailure | n/a | yes → `error` | partial — only preservation tested, no fire-from-working test | — |
| PostToolBatch | n/a | no | n/a | — |
| PermissionRequest | (no `tool_name`) | yes → `waiting` (quick-write only) | no | — |
| PermissionRequest | with `tool_name` (HTTP forward) | yes → `waiting` + POST to :3002 | **no — `_quick_state_write` + `_forward_permission_request` untested** | — |
| PermissionDenied | n/a | no | n/a | — |
| Stop | n/a | yes → `idle` (subject to AskUserQuestion → `waiting` promotion) | partial — idle/done preservation tested but **AskUserQuestion routing untested** | — |
| StopFailure | n/a | no | n/a | — |
| SubagentStart | n/a | yes → `subagent` (+ counter++) | yes | `test_subagent_start_increments_counter` |
| SubagentStop | n/a | yes → `subagent_stop` | partial — counter and preservation tested, **`_turn_has_finished`-routes-to-idle path untested** | `test_subagent_stop_decrements_counter`, `test_subagent_stop_clamps_at_zero` |
| TaskCreated | n/a | no | n/a | — |
| TaskCompleted | n/a | yes → `done` | no direct test | — |
| Notification | (all subtypes) | yes → `done` | no | — |
| TeammateIdle | n/a | no | n/a — team idle-to-done handled in Rust | — |
| FileChanged | n/a | no | n/a | — |
| ConfigChange | n/a | no | n/a | — |
| InstructionsLoaded | n/a | no | n/a | — |
| CwdChanged | n/a | no | n/a | — |
| PreCompact | n/a | yes → `compacting` | no | — |
| PostCompact | n/a | no | n/a | — |
| WorktreeCreate / WorktreeRemove | n/a | no | n/a | — |
| Elicitation / ElicitationResult | n/a | no | n/a | — |
| SessionEnd | hangup / logout / exit | yes → `remove` (sets state="ended") | **no — entire `remove` branch untested** | — |

**Net:** Of 13 mapped event names, only 4 have any end-to-end pytest coverage. 9 mapped events are completely unanchored.

### State transition coverage

| From | To | Trigger | Tested in pytest? | Test name(s) |
| --- | --- | --- | --- | --- |
| (new) | idle | SessionStart (startup) | no | — |
| (new) | thinking | UserPromptSubmit on fresh session | no | — |
| idle | working | PreToolUse / PostToolUse | partial | `test_stale_counter_reset_lets_working_transition` |
| idle | thinking | UserPromptSubmit | no | — |
| idle | waiting | PermissionRequest | no | — |
| idle | subagent | SubagentStart | no | — |
| idle | compacting | PreCompact | no | — |
| idle | ended | SessionEnd | no | — |
| working | thinking | UserPromptSubmit mid-turn | no | — |
| working | waiting | PermissionRequest | no | — |
| working | error | PostToolUseFailure | no | — |
| working | subagent | SubagentStart (override fires) | yes | `test_subagent_start_increments_counter`, `test_working_still_overridden_to_subagent` |
| working | done | TaskCompleted / Notification | no | — |
| working | idle | Stop | no direct test | — |
| working | compacting | PreCompact | no | — |
| working | ended | SessionEnd | no | — |
| thinking | working | promote_decision latch (Rust) | yes (Rust) | `promote_fires_when_text_after_prompt`, etc. |
| thinking | subagent | (BLOCKED by design) | yes (negative) | `test_thinking_propagates_through_active_subagents` |
| thinking | done | TaskCompleted / Notification | no | — |
| thinking | idle | Stop | no | — |
| waiting | working | PostToolUse after permission decision | no | — |
| waiting | (preserved) | subagent_stop / done / idle / subagent | yes | `TestWaitingNotClobbered` (4 tests) |
| waiting | error | PostToolUseFailure on waiting | no | — |
| waiting | idle | demoter (turn-ended, Rust) | yes (Rust) | `test_demote_turn_ended_for_waiting_state` |
| error | (preserved) | subagent_stop / done / idle / subagent | yes | `TestErrorNotClobbered` (4 tests) |
| error | working | next PreToolUse | no | — |
| error | thinking | UserPromptSubmit on error | no | — |
| subagent | working | last SubagentStop, turn not finished | no | — |
| subagent | idle | last SubagentStop, `_turn_has_finished == True` | **no** | — |
| subagent | idle (forced) | stale-counter self-heal | yes | `test_stale_counter_reset_lets_working_transition` |
| compacting | working | PostCompact or next PreToolUse | no | — |
| compacting | idle | stuck-active 60s cap (Rust) | yes (Rust) | `test_demote_stuck_active_compacting_past_60s` |
| clearing | * | **N/A — `clearing` is never written by hook** | n/a | — |
| ended | (revived) | SessionStart on tombstoned session | no | — |
| any active | idle | liveness demote (dead PID) | yes (Rust) | `resolve_liveness*` |
| any active | idle | JSONL-missing demote | no end-to-end test | — |
| any | ended | SessionEnd → `remove` | **no** | — |
| done/idle | subagent | rescue latch (Rust) | partial | `test_is_recently_live_*` |
| (idle + AskUserQuestion in transcript) | waiting | Stop → `_last_tool_was_ask_question` | **no** | — |
| (transcript prior content + SessionStart) | idle (with startedAt reset) | `is_clear == True` branch | **no** | — |

## Findings

### F-tests-101: `SessionEnd → state=ended` (the `remove` action) is completely untested
- **Severity:** critical
- **Confidence:** 100
- **Files:** hooks/cue-hook:703-712; tests/hooks/test_cue_hook.py (no test references `"remove"` or `"ended"`)
- **What:** The `remove` action is the ONLY way the hook transitions a session into the `ended` tombstone state — yet no test invokes `invoke_hook("remove", ...)`. Both the happy path (existing session → `state="ended"`) and the no-op path (no existing entry → write nothing) are unexercised.
- **Why it matters:** `ended` is the signal the frontend uses to filter sessions into the "revived" section. If `remove` silently deletes the entry instead of tombstoning, every SessionEnd erases the card without ceremony.
- **Suggested fix:** Add `TestRemoveAction`:
  - `test_remove_tombstones_existing_session`
  - `test_remove_noop_when_session_absent`
  - `test_remove_preserves_workspace_pid_subprocess`
  - `test_remove_then_session_start_overwrites_tombstone`
- **Verification:** `pytest tests/hooks/test_cue_hook.py::TestRemoveAction -v`

### F-tests-102: `/clear` and `/compact` detection (`is_clear` branch) untested
- **Severity:** high
- **Confidence:** 98
- **Files:** hooks/cue-hook:719-732, 835
- **What:** SessionStart with `action == "idle"` and transcript >100 bytes triggers `is_clear` path that resets `startedAt`. No tests for trigger, negative (small transcript), or no-op (missing path).
- **Why it matters:** A regression swapping `>` for `>=`, or misreading `hook_event_name`, silently disables `/clear` detection. The active-duration timer then accumulates through every `/clear`.
- **Suggested fix:** Add `TestClearDetection`:
  - `test_clear_detected_when_transcript_has_prior_content`
  - `test_clear_not_detected_for_fresh_transcript`
  - `test_clear_not_detected_without_session_start_event_name`
  - `test_clear_not_detected_when_transcript_path_missing`

### F-tests-103: `_quick_state_write` and `_forward_permission_request` untested
- **Severity:** high
- **Confidence:** 96
- **Files:** hooks/cue-hook:233-336, 338-366, 634-650
- **What:** When `action == "waiting"`, the hook calls `_quick_state_write` BEFORE the blocking HTTP forward. Neither function has any test. The `if action == "waiting" and "tool_name" in hook_data` branch (line 642) is the ONLY thing distinguishing a real PermissionRequest from a manual `cue-hook waiting`.
- **Why it matters:** PermissionRequest is the only event with network I/O. A crash inside `_quick_state_write` is swallowed and the main write path picks up 300s later.
- **Suggested fix:** Add `TestQuickStateWrite` + `TestPermissionRequest`:
  - `test_quick_write_creates_waiting_entry_with_subagent_counter_preserved`
  - `test_quick_write_stale_guard_skips_when_newer_activity_exists`
  - `test_quick_write_carries_forward_stateChangedAt_when_already_waiting`
  - `test_quick_write_resets_stateChangedAt_when_transitioning`
  - `test_quick_write_propagates_permission_mode`
  - `test_waiting_action_without_tool_name_skips_http_forward` (mock `urllib.request.urlopen`)
  - `test_waiting_action_with_tool_name_attempts_http_forward`
  - `test_permission_request_http_failure_still_writes_sessions_json` (mock URLError)

### F-tests-104: `_last_tool_was_ask_question` and `_turn_has_finished` (transcript-driven routing) untested
- **Severity:** high
- **Confidence:** 95
- **Files:** hooks/cue-hook:494-525, 769, 799
- **What:** Two transcript-parsing helpers drive critical action routing:
  - `_last_tool_was_ask_question`: routes `idle/done → waiting` when last tool was AskUserQuestion. Untested.
  - `_turn_has_finished`: routes `subagent_stop` (counter=0) to `idle` vs `working`. Untested.
- **Why it matters:** Failure modes: (1) Stop leaves card on `idle` instead of `waiting` when AskUserQuestion is pending. (2) Final SubagentStop routes to `working` and pins forever (no stuck-active cap for working). (3) Malformed transcript JSON crashes the hook, sessions.json never updated.
- **Suggested fix:** Add `TestTranscriptDrivenRouting`:
  - `test_last_tool_ask_question_detects_terminal_tool_use_block`
  - `test_last_tool_ask_question_false_for_other_tools`
  - `test_last_tool_ask_question_false_for_text_only_response`
  - `test_last_tool_ask_question_handles_malformed_transcript`
  - `test_turn_has_finished_routes_subagent_stop_to_idle_when_end_turn_seen`
  - `test_turn_has_finished_routes_subagent_stop_to_working_when_no_end_turn`
  - `test_turn_has_finished_returns_false_on_empty_transcript`

### F-tests-105: PostToolUseFailure → `error` from `working` not tested as a fire path
- **Severity:** high
- **Confidence:** 90
- **Files:** hooks/cue-hook:570-866
- **What:** `TestErrorNotClobbered` tests preservation but no test fires `error` from a `working`/`idle`/`thinking` baseline. A regression that no-ops the error action (e.g. hoisting it into the `done/idle` guard list) would still pass every existing test.
- **Why it matters:** `error` is the only signal Cue surfaces for tool failures.
- **Suggested fix:** Add `TestErrorState`:
  - `test_error_action_transitions_from_working`
  - `test_error_action_transitions_from_idle`
  - `test_error_action_transitions_from_thinking`
  - `test_error_action_resets_stateChangedAt_on_transition`
  - `test_error_does_not_increment_subagent_counter`

### F-tests-106: `_should_ignore_session` (session_type + CUE_SKIP) untested
- **Severity:** high
- **Confidence:** 92
- **Files:** hooks/cue-hook:399-412, 679-699
- **What:** When payload indicates non-interactive or `CUE_SKIP=1`, hook attempts cleanup of existing entry then returns. Three branches untested. The cleanup path also writes sessions.json — second write path, uncovered.
- **Why it matters:** `claude -p` subprocesses fire hooks. If `_should_ignore_session` regresses to False, every `claude -p` shows up as a phantom; no SessionEnd fires for print mode, so they pile up forever.
- **Suggested fix:** Add `TestIgnoredSessions`:
  - `test_print_mode_session_skipped`
  - `test_interactive_session_not_skipped`
  - `test_cue_skip_env_var_skips_session`
  - `test_ignored_session_cleans_up_prior_entry`
  - `test_ignored_session_no_write_when_no_prior_entry`

### F-tests-107: `permission_mode` propagation untested
- **Severity:** high
- **Confidence:** 90
- **Files:** hooks/cue-hook:622-627, 309-313, 862-865
- **What:** Hook reads `permission_mode` (or `permissionMode`). Two casings × three outcomes (set/carry/drop) × two write paths = 12 cells. Zero tested.
- **Why it matters:** Permission-mode pill is the user's primary signal for "Claude has shift+tab'd into bypass mode behind my back".
- **Suggested fix:** Add `TestPermissionMode`:
  - `test_permission_mode_snake_case_persisted`
  - `test_permission_mode_camel_case_persisted`
  - `test_permission_mode_carries_forward_when_absent_from_payload`
  - `test_permission_mode_overwritten_when_new_value_supplied`
  - `test_permission_mode_quick_write_carries_forward`
  - `test_permission_mode_invalid_type_treated_as_none`

### F-tests-108: `clearing` state is documented + supported in Rust but never produced by the hook
- **Severity:** high
- **Confidence:** 98
- **Files:** CLAUDE.md schema; hooks/cue-hook:575 (valid_actions); cue-desktop/src-tauri/src/env_detect.rs:165-179 (no PreClear); cue-desktop/src-tauri/src/session_monitor.rs:943, 1009, 1089
- **What:** Rust treats `clearing` as a first-class state. But: `PreClear` is NOT in `HOOK_EVENTS`; `"clearing"` is NOT in `valid_actions`; the only `"clearing"` reference in `hooks/cue-hook` is a comment on line 716. Every Rust test for clearing verifies behavior on a state that cannot ever appear in sessions.json.
- **Why it matters:** False sense of completeness. Either feature was abandoned (drop everywhere) or the hook is missing `PreClear → clearing`. Current state is worst of both: dead code in producer, live code with tests in every consumer.
- **Suggested fix:** Pick a direction and add an integration test:
  - If feature should ship: add `("PreClear", "clearing")` to `HOOK_EVENTS`, add `"clearing"` to `valid_actions`, add `test_pre_clear_writes_clearing_state`.
  - If abandoned: remove `clearing` from CLAUDE.md, drop arms from `is_liveness_sensitive`, `should_demote_stuck_active`, `dedup_state_priority`.
  - Either way, add a contract test asserting every state arm in `is_liveness_sensitive`/`dedup_state_priority` is reachable from some hook action.

### F-tests-109: Workspace-pinning contract (`stable_workspace`) untested
- **Severity:** high
- **Confidence:** 88
- **Files:** hooks/cue-hook:813, 831
- **What:** `workspace` pinned via `existing.get("workspace", workspace)`. No test confirms first-event seeding, subsequent-event preservation, or `_quick_state_write` preservation.
- **Why it matters:** Flipping workspace mid-session breaks dedup, breaks Rust JSONL path resolution, breaks privacy.
- **Suggested fix:** Add `TestWorkspacePinning`:
  - `test_first_event_seeds_workspace_from_cwd`
  - `test_subsequent_event_with_different_cwd_keeps_original_workspace`
  - `test_quick_write_path_preserves_pinned_workspace`
  - `test_remove_action_preserves_workspace_in_tombstone`

### F-tests-110: Sessions.json corruption recovery (`.corrupt-<ts>` rename) untested
- **Severity:** high
- **Confidence:** 92
- **Files:** hooks/cue-hook:666-672
- **What:** When sessions.json fails to parse, hook renames it aside. No tests for rename step, fallback, or rename-failure no-op.
- **Why it matters:** Only data-preservation path for forensic recovery.
- **Suggested fix:** Add `TestCorruptionRecovery`:
  - `test_invalid_json_renames_to_corrupt_suffix`
  - `test_invalid_json_starts_fresh_after_rename`
  - `test_unicode_decode_error_also_triggers_rename`
  - `test_file_not_found_does_not_trigger_rename`
  - `test_rename_failure_does_not_crash_hook`

### F-tests-111: Stale-`waiting` write guard in main path untested
- **Severity:** high
- **Confidence:** 90
- **Files:** hooks/cue-hook:734-742
- **What:** Lines 739-742 skip `waiting` writes when `existing_activity > hook_start_time`. No test seeds `lastActivity > hook_start_time` and verifies the waiting write is skipped.
- **Why it matters:** Race-condition guard for 300s HTTP call.
- **Suggested fix:** Add `TestStaleWaitingGuard`:
  - `test_main_path_waiting_skips_when_newer_activity_exists`
  - `test_main_path_waiting_applies_when_no_newer_activity`

### F-tests-112: Concurrent hooks racing on lock acquisition / lock-timeout untested
- **Severity:** high
- **Confidence:** 80
- **Files:** hooks/cue-hook:30-44
- **What:** Non-Windows `_lock` retries `flock(LOCK_EX | LOCK_NB)` for 2s. No test exercises the retry loop, the 2-second timeout, or verifies lock-failure leaves sessions.json unchanged.
- **Why it matters:** A regression dropping the timeout (flipping to blocking `LOCK_EX`) would let one stuck hook block the entire pipeline indefinitely.
- **Suggested fix:** Add `TestLockContention` (Unix-only):
  - `test_lock_retries_when_contended_briefly`
  - `test_lock_times_out_after_2_seconds_when_indefinitely_held`
  - `test_lock_failure_leaves_sessions_json_unchanged`

### F-tests-113: Subagent-stop → `idle` via `_turn_has_finished` integration untested
- **Severity:** high
- **Confidence:** 92
- **Files:** hooks/cue-hook:781-799
- **What:** When `subagent_stop` decrements counter to 0 AND `_turn_has_finished` returns True, action rewritten to `"idle"`. F-tests-104 covers the helper but the integration is unanchored.
- **Suggested fix:**
  - `test_subagent_stop_routes_to_idle_when_turn_finished`
  - `test_subagent_stop_routes_to_working_when_turn_ongoing`

## Out of scope
- Frontend tests (Vitest/Jest) — outside Rust/Python target.
- Tests for events the hook does NOT map — feature gap, not test gap.
- Adequately covered: subagent counter increment/decrement/clamp; waiting/error preservation; stateChangedAt carry-forward vs reset; thinking-not-clobbered; `_validate_sessions`; session ID validation; subagent JSONL freshness check + self-heal; all Rust pure predicates.
