# Manual live-state verification harness

`live_state_driver.py` drives a real interactive Claude Code session through the
state transitions Cue must classify, while recording:

- every hook event payload (via a capture hook in a scratch project), and
- the sessions.json state of that session sampled at 400 ms.

Used to produce the evidence in `plans/audit/state_reliability_audit_2026-06-09.md`
(`capture-2026-06-09.jsonl` / `timeline-2026-06-09.jsonl` are the raw artifacts).

## Setup

1. Create a scratch project (e.g. `/tmp/cue-audit-proj`) containing
   `.claude/settings.json` that registers a capture hook for all 15 events
   (each: `python3 <proj>/capture-hook.py <EventName>`, where capture-hook.py
   appends `{t, argv, payload}` to `/tmp/cue-hook-capture.jsonl`) and a
   `permissions.ask` rule (e.g. `Bash(touch *)`) to force permission dialogs.
2. First run will hit the "trust this folder" dialog — the driver presses Enter
   until SessionStart is captured.
3. Run: `python3 live_state_driver.py` (needs pexpect; spawns
   `claude --permission-mode default --model haiku --strict-mcp-config`).

## Phases

| Phase | Exercise | Expected sessions.json |
|---|---|---|
| Q1 | AskUserQuestion dialog, hold 12s, answer | waiting while open; NOT waiting after Stop (F4 regression) |
| Q2 | One Explore subagent | subagent w/ subs=1 for the run, then working→idle |
| Q3 | Permission dialog, ESC-deny | waiting while open; idle within ~6s after deny |
| Q4 | ESC mid-generation | working/thinking must demote promptly (F2 regression) |
| Q5 | /exit | ended |

Compare the merged chronology (capture + timeline sorted by t) against the
expected column; the audit doc's F-numbers describe known failure signatures.
