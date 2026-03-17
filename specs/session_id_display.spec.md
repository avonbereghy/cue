# Session ID Display in Project Rows

## Overview

Display a truncated session/conversation ID in each project row on the dashboard, with a click-to-copy button that copies the full session UUID. This lets users quickly resume sessions via `claude --resume <id>` after reloading the page or from a different terminal.

**User value**: Currently there's no way to identify or resume a specific session from the dashboard. Showing the session ID bridges the dashboard and CLI workflows.

## Functional Requirements

1. **Where** the session ID is displayed, the system **shall** render the first 8 characters of `info.id` followed by an ellipsis (`…`) in the metrics row (Row 2) of each `SessionCard`.

2. **When** the user clicks the session ID or its adjacent copy icon, the system **shall** copy the full `info.id` value to the clipboard.

3. **When** the clipboard write succeeds, the system **shall** briefly change the copy icon to a checkmark (✓) for 1.5 seconds as confirmation.

4. **Where** the session ID starts with `pid-` (fallback ID), the system **shall** still display and allow copying it.

## Non-Functional Requirements

- The session ID element must not cause the metrics row to wrap on windows ≥ 400px wide.
- Clipboard write must use the Clipboard API (`navigator.clipboard.writeText`).

## Acceptance Criteria

```
Given a session card is visible on the dashboard,
When the user looks at the metrics row,
Then they see a truncated session ID (8 chars + …) with a copy icon.

Given a session card with ID "706fceff-70ed-4391-8780-2ebb004b8183",
When the user clicks the session ID or copy icon,
Then "706fceff-70ed-4391-8780-2ebb004b8183" is copied to the clipboard.

Given the user just clicked to copy a session ID,
When the copy succeeds,
Then the icon changes to a checkmark for ~1.5 seconds before reverting.
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Clipboard API unavailable | Silently fail (no crash, no UI change) |
| `info.id` is empty or missing | Hide the session ID element entirely |

## Implementation Checklist

- [ ] Add truncated ID + copy button to `SessionCard.tsx` Row 2
- [ ] Implement clipboard copy with success feedback (checkmark icon)
- [ ] Verify build compiles: `cargo check` (Rust) + `npm run build` (frontend)
