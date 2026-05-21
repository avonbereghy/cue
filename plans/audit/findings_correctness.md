# Correctness Findings

## Summary

Track-1/Track-2 fixes resolved every previously-recorded high-severity defect in the prior `findings_correctness.md` (subagent counter leak, error/compacting suppression in dedup, the symmetric `subagent`/`subagent_stop` clobbers of `error`, the `_quick_state_write` missing-`stateChangedAt`, the `metrics_cache` prune). A fresh sweep surfaces three new high-confidence correctness issues — two land in the Rust pipeline (compacting floor masks `error`/`waiting`; the sandbox writer races sessions.json without the hook lock) and one in the Python hook (`subagent_stop` silently overwrites `compacting`/`clearing`). All three are reproducible without unusual conditions.

## Findings

### F-correctness-001: `compacting_floor` masks `error` and `waiting` for up to 1.5 s
- **Severity:** high
- **Confidence:** 95
- **Files:** cue-desktop/src-tauri/src/session_monitor.rs:422-430, 1191-1193
- **What:** When the hook writes `compacting` for a session, `poll_status` arms `compacting_floor` with `now + 1.5s`. On any later poll within that window where the state is NOT `compacting`, the predicate `floor_extends(state, until, now)` returns `true` for **any** non-compacting state, and `s.state` is overwritten back to `"compacting"`. The predicate's only guard is `state != "compacting"` — `error`, `waiting`, `subagent`, `done`, `idle` all trigger the extension equally. Concretely: if `/compact` is interrupted by `PostToolUseFailure` (state → `error`) or a `PermissionRequest` (state → `waiting`) within 1500 ms of the PreCompact hook, the user-attention state is silently displayed as `compacting` until the floor expires.
- **Why it matters:** Errors and permission prompts are the two states with the strongest user-attention contract. Hiding either behind a periwinkle "compacting" indicator for a full poll cycle delays the user's awareness by 1–2 polls. The mistake is invisible to the operator — sessions.json contains `error`/`waiting`, but the dashboard says `compacting`. Existing tests at 1452-1470 only validate "left compacting for working/idle" — the omission is in the predicate, not the test coverage.
- **Suggested fix:** Narrow `floor_extends` to mask ONLY `working`/`thinking`/`idle`/`done` — never `error`, `waiting`, `subagent`, `clearing`:
  ```rust
  pub(crate) fn floor_extends(state: &str, until: Option<f64>, now: f64) -> bool {
      if !matches!(state, "working" | "thinking" | "idle" | "done") { return false; }
      until.is_some_and(|u| u > now)
  }
  ```
  Mirrors the philosophy of `dedup_state_priority`: user-attention states are never shadowed.
- **Verification:** Add tests pinning `floor_extends("error", Some(now+1.0), now) == false`, `floor_extends("waiting", Some(now+1.0), now) == false`, and a poll-level integration test that armed-floor + new state=`error` keeps `s.state == "error"`.

### F-correctness-002: `write_sandbox_sessions` / `clear_sandbox_sessions` race the hook without `sessions.lock`
- **Severity:** high
- **Confidence:** 92
- **Files:** cue-desktop/src-tauri/src/lib.rs:594-649 (write), 652-675 (clear); cue-desktop/src-tauri/src/security.rs:16-60 (`atomic_write` — rename-atomic, no flock)
- **What:** The Python hook performs every read-modify-write of `sessions.json` under an exclusive `fcntl`/`msvcrt` lock on `sessions.lock` (cue-hook lines 247-333, 651-889). The Rust sandbox commands `write_sandbox_sessions` and `clear_sandbox_sessions` do a parallel read-modify-write of the same file via `security::atomic_write`, which is atomic at the rename layer but acquires NO lock at all. If a hook fires between the Rust read and the Rust rename, the hook's write is silently overwritten by the Rust commit (based on a stale snapshot). Symmetrically, a Rust commit landing between two hook events can clobber the persisted inter-hook state.
- **Why it matters:** A user toggling sandbox sessions in the dashboard at the same moment a real Claude Code hook fires will lose either the hook event (real session card freezes on stale state) or the sandbox toggle. Worse, the hook's `_validate_sessions` will silently DROP any sandbox entry on the next hook write if the entry's `id` doesn't pass `_is_valid_session_id` — and the sandbox writer at line 605-611 only checks `starts_with("sandbox-")`, not the regex (`_SESSION_ID_RE = ^[A-Za-z0-9_-]{1,128}$`). A sandbox id containing `/`, `.`, etc. is written by Rust then erased by the next hook event, with no UI signal.
- **Suggested fix:** Either (a) acquire `sessions.lock` from Rust (port the hook's flock/msvcrt scheme into a `with_sessions_lock<F>` helper in `security.rs` and route both sandbox commands through it), or (b) move sandbox-session storage into a separate file (`sandbox_sessions.json`) that the poller merges in-memory. (b) is the cleaner long-term fix — eliminates contention entirely and stops Rust ever writing the hook-owned file. Either fix should additionally validate sandbox IDs against the same regex the hook enforces.
- **Verification:** Concurrency test that spawns 100 alternating `write_sandbox_sessions` and `subprocess.run(['cue-hook','working'], …)` invocations and asserts every survivor entry from both writers is preserved in the final sessions.json. Plus a unit test asserting `write_sandbox_sessions` rejects ids with `/`, `..`, NUL, etc.

### F-correctness-003: `subagent_stop` clobbers `compacting`/`clearing` on counter→0
- **Severity:** high
- **Confidence:** 85
- **Files:** hooks/cue-hook:781-799
- **What:** When `SubagentStop` arrives, the hook decrements `active_subs`. Lines 783-799 choose the new action: `waiting`/`error` preserved, `active_subs > 0` → `subagent`, else → `idle`/`working` via `_turn_has_finished`. There is NO branch for `existing.state in ("compacting", "clearing")` — both transient transitional states get overwritten with `working` or `idle` when the last subagent ends mid-compact/clear. The 1500 ms `compacting_floor` on the Rust side mitigates compacting briefly but not after the floor expires; `clearing` has no symmetric floor. A fast subagent finish during `/compact` produces a 1–2 poll flash of `working`, and if the resolving PostCompact hook never fires the card pins on `working` (not `compacting`) until the 60 s stuck-active cap demotes it to `idle`.
- **Why it matters:** Parallel subagents finishing during `/compact` is a routine workflow (long sessions trigger auto-compact, agents in flight). The user sees a "working" pulse mid-compact that contradicts the actual session phase, and the wrong-state window is self-correcting only via demotion to `idle`, never back to `compacting`.
- **Suggested fix:** Add `compacting`/`clearing` to the preservation arm at line 783:
  ```python
  if existing.get("state") in ("waiting", "error", "compacting", "clearing"):
      action = existing["state"]
  ```
  Mirrors the same philosophy as the existing `waiting`/`error` guards and the CLAUDE.md contract that the subagent override applies to `working`/`done`/`idle` only.
- **Verification:** Pre-seed `state="compacting"`, `activeSubagents=1`; fire `subagent_stop`; assert resulting `state == "compacting"` and `activeSubagents == 0`. Repeat for `clearing`.

## Out of scope
- Hook `_quick_state_write` runs without re-reading sessions.json after `_forward_permission_request` returns — if a faster hook wrote during the HTTP wait, the stale-waiting guard at line 740 catches it but the quick-write at line 268 already committed. Medium; main path corrects within one event.
- Subagent rescue latch (session_monitor.rs:465-498) uses `(now - t) >= 0.0` so a small negative clock skew (NTP step) silently masks legitimately-recent agents for one poll.
- `last_assistant_text_ts` and `last_user_prompt_ts` come from JSONL timestamps and can race in-flight writes — `promote_decision`'s latch handles the bounce but not a one-poll mis-promotion.
- The hook's `_subagent_jsonls_active` 30 s window vs Rust's 15 s `should_demote_stale_subagent` grace — both correct in isolation but the asymmetry produces a single demote → re-arm cycle when a subagent dir is 16-29 s old. Cosmetic.
- `clearing` state has no `compacting_floor` analog; with the F-correctness-001 fix this becomes irrelevant.
- Stuck-active 60 s cap demotes both `compacting` and `clearing` to `idle` (session_monitor.rs:1088-1096) — for `clearing`, the real recovery is the next `SessionStart` writing `idle`, so the cap is harmless but redundant.
