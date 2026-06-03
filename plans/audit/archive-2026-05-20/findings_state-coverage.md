# State-Coverage Findings

## Summary
Cue's hook installer (`env_detect::HOOK_EVENTS`, env_detect.rs:165-179) wires only **13 of ~28** Claude Code hook events, and within those 13 it collapses every subtype (`SessionStart.source`, `Notification.notification_type`, `StopFailure.error_type`, `PreCompact.matcher`) into a single coarse state. The hook script (`cue-hook`) accepts only 10 actions and uses `hook_event_name` for exactly one decision — distinguishing `/clear`/`/compact` from a true startup. Result: roughly half of the canonical hook surface is invisible to Cue, several states are sticky with no exit path (`compacting` with no `PostCompact`, `error` with no recovery from `StopFailure`), and one mapping is actively wrong — every `Notification.permission_prompt` and `idle_prompt` is rendered as a green `done` instead of `waiting`.

## Event Coverage Matrix

| Event | Subtype / matcher | cue-hook handler | Rust reaction | Verdict |
|-------|-------------------|------------------|---------------|---------|
| SessionStart | startup | → `idle` (env_detect.rs:166); transcript-size heuristic at hook line 720-732 | `admit_session` (session_monitor.rs:963) | ok |
| SessionStart | resume | same → `idle` | start time reset only if transcript > 100 B | gap |
| SessionStart | clear | same `idle` with `is_clear=True` (resets `startedAt` only) | passes through | wrong |
| SessionStart | compact | same | same | wrong |
| Setup | init / maintenance | none | n/a | gap |
| SessionEnd | clear / resume / logout / prompt_input_exit / bypass_permissions_disabled / other | all → action `remove` → `state="ended"` (hook 703-711) | admit gate filters | partial (subtype collapsed) |
| UserPromptSubmit | (none) | → `thinking` (env_detect.rs:169) | thinking→working latch | ok |
| UserPromptExpansion | command_name | none | n/a | gap |
| PreToolUse | tool_name | → `working` (env_detect.rs:167) | overrides `thinking` | ok |
| PostToolUse | tool_name | → `working` (env_detect.rs:168) | same | ok |
| PostToolUseFailure | tool_name | → `error` (env_detect.rs:171); preserved at hook lines 762, 776, 783 | bypasses subagent override | partial |
| PostToolBatch | (none) | none | n/a | gap |
| PermissionRequest | tool_name | → `waiting`; quick-write + HTTP forward (hook 631-650) | `waiting` preserved | ok |
| PermissionDenied | tool_name | none | n/a | gap |
| Stop | (none) | → `idle`; may rewrite to `waiting` if last assistant ended in AskUserQuestion (hook 769-771) | done/idle paths | ok |
| StopFailure | rate_limit / authentication_failed / oauth_org_not_allowed / billing_error / invalid_request / model_not_found / server_error / max_output_tokens / unknown | none | n/a | **gap (critical)** |
| SubagentStart | agent_type | → `subagent`; bumps counter | counter override in hook; stale-subagent demoter (session_monitor.rs:1107) | ok |
| SubagentStop | agent_type | → `subagent_stop`; decrements counter; tail check via `_turn_has_finished` | symmetric Rust demoter | ok |
| TeammateIdle | (none) | none | n/a | gap |
| TaskCreated | (none) | none (only the TaskCreate tool *use* is parsed from JSONL) | n/a | gap |
| TaskCompleted | (none) | → `done` (env_detect.rs:175) | passes through | ok |
| FileChanged | filename | none | n/a | gap |
| ConfigChange | config_source | none | n/a | gap |
| InstructionsLoaded | load_reason | none | n/a | gap |
| CwdChanged | (none) | none | n/a | gap |
| PreCompact | manual / auto | both → `compacting` (env_detect.rs:177) | `compacting_floor` 1.5 s (session_monitor.rs:422) | partial (subtype collapsed) |
| PostCompact | manual / auto | none | n/a | **gap** |
| WorktreeCreate / WorktreeRemove | (none) | none | n/a | gap |
| Notification | permission_prompt | → `done` (env_detect.rs:176) — WRONG | green "finished" pill | **wrong (critical)** |
| Notification | idle_prompt | → `done` | same | **wrong (high)** |
| Notification | elicitation_dialog | → `done` | same | **wrong** |
| Notification | auth_success / elicitation_complete / elicitation_response | → `done` | pollutes done | wrong (informational) |
| Elicitation / ElicitationResult | mcp_server_name | none | n/a | gap |

Coverage tally: 13 of ~28 events wired; ~9 subtype dimensions collapsed; 1 subtype mapping inverted (`Notification → done` for prompt subtypes).

## Findings

### F-state-coverage-001: `Notification.permission_prompt` and `idle_prompt` render as green "done"
- **Severity:** critical
- **Confidence:** 95
- **Files:** cue-desktop/src-tauri/src/env_detect.rs:176; hooks/cue-hook:575 (`valid_actions` has no notification subtype branch)
- **What:** Every `Notification` hook event is mapped to a single state `done`, regardless of `notification_type`. The canonical subtypes are `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_complete`, `elicitation_response`. Three of those are user-attention events (the prompts and `elicitation_dialog`); the rest are informational. Cue paints them all green ("finished") — the opposite of what the prompt subtypes mean.
- **Why it matters:** A session that hits an MCP elicitation dialog or a notification permission prompt appears *complete* in the tray. The user dismisses the UI, never sees the prompt, and Claude eventually times out. Same class of bug `PermissionRequest → waiting` was created to fix, on a different code path.
- **Suggested fix:** Have the hook branch on `hook_data.get("notification_type")` and translate to `waiting` for `permission_prompt`, `idle_prompt`, `elicitation_dialog`; return-without-writing for informational subtypes. As a one-line cheap version: change env_detect.rs:176 from `("Notification", "done")` to `("Notification", "waiting")` — `done` is already produced by Stop/TaskCompleted, so we lose nothing.
- **Verification:** Trigger an MCP elicitation; confirm dashboard pill becomes `waiting`. Add a pytest in tests/hooks/test_cue_hook.py feeding `notification_type=permission_prompt`.

### F-state-coverage-002: `StopFailure` events leave session pinned on `working`
- **Severity:** critical
- **Confidence:** 90
- **Files:** cue-desktop/src-tauri/src/env_detect.rs:165-179 (no `StopFailure` row)
- **What:** Claude Code emits `StopFailure` with `error_type ∈ {rate_limit, authentication_failed, oauth_org_not_allowed, billing_error, invalid_request, model_not_found, server_error, max_output_tokens, unknown}` when a turn ends due to API error. Cue does not install it. The session is left in `working` (from the last PreToolUse / UserPromptSubmit) until the user submits a new prompt or `should_demote_turn_ended` sees a later `end_turn` in the JSONL — which never happens on a failed call.
- **Why it matters:** Rate-limit, auth, and billing errors are exactly the situations cue most needs to surface. Today the pill stays a green-cycling "Working" while Claude has actually given up. Only escapes: PID death or a manual user retry.
- **Suggested fix:** Add `("StopFailure", "error")` to `HOOK_EVENTS`. Persist `error_type` on the session entry; the UI already has the `error` state with red ✗. Mirror the `error` preservation already at hook lines 762, 776, 783 so subagent counters don't overwrite it.
- **Verification:** Set `ANTHROPIC_API_KEY=invalid`, run a prompt, confirm pill becomes red `error` within one hook event. Pytest asserting `StopFailure` with `error_type=rate_limit` writes `state=error`.

### F-state-coverage-003: `PostCompact` is unwired; only a 60 s safety cap unsticks `compacting`
- **Severity:** high
- **Confidence:** 90
- **Files:** cue-desktop/src-tauri/src/env_detect.rs:177; cue-desktop/src-tauri/src/session_monitor.rs:1088-1096 (`should_demote_stuck_active`)
- **What:** Cue installs `PreCompact → compacting` but not the symmetric `PostCompact`. Exit from `compacting` relies on whatever hook event fires next. The Rust side's `should_demote_stuck_active` forces `compacting → idle` at 60 s, which the source explicitly labels a band-aid for "an interrupted /compact whose resolving hook never fired" — the exact gap PostCompact would close.
- **Why it matters:** A compact that completes cleanly but with no follow-up tool call sits on `compacting` for up to 60 s.
- **Suggested fix:** Add `("PostCompact", "working")` to `HOOK_EVENTS`. The next Stop will land it on `idle` correctly.
- **Verification:** Run `/compact`; confirm the `compacting` pill leaves within ~1.5 s (the floor) instead of waiting on the 60 s cap.

### F-state-coverage-004: `SessionStart.source ∈ {resume, compact}` collapses to `idle` with timer reset
- **Severity:** high
- **Confidence:** 85
- **Files:** hooks/cue-hook:712-732, 829-836; cue-desktop/src-tauri/src/env_detect.rs:166
- **What:** All four SessionStart sources (`startup`, `resume`, `clear`, `compact`) hit the same `"idle"` action. The hook distinguishes `clear`/`compact` from `startup` via `transcript_path` size > 100 B, but only uses that to reset `startedAt` — `state` is still `idle`. For `resume` mid-turn the session shows `idle` for one cycle before the next PreToolUse promotes it. For `compact` the user just kicked off `/compact` and is actively working post-compact, but shows `idle`.
- **Why it matters:** "Resume" is a primary workflow (the `revive_session` Tauri command literally spawns `claude --resume`); a transient `idle` flash is confusing. Interacts with F-state-coverage-003.
- **Suggested fix:** Branch on `hook_data.get("source")` for SessionStart; write `working` for `compact`/`resume` (when transcript has pending assistant content), `idle` only for `startup`.
- **Verification:** `claude --resume <id>` against a session whose last entry is mid-tool-call; confirm Cue shows `working`/`subagent` immediately.

### F-state-coverage-005: `PermissionDenied` is unwired
- **Severity:** medium
- **Confidence:** 80
- **Files:** cue-desktop/src-tauri/src/env_detect.rs:165-179 (no `PermissionDenied`)
- **What:** The auto-deny classifier (deny rules, sandbox violations, MCP allowlists) fires `PermissionDenied` with `tool_name`. Cue installs `PermissionRequest` but not `PermissionDenied`.
- **Why it matters:** A series of silent denies looks identical to a healthy `working` pill; user thinks Claude is busy while every Bash call is being rejected.
- **Suggested fix:** Add `("PermissionDenied", "error")` (or a dedicated `denied` action mapped to a yellow/orange pill). Forward `tool_name` so the UI can show "Auto-denied Bash".
- **Verification:** Configure a Bash deny rule; ask Claude to run `ls`; confirm denial surfaces.

### F-state-coverage-006: `Setup`, `WorktreeCreate`, `WorktreeRemove`, `CwdChanged`, `InstructionsLoaded`, `ConfigChange`, `FileChanged` are unwired
- **Severity:** medium
- **Confidence:** 75
- **Files:** cue-desktop/src-tauri/src/env_detect.rs:165-179
- **What:** Seven events absent from `HOOK_EVENTS`. Cue covers their effects with 5 s/30 s polling (config counts session_monitor.rs:783; git status :773) or ignores. No `Setup` reaction — `_should_ignore_session` relies on `session_type`.
- **Why it matters:** `InstructionsLoaded` would invalidate config-counts instantly; `ConfigChange` catches between-poll edits; `FileChanged` could refresh git without polling; `Setup` should explicitly ignore so init-only invocations never flash a card.
- **Suggested fix:** Lightweight handlers: `Setup` → ignore; `ConfigChange`/`InstructionsLoaded` → no state change but emit invalidate signal; `Worktree*` → no-op for now to unblock future use.
- **Verification:** `claude --init-only`; confirm no session ever appears.

### F-state-coverage-007: `SessionEnd` subtype collapse loses recovery information
- **Severity:** low
- **Confidence:** 70
- **Files:** hooks/cue-hook:703-711; cue-desktop/src-tauri/src/env_detect.rs:178
- **What:** Six subtypes (`clear`, `resume`, `logout`, `prompt_input_exit`, `bypass_permissions_disabled`, `other`) all flatten to `"remove"` → `"ended"`. Frontend shows "revived" with no reason. `bypass_permissions_disabled` is a user-attention event that warrants `error`.
- **Why it matters:** Lossy but functional. Same hook payload fires `SessionEnd.clear` then `SessionStart.clear` ms later, so cue could light up `clearing` during the gap instead of `ended → clearing → idle`.
- **Suggested fix:** Persist `endReason` from `hook_data.get("source")`; surface in revived card subtitle. For `bypass_permissions_disabled`, set `error` instead of `ended`.
- **Verification:** `claude` then `/exit`; revived card shows exit reason.

### F-state-coverage-008: Subagent-counter override discards `agent_type`
- **Severity:** low
- **Confidence:** 65
- **Files:** hooks/cue-hook:572-575, 781-799
- **What:** SubagentStart/Stop carry `agent_type` (e.g. `code-reviewer`); Cue's integer counter discards it. The JSONL-scan rescue in session_monitor.rs already keys subagents by file so counter inaccuracy is bounded, but the dashboard could show *which* agent type is running.
- **Why it matters:** Cosmetic.
- **Suggested fix:** Persist `lastSubagentType`; UI pill can read "Running code-reviewer (2 active)".
- **Verification:** Spawn a Task agent; confirm `lastSubagentType` in sessions.json.

### F-state-coverage-009: `error` state has no recovery path absent explicit user action
- **Severity:** medium
- **Confidence:** 85
- **Files:** hooks/cue-hook:761-763, 776, 783-791; cue-desktop/src-tauri/src/session_monitor.rs:1067 (only `working|thinking|waiting` demoted on end_turn)
- **What:** Once `state="error"` is written it survives every event except an explicit non-error action. But `should_demote_turn_ended` excludes `error`. A session that errored, then was retried with a clean `end_turn` in the JSONL without firing a fresh observable hook, stays red forever.
- **Why it matters:** Real edge case — a missed PostToolUse/Stop combined with `error` pins the card red. CLAUDE.md excludes `error` from JSONL recovery because it "needs user attention", but the user has attended (by retrying); the `end_turn` is the proof.
- **Suggested fix:** Include `error` in `should_demote_turn_ended` (demote to `idle` when a newer `end_turn` exists). Becomes much less load-bearing once F-state-coverage-002 lands.
- **Verification:** Write `state="error"` manually, submit a prompt; confirm the card transitions out.

### F-state-coverage-010: `PreCompact.auto` vs `manual` collapse hides context-limit pressure
- **Severity:** low
- **Confidence:** 70
- **Files:** cue-desktop/src-tauri/src/env_detect.rs:177
- **What:** PreCompact's `matcher` distinguishes user `/compact` (`manual`) from auto-compact (`auto`). Cue installs a single PreCompact and treats both identically. The dashboard already has a context-usage bar; surfacing "auto-compact triggered" would be a stronger signal.
- **Why it matters:** UX polish.
- **Suggested fix:** Install two PreCompact entries with matchers, or read `hook_data.get("trigger")` in the hook and persist `compactReason`.
- **Verification:** Hit context limit and confirm auto-compact lights up differently than `/compact`.

## Out of scope
- Frontend rendering of new states (icon/animation/color) — outside the audited file list.
- The `permissionMode` pill suppression rule (CLAUDE.md says it only renders while state ∈ {working, thinking, subagent, compacting, clearing}) — couldn't verify without reading SessionCard.tsx.
- `tests/hooks/test_cue_hook.py` covers subagent-counter behavior thoroughly but has zero coverage for `notification_type` subtypes, `StopFailure`, `PostCompact`, or `SessionStart.source` differentiation — adding tests should be a precondition of any fix.
- The Tauri permission server (port 3002) correctly handles `PermissionRequest` end-to-end but has no companion for any other interactive event (notifications, elicitations).
