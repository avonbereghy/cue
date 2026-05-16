# Improvement Plan — Cue State Correctness Sweep

**Base commit:** `3292322`
**Scope:** state changes and state identification (`session_monitor.rs`, `jsonl_parser.rs`, `models.rs`, `hooks/cue-hook`)
**Severity floor:** `high`
**Lenses run:** security, reliability, correctness, tests

## Lens Coverage

| Lens | Findings | Critical | High | Medium |
|------|----------|----------|------|--------|
| security    | 3  | 0 | 3  | 4 (out-of-scope) |
| reliability | 8  | 1 | 7  | 9 (out-of-scope) |
| correctness | 7  | 0 | 7  | 6 (out-of-scope) |
| tests       | 10 | 1 | 9  | — |
| **Total**   | **28** | **2** | **26** | — |

After dedup: 24 distinct fix items (correctness-F-005 merged into F-002; correctness-F-007 merged into reliability-F-002's cache pruning; tests-F-008 merged into tests-F-001 Python suite).

## Top Risks (severity × confidence)

1. **F-tests-001** (zero Python hook coverage) — `critical × 100 = 400`. Hook is the canonical state writer; regressions ship undetected.
2. **F-reliability-001** (destructive `_validate_sessions`) — `critical × 90 = 360`. Real live sessions disappear off the dashboard when an unrelated session fires a hook.
3. **F-correctness-001** (SubagentStop counter leak when state=waiting) — `high × 95 = 285`. Stuck-subagent trap after permission prompts.
4. **F-correctness-002 + F-005** (subagent override clobbers `error`) — `high × 92 = 276`. Red error indicator silently lost when any subagent fires.
5. **F-correctness-003** (dedup priority ranks `error`/`compacting` below `idle`) — `high × 90 = 270`. User-attention states hidden behind phantom siblings.

## Track Plan

### Foundation Track (sequential, runs first)
- **Owner:** orchestrator (main session)
- **Files:** `cue-desktop/src-tauri/src/security.rs`
- **Produces:** `pub fn validate_session_id(s: &str) -> Result<(), SecurityError>`. Requires `[A-Za-z0-9_-]{1,128}`, rejects empty, `/`, `\`, leading `.`, embedded NUL, control chars.
- **Findings addressed:** F-security-001 (helper portion)
- **Verification:** `cargo test --lib --package cue-desktop-lib validate_session_id` (all branches green); `cargo check` succeeds.

### Track 1 — Python hook state correctness
- **Owner:** Python hook agent
- **Files modified:** `hooks/cue-hook`
- **Files created:** `tests/hooks/test_cue_hook.py`, `tests/hooks/__init__.py`, `tests/__init__.py`, `tests/hooks/conftest.py`
- **Findings addressed:**
  - F-correctness-001 (persist counter decrement when waiting)
  - F-correctness-002 + F-005 (error-state guard symmetric to waiting; widen line-666 override skip-list)
  - F-correctness-004 (drop `thinking` from override)
  - F-correctness-006 (add stateChangedAt to `_quick_state_write`)
  - F-reliability-001 (non-destructive `_validate_sessions` — leave malformed entries in place, log; coerce safe defaults where unambiguous)
  - F-reliability-004 (counter-reset for stale subagent: if `existing.state=="subagent"` AND stateChangedAt > 60s AND no subagent JSONL mtime within 30s → reset `active_subs = 0`)
  - F-reliability-005 (call `_validate_sessions` from `_quick_state_write`)
  - F-security-001 (hook side: validate session_id before persisting via shared regex)
  - F-tests-001 + F-tests-008 (full pytest suite covering all above)
- **Contract to other tracks:** writes schema-compliant entries with `stateChangedAt` on every state change, `error` preserved across subagent events, stale subagent counters self-heal.
- **Verification:** `python -m pytest tests/hooks/ -v` exits 0; manually inspect sessions.json after triggering hook with pre-seeded fixtures.

### Track 2 — Rust state pipeline
- **Owner:** Rust state agent
- **Files modified:** `cue-desktop/src-tauri/src/session_monitor.rs`
- **Findings addressed:**
  - F-correctness-003 (rebuild `state_priority`: `error=5, waiting=4, working|subagent=3, thinking|compacting|clearing=2, done|idle=1, ended=0`)
  - F-correctness-007 (`should_demote_stale_subagent`: when `metrics.is_none()`, require 30s grace instead of 15s)
  - F-reliability-002 (per-poll `.retain()` on `metrics_cache`, `jsonl_entry_cache`, `file_mod_dates`, `resolved_paths`, `output_speed_cache` — observe lock order)
  - F-reliability-003 (extend `should_demote_turn_ended` to include `waiting`; add `should_demote_stuck_active(state, state_changed_at, max_duration)` for compacting/clearing with 60s cap)
  - F-reliability-006 (after 5 consecutive parse failures, rename sessions.json aside and create empty `{"sessions":{}}`)
  - F-reliability-008 (extend `resolve_liveness` to optionally check process name contains `claude` on first-sight)
  - F-security-001 wiring (call `security::validate_session_id` in `poll_status` admission filter, drop invalid entries)
  - F-security-002 (size-capped read: `metadata().len() > 4 MiB` → log + bail preserving prior state)
  - F-tests-003 (extract `rescue_decision` pure predicate, 6 tests)
  - F-tests-004 (extract `dedup_sessions` pure predicate, 7 tests)
  - F-tests-005 (extract `promote_team_idle` pure predicate, 5 tests)
  - F-tests-006 (extract `apply_compacting_floor` pure predicate, 4 tests)
  - F-tests-007 (boundary tests at 15s/30s/10s/1.5s for existing + new predicates)
- **Contract:** consumes `security::validate_session_id` from Foundation; no consumer downstream.
- **Verification:** `cargo test --lib --package cue-desktop-lib` — at minimum +27 new tests; entire suite green (≥298 passing).

### Track 3 — JSONL parser test coverage
- **Owner:** JSONL parser agent
- **Files modified:** `cue-desktop/src-tauri/src/jsonl_parser.rs`
- **Findings addressed:**
  - F-tests-009 (load `tests/fixtures/malformed.jsonl` + add embedded-null, oversized-line, wrong-shape, leading-malformed cases)
  - F-tests-010 (`test_pending_tool_use_entry_does_not_flag_end_turn` — per-entry contract)
- **Contract:** none.
- **Verification:** `cargo test --lib --package cue-desktop-lib jsonl_parser::tests::` — at least +5 new tests; all green.

### Track 4 — Models test coverage
- **Owner:** Models agent
- **Files modified:** `cue-desktop/src-tauri/src/models.rs`
- **Findings addressed:**
  - F-tests-002 (`is_recently_live` — 5 boundary tests)
- **Contract:** none.
- **Verification:** `cargo test --lib --package cue-desktop-lib is_recently_live` — 5 tests green.

### Integration Track
**Not required.** No shared entry points need wiring after parallel work — `security::validate_session_id` is produced by Foundation and consumed only by Track 2; no other cross-track contracts beyond the schema invariant Track 1 produces (which Track 2 reads from `sessions.json` via existing serde).

## File Ownership Matrix

| File | Foundation | Track 1 | Track 2 | Track 3 | Track 4 |
|------|------------|---------|---------|---------|---------|
| `cue-desktop/src-tauri/src/security.rs`        | ✏️ |    |    |    |    |
| `hooks/cue-hook`                                |    | ✏️ |    |    |    |
| `tests/hooks/test_cue_hook.py`                  |    | ✨ |    |    |    |
| `tests/hooks/__init__.py`                       |    | ✨ |    |    |    |
| `tests/__init__.py`                             |    | ✨ |    |    |    |
| `tests/hooks/conftest.py`                       |    | ✨ |    |    |    |
| `cue-desktop/src-tauri/src/session_monitor.rs`  |    |    | ✏️ |    |    |
| `cue-desktop/src-tauri/src/jsonl_parser.rs`     |    |    |    | ✏️ |    |
| `cue-desktop/src-tauri/src/models.rs`           |    |    |    |    | ✏️ |

✨ = create new ✏️ = modify existing.

### Matrix Validation
1. No file in more than one parallel track column ✓
2. Foundation file (`security.rs`) does not reappear with ✨ in any parallel track ✓
3. Files marked ✏️ in any track exist in the repo (verified via `ls`) ✓ — no Integration column needed
4. No track exceeds ~6 files; LOC budgets: Foundation ~80, Track 1 ~550, Track 2 ~600, Track 3 ~120, Track 4 ~60 — Track 2 slightly over guideline, justified by predicate extraction + test fortification on a single file that the matrix rule forces into one track

## Inter-Track Contracts
- **Foundation produces:** `security::validate_session_id(&str) -> Result<(), SecurityError>` — consumed by Track 2 admission filter.
- **Track 1 produces (schema invariants consumed by Track 2 via sessions.json):**
  - `stateChangedAt` present on every entry written, including `_quick_state_write` outputs
  - `error` state preserved across SubagentStart/Stop events
  - `activeSubagents` self-heals to 0 when stale (no JSONL mtime within 30s + stateChangedAt > 60s)
  - Malformed entries no longer dropped — Track 2's downstream demotion paths see consistent records
- **No track produces an API consumed by another at compile time** — Tracks 1–4 can run fully in parallel after Foundation commits.

## Acknowledged but Deferred

Filed but not fixed this run (out of scope by severity floor, or requires substantial refactor):

- **F-security-003** (unauthenticated permission HTTP) — substantial design change (UDS or token auth); schedule separately.
- **F-reliability-007** (JsonlEntryCache sliding-window aggregation) — substantial refactor to incremental aggregation; defer.
- **F-reliability-006** — INCLUDED above (size cap recovery). The parse-failure-replace logic stays in Track 2.
- Medium-severity items per individual findings files' "Out of scope" sections (subagent rescue idempotent re-fire, encode_workspace collisions, `_turn_has_finished` write race, etc.) — kept for future severity=medium sweep.

## Execution Plan

1. **Foundation** — main session writes `security.rs` validation helper + inline tests; commits `fix(audit): add validate_session_id`; verifies `cargo check && cargo test --lib validate_session_id`.
2. **Parallel tracks** — launch 4 `TeamCreate` teammates in a single message (Tracks 1–4 can all run concurrently per matrix). Each teammate commits its own `fix(audit): <track>` commit.
3. **Verify** — `cargo test --lib` (all green, ≥303 tests up from 271 baseline + 27 in Track 2 + 5 in Track 3 + 5 in Track 4 + Foundation), `python -m pytest tests/hooks/` (green), `npm --prefix cue-desktop run build` succeeds, lint clean on changed files, no `#[allow]` / `# noqa` introduced.
4. **Summarize** — report per-track status, findings handled vs deferred, full diff scope.
