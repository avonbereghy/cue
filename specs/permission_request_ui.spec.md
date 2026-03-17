# Feature: Permission Request UI + CLAUDE.md Hardening

## Overview

Add an in-app permission approval UI to claude-cue so users can approve or deny Claude Code's `PermissionRequest` events directly from the dashboard — instead of switching to the terminal/VSCode. Also harden the desktop app's CLAUDE.md with cross-platform guidance, a schema contract, hook-event mapping, and audit escalation rules. Together these changes evolve claude-cue from a passive status monitor into an active session control surface.

## Target Users

Claude Code power users running multiple concurrent sessions who want:
- Glanceable status (existing) **plus** actionable permission control (new)
- A single UI for monitoring and responding to Claude across sessions
- Full audit trail of what they approved/denied

## Functional Requirements

### Permission Request UI

#### FR-PERM-001: HTTP Hook Server
When the Tauri app launches, the system shall start a localhost-only HTTP server (bound to `127.0.0.1`) that accepts POST requests from Claude Code `PermissionRequest` hooks.

#### FR-PERM-002: Permission Request Reception
When a POST request arrives at `/permission-request`, the system shall parse the JSON payload (`tool_name`, `tool_input`, `session_id`, `hook_event_name`), associate it with the matching session row, and display an inline permission prompt under that session's row in the dashboard.

#### FR-PERM-003: Summary + Expand Display
When a permission request is displayed, the system shall show:
- A one-line human-readable summary (e.g., "Run: `npm install`", "Edit: `src/main.rs`", "Read: `package.json`")
- An expandable detail section showing the full `tool_name` + `tool_input` JSON
- Approve and Deny buttons

#### FR-PERM-004: Smart Summaries
When formatting the one-line summary, the system shall parse `tool_input` to produce human-readable descriptions based on `tool_name`:
- `Bash` → "Run: `{command}`" (truncated to 80 chars)
- `Read` → "Read: `{file_path}`"
- `Edit` → "Edit: `{file_path}`"
- `Write` → "Write: `{file_path}`"
- `Glob` → "Search: `{pattern}`"
- `Grep` → "Search for: `{pattern}`"
- Other → "`{tool_name}`: {first key/value from tool_input}"

#### FR-PERM-005: Approve/Deny Response
When the user clicks Approve or Deny, the system shall respond to the pending HTTP request with:
- Approve: `{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}`
- Deny: `{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "deny"}}}`

#### FR-PERM-006: No Auto-Timeout
The system shall never auto-approve or auto-deny permission requests. Permissions remain pending until the user explicitly clicks Approve or Deny. If the user does not respond, Claude Code's own 10-minute timeout handles the fallback — the app takes no action.

#### FR-PERM-007: Permission Audit Log
When a permission decision is made, the system shall:
- Append the decision to a local log file at `{STATUS_DIR}/permission-log.jsonl` (one JSON object per line: `timestamp`, `session_id`, `tool_name`, `tool_input`, `decision`)
- Display the decision history in the dashboard under each session's expandable section

#### FR-PERM-008: Multiple Pending Requests
While multiple sessions have pending permission requests simultaneously, the system shall display each inline under its respective session row, independently actionable.

#### FR-PERM-009: Visual Indicator
While a session has a pending permission request, the system shall highlight that session's row (e.g., yellow accent border) and update the tray icon state to "waiting" (yellow dot) if it isn't already.

### CLAUDE.md Hardening

#### FR-DOC-001: Localhost Network Exception
The CLAUDE.md security rules shall be amended to:
> "NO outbound network calls. Localhost-only HTTP server (`127.0.0.1`) is permitted for Claude Code hook communication. Never bind to `0.0.0.0`. No HTTP clients in deps."

#### FR-DOC-002: Cross-Platform Hook Guidance
The CLAUDE.md shall include a note:
> "Hook must support macOS (`~/Library/Application Support/`), Linux (`$XDG_DATA_HOME/claude-cue/` or `~/.local/share/claude-cue/`), and Windows (`%LOCALAPPDATA%\Claude Cue\`). No `fcntl` on Windows — use `msvcrt.locking` or the `filelock` package."

#### FR-DOC-003: Session Schema Contract
The CLAUDE.md shall document the `sessions.json` schema:
```json
{
  "sessions": {
    "<session_id>": {
      "id": "string",
      "workspace": "string (absolute path)",
      "state": "idle | working | waiting | error | done | subagent",
      "lastActivity": "number (unix timestamp)",
      "startedAt": "number (unix timestamp)"
    }
  }
}
```
> "Both the Python hook (writer) and Rust backend (reader) must conform to this schema. Any changes require updating both sides."

#### FR-DOC-004: Hook Event → State Mapping
The CLAUDE.md shall include the canonical mapping:

| Hook Event | State | Tray Color |
|---|---|---|
| `SessionStart` | idle | dim white |
| `PreToolUse` | working | blinking white |
| `PostToolUse` | working | blinking white |
| `UserPromptSubmit` | working | blinking white |
| `PermissionRequest` | waiting | yellow |
| `PostToolUseFailure` | error | red |
| `SubagentStart` | subagent | blinking cyan |
| `SubagentStop` | working | blinking white |
| `Stop` | done | green |
| `TaskCompleted` | done | green |
| `Notification` | done | green |
| `SessionEnd` | (removed) | — |

#### FR-DOC-005: Specs/Plans Reference
The CLAUDE.md shall include:
> "See `../specs/` for feature specifications and `../plans/` for architecture decisions (especially `cross_platform_final_plan.md`)."

#### FR-DOC-006: Audit Escalation
The CLAUDE.md audit rules shall be amended to:
> "Run `cargo audit` after adding any Rust dependency and `npm audit` after adding any npm dependency. If either finds a vulnerability, do not proceed — flag it to the user before continuing."

## Non-Functional Requirements

### Performance
- HTTP server response handling: < 50ms from button click to HTTP response
- Permission prompt render: < 100ms from POST receipt to visible UI
- Audit log append: < 10ms (async, non-blocking)
- No impact on existing 1s session polling or 5s metrics parsing

### Security
- HTTP server MUST bind to `127.0.0.1` only — never `0.0.0.0`
- Reject requests not matching the expected Claude Code hook payload schema
- Validate `session_id` against known sessions (warn on unknown, still display)
- Permission log file: 0600 permissions (Unix), restricted ACL (Windows)
- Atomic writes for permission log (temp + rename pattern)
- No CORS headers (not needed for non-browser clients)

### Reliability
- If the HTTP server fails to start (port in use), fall back to file-based hook mode and show a warning in the dashboard
- If the app crashes or quits mid-permission, Claude Code's own 10min timeout handles it — no orphaned approvals possible
- Graceful handling of malformed hook payloads (log + ignore, don't crash)

## Acceptance Criteria

### AC-001: Permission Request Appears in Dashboard
Given claude-cue is running and the HTTP hook server is active,
When Claude Code sends a `PermissionRequest` hook to the configured port,
Then the matching session row shows an inline permission prompt with summary, expand button, Approve, and Deny.

### AC-002: Approve Returns Correct Response
Given a pending permission request is displayed,
When the user clicks Approve,
Then the HTTP response contains `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` and the prompt disappears.

### AC-003: Deny Returns Correct Response
Given a pending permission request is displayed,
When the user clicks Deny,
Then the HTTP response contains `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}` and the prompt disappears.

### AC-004: No Auto-Timeout
Given a permission request has been pending for any duration,
When the user has not clicked Approve or Deny,
Then the system takes no action — the request remains visible until the user decides or Claude Code's own timeout expires.

### AC-005: Audit Log Written
Given a permission decision has been made,
When the decision is recorded,
Then a JSONL line is appended to `permission-log.jsonl` containing timestamp, session_id, tool_name, tool_input summary, and decision.

### AC-006: Audit History in Dashboard
Given a session has prior permission decisions,
When the user expands that session's permission history,
Then all past decisions are shown with timestamp, tool summary, and approve/deny badge.

### AC-007: Multiple Concurrent Requests
Given sessions A and B both have pending permission requests,
When the user approves A and denies B,
Then each response goes to the correct Claude Code instance with the correct decision.

### AC-008: Smart Summary Parsing
Given a `Bash` tool permission request with command `npm install --save-dev typescript`,
When it is displayed,
Then the summary line reads "Run: `npm install --save-dev typescript`".

### AC-009: Server Localhost Only
Given the HTTP hook server is running,
When a connection attempt comes from a non-loopback address,
Then the connection is rejected.

### AC-010: CLAUDE.md Contains All Updates
Given the CLAUDE.md has been updated,
Then it contains: localhost exception rule, cross-platform hook guidance, sessions.json schema, hook-event-to-state mapping, specs/plans reference, and audit escalation rule.

## Error Handling

| Error Condition | Behavior |
|---|---|
| Port already in use | Log warning, show banner in dashboard: "Permission server unavailable — port {N} in use". Fall back to file-based hook. |
| Malformed JSON payload | Return HTTP 400, log the raw payload for debugging, don't show in UI |
| Unknown session_id | Show permission prompt with "Unknown session" label, still actionable |
| HTTP server crashes | Attempt restart once. If fails, show persistent warning in dashboard. |
| Permission log write fails | Log to stderr, continue — don't block the approval response |
| App quits with pending requests | Claude Code's 10min timeout handles it. No cleanup needed. |

## Implementation TODO

### Rust Backend (src-tauri)
- [ ] Add `axum` or `tiny_http` dependency (localhost HTTP server — run `cargo audit` after)
- [ ] Create `permission_server.rs` module — start server on app launch, bind `127.0.0.1:{port}`
- [ ] Define `PermissionRequest` and `PermissionDecision` structs
- [ ] Implement POST `/permission-request` handler — parse payload, emit Tauri event to frontend
- [ ] Implement response channel (tokio oneshot) — frontend sends decision back, handler responds to HTTP
- [ ] Add configurable port to settings (default: TBD, check port registry)
- [ ] Create `permission_log.rs` — append JSONL, atomic writes, 0600 permissions
- [ ] Add smart summary formatter (tool_name → human-readable)
- [ ] Unit tests: payload parsing, summary formatting, log writing

### React Frontend (src/)
- [ ] Create `PermissionPrompt` component — summary line, expand/collapse, Approve/Deny buttons
- [ ] Create `PermissionHistory` component — list of past decisions with badges
- [ ] Integrate into session row — show inline when permission event arrives
- [ ] Add Settings field: port number
- [ ] Listen for Tauri `permission-request` events
- [ ] Send decision back via Tauri command (`approve_permission` / `deny_permission`)
- [ ] TypeScript types for `PermissionRequest`, `PermissionDecision`, `PermissionLogEntry`

### Hook Configuration
- [ ] Update `install.sh` to add HTTP hook entry for `PermissionRequest` event alongside existing command hook
- [ ] Document the hook config in README
- [ ] Test that both hooks fire (command hook updates status to "waiting", HTTP hook sends permission UI)

### CLAUDE.md Updates
- [ ] Amend security rule: localhost-only network exception (FR-DOC-001)
- [ ] Add cross-platform hook guidance (FR-DOC-002)
- [ ] Add sessions.json schema contract (FR-DOC-003)
- [ ] Add hook event → state mapping table (FR-DOC-004)
- [ ] Add specs/plans reference (FR-DOC-005)
- [ ] Amend audit escalation rule (FR-DOC-006)

### Testing
- [ ] Integration test: mock Claude Code POST → verify UI prompt appears → click Approve → verify HTTP response
- [ ] Integration test: permission stays pending indefinitely until user acts
- [ ] Unit test: smart summary for each tool type
- [ ] Unit test: permission log JSONL format
- [ ] Manual test: two concurrent sessions with simultaneous permission requests

## Out of Scope
- Bulk approve/deny ("allow all from this session")
- Rule-based auto-approval (e.g., "always allow Read")
- Remote/SSH permission forwarding
- macOS Swift app integration (this is Tauri-only for now)
- Push notifications to mobile

## Open Questions
- [ ] Which port to use for the HTTP hook server? (Check port registry in global CLAUDE.md — 3001 is taken by MCP servers)
- [ ] Should the permission log have a max size / rotation policy?
- [ ] Should the "waiting" tray color change to distinguish "waiting for terminal permission" vs "waiting for dashboard permission"?
- [ ] Does the existing `PermissionRequest` command hook (status → waiting) need to remain alongside the new HTTP hook, or can the HTTP hook handle both status update and permission UI?
