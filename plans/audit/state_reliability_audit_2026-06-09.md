# State Reliability Audit — 2026-06-09

Scope: the full session-state pipeline (hooks/cue-hook → sessions.json → session_monitor.rs
poll/demote/rescue passes → jsonl_parser.rs signals), audited against **live data**:

- Two driven interactive Claude Code sessions (v2.1.170) in `/tmp/cue-audit-proj` with a
  payload-capture hook registered for all 15 events, exercising: permission prompt
  (approve / ESC-deny / abandon), AskUserQuestion, Explore subagent, ESC interrupt
  mid-generation, `/exit`. Captures: `/tmp/cue-hook-capture.jsonl`,
  `/tmp/cue-state-timeline.jsonl` (sessions.json sampled at 400 ms).
- One `claude -p` print-mode run in the same project.
- 56 real transcripts touched in the last 7 days (stop_reason census, interrupt markers).
- The live `sessions.json` (691 entries) including an in-flight 8-agent retenir session.
- Current hooks docs (notification/subagent/stop payload schemas).
- `cargo test --lib` at HEAD: 394 passed.

Verdict on the three reported symptoms — all reproduced with identified root causes.

---

## F1 (HIGH) — "idle while in subagents": 60s mtime window is the wrong liveness signal

**Mechanism.** Subagent liveness everywhere is "JSONL mtime within 60s"
(`jsonl_parser.rs::parse_subagent_jsonl` → `is_active`). Both the demoter
(`should_demote_stale_subagent`, session_monitor.rs:1471) and the rescue
(`subagent_rescue_count`, session_monitor.rs:1524) consume it, and the hook's
self-heal `_maybe_clear_stale_subagent_counter` (cue-hook:217) uses the same idea
with a 30s window.

**Evidence.** The live retenir session (48e668f4, `activeSubagents: 3`) had 8 agent
JSONLs; **7 of 8 contained inter-entry silent gaps of 71–167s** (long tool calls).
During any window where all live agents are quiet >60s (>15s after stateChangedAt),
the demoter flips the card to `idle` and zeroes the displayed counter; the rescue
cannot re-enter until an agent writes again. Result: subagent → idle → subagent
flapping for the whole run — exactly the reported symptom. The hook-side heal can
additionally zero the **persisted** counter if any event lands mid-gap.

**Misattribution note.** The code comments (F-reliability-009) blame flock contention
dropping SubagentStart events. A clean benchmark (8 parallel SubagentStart against a
copy of the real 327 KB sessions.json) landed **8/8 increments at ~26 ms/event** — the
2s lock timeout is nowhere near exceeded. The mtime window, not lock contention, is
the operative failure.

**Deterministic fix.**
1. Parent-side: while the parent transcript's tail has an unresolved `tool_use` whose
   name is `Agent` (`pending_tool_use` && `running_tool_name == "Agent"`), agents are
   running *by definition* (foreground batch). Hold `subagent` on that signal alone.
2. Per-agent: an agent is *finished* iff its own JSONL tail shows `end_turn` with no
   pending tool_use (same scan as the main transcript); otherwise it is running,
   regardless of mtime. Use mtime only as a crash backstop (e.g. 10 min, flagged).
3. Hook heal: gate `_maybe_clear_stale_subagent_counter` on the same per-agent
   tail-state check rather than the 30s mtime window.

Captured SubagentStart/Stop payloads carry `agent_id` + `agent_type`; subagent tool
events also fire PreToolUse/PostToolUse **on the parent session_id** with `agent_id`
set — these could maintain an exact per-agent registry if desired.

---

## F2 (HIGH) — "working while idle" after ESC interrupt: no hook fires, parser misreads the marker

**Mechanism.** Confirmed by docs and live capture: **no hook event fires on user
interrupt** (Q4: ESC at +83.9s → zero events until the next prompt). The transcript
records the aborted assistant message with `stop_reason: "stop_sequence"` (not
`end_turn`) plus a user entry whose text is `[Request interrupted by user]` (or
`…for tool use]`). The parser treats that marker as a real user prompt
(`extract_user_prompt_text` strips only `image`/`attachment` bracket markers), so:

- `last_user_prompt_ts` := interrupt time → the end_turn backward scan
  (jsonl_parser.rs:1124) breaks at it → `last_end_turn_ts = None` → turn-ended demote
  can never fire;
- `last_prompt` (UI pill) becomes "[Request interrupted by user]";
- the only recovery is the 5-minute stalled-turn timer.

So every ESC leaves the card on `working`/`thinking` for ~5 minutes. (Tool-use
interrupts are partially saved: a synthetic `tool_result` clears `pending_tool_use`,
and the ESC-deny path Q3 demoted correctly within one metrics refresh.)

**Deterministic fix.** Recognize interrupt-marker user entries in `parse_line`:
- do NOT count them as user messages / last_prompt;
- record `last_interrupt_ts`;
- demote `working`/`thinking` (and resolve `waiting`) when
  `last_interrupt_ts > stateChangedAt`, exactly like the end_turn demote.
Optionally also accept tail `stop_sequence` (46 occurrences this week) as turn-end
when nothing newer is pending.

---

## F3 (HIGH) — "working while idle" after manual /compact: PostCompact unconditionally maps to working

**Mechanism.** Hook registration maps PostCompact → `working`. On a **manual**
`/compact` typed between turns there is no in-flight turn; event order is
PreCompact(compacting) → SessionStart(source=compact → idle, resets startedAt) →
**PostCompact(working) lands last**. Nothing else fires, so the card pins on
`working`. The turn-ended demote can't fire (the compact summary writes a fresh
user-type entry that blocks the end_turn scan), leaving the 5-minute stalled-turn
timer as the only recovery.

**Evidence (live, untouched).** Session 80b5336a (Wattro): transcript shows
`/compact` at 03:11–03:13Z, no assistant entry after it; sessions.json holds
`state=working`, `stateChangedAt≈startedAt≈lastActivity≈03:12:56Z`, 25+ minutes
stale at observation time.

**Deterministic fix.** PostCompact carries `trigger: "manual" | "auto"`.
Map `auto` → working (mid-turn compaction, correct today) and `manual` → idle.
Belt-and-braces: also exclude compact-summary/`<command-*>` user entries from the
end_turn scan boundary so turn-ended recovery still works after compaction.

---

## F4 (MED-HIGH) — phantom `waiting` after an *answered* AskUserQuestion at turn end

**Mechanism.** On Stop the hook checks `_last_tool_was_ask_question` (cue-hook:577):
"does the last assistant message end with an AskUserQuestion tool_use?" — it never
checks whether that tool_use was *answered* (has a matching tool_result), and it
reads the transcript file which can lag the Stop hook by a few hundred ms.

**Evidence.** Round-2 Q1: question answered at +23.7s (tool_result in transcript at
03:52:38.8), final assistant text + end_turn at 03:52:40.48, Stop at +25.5 → hook
wrote **waiting** at +25.6. Ground truth: turn complete, nothing needed from the user.

**Recovery is race-prone.** The Rust resolve gate `metrics_caught_up`
(session_monitor.rs:1337) requires `last_entry_ts >= stateChangedAt`, but after the
turn ends no newer *timestamped* entry will ever arrive (trailing `last-prompt` /
`ai-title` / `mode` rows carry no timestamps), so the demote depends entirely on the
`parsed_file_mtime >= boundary` fallback in `should_demote_turn_ended` — a sub-second
mtime race decides between a ~6s blip and an indefinitely pinned yellow card.

**Deterministic fix.** In `_last_tool_was_ask_question`, also scan the tail for a
`tool_result` whose `tool_use_id` matches the AskUserQuestion id; answered → `idle`.
(Mirrors the Rust `awaiting_user_prompt` verdict.) Additionally, let an unmatched-
prompting-tool check drive the resolve instead of the `last_entry_ts` freshness gate
when the tail already contains the matching tool_result.

---

## F5 (MED) — "missing waiting": permission prompts are invisible for the first ~6s (or entirely, if answered fast)

**Mechanism + evidence.** Permission-prompt `waiting` is seeded only by
`Notification(permission_prompt)`. Across all three captured dialogs the
Notification fired **~6.0s after the dialog actually opened** (PermissionRequest at
+13.1/+11.6/+56.4 → Notification at +19.1/+17.6/+62.4). Until then the card shows
blinking-white `working` while the session is in fact blocked. A user watching
several sessions sees "working" on a blocked session — the reported "missing
waiting". (CC only sends the notification if the dialog stays unanswered ~6s;
fast approvals produce none, which is benign.)

Also confirmed: CC 2.1.170 sends `notification_type=permission_prompt` even for
AskUserQuestion dialogs (`elicitation_dialog` never appeared); harmless today since
the hook treats both identically, but the AskUserQuestion fast-path via PreToolUse
is what actually catches question dialogs instantly (+11.5 → waiting at +11.8 ✓).

**Fix options (in preference order).**
1. Seed `waiting` from the `PermissionRequest` event (fires at dialog-open). Caveat
   to verify first: that it does NOT fire for auto-approved/allowlisted calls — in
   all captures it appeared only when a dialog was actually shown, but this needs a
   targeted test with an `allow` rule before shipping, else a long allowlisted tool
   would wear a false `waiting` until PostToolUse.
2. If (1) is unsafe: accept the 6s as a CC-side constant and document it.

**Related known limitation (document):** after the user *approves* a dialog, no hook
event and no JSONL entry exist until the tool completes (PostToolUse), so the card
stays `waiting` for the full duration of a long approved tool. Only the permission-
forwarding feature (Cue's permission server sees the decision) could close this gap
deterministically.

---

## F6 (MED) — transient "idle while working" during long text-quiet turns

**Mechanism.** Between a `tool_result` landing and the next assistant message, the
backward scan sets `pending_tool_use=false` (tail is a tool_result). If the turn has
produced no text/end_turn/prompt for >5 min (deep agentic stretches, thinking-heavy
output), `should_demote_stalled_turn` (session_monitor.rs:1435) fires during that
seconds-wide window → card flips to `idle` until the next hook event/metrics refresh.
Narrow but real, and it presents exactly as "idle while working".

**Fix.** Key the stall clock on *file mtime of the main transcript* (any append —
tool_results included — proves liveness) instead of only the three conversational
timestamps, or treat a tail `tool_result` newer than `STALLED_TURN_SECS` ago as
activity. Both keep the timer last-resort but stop it misfiring mid-turn.

---

## F7 (LOW) — hygiene and environment findings

1. **sessions.json never GC'd**: 691 entries / 327 KB, mostly `ended` ghosts since
   March; rewritten (indent=2, fsync) on every hook event. Prune `ended` entries
   older than ~7 days (and cap total entries) inside the hook's locked write.
   (Known-deferred item; bumped because it taxes every event.)
2. **`_should_ignore_session` is dead code**: no `session_type` field exists in any
   payload (confirmed by docs + print-mode capture). `claude -p` runs are fully
   tracked (SessionStart→…→SessionEnd) and leave `ended` ghosts. GC (above) mostly
   absorbs this; CUE_SKIP remains the explicit opt-out.
3. **Workspace encoding mismatch**: CC encodes `_`/`.` → `-` (`codebase_visualizer`
   → `-Users-dev-Projects-Tools-codebase-visualizer`); `encode_workspace_path`
   replaces only `/`. The all-dirs fallback scan saves correctness at the cost of a
   directory walk per new session. Port CC's encoding.
4. **SSH sessions are invisible**: `hook-runner.sh` skips cue-hook in SSH sessions
   without a `.ssh-ok` marker — sessions driven over SSH never update sessions.json.
   Worth a docs note or `.ssh-ok` for headless boxes.
5. **Unused rich Stop payload**: Stop carries `last_assistant_message`,
   `background_tasks`, `session_crons` — `background_tasks` could deterministically
   distinguish "idle with background work running" in future.
6. **SessionEnd `reason` mismatch vs docs**: interactive `/exit` produced
   `prompt_input_exit`, print mode produced `other` (docs imply the reverse).
   Don't branch on these values without local verification.
7. Cue desktop app wasn't running during the audit (LaunchAgent `RunAtLoad=false`)
   — irrelevant to the logic audit (all demotes are view-layer), but worth checking
   that the dashboard was actually live when symptoms were observed.

## Symptom → root-cause map

| Reported symptom | Root cause(s) |
|---|---|
| idle while in subagents | F1 (60s mtime window; both demoter and rescue blind during real 71–167s tool-call gaps) |
| missing waiting states | F5 (6s Notification lag; SSH skip F7.4) |
| idle while working | F6 (stalled-turn misfire window); plus the inverse "working while idle": F2 (interrupt), F3 (manual /compact), F4 (phantom waiting) |

## Suggested fix order

1. F1 (pending-Agent-tool + per-agent tail-state liveness) — direct hit on the top complaint.
2. F2 (interrupt markers) — cheap parser change, removes the worst 5-min stick.
3. F3 (PostCompact trigger mapping) — one-line hook change + boundary fix.
4. F4 (answered-question check in Stop path + resolve gate) — hook + small Rust change.
5. F5/F6 — after verifying PermissionRequest semantics; stall-clock re-key.
6. F7 hygiene batch (GC, encoding, dead code).

All fixes lead with deterministic signals; timers remain only as flagged last-resort
backstops, per project policy.
