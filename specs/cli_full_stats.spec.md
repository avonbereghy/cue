# Feature: CLI Full Session Stats

## Overview

Enhance the existing `cue-desktop --status` CLI to display all session statistics that the GUI dashboard shows — including session ID, message counts, input/output tokens, tool usage breakdown, model, source client, cache hit rate, context usage, and git branch. This enables full session monitoring over SSH without needing the desktop UI.

## Functional Requirements

### FR-CLI-001: JSONL Enrichment
When `--status` is passed, the CLI shall parse JSONL conversation logs using the existing `jsonl_parser` module to populate `SessionMetrics` for each session, matching the data the GUI receives.

### FR-CLI-002: Summary Header
When `--pretty` is passed, the CLI shall display a summary header showing total active session count, total message count, and total token count (matching the UI's summary bar).

### FR-CLI-003: Session ID Display
The CLI shall display the first 8 characters of the session ID for each session, in both JSON and pretty output modes.

### FR-CLI-004: Message Counts
The CLI shall display user message count and total message count (formatted as `user/total`) for each session.

### FR-CLI-005: Token Breakdown
The CLI shall display input tokens (↓) and output tokens (↑) separately for each session, using the same `format_tokens` abbreviation (K/M suffixes).

### FR-CLI-006: Tool Usage Breakdown
The CLI shall display tool usage counts per session, showing tool name and count for each tool used (e.g., `Edit 13 | Read 10 | Bash 6`), sorted by count descending.

### FR-CLI-007: Model Display
The CLI shall display the model display name (e.g., "Opus 4.6", "Sonnet 4.6") for each session, using the existing `model_display_name` enrichment.

### FR-CLI-008: Source Client Display
Where a source client is known, the CLI shall display the client display name (e.g., "VSCode", "Terminal", "iTerm") for each session.

### FR-CLI-009: Cache Hit Rate
Where cache tokens are present (cache_read > 0 or cache_creation > 0), the CLI shall display the cache hit percentage for each session.

### FR-CLI-010: Context Usage
The CLI shall display context usage as a percentage and token count vs limit (e.g., `13% 132.6K/1M`) for each session, using the existing `context_usage_percent` and `context_limit` enrichment fields.

### FR-CLI-011: Context Progress Bar
When `--pretty` is passed, the CLI shall render a text-based progress bar for context usage using block characters (e.g., `████░░░░░░`).

### FR-CLI-012: Git Branch Display
Where a git branch is known (and not "HEAD"), the CLI shall display the branch name for each session.

### FR-CLI-013: Duration Display
The CLI shall display session duration in human-readable format (e.g., `18m 37s`, `1h 02m 15s`), using the existing `format_duration` function.

### FR-CLI-014: State Display
The CLI shall display a state icon and state name for each session, using the existing `state_icon` mapping and colored when ANSI is enabled (green=done, yellow=waiting, red=error, cyan=subagent, white=working/idle).

### FR-CLI-015: Compact Mode
When `--compact` is passed alongside `--pretty`, the CLI shall render each session as a single dense line containing: state icon, title, state, session ID (8 chars), messages, input/output tokens, tool count, model, duration, and context %.

### FR-CLI-016: Rich Mode (Default Pretty)
When `--pretty` is passed without `--compact`, the CLI shall render each session as a multi-line card with all stats laid out for readability (summary line, detail line, tool chips line, context bar line).

### FR-CLI-017: ANSI Color Auto-Detection
The CLI shall use ANSI color codes when stdout is a TTY, and omit them when stdout is piped to another process.

### FR-CLI-018: JSON Full Enrichment
When `--status` is passed without `--pretty`, the CLI shall output JSON containing all enriched fields: `id`, `workspace`, `state`, `stateIcon`, `displayTitle`, `durationSecs`, `messageCount`, `userMessageCount`, `inputTokens`, `outputTokens`, `totalTokens`, `cacheCreationTokens`, `cacheReadTokens`, `cacheHitPercent`, `model`, `modelDisplayName`, `sourceDisplay`, `toolCounts`, `contextUsagePercent`, `contextLimit`, `lastInputTokens`, `gitBranch`.

### FR-CLI-019: Sort Order
The CLI shall sort sessions with active states (working, waiting, subagent) first, then idle, then done/error, with each group sorted by start time (most recent first).

### FR-CLI-020: Privacy (Existing)
The CLI shall display only the leaf directory name for workspaces by default, showing full paths only when `--show-paths` is passed.

## Non-Functional Requirements

### Performance
- CLI output shall complete within 2 seconds for up to 20 concurrent sessions
- JSONL parsing should be bounded: skip files larger than 50MB to avoid blocking

### Security
- No network calls — all data read from local filesystem
- Workspace paths hidden by default (leaf name only) for privacy
- JSONL file paths derived from sessions.json workspace field, validated through existing `sanitize_workspace_path`

### Compatibility
- Must work over SSH (no GUI dependencies)
- ANSI colors degrade gracefully (auto-detect TTY)
- Output parseable by common tools (`jq` for JSON, `grep`/`awk` for pretty)

## Acceptance Criteria

### AC-001: Full Stats in Pretty Mode
Given two active sessions with JSONL logs,
When the user runs `cue-desktop --status --pretty`,
Then the output shows all stats for each session: state icon, title, session ID (8 chars), state badge, duration, messages (user/total), input tokens, output tokens, tool breakdown, model, source, cache %, context bar with %, and git branch.

### AC-002: Full Stats in JSON Mode
Given an active session with JSONL logs,
When the user runs `cue-desktop --status`,
Then the JSON output contains all enriched fields including `inputTokens`, `outputTokens`, `toolCounts`, `modelDisplayName`, `sourceDisplay`, `cacheHitPercent`, `contextUsagePercent`, and `gitBranch`.

### AC-003: Compact Mode
Given active sessions,
When the user runs `cue-desktop --status --pretty --compact`,
Then each session is rendered as a single line with key stats.

### AC-004: Summary Header
Given 3 active sessions with a combined 150 messages and 80K tokens,
When the user runs `cue-desktop --status --pretty`,
Then the header shows `● 3 sessions  💬 150 messages  ↕ 80.0K tokens`.

### AC-005: Color Auto-Detection
Given the user runs the CLI with stdout connected to a TTY,
When the output is rendered,
Then ANSI color codes are present in the output.

Given the user pipes the CLI output (`| jq .`),
When the output is rendered,
Then no ANSI escape codes are present in the output.

### AC-006: No JSONL Graceful Degradation
Given a session whose JSONL log file does not exist or is unreadable,
When the CLI runs,
Then the session is still displayed with available data from sessions.json (state, workspace, duration) and zeroed metrics.

### AC-007: Sort Order
Given one session in "done" state and one in "working" state,
When the user runs `cue-desktop --status --pretty`,
Then the "working" session appears before the "done" session.

### AC-008: SSH Usability
Given the user is connected via SSH to the machine,
When they run `cue-desktop --status --pretty`,
Then the output renders correctly in the terminal without requiring a display server.

## Error Handling

| Error Condition | Behavior |
|-----------------|----------|
| sessions.json missing | Print "No active sessions" (pretty) or `{"sessions":[]}` (JSON), exit 0 |
| sessions.json malformed | Print "No active sessions" / empty JSON, exit 0 |
| JSONL file missing | Display session with default metrics (zeros) |
| JSONL file corrupt/partial | Parse what's readable, skip corrupt lines |
| JSONL file >50MB | Skip parsing, use default metrics |
| No TTY (piped output) | Disable ANSI colors automatically |
| Unknown model string | Display raw model string as-is |
| Unknown source client | Omit source display field |

## Implementation TODO

### Rust Backend (cli.rs)
- [ ] Import and call JSONL parser (`jsonl_parser::parse_session_log`) in `load_sessions()` to populate `SessionMetrics`
- [ ] Add `--compact` flag parsing alongside existing `--pretty` and `--show-paths`
- [ ] Add TTY detection (`atty` crate or `std::io::IsTerminal`)
- [ ] Expand `JsonSession` struct to include all enriched fields (FR-018)
- [ ] Implement `print_pretty_rich()` — multi-line card format with summary header
- [ ] Implement `print_pretty_compact()` — single-line-per-session format
- [ ] Add ANSI color helper functions (state colors, dim text, bold)
- [ ] Add context progress bar renderer (block chars)
- [ ] Add cache hit % calculation and display
- [ ] Update sort logic: active states first, then by start time within groups
- [ ] Add summary header computation (aggregate counts across sessions)

### Testing
- [ ] Unit test: `print_pretty_rich` output contains all expected fields
- [ ] Unit test: `print_pretty_compact` renders one line per session
- [ ] Unit test: JSON output includes all enriched fields
- [ ] Unit test: ANSI codes absent when `is_tty = false`
- [ ] Unit test: sort order (working before done)
- [ ] Unit test: graceful fallback when JSONL missing
- [ ] Unit test: summary header aggregation math
- [ ] Integration test: `--compact` flag recognized

## Out of Scope
- Usage tab data (5-hour/daily/weekly aggregates) — sessions only for now
- Watch mode / auto-refresh (`--watch`) — future enhancement
- Permission request display in CLI
- Interactive session selection / drill-down
- Settings management via CLI

## Open Questions
- [x] Invocation method → Keep in Tauri binary ✓
- [x] Output style → Both rich and compact ✓
- [x] Usage data → Sessions only ✓
- [x] Colors → Auto-detect TTY ✓
- [x] JSONL parsing → Reuse existing parser ✓
- [x] JSON enrichment → Full enrichment ✓
- [x] Sort order → Active first, then by start time ✓
