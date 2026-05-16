# Correctness Findings

## Summary
State derivation is broadly sound, but several high-confidence defects exist around the Python hook's subagent counter and the Rust dedup priority that can latch the UI into wrong states for the session lifetime.

## Findings

### F-correctness-001: SubagentStop early-return leaks `activeSubagents` when state is "waiting"
- **Severity:** high
- **Confidence:** 95
- **Files:** hooks/cue-hook:650-657
- **What:** On `subagent_stop` when `existing.state == "waiting"`, the hook decrements in memory then returns WITHOUT writing the updated dict. Every subsequent stop re-reads the same un-decremented counter. The on-disk counter is frozen at its waiting-entry value. After waiting resolves, the persisted counter is still positive and the hook's line 666 override forces state to `subagent` indefinitely (until Rust's stale demoter fires, but a fresh subagent re-arms the trap).
- **Why it matters:** Common workflow (parallel subagents finish during permission prompt) leaves the session stuck on `subagent` after the user resumes.
- **Suggested fix:** At line 657 replace the bare return with a write that persists the decremented `active_subs` but preserves `state="waiting"` and refreshes `lastActivity`.
- **Verification:** Pre-seed `state="waiting"`, `activeSubagents=2`. Run hook `subagent_stop` twice. Assert resulting `activeSubagents == 0`.

### F-correctness-002: SubagentStart/Stop silently clobbers existing `error` state
- **Severity:** high
- **Confidence:** 92
- **Files:** hooks/cue-hook:633-667
- **What:** CLAUDE.md states `waiting` AND `error` are NOT overridden by subagent counter logic. Hook honors `waiting` (lines 638-639, 654-657) but has NO symmetric guard for `error`. Three paths overwrite `error`: `subagent` increments and writes `state=subagent`; `subagent_stop` with counter→0 sets working/idle; line 666 blanket override forces working/thinking → subagent.
- **Why it matters:** A `PostToolUseFailure` session loses its red error indication the instant any subagent fires. User has no way to know an error occurred.
- **Suggested fix:** Mirror the `waiting` guard for `error` at all three sites. Widen line 666 override to skip when existing state is `error` or `waiting`.
- **Verification:** Pre-seed `state="error"`; run hook `subagent`; assert state remains `error`.

### F-correctness-003: dedup `state_priority` ranks `error` / `compacting` / `clearing` below `idle`
- **Severity:** high
- **Confidence:** 90
- **Files:** cue-desktop/src-tauri/src/session_monitor.rs:172-216
- **What:** `state_priority` collapses `error`/`compacting`/`clearing`/`done`/`ended` all into priority 0 — below `idle` (priority 1). Dedup keeps the higher-priority duplicate, so `error` and `compacting` get shadowed by phantom `idle` siblings when two sessions collide in the workspace+started_at<3s window. Stable-id preservation (line 207-209) then makes the canonical session inherit the phantom's pid/state_changed_at/active_subagents — downstream liveness reads a hybrid.
- **Why it matters:** (1) Error suppression on workspace collisions. (2) Compacting/clearing invisibility (dedup runs before `compacting_floor`). (3) Latch keys now point at hybrid records.
- **Suggested fix:** Rebuild priority: `error => 5, waiting => 4, working|subagent => 3, thinking|compacting|clearing => 2, done|idle => 1`. Or: never dedup when either candidate is in `{error, waiting, compacting, clearing}`.
- **Verification:** Unit test: two SessionInfos same workspace within 2s, one `error` + one `idle`. Assert `error` survives.

### F-correctness-004: SubagentStart overriding `thinking` → `subagent` breaks the visual handoff
- **Severity:** high
- **Confidence:** 80
- **Files:** hooks/cue-hook:666-667
- **What:** CLAUDE.md restricts override to `working|done|idle`. Code at line 666 also overrides `thinking`. The backend never observes `thinking`, so `promoted_for_prompt` never latches for that prompt and the orange thinking beat is suppressed for any session running parallel subagents. The latch's equality-on-prompt_ts gains a stale-cross-turn surface.
- **Why it matters:** UX advertised by the schema is suppressed; potential cross-turn latch staleness.
- **Suggested fix:** Remove `"thinking"` from the override condition at line 666. Let the Rust latch own the handoff during subagent runs.
- **Verification:** With `active_subs=1`, fire `UserPromptSubmit`; assert entry written has `state="thinking"`.

### F-correctness-005: SubagentStop fall-through clobbers existing `error` (specific instance of F-002)
- **Severity:** high
- **Confidence:** 88
- **Files:** hooks/cue-hook:650-662
- **What:** `subagent_stop` arms: `active_subs>0` → subagent; `state=="waiting"` → return; else → idle/working. Missing `state=="error"` arm overwrites error on counter→0. Merged with F-002 fix.
- **Why it matters:** Concrete reproducer for F-002 — error silently cleared when parallel subagent ends.
- **Suggested fix:** Insert `elif existing.get("state") == "error": return` symmetric to waiting arm.
- **Verification:** Pre-seed `state="error"`, `activeSubagents=1`. Run `subagent_stop`. Assert state stays `error`.

### F-correctness-006: `_quick_state_write` omits `stateChangedAt`, breaking schema
- **Severity:** high
- **Confidence:** 75
- **Files:** hooks/cue-hook:146-226 (entry dict at 174-183)
- **What:** Fast-path waiting writer constructs entry without `stateChangedAt`. Schema requires it on every state change; waiting IS a state change. Main path populates it (line 692). If main path differs, the fast-write entry persists schema-noncompliant.
- **Why it matters:** Active-duration timer for waiting measures from wrong moment; future state code that gates on stateChangedAt for waiting silently breaks.
- **Suggested fix:** Add `stateChangedAt` to the entry dict in `_quick_state_write` using the same carry-forward logic as main path.
- **Verification:** Trigger PermissionRequest; before HTTP returns, inspect sessions.json; assert `stateChangedAt` is present and equals now.

### F-correctness-007: Stale-subagent demoter trusts `metrics: None` after grace, but `metrics_cache` is never pruned
- **Severity:** high
- **Confidence:** 70
- **Files:** cue-desktop/src-tauri/src/session_monitor.rs:989-1010
- **What:** `should_demote_stale_subagent` treats `metrics: None` after 15s grace as evidence JSONL is dead. But `metrics_cache` is never pruned by alive-session set (no `retain` anywhere). With 1Hz poll vs 5Hz `refresh_metrics`, a fresh subagent can be observed for up to 5 polls before metrics is parsed. If `stateChangedAt` is carried forward across overrides and already > 15s old, the demoter fires on the first poll.
- **Why it matters:** Race-window false-positive demotion of legitimate subagent sessions.
- **Suggested fix:** (a) Prune `metrics_cache` per poll (covered by reliability F-002). (b) When `metrics.is_none()`, require a larger grace (e.g. 30s) — give the cache time to be populated before second-guessing the hook.
- **Verification:** Update test_demote_stale_subagent_when_metrics_absent boundary; add new test at the 30s grace.

## Out of scope
- `_turn_has_finished` reads JSONL from hook (line 412-417), can race writer — medium; Rust recovers later.
- `stateChangedAt` resets across working→compacting→working contradicting schema comment — display, not state.
- `subagent` rescue re-fires every poll while ended_at advances (idempotent waste) — medium.
- Ties in priority-0 broken by last_activity (line 204-205) — symptom of F-003.
- `extract_user_prompt_text` only detects harness JSON on string content — leakage, not state.
- `team_ids` built before dedup using metrics_cache — race tightens within one cycle.
