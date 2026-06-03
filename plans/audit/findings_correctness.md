# Correctness Findings

## Summary
The state machine is broadly sound and well-tested (374 Rust unit tests pass), but two real correctness defects survive: a subagent counter that leaks under `waiting`/`error` with no self-heal path (can pin a later card on false `subagent` forever), and `_quick_state_write` overwriting a live `error` card with `waiting` while silently dropping `errorType`. Several lower-severity issues are listed under Out of scope.

## Findings

### F-correctness-001: Subagent counter leaks under `waiting`/`error` and is never self-healed, pinning a later card on false `subagent`
- **Severity:** high
- **Confidence:** 80
- **Files:** hooks/cue-hook:869-877, hooks/cue-hook:203-230, hooks/cue-hook:900-908; cue-desktop/src-tauri/src/session_monitor.rs:1383-1417
- **What:** On `SubagentStart` while the session is in `waiting`/`error`, the hook increments `activeSubagents` but preserves the user-attention state (`action = existing["state"]`, lines 873-875). The persisted entry now has `state="waiting"` with `activeSubagents>0`. Both self-heal paths are gated strictly on `state == "subagent"`: the hook's `_maybe_clear_stale_subagent_counter` returns early unless `existing.get("state") == "subagent"` (line 219), and the Rust `should_demote_stale_subagent` returns false unless `state != "subagent"` (line 1389). So if the matching `SubagentStop` is ever missed (the exact failure mode these heals exist for) while the card sat in `waiting`/`error`, the non-zero counter is never cleared. When the session later legitimately transitions to `working` (line 907-908) or `idle`/`done` (line 862-865), the leaked counter overrides it back to `subagent`.
- **Why it matters:** A session that genuinely finished (idle/done) or is actively working renders permanently as `subagent` (blinking cyan) until the owning process dies — the liveness check is the only backstop, and only fires when the process is actually gone. Observable whenever a subagent is spawned during a permission prompt / error and its Stop event is dropped.
- **Suggested fix:** Broaden `_maybe_clear_stale_subagent_counter` and `should_demote_stale_subagent` to also run when `activeSubagents > 0` regardless of state (key the heal on the leaked counter, not the display state), OR don't increment `activeSubagents` while preserving `waiting`/`error` — defer the count until the state leaves the user-attention state.
- **Verification:** Construct a sessions.json entry with `state="waiting"`, `activeSubagents=2`, `stateChangedAt` > 60s ago, no subagent JSONLs on disk; fire a `working`/PostToolUse hook event and confirm the resulting state is `subagent` not `working`. Grep: `grep -n 'state.*!=.*subagent\|state.*==.*subagent' hooks/cue-hook cue-desktop/src-tauri/src/session_monitor.rs`.

### F-correctness-002: `_quick_state_write` overwrites a live `error` card with `waiting` and drops `errorType`
- **Severity:** high
- **Confidence:** 72
- **Files:** hooks/cue-hook:233-309, hooks/cue-hook:671-682
- **What:** `_quick_state_write` is the fast-path that writes `state="waiting"` on `Notification(elicitation_dialog|permission_prompt)` and on `PreToolUse(AskUserQuestion|ExitPlanMode)`. Unlike the main write path (which guards `existing_state in ("waiting","error")` and early-returns, lines 859-860/873/880, and carries `errorType` forward, lines 970-973), `_quick_state_write` unconditionally builds a fresh `state="waiting"` entry. It preserves `workspace`, `startedAt`, `source`, `activeSubagents`, tokens, and `permissionMode`, but it does NOT preserve `errorType` and applies NO guard for an existing `error` state. So a `Notification(permission_prompt)` (or elicitation) firing on a session currently shown as `error` clobbers the red error card to yellow `waiting` and permanently loses the error category. The stale-write guard (line 265, `existing_activity > hook_start_time`) only blocks out-of-order writes, not this state downgrade.
- **Why it matters:** A session that hit a `StopFailure` (e.g. rate_limit) and then surfaces any permission/elicitation dialog will silently flip `error`→`waiting`, masking the failure and dropping `errorType` so the UI can no longer tell the user *why* it broke. The main path was explicitly hardened against exactly this (lines 850-908); the quick path bypasses every one of those guards.
- **Suggested fix:** In `_quick_state_write`, mirror the main path: if `existing.get("state") == "error"`, either return without writing or carry `errorType` forward onto the new entry; at minimum copy `existing.get("errorType")` into `entry` when present.
- **Verification:** Seed sessions.json with `{state:"error", errorType:"rate_limit", lastActivity:<past>}`; invoke the hook with a `Notification` payload `notification_type=permission_prompt`; confirm the entry is not silently flipped to `waiting` with `errorType` dropped. Code check: `_quick_state_write` body contains no reference to `errorType` or to an `error`-state guard (grep `errorType` shows hits only at line >= 965).

## Out of scope
The following are real but below the HIGH/CRITICAL floor, or are low-confidence:

- **`running_tool_name` picks the LAST tool_use in a multi-tool assistant message** (jsonl_parser.rs:464-465, confirmed by `ASSISTANT_WITH_USAGE` test where Bash/Read/Bash yields "Bash"). This is the known-suspected bug, but it is cosmetic only — `running_tool_name`/`running_tool_target` feed a display pill, not any state verdict. `pending_tool_use`, `awaiting_user_prompt`, and `prompting_tool_use_ids` are all computed independently of which single tool is chosen, so no state goes wrong. Medium severity at most (wrong tool label on the card).

- **`should_demote_stale_subagent` with `None` metrics demotes a real subagent after 30s** (session_monitor.rs:1407-1415). If `refresh_metrics` (5s cadence) hasn't populated metrics for a freshly-rotated session within 30s of `stateChangedAt`, a genuinely-running subagent with no parsed metrics is demoted to idle. The 30s grace makes this rare in practice; flagged as a latent edge, not a confirmed live failure.

- **`is_promotable_to_waiting` includes `idle`** (session_monitor.rs:1250), so a JSONL `awaiting_user_prompt` can promote `idle`->`waiting`. This is intended (a stale unmatched AskUserQuestion legitimately means waiting), and the resolve path + pending-tool guard keep it from pinning. No defect, noted for completeness.

- **`extract_timestamp` only accepts RFC3339 / two `NaiveDateTime` formats** (jsonl_parser.rs:638-651). Integer JSON timestamps are handled (serde `as_f64()` covers ints). A timestamp with a non-`Z` named offset and no `T` separator, or space-separated, would fail to parse and yield `None`; downstream code tolerates `None` (treated as 0.0 / skipped), so this degrades gracefully rather than producing a wrong verdict.

- **`floor_extends` could briefly hold `idle`/`done` on `compacting` for up to 1.5s** (session_monitor.rs:1475-1480). By design; the comment documents the narrowing to neutral states only. Not a defect.

- **model_context.rs gate scanner** is heuristic byte-scanning of a minified binary; if Claude Code renames gate functions again or moves `return 1e6` >300 bytes from the call site, extraction silently falls back to the baked-in `FALLBACK_1M_SUBSTRINGS` (model_context.rs:24-31, 66-83). That fallback currently covers shipping 1M models, so a parse miss degrades to a correct-enough default rather than a wrong context window. Maintenance risk, not a current correctness bug.
