# Reliability Findings

## Summary
Prior audit fix commits (track 1-4) closed the validator-drops, cache-leak, missing-transcript-exit-signal, counter-drift, quick-write-validation, and corrupt-JSON hook-side issues. Remaining defects cluster around two surfaces: the permission HTTP server (no client-disconnect or pending-slot timeout) and concurrent writers to sessions.json (Rust's sandbox path skips the cross-process lock and can clobber hook writes). Several long-running risks persist (per-session JSONL cache growth, PID first-sight identity, Rust never auto-repairs corrupt sessions.json).

## Findings

### F-reliability-001: Permission server leaks pending slots — 64 abandoned requests permanently locks out new permissions
- **Severity:** critical
- **Confidence:** 95
- **Files:** cue-desktop/src-tauri/src/lib.rs:1491-1724; cue-desktop/src-tauri/src/permission_server.rs:23, 41-49
- **What:** `handle_permission_connection` awaits `rx.await` with NO timeout and NO TCP-stream-closed detection. If Claude Code aborts (Ctrl-C, parent kill, network error), the Python hook's TCP connection closes, but the Rust side keeps the `PendingRequests` entry and `permission_metadata` entry alive until the user clicks Approve/Deny in the UI (which may never happen — the user may not even know the abandoned prompt exists, or may dismiss the toast). `PendingRequests` is capped at `MAX_PENDING = 64`; once that fills with zombies, every subsequent legitimate permission request gets 503 (line 1668), and the Python hook returns `None` from `_forward_permission_request`, meaning Claude Code falls through with no decision payload.
- **Why it matters:** A user who restarts Claude Code mid-permission, kills a `claude` process while a prompt is pending, or just experiences a network blip, accumulates zombie slots. After 64 such events (which can happen in a single long-running session), Cue silently stops mediating permissions for ALL Claude Code processes on the machine until the desktop app is restarted. The UI gives no visible signal that the cap has been reached.
- **Suggested fix:** Wrap `rx.await` in `tokio::time::timeout(_, rx)` matching Python's 300s urlopen timeout (or shorter — 60s seems reasonable since the UI is local). On timeout, remove from both `pending` and `metadata`. Additionally race `rx` against a `stream.readable()` future or a `stream.read` returning `Ok(0)` so we detect the Python hook closing the connection and free the slot immediately. Surface a UI counter for pending permissions so users see when the cap approaches.
- **Verification:** Integration test: spawn the permission server, post a request, drop the TCP stream without resolving; verify `pending.len() == 0` within timeout window. Repeat 64 times and assert the 65th still succeeds.

### F-reliability-002: `write_sandbox_sessions` / `clear_sandbox_sessions` bypass the Python hook's file lock
- **Severity:** high
- **Confidence:** 90
- **Files:** cue-desktop/src-tauri/src/lib.rs:594-675; cue-desktop/src-tauri/src/security.rs:16-60; hooks/cue-hook:247-249, 653-655
- **What:** Both Tauri commands perform a read-modify-write of `sessions.json` via `std::fs::read_to_string` → mutate → `security::atomic_write`. Neither acquires the `sessions.lock` file that the Python hook holds for the same cycle. The atomic-write rename is OS-atomic, but the read-modify-write is NOT atomic across processes: if a hook fires between Rust's read and Rust's rename, the hook's update is silently overwritten when Rust renames.
- **Why it matters:** Sandbox mode is a frontend developer convenience (the UI calls `write_sandbox_sessions` whenever the sandbox list changes — see `SessionsTab.tsx:525`), which can fire at React's render cadence. Every concurrent hook write during that window can lose its session-state update. A user with a real session AND sandbox mode active can see real sessions stall on stale state for arbitrarily long.
- **Suggested fix:** Have Rust acquire the same `sessions.lock` flock (use `fs2` or `fd-lock` for cross-platform advisory locking) for the entire read-modify-write block in both commands. Match the hook's 2s wait-with-retry. Alternatively, partition sandbox sessions into a separate file (`sandbox-sessions.json`) that the Rust poller merges in-memory and never asks the hook to touch.
- **Verification:** Concurrency test: spawn the hook 50× concurrently with `write_sandbox_sessions` calls; assert every hook write is reflected in the final `sessions.json`.

### F-reliability-003: `poll_status` holds three mutexes across blocking disk I/O
- **Severity:** high
- **Confidence:** 80
- **Files:** cue-desktop/src-tauri/src/session_monitor.rs:241-266, 810-861
- **What:** The JSONL-presence demotion block (L241-266) acquires `active_since` and `process_identity` and then calls `self.jsonl_exists_on_disk(...)` per session. `jsonl_exists_on_disk` (L810-861) takes `resolved_paths` and performs `Path::exists()` stats plus a `std::fs::read_dir` fallback. All three mutexes plus the stat syscalls execute while iterating the active list. A slow disk (network FS, sleeping spindle, encrypted volume) blocks every other path that needs `active_since`, `process_identity`, or `resolved_paths` — which includes the next `poll_status` tick. The `read_dir` fallback (L847) scans every project directory under `~/.claude/projects`, which can be hundreds of entries on long-time Claude Code users.
- **Why it matters:** Polling cadence (1Hz) degrades to disk latency, freezing the dashboard. With many sessions and a slow disk, this compounds linearly.
- **Suggested fix:** Compute the existence checks BEFORE locking — collect `(id, workspace)` tuples under a quick lock, drop locks, perform all `Path::exists()` calls outside, then reacquire to apply demotions. Or keep a long-lived `resolved_paths` cache populated lazily and skip the `read_dir` fallback on the poll path (let it happen in `refresh_metrics` instead).
- **Verification:** Test with synthesized fixture: 100 active sessions, projects dir with 500 entries; measure `poll_status` duration; assert <50ms.

### F-reliability-004: `JsonlEntryCache` retains every parsed entry for the session lifetime
- **Severity:** high
- **Confidence:** 85
- **Files:** cue-desktop/src-tauri/src/jsonl_parser.rs:130-141, 245-254, 859-1003
- **What:** `refresh_entry_cache` appends every newly-parsed line to `cache.entries` and never trims. The 500 MB file-size cap exists but no entry-count cap. `aggregate_entries` re-walks the whole vector on every 5s refresh — multi-thousand-message sessions accumulate megabytes of `ParsedEntry` (each one holds owned `String`s, `HashMap<String, i64>`, `Vec<TodoItem>`) per session. The earlier audit added per-session retain pruning (good), but the per-session memory is still unbounded in conversation length.
- **Why it matters:** A long-running session that crosses /compact boundaries accumulates entries indefinitely. Memory grows O(messages) per session. Re-aggregation CPU also grows O(messages), turning the 5s refresh into a measurable load.
- **Suggested fix:** Maintain running aggregates in `JsonlEntryCache` directly (input/output token totals, last_*_ts fields, tool_counts) and only retain the trailing N entries needed for the pending-tool-use / end_turn detection. Drop older entries after they've been aggregated.
- **Verification:** Test: synthesize 50k-line JSONL, parse twice, assert `cache.entries.len()` is bounded and second-parse latency is constant in N.

### F-reliability-005: First-sight liveness accepts any PID without identity verification
- **Severity:** high
- **Confidence:** 70
- **Files:** cue-desktop/src-tauri/src/session_monitor.rs:1199-1219, 295-313
- **What:** `resolve_liveness` accepts `(Some(start), None)` (first-sight case) as Alive and captures whatever `start_time` the OS reports for that PID. If the original Claude Code process died between the hook write and the first Rust poll, and the OS happened to recycle that PID to an unrelated process, Cue captures the wrong identity and treats the unrelated process as the session owner. The session then survives liveness checks indefinitely.
- **Why it matters:** Rare in practice (PIDs rarely recycle within the 1Hz poll window) but produces hard-to-debug ghost sessions on heavily loaded systems or after reboot-recovery situations where Cue starts polling old `sessions.json` content.
- **Suggested fix:** On first-sight capture (`(Some(start), None)` arm), additionally verify the process's name/cmdline contains "claude" before accepting. Pass the process name into `resolve_liveness` from the sysinfo call site. Reject (return `Dead`) if name doesn't match.
- **Verification:** Extend `resolve_liveness` signature with `process_name: Option<&str>`; assert only `claude*` processes return Alive on first sight; add tests for the rejection path.

### F-reliability-006: Rust never auto-repairs persistently corrupt sessions.json
- **Severity:** high
- **Confidence:** 75
- **Files:** cue-desktop/src-tauri/src/session_monitor.rs:151-167
- **What:** On `serde_json::from_str` failure, `poll_status` logs and returns, preserving prior enriched state. The Python hook DOES rename-aside-and-reset on corruption (cue-hook:666-672), but only when a hook event fires. If Claude Code is idle (or all Claude Code processes have died), no hook fires, sessions.json stays corrupt, and the Rust poller silently shows stale state forever. Users see a frozen dashboard with no error indication.
- **Why it matters:** Cue stops reflecting reality without any user-visible signal.
- **Suggested fix:** Track consecutive parse-failure count in `SessionMonitorState`; after N (e.g. 5) consecutive failures, rename the corrupt file aside (`sessions.json.corrupt-<ts>`) and write an empty `{"sessions":{}}`. Surface a one-time tray notification when this happens.
- **Verification:** Unit test: pre-write garbage to sessions.json; call `poll_status` 10×; assert rename happened and file is now valid.

### F-reliability-007: Permission-server pending-insert vs metadata-insert race drops audit log entry
- **Severity:** high
- **Confidence:** 60
- **Files:** cue-desktop/src-tauri/src/lib.rs:1665-1692, 510-540
- **What:** The pending receiver is inserted (line 1665) BEFORE the metadata entry (line 1675) and BEFORE the frontend event (line 1692). These are separate mutexes acquired sequentially. If `record_permission_decision` somehow runs between lines 1672 and 1675, the `metadata.lock().remove(request_id)` at line 525 returns None and the permission log entry is silently dropped — no audit trail.
- **Why it matters:** Permission audit log is a security feature. Silently dropped entries break the audit trail. The request_id is `Uuid::new_v4()` so collision is astronomically unlikely, BUT the same code path is reused if the request_id is ever made deterministic.
- **Suggested fix:** Insert metadata BEFORE inserting into `pending`. Or merge `PendingRequests` and `permission_metadata` into one mutex-guarded struct.
- **Verification:** Concurrency test: insert + resolve in quick succession; assert audit log contains every decision.

### F-reliability-008: Subagent `ended_at` advances monotonically while subagent is running → rescue latch can re-fire
- **Severity:** high
- **Confidence:** 65
- **Files:** cue-desktop/src-tauri/src/jsonl_parser.rs:802-808; cue-desktop/src-tauri/src/session_monitor.rs:463-503
- **What:** `parse_subagent_jsonl` sets `ended_at = max(ts)` across all entries (L806-807) — for a still-running subagent, this advances every refresh. The rescue latch at L463-498 uses `(latest_ended - already).abs() > 0.001` to gate re-fire. Since `latest_ended` keeps growing as the subagent runs, the latch fires once per 5s refresh interval. Each fire flips state from done/idle → subagent. Result: state can flicker between subagent/done on every refresh while the live subagent runs but the hook counter is wrong.
- **Why it matters:** Visible UI flicker. The latch was intended to fire ONCE per rescue.
- **Suggested fix:** Either (a) make `ended_at` track the LAST entry timestamp only when `is_active == false` (otherwise use `started_at` or None), or (b) change the latch to record the latest_ended high-water mark and only re-fire when there's a NEW subagent.
- **Verification:** Test: simulate 10 refreshes of an active subagent JSONL; assert rescue fires at most once.

### F-reliability-009: PostToolUse arriving during permission HTTP wait clobbers `waiting` state to `working`
- **Severity:** high
- **Confidence:** 70
- **Files:** hooks/cue-hook:631-650, 712-866
- **What:** PermissionRequest flow: (1) `_quick_state_write` writes `waiting`. (2) Hook blocks up to 300s on HTTP. (3) Main write path runs. Between (1) and (3), if any other hook event fires for the same session (e.g., a PostToolUse from a parallel tool call), it grabs the lock and writes its own state. The main write path's stale-write guard (L739-742) only fires for `action == "waiting"`. The OTHER concurrent hook (action != waiting) bypasses that guard entirely, overwriting `waiting` with `working`.
- **Why it matters:** Misleading UI state during the entire user-deliberation window for permission prompts.
- **Suggested fix:** Make `_quick_state_write` set a sticky marker (e.g., `pendingPermission: true`) that the main write path of OTHER hooks checks. If pendingPermission is true and the candidate new state is not a user-attention state, keep state as `waiting`. Clear the marker when permission resolves.
- **Verification:** Concurrency test: fire PermissionRequest hook, then immediately fire PostToolUse for same session; assert sessions.json shows `waiting` until the permission hook completes.

## Out of scope
- Hook process termination by OS (OOM killer, SIGTERM) — Claude Code retries on next event.
- `permission_log.jsonl` write reliability — append+fsync per entry is the right pattern.
- `process_identity.retain` only runs when liveness block executes — but runs every poll unconditionally, so no leak.
- `_validate_sessions` regression risk — mitigated by the outer try/except in `_quick_state_write`.
- JSONL parser advancing past bad lines — verified correct.
- Lock ordering between `refresh_metrics` and `poll_status` — verified no cycle.
- `_quick_state_write` overwriting prior `subagent` state with `waiting` — intentional per CLAUDE.md.
- 500 MB JSONL file-size cap drops all metrics for very large sessions — rare; correctness preserved.
- Sessions.json `ended` entries never purged — admission gate filters by launched_at.
