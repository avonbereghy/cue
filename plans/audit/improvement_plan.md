# Improvement Plan — Claude State Coverage Sweep

Base commit: `45694d0`

## Lens Coverage

| Lens | Findings | Critical | High | Medium | Low |
|------|----------|----------|------|--------|-----|
| state-coverage | 10 | 2 | 2 | 4 | 2 |
| correctness | 3 | 0 | 3 | 0 | 0 |
| reliability | 9 | 1 | 8 | 0 | 0 |
| tests | 13 | 1 | 12 | 0 | 0 |

Total: 35 findings; 4 critical, 25 high, 4 medium, 2 low. Severity floor for this run: **high**. Below-floor (medium/low) acknowledged but deferred.

## Top Risks (severity × confidence)

1. **F-tests-101** — `SessionEnd → state=ended` completely untested. Sessions could vanish on every exit; we'd have no test to catch a regression.
2. **F-state-coverage-001** — `Notification.permission_prompt` and `idle_prompt` render as green "done" instead of yellow `waiting`. User dismisses MCP prompts unseen.
3. **F-reliability-001** — Permission server has no timeout / disconnect detection. After 64 abandoned permissions, Cue stops mediating ALL permissions until app restart.
4. **F-state-coverage-002** — `StopFailure` (rate_limit, billing_error, auth_failed, ...) unwired. Session stays green-pulsing "Working" after API errors until manual retry.
5. **F-state-coverage-003** — `PostCompact` unwired. `compacting` state stuck for up to 60s after clean compact.

## Dedup Notes

- **F-correctness-002 ≡ F-reliability-002** — both flag the sandbox sessions writers bypassing the hook's flock. Merged into one finding under Track 3 with two complementary fix options (acquire flock from Rust, or split into separate file).
- **F-tests-108 (clearing state)** crosses lens boundaries — it's both a coverage gap (test missing) and a correctness gap (Rust treats a state the hook can never produce). Resolved by Track 2 (drop `clearing` from Rust since `PreClear` doesn't exist in the canonical Claude Code event list).
- **F-reliability-009 + F-state-coverage-001** — both touch `_quick_state_write` in cue-hook. Handled together in Track 1.

## Track Plan

### Track 1: Hook event coverage  (parallel)
- **Owner:** state machine
- **Files:** `hooks/cue-hook`, `cue-desktop/src-tauri/src/env_detect.rs`, `cue-desktop/src-tauri/src/models.rs`
- **Findings addressed:**
  - F-state-coverage-001 — Notification subtype branching (permission_prompt/idle_prompt/elicitation_dialog → waiting; informational subtypes → no-op write)
  - F-state-coverage-002 — Wire `StopFailure → error`; persist `error_type` on session entry; mirror error-preservation guards
  - F-state-coverage-003 — Wire `PostCompact → working`
  - F-state-coverage-004 — Branch `SessionStart` on `source` (`startup` → `idle`, `resume`/`compact` with prior transcript content → `working`)
  - F-correctness-003 — `subagent_stop` preserves `compacting`/`clearing` (mirror existing waiting/error guard)
  - F-reliability-009 — Sticky `pendingPermission` marker on `_quick_state_write` to protect `waiting` from concurrent non-attention writes (cleared by main-path Permission write completion)
- **Verification:**
  - `cargo test -p cue-desktop env_detect::tests::` (extend `HOOK_EVENTS` assertions for new rows)
  - Pytest cases added in Integration track exercise the new branches

### Track 2: Rust state pipeline  (parallel)
- **Owner:** Rust state derivation
- **Files:** `cue-desktop/src-tauri/src/session_monitor.rs`, `cue-desktop/src-tauri/src/jsonl_parser.rs`
- **Findings addressed:**
  - F-correctness-001 — Narrow `floor_extends` to mask only `working`/`thinking`/`idle`/`done` (never `error`, `waiting`, `subagent`, `clearing`)
  - F-reliability-005 — First-sight liveness verifies process name contains `claude` before accepting capture
  - F-reliability-006 — After N consecutive `serde_json::from_str` failures, rename sessions.json aside and reset to `{"sessions":{}}`
  - F-reliability-008 — `parse_subagent_jsonl` `ended_at` only finalizes when `is_active == false`; rescue latch keys on subagent set membership delta, not timestamp
  - F-state-coverage-009 — Add `error` to `should_demote_turn_ended` so a clean post-error `end_turn` releases the red latch
  - F-tests-108 — Resolve the `clearing` dead-code problem: drop `clearing` from `is_liveness_sensitive`, `should_demote_stuck_active`, `dedup_state_priority`, and the stuck-active 60s arm (the hook never produces it; canonical Claude Code hooks docs don't define `PreClear`)
- **Verification:**
  - `cargo test -p cue-desktop` — inline `#[cfg(test)] mod tests` in each file
  - New tests pin: `floor_extends("error", Some(now+1.0), now) == false`; `should_demote_turn_ended("error", ...)` returns Some on a fresh `end_turn`; subagent rescue fires at most once across 10 refreshes of an active subagent

### Track 3: Permission server reliability  (parallel)
- **Owner:** permission flow
- **Files:** `cue-desktop/src-tauri/src/lib.rs`, `cue-desktop/src-tauri/src/permission_server.rs`, `cue-desktop/src-tauri/src/security.rs`
- **Findings addressed:**
  - F-reliability-001 — Wrap `rx.await` in `tokio::time::timeout(60s, rx)`; race against stream-shutdown detection so a closed Python TCP connection frees the slot immediately. Surface pending count for UI.
  - F-correctness-002 / F-reliability-002 — Either (a) port `sessions.lock` flock into a `with_sessions_lock` helper in `security.rs` and route `write_sandbox_sessions` / `clear_sandbox_sessions` through it, OR (b) split sandbox sessions into a separate file. Pick (a) for surgical fix. Also validate sandbox IDs against the same regex `_SESSION_ID_RE` the hook enforces.
  - F-reliability-007 — Insert `permission_metadata` entry BEFORE `pending` insert (or merge both into one mutex-guarded struct) to close the audit-log race
- **Verification:**
  - `cargo test -p cue-desktop` permission tests — synthetic timeout/disconnect/MAX_PENDING saturation recovery
  - Manual: trigger 65 abandoned permissions in a row; confirm the 65th is still mediated

### Integration Track: Test coverage  (sequential, runs LAST)
- **Owner:** pytest expansion
- **Files:** `tests/hooks/test_cue_hook.py`, `tests/hooks/conftest.py`
- **Findings addressed:** all 13 F-tests-101..113 plus pytest coverage for behaviors changed in Tracks 1-3:
  - F-tests-101 `TestRemoveAction` — tombstone path
  - F-tests-102 `TestClearDetection` — `is_clear` branch
  - F-tests-103 `TestQuickStateWrite` + `TestPermissionRequest` — quick-write and HTTP forward paths
  - F-tests-104 `TestTranscriptDrivenRouting` — `_last_tool_was_ask_question`, `_turn_has_finished`
  - F-tests-105 `TestErrorState` — fire `error` from working/idle/thinking
  - F-tests-106 `TestIgnoredSessions` — print/CUE_SKIP cleanup paths
  - F-tests-107 `TestPermissionMode` — propagation casings × carry-forward × write paths
  - F-tests-109 `TestWorkspacePinning` — workspace stays pinned across cwd flips
  - F-tests-110 `TestCorruptionRecovery` — `.corrupt-<ts>` rename
  - F-tests-111 `TestStaleWaitingGuard` — main-path waiting guard against newer activity
  - F-tests-112 `TestLockContention` — flock retry, 2s timeout (Unix-only)
  - F-tests-113 — `subagent_stop → idle` when `_turn_has_finished == True`
  - **New for Track 1:** `TestNotificationSubtypes` (permission_prompt → waiting; auth_success → no-op); `TestStopFailure` (writes error + persists error_type); `TestPostCompact` (writes working); `TestSessionStartSources` (source=resume + transcript content → working); `TestSubagentStopPreservesCompacting` (F-correctness-003)
- **Verification:**
  - `pytest tests/hooks/ -v` — all green
  - Coverage report: every event-name in HOOK_EVENTS has at least one direct pytest

## File Ownership Matrix

| File                                                | Track 1 | Track 2 | Track 3 | Integration |
|-----------------------------------------------------|---------|---------|---------|-------------|
| hooks/cue-hook                                      | ✏️      |         |         |             |
| cue-desktop/src-tauri/src/env_detect.rs             | ✏️      |         |         |             |
| cue-desktop/src-tauri/src/models.rs                 | ✏️      |         |         |             |
| cue-desktop/src-tauri/src/session_monitor.rs        |         | ✏️      |         |             |
| cue-desktop/src-tauri/src/jsonl_parser.rs           |         | ✏️      |         |             |
| cue-desktop/src-tauri/src/lib.rs                    |         |         | ✏️      |             |
| cue-desktop/src-tauri/src/permission_server.rs      |         |         | ✏️      |             |
| cue-desktop/src-tauri/src/security.rs               |         |         | ✏️      |             |
| tests/hooks/test_cue_hook.py                        |         |         |         | ✏️          |
| tests/hooks/conftest.py                             |         |         |         | ✏️          |

**Validation:** no file appears in more than one column. No Foundation track is needed — Tracks 1-3 are independent and Integration is sequential at the end. Track 1 adds optional fields to entries in `models.rs`; Tracks 2 and 3 only READ from `models.rs`, no modifications.

## Inter-Track Contracts

- **Track 1 → Integration:** New `valid_actions`/`HOOK_EVENTS` entries listed in the commit body. Integration pytest can grep them to drive parameterized tests.
- **Track 1 → Track 2:** Track 2 drops `clearing` arms; Track 1 leaves the (commented-out / unused) reference in cue-hook untouched. Independent.
- **Track 3 → Integration:** Any new fields added to permission metadata (e.g. a `received_at` timestamp for the timeout path) must be JSON-serializable so the audit log fixture matches.

## Acknowledged but Deferred (below `high` severity floor or out of sweep budget)

- F-state-coverage-005 (medium) — `PermissionDenied` event unwired
- F-state-coverage-006 (medium) — `Setup`, `WorktreeCreate/Remove`, `CwdChanged`, `InstructionsLoaded`, `ConfigChange`, `FileChanged` unwired (most observability-only)
- F-state-coverage-007 (low) — `SessionEnd` reason subtypes lost
- F-state-coverage-008 (low) — `agent_type` from SubagentStart/Stop discarded
- F-state-coverage-010 (low) — `PreCompact.manual` vs `auto` collapse
- F-reliability-003 (high, **deferred**) — `poll_status` lock-vs-IO ordering. Real risk on slow disks but the refactor is invasive (touches every active-list iteration site). Separate ticket.
- F-reliability-004 (high, **deferred**) — `JsonlEntryCache` unbounded growth. Real long-session memory issue but requires reworking aggregation to incremental. Separate ticket.

These will be revisited if/when the user re-runs the sweep with `severity=medium`, or as individual targeted fixes.
