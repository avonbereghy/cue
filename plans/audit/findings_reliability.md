# Reliability Findings

## Summary
State plumbing is overall well-considered (atomic writes, file locks, pure-predicate recovery paths). Defects: the Python hook's schema validator silently drops sessions on every invocation, five Rust caches grow unbounded, several active states have no transcript-driven exit signal, and the cross-process counter drift can loop forever.

## Findings

### F-reliability-001: `_validate_sessions` silently drops sessions written by older hooks
- **Severity:** critical
- **Confidence:** 90
- **Files:** hooks/cue-hook:122-143, 560-561
- **What:** `_validate_sessions` runs unconditionally; any entry missing a required key or with wrong type is silently dropped before write-back. `_quick_state_write` also writes back without validating. A single malformed entry wipes itself on the next hook call from any session.
- **Why it matters:** Real live sessions disappear off the dashboard when another session fires a hook, with no error surface.
- **Suggested fix:** Don't drop — leave malformed entries in place untouched (or coerce missing fields to safe defaults: lastActivity/startedAt → now, missing state → idle). Add debug log. Call `_validate_sessions` inside `_quick_state_write` too.
- **Verification:** Python test: pre-seed sessions.json with one malformed + one valid entry; fire hook for valid; assert both persist.

### F-reliability-002: Five mutex-guarded HashMaps grow without bound
- **Severity:** high
- **Confidence:** 95
- **Files:** cue-desktop/src-tauri/src/session_monitor.rs:51-65, 660-680, 802-877
- **What:** `metrics_cache`, `jsonl_entry_cache`, `file_mod_dates`, `resolved_paths`, `output_speed_cache` are inserted-into but never pruned. Only `process_identity`, `active_since`, `promoted_for_prompt`, `subagent_rescued_for`, `compacting_floor` get `.retain()` per poll.
- **Why it matters:** Memory grows linearly with session-ids ever observed. Long-running tray app accumulates parsed JSONL state until OS pressure kills it.
- **Suggested fix:** In `poll_status` (where `current_ids` is computed), extend `.retain()` to all five caches. Respect lock-ordering (cache locks before `enriched_sessions`).
- **Verification:** Unit test: simulate 100 poll cycles with rotating session ids; assert each cache size <= active session count.

### F-reliability-003: `waiting` / `compacting` / `clearing` lack a transcript-driven exit signal
- **Severity:** high
- **Confidence:** 80
- **Files:** cue-desktop/src-tauri/src/session_monitor.rs:907-924, 961-1010
- **What:** `should_demote_turn_ended` gates strictly on `working|thinking`. If a permission prompt is resolved out-of-band, or `/compact` errors without follow-up hook, sessions stay pinned until parent PID dies.
- **Why it matters:** Stuck cards for the lifetime of Claude Code, potentially hours/never.
- **Suggested fix:** Add JSONL-based recovery: (a) `waiting` → `idle` when end_turn newer than stateChangedAt + no pending tool_use; (b) `compacting`/`clearing` → `idle` after 60s past stateChangedAt cap.
- **Verification:** Extend `should_demote_turn_ended` test set with `waiting` case + new `should_demote_stuck_compacting` predicate with cap-boundary tests.

### F-reliability-004: `activeSubagents` drift loops between Rust demotion and hook override
- **Severity:** high
- **Confidence:** 75
- **Files:** hooks/cue-hook:628-667; cue-desktop/src-tauri/src/session_monitor.rs:357-380
- **What:** Rust's `should_demote_stale_subagent` clears `s.active_subagents = 0` in-memory but never writes sessions.json. Next hook event reads stale on-disk counter and re-applies subagent override → flicker between subagent/idle. Duplicate SubagentStart deliveries with a single Stop also leak counter permanently.
- **Why it matters:** Visible flicker on stuck sessions; counter only recovers when Claude Code exits.
- **Suggested fix:** Move counter-reset to the only writer (Python hook). Before each event: if `existing.state == "subagent"` AND stateChangedAt > 60s AND no subagent JSONL recently modified, reset `active_subs = 0`. Complements Rust demotion.
- **Verification:** Python test: pre-seed activeSubagents=2, stateChangedAt 90s old; fire `working` hook; assert resulting activeSubagents=0 and state=working.

### F-reliability-005: `_quick_state_write` skips schema validation
- **Severity:** high
- **Confidence:** 75
- **Files:** hooks/cue-hook:146-226, 245-257, 535-547
- **What:** PermissionRequest path: quick-write writes waiting, releases lock, blocks 300s on HTTP, reacquires lock, writes final state. Quick-write does NOT call `_validate_sessions`, so malformed entries survive then get dropped by main path during the 5-min window.
- **Why it matters:** Sessions can vanish during user's permission deliberation.
- **Suggested fix:** Call `_validate_sessions` immediately after read inside `_quick_state_write`. Lower HTTP timeout from 300s.
- **Verification:** Python test: call `_quick_state_write` against sessions.json with one malformed entry; assert it remains (after F-001's non-destructive fix).

### F-reliability-006: Persistently corrupt sessions.json freezes Cue until next hook fires
- **Severity:** high
- **Confidence:** 70
- **Files:** cue-desktop/src-tauri/src/session_monitor.rs:134-150
- **What:** Parse failure logs + returns; Rust never repairs. Hook repairs (cue-hook:550-555) but only on a triggering event. If Claude Code idle, dashboard shows stale state indefinitely.
- **Why it matters:** Stale dashboard for duration of corruption + Claude Code idleness.
- **Suggested fix:** After N consecutive parse failures (e.g. 5), have Rust rename aside and create empty `{"sessions":{}}`. Symmetric to hook behavior.
- **Verification:** Unit test: write garbage; call poll_status 10x; assert file renamed and replaced.

### F-reliability-007: `JsonlEntryCache` retains every parsed entry forever
- **Severity:** high
- **Confidence:** 80
- **Files:** cue-desktop/src-tauri/src/jsonl_parser.rs:13, 130-255, 859-1074
- **What:** 500 MB read cap exists but no entry cap. `refresh_entry_cache` pushes every parsed line; re-walks the vector every refresh. Multi-thousand-message sessions = megabytes per session, multiplied by F-002.
- **Why it matters:** Memory grows linearly with conversation length; CPU re-aggregation cost grows too.
- **Suggested fix:** Either cap `entries.len()` to a sliding window with running aggregates, or compute aggregates incrementally and drop parsed entries.
- **Verification:** Test: synthesize 50k-line JSONL, parse twice, assert cache size sub-linear in N.

### F-reliability-008: First-sight PID identity is vulnerable to PID reuse
- **Severity:** high
- **Confidence:** 65
- **Files:** cue-desktop/src-tauri/src/session_monitor.rs:289-328, 1064-1088
- **What:** On first liveness check (`Some(start), None` case in resolve_liveness), accepts any start_time without independent verification. If original process died before observation and OS recycled the PID, Cue captures the wrong process.
- **Why it matters:** Rare ghost sessions on heavily-loaded systems.
- **Suggested fix:** On first-sight capture, verify process name/cmdline contains `claude` before accepting identity.
- **Verification:** Extend `resolve_liveness` signature with process-name parameter; assert only claude-* processes Alive on first sight.

## Out of scope
- `open_jsonl_no_follow` correct on Unix; Windows lacks symlinks — defensive only.
- `refresh_metrics` silently drops on parse failure — acceptable, next poll retries.
- `refresh_supplemental` runs git_status/config_counts synchronously per workspace — perf, not reliability.
- `encode_workspace_path` `/`→`-` collisions — pre-existing convention.
- `active_since` cleared then re-seeded on rescue re-promotion — cosmetic.
- `promote_decision` fallback `text_after_prompt=true` when both ts None — can over-promote extended-thinking.
- 3s dedup window could collapse legitimately rapid pair — narrow.
