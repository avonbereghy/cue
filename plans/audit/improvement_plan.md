# Improvement Plan — Backend Quality Sweep (2026-06-03)

Focus: correctness & accuracy while monitoring Claude Code sessions; reading from JSON/JSONL.
Base commit: `0a0eed3`. Severity floor: high. All 13 findings are high+ → all in fix scope.

## Lens Coverage
| Lens | Findings | Critical | High |
|------|----------|----------|------|
| security | 2 | 0 | 2 |
| reliability | 2 | 0 | 2 |
| correctness | 2 | 0 | 2 |
| protocol | 2 | 0 | 2 |
| types | 1 | 1 | 0 |
| tests | 4 | 0 | 4 |
| **Total** | **13** | **1** | **12** |

## Top Risks (severity × confidence)
1. **F-types-001 (CRIT, 95)** — `SessionInfo` requires `id/workspace/state/lastActivity/startedAt` with no `#[serde(default)]`, but the hook intentionally preserves entries missing those. One malformed entry aborts the *entire* `StatusData` parse → blanks all cards, and after 5 polls the self-repair renames the file aside, destroying live records. The reader is stricter than the writer.
2. **F-protocol-001 (HIGH, 92)** — parser reads only legacy `custom-title`; current Claude Code writes `ai-title`/`aiTitle` (168 of 169 live transcripts). Auto session titles never reach the UI.
3. **F-reliability-001 (HIGH, 85)** — hook main-path locked write has no `try/except`: on Unix a 2 s flock-timeout raises uncaught → state update silently lost; on Windows `msvcrt LK_LOCK` blocks unbounded → hangs to the 5 s kill.
4. **F-tests-001 (HIGH, 85)** — permission-prompt `waiting` survival is locked only as a pure predicate, never through `poll_status` end-to-end (the exact `cd2a32b` regression class).
5. **F-security-001 (HIGH, 80)** — `rate_limits.json` read unbounded (every 5 s); a same-uid oversized file OOMs the backend.

Full per-finding detail in `findings_{security,reliability,correctness,protocol,types,tests}.md`.

## Track Plan (4 parallel tracks, file-disjoint; no Foundation/Integration needed)

### Track A — Schema contract (`models.rs`)
- Findings: **F-types-001** (CRIT), **F-tests-004**.
- Fix: add `#[serde(default)]` to `id`, `workspace`, `state`, `last_activity`, `started_at` on `SessionInfo` so one malformed entry deserializes to a defaulted (then admission-filtered) entry instead of aborting the whole map. Add `test_hook_written_sessions_json_round_trips` + a per-entry-resilience test.
- Verify: `cd cue-desktop/src-tauri && cargo test models`.

### Track B — Transcript parser (`jsonl_parser.rs`)
- Findings: **F-protocol-001**, **F-tests-002**.
- Fix: in `parse_line`, read `aiTitle` from `type=="ai-title"` into `custom_title` (same ANSI/xml/bracket sanitisation), keeping the `custom-title` branch authoritative so explicit `/title` + `(Branch)` detection still win. Add `test_pending_tool_use_clears_when_tool_result_lands` + negative twin; add an `ai-title` parse test.
- Verify: `cargo test jsonl_parser`.

### Track C — Python hook (`hooks/cue-hook` + `tests/hooks/test_cue_hook.py`)
- Findings: **F-reliability-001**, **F-correctness-002**, **F-protocol-002**, hook-side of **F-correctness-001**.
- Fix: (1) wrap the main-path locked write in `try/except Exception: pass` (mirror `_quick_state_write`) and give Windows `_lock` a bounded `LK_NBLCK` retry loop. (2) In `_quick_state_write`, guard/​carry-forward `errorType` so a permission/elicitation Notification can't silently downgrade a live `error` card to `waiting`. (3) Tail-read loop: if no `assistant` line in the first window, double the chunk up to ~1 MiB. (4) Broaden `_maybe_clear_stale_subagent_counter` to heal on `activeSubagents>0` regardless of display state (keep the staleness/no-active-JSONL evidence checks). Add pytest locks for each.
- Verify: `cd /Users/dev/Projects/Repos/cue && python3 -m pytest tests/hooks/ -q`.

### Track D — Reconciler + app wiring (`session_monitor.rs` + `lib.rs`)
- Findings: **F-security-001**, **F-security-002**, **F-reliability-002**, **F-tests-001**, **F-tests-003**, Rust-side of **F-correctness-001**.
- Fix (as applied): (1) ✅ routed the `rate_limits.json` read through `read_to_string_bounded(.., 1 MiB)`. (2) ✅ added a fixed 10s ingest deadline (`timeout_at` on the header + body reads — defeats a byte-dribbling slowloris) and a 32-permit connection `Semaphore` (drops at capacity, no accept-loop stall). (3) ✅ F-reliability-002 — introduced a `LockSafe::lock_safe()` extension trait (recover-through-poison via `PoisonError::into_inner`) and swept all 73 `.lock().unwrap()` sites in both files; no new dependency. (4) ✅ extracted `poll_status_with(status_path, projects_path)` seam; added the permission-prompt-waiting end-to-end lock (holds `waiting` while `pending`, demotes on resolve) + the three error-recovery tests. (5) ❌ **NOT applied — verified false positive.** Broadening `should_demote_stale_subagent` past `state == "subagent"` would demote a legitimate permission-prompt/error card to `idle` (the demote sets `state=idle, active_subagents=0`, and the waiting pass that runs *after* can't re-promote a permission prompt). The hook-side heal in Track C is the correct and sufficient fix for F-correctness-001.
- Verify: `cargo test --lib` (384 pass) + `cargo build` + `cargo clippy` (clean).

## File Ownership Matrix
| File | Track A | Track B | Track C | Track D |
|------|---------|---------|---------|---------|
| cue-desktop/src-tauri/src/models.rs | ✏️ | | | |
| cue-desktop/src-tauri/src/jsonl_parser.rs | | ✏️ | | |
| hooks/cue-hook | | | ✏️ | |
| tests/hooks/test_cue_hook.py | | | ✏️ | |
| cue-desktop/src-tauri/src/session_monitor.rs | | | | ✏️ |
| cue-desktop/src-tauri/src/lib.rs | | | | ✏️ |

Validation: no file in two columns ✓ · no Foundation/Integration files ✓ · each track ≤ 2 files ✓ · diffs bounded < ~500 lines (Track D Mutex fix kept minimal) ✓.

## Inter-Track Contracts
- **F-correctness-001 is split** across Track C (hook heal) and Track D (Rust heal). The two heals are *independent* — either alone fixes the user-visible "pinned on false subagent" bug; both = defense in depth. No ordering dependency between the halves.
- No shared types/helpers produced or consumed across tracks → no Foundation. No entry-point wiring → no Integration.

## Execution note
Audit subagents were blocked by the harness from writing files this run (they returned findings as text). To avoid the same limitation on the fix phase, tracks are executed **sequentially in the main session** (one commit per track) rather than via parallel teammates. The matrix still governs correctness: each commit touches only its track's files, which the Step 5 verification checks per-commit.

## Acknowledged but Deferred (below HIGH floor — recorded, not fixed this run)
- `running_tool_name` picks the last tool in a multi-tool message (cosmetic pill label only; no state goes wrong). *(already logged as a todo)*
- `permission-log.jsonl` unbounded disk growth (read is 16 MiB-bounded; disk-leak only).
- `sessions.json` retention/pruning (600+ entries / ~294 KB bloat) — *separate retenir todo `01KSZZGH...`*.
- `extract_timestamp` rejects space-separated / named-offset timestamps (degrades to `None`, tolerated).
- `model_context.rs` gate-scanner fragility (falls back to baked-in 1M substrings — correct-enough default).
- `should_demote_stale_subagent` with `None` metrics 30 s edge; `_get_wsl_windows_status_dir` path derivation; sandbox-session unbounded reads (frontend-invoked, locked).
