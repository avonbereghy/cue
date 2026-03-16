# Feature: Account Usage Tab

## Overview

Add a "Usage" tab to the Claude Cue dashboard that aggregates token consumption across all Claude Code sessions over rolling time windows (5-hour, daily, weekly). This gives users real-time visibility into their account utilization — including token totals, session counts, estimated API cost, message counts, and tool breakdowns — so they can pace their usage and avoid hitting rate limits.

## User Value

- **Rate limit awareness**: See at a glance how much of the 5-hour rolling window has been consumed
- **Cost visibility**: Understand the equivalent API cost of subscription usage
- **Usage patterns**: Identify which tools and models consume the most tokens over time

---

## Functional Requirements

### FR-001: Dashboard Tab Navigation
When the dashboard window opens, the system shall display a tab bar with "Sessions" and "Usage" tabs, defaulting to the "Sessions" tab.

### FR-002: Usage Tab — 5-Hour Rolling Window
When the user selects the "Usage" tab, the system shall display token usage aggregated over a rolling 5-hour window (current time minus 5 hours).

### FR-003: Usage Tab — Daily Window
When the user selects the "Usage" tab, the system shall display token usage aggregated for the current calendar day (midnight to now, local time).

### FR-004: Usage Tab — Weekly Window
When the user selects the "Usage" tab, the system shall display token usage aggregated for the current calendar week (Monday to now, local time).

### FR-005: Token Metrics per Window
While a time window is displayed, the system shall show total input tokens, total output tokens, and combined total tokens (formatted as K/M).

### FR-006: Session Count per Window
While a time window is displayed, the system shall show the number of distinct sessions that contributed token usage within that window.

### FR-007: Cost Estimate per Window
While a time window is displayed, the system shall show an estimated USD cost based on published API token pricing for each model used (e.g., Opus, Sonnet, Haiku input/output rates).

### FR-008: Message Count per Window
While a time window is displayed, the system shall show total user messages and assistant messages within that window.

### FR-009: Tool Usage Breakdown per Window
While a time window is displayed, the system shall show a breakdown of tool usage counts (top tools, ranked by frequency).

### FR-010: Auto-Refresh
While the "Usage" tab is visible, the system shall refresh usage data every 5 seconds (matching existing metrics refresh cadence).

### FR-011: Data Source — Local JSONL Logs
The system shall compute all usage metrics by parsing JSONL conversation logs from `~/.claude/projects/`. No network requests shall be made.

### FR-012: Forward-Only Tracking
The system shall only track usage data from the point of installation forward. It shall not retroactively parse historical JSONL files that existed before the feature was enabled.

### FR-013: 5-Hour Progress Bar
While the 5-hour rolling window is displayed, the system shall render a visual progress bar showing token usage as a percentage. The percentage denominator shall be configurable (default: a sensible estimate per plan tier, user-editable in settings).

### FR-014: Empty State
When no usage data exists for a time window, the system shall display a "No usage recorded" message with context about the tracking start date.

---

## Non-Functional Requirements

### Performance
- Aggregation across all JSONL files shall complete in < 500ms for up to 500 conversation files
- Tab switching shall feel instant (< 100ms perceived latency)
- Memory overhead for cached aggregation data shall not exceed 10MB

### Reliability
- Malformed or incomplete JSONL lines shall be silently skipped without crashing
- Missing or inaccessible log directories shall result in zero-value metrics, not errors

### Usability
- Token counts shall use the existing `Format.tokens()` helper (K/M formatting)
- Cost estimates shall display as USD with 2 decimal places (e.g., "$1.23")
- Color coding for the 5h progress bar shall match existing context bar colors: green (<50%), orange (50-80%), red (>80%)

---

## Acceptance Criteria

### AC-001: Tab Navigation
Given the dashboard window is open,
When the user clicks the "Usage" tab,
Then the view switches to the Usage tab content
And the "Usage" tab appears selected.

### AC-002: 5-Hour Rolling Window Shows Current Data
Given Claude Code sessions have been active in the last 5 hours,
When the user views the Usage tab,
Then the 5-hour section shows aggregated tokens from all sessions with activity in the last 5 hours
And the progress bar reflects the percentage of the configured limit.

### AC-003: Daily Window Resets at Midnight
Given usage has been tracked across two calendar days,
When the user views the daily section after midnight,
Then only today's usage is shown
And yesterday's usage is not included.

### AC-004: Weekly Window Shows Monday–Now
Given usage has been tracked across multiple days this week,
When the user views the weekly section,
Then usage from Monday 00:00 local time through now is aggregated.

### AC-005: Cost Estimate Accuracy
Given sessions used a mix of Opus and Sonnet models,
When the user views the cost estimate,
Then the cost reflects per-model pricing applied to each session's token counts.

### AC-006: Tool Breakdown
Given sessions used Bash, Read, Edit, and Write tools,
When the user views the tool breakdown for a time window,
Then tools are listed in descending order of use count.

### AC-007: Empty State
Given no sessions have occurred since installation,
When the user opens the Usage tab,
Then a "No usage recorded" message is displayed
And the tracking start date is shown.

### AC-008: Auto-Refresh
Given the Usage tab is visible and a new Claude Code session generates tokens,
When 5 seconds elapse,
Then the displayed metrics update to include the new session's data.

### AC-009: Resilience to Bad Data
Given a JSONL file contains malformed lines,
When the system parses it for aggregation,
Then valid lines are counted and malformed lines are skipped silently.

---

## Error Handling

| Error Condition | Behavior | User Message |
|-----------------|----------|--------------|
| JSONL file unreadable (permissions) | Skip file, count available files | None (silent) |
| Malformed JSON line in JSONL | Skip line, continue parsing | None (silent) |
| No JSONL files found | Show empty state | "No usage recorded since [install date]" |
| `~/.claude/projects/` missing | Show empty state | "No usage recorded since [install date]" |
| Token limit not configured | Show raw totals without percentage | Progress bar hidden until limit is set |

---

## Implementation TODO

### Data Layer (Models.swift / new UsageAggregator)
- [ ] Create `UsageWindow` enum: `.fiveHour`, `.daily`, `.weekly`
- [ ] Create `WindowMetrics` struct: inputTokens, outputTokens, sessions, messages (user/assistant), toolCounts, modelBreakdown, estimatedCostUSD
- [ ] Create `UsageAggregator` class that scans JSONL files and aggregates by time window
- [ ] Add model-to-pricing mapping for cost estimation (Opus, Sonnet, Haiku input/output rates)
- [ ] Store tracking start date in UserDefaults on first launch with this feature
- [ ] Add user-configurable 5h token limit to UserDefaults (Settings)

### Session Monitor Integration (SessionMonitor.swift)
- [ ] Add `usageMetrics` published property: `[UsageWindow: WindowMetrics]`
- [ ] Extend `refreshMetrics()` to also compute window aggregations (every 5s)
- [ ] Reuse existing JSONL parsing; filter by timestamp for each window

### Usage Tab View (new UsageView.swift)
- [ ] Create `UsageView` SwiftUI view with three window sections
- [ ] Create `WindowSection` subview: header (window name + time range), stats row, progress bar (5h only), tool chips
- [ ] Create `CostBadge` component showing "$X.XX"
- [ ] Add empty state view with tracking start date
- [ ] Match existing dashboard styling (fonts, colors, spacing)

### Dashboard Integration (DashboardView.swift)
- [ ] Add `TabView` or segmented `Picker` to top of DashboardView
- [ ] Wire "Sessions" tab to existing content
- [ ] Wire "Usage" tab to new UsageView
- [ ] Persist last-selected tab in UserDefaults

### Settings (main.swift)
- [ ] Add "5-hour token limit" numeric input field to CueSettingsView
- [ ] Default value: 0 (unconfigured — hides progress bar percentage)

### Testing
- [ ] Test `UsageAggregator` with sample JSONL data (multiple sessions, models)
- [ ] Test rolling window boundary (session spans the 5h boundary — partial counting)
- [ ] Test empty state (no files)
- [ ] Test malformed JSONL resilience
- [ ] Test cost calculation with mixed models
- [ ] Test midnight rollover for daily window
- [ ] Test Monday rollover for weekly window

---

## Out of Scope
- **Anthropic API integration**: No network calls to fetch actual account limits or server-side usage
- **Multi-machine aggregation**: Only tracks usage from this machine's local logs
- **Historical backfill**: Does not retroactively parse pre-existing JSONL files
- **Push notifications / alerts**: No alerts when approaching limits (future enhancement)
- **Per-project usage breakdown**: Aggregates across all projects (could be a future filter)

## Open Questions
- [ ] What are the current published API token prices for Opus 4.6, Sonnet 4.6, and Haiku 4.5? (Needed for cost estimation mapping)
- [ ] Should the 5h token limit default to a known value for Max plan users, or always start unconfigured?
