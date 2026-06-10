//! Session monitoring — port of SessionMonitor.swift.
//!
//! Polls sessions.json for current session states and parses JSONL conversation
//! logs for token metrics. Maintains enriched sessions and usage metrics.

use crate::jsonl_parser;
use crate::models::{
    ConfigCounts, EnrichedSession, GitStatus, RateLimitInfo, SessionInfo, SessionMetrics,
    StatusData, SupplementalData, SystemMemory,
};
use crate::paths;
use crate::security;
use crate::{config_counter, git_status, system_info};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// Lock a `std::sync::Mutex`, recovering through poison instead of panicking.
///
/// `std::sync::Mutex` poisons itself if a thread panics while holding the guard,
/// after which every plain `.lock_safe()` on that mutex panics too. In a
/// long-running daemon a single transient panic in any lock-holding scope would
/// otherwise permanently wedge every later `poll_status`, blink tick, and
/// `get_sessions` — freezing the tray + dashboard with no self-recovery, which
/// is worse than a clean crash-and-restart. The protected data is plain session
/// state (Rust guarantees no memory unsafety across the unwind), so recovering
/// with possibly-stale data that self-corrects on the next poll beats a
/// permanent freeze. Use `.lock_safe()` for all shared-state mutexes.
pub(crate) trait LockSafe<T> {
    fn lock_safe(&self) -> std::sync::MutexGuard<'_, T>;
}

impl<T> LockSafe<T> for Mutex<T> {
    fn lock_safe(&self) -> std::sync::MutexGuard<'_, T> {
        self.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Sort sessions by start time. Used by both the monitor and CLI.
pub fn sort_sessions(sessions: impl IntoIterator<Item = SessionInfo>) -> Vec<SessionInfo> {
    let mut list: Vec<_> = sessions.into_iter().collect();
    list.sort_by(|a, b| a.started_at.total_cmp(&b.started_at));
    list
}

/// Bundle of supplemental info that the 5s timer refreshes together. Read in
/// poll_status under one lock so the enrichment path doesn't have to acquire
/// five separate guards back-to-back on every tick.
#[derive(Default, Clone)]
pub struct SupplementalCache {
    pub rate_limits: Option<RateLimitInfo>,
    pub system_memory: SystemMemory,
    pub claude_version: Option<String>,
    /// Global default effort level from `~/.claude/settings.json`.
    pub claude_default_effort: Option<String>,
    /// `~/.claude/settings.json` mtime (unix secs). Used to resolve which is
    /// fresher: a session's last `/effort` command or the global default.
    pub claude_default_effort_ts: Option<f64>,
}

/// Shared state for the session monitor.
///
/// **Lock ordering invariant:** `poll_status` acquires supplemental caches
/// (metrics_cache, rate_limits, etc.) and drops them ALL before acquiring
/// `enriched_sessions`. `refresh_metrics` acquires `enriched_sessions` first
/// (read-only clone), then acquires `metrics_cache`. This is safe because
/// `poll_status` never holds `metrics_cache` while writing `enriched_sessions`.
/// Do not hold any cache lock while acquiring `enriched_sessions`.
pub struct SessionMonitorState {
    pub enriched_sessions: Mutex<Vec<EnrichedSession>>,
    metrics_cache: Mutex<HashMap<String, SessionMetrics>>,
    /// Per-session JSONL parse cache (offset + accumulated entries). Lets
    /// `refresh_metrics` tail only newly-appended lines instead of re-reading
    /// and re-parsing the entire transcript every 5s.
    jsonl_entry_cache: Mutex<HashMap<String, jsonl_parser::JsonlEntryCache>>,
    file_mod_dates: Mutex<HashMap<String, SystemTime>>,
    resolved_paths: Mutex<HashMap<String, String>>,
    /// Bundled supplemental info refreshed by the 5s timer. Bundling lets
    /// poll_status snapshot all five fields under a single lock acquisition
    /// instead of taking + dropping five separate Mutex guards in sequence.
    pub supplemental: Mutex<SupplementalCache>,
    git_status_cache: Mutex<HashMap<String, (GitStatus, SystemTime)>>,
    config_counts_cache: Mutex<HashMap<String, (ConfigCounts, SystemTime)>>,
    /// Tracks previous output_tokens per session for speed calculation
    output_speed_cache: Mutex<HashMap<String, (i64, f64)>>, // session_id → (prev_output_tokens, prev_timestamp)
    /// Cached sysinfo::System instance to avoid re-allocation every poll
    sysinfo_system: Mutex<sysinfo::System>,
    /// Per-session cached `(pid, process_start_time_secs)` used to detect
    /// when the owning Claude Code process has died. Captured from sysinfo on
    /// first sight of a session; on later polls, a missing or start-time-
    /// mismatched process demotes the session out of any active state.
    /// `start_time` guards against PID reuse on long-lived machines.
    process_identity: Mutex<HashMap<String, (u32, u64)>>,
    /// Per-session timestamp (unix secs) when the session entered an active state
    /// (working/thinking/waiting/error/subagent). Cleared on idle/done/compacting.
    /// Used to compute the "active duration" timer shown on session cards.
    active_since: Mutex<HashMap<String, f64>>,
    /// Latches the most recent `last_user_prompt_ts` for which we promoted
    /// thinking→working. Subsequent polls within the same turn skip
    /// re-evaluation, eliminating the bounce caused by JSONL flush timing
    /// variance between polls.
    promoted_for_prompt: Mutex<HashMap<String, f64>>,
    /// Latches the `started_at` of the most recent subagent that triggered
    /// a done/idle→subagent rescue. The latch keys on `started_at` (set
    /// once on first entry, then never changes) rather than `ended_at`
    /// (which advances every refresh while the agent is still running),
    /// so the same agent can't re-trigger the rescue on every poll —
    /// only a brand-new agent with a later first-entry timestamp does.
    subagent_rescued_for: Mutex<HashMap<String, f64>>,
    /// Per-session "compacting visible at least until" floor. When the hook
    /// writes `compacting`, we set this 1500ms in the future so the frontend
    /// always observes at least one tick of compacting even if a subsequent
    /// `working` write lands within the same poll window.
    compacting_floor: Mutex<HashMap<String, f64>>,
    /// Consecutive `serde_json::from_str` failures on sessions.json. The hook
    /// renames corrupt files aside on its own write, but only when a hook
    /// event fires — if all Claude Code processes are idle and the file is
    /// corrupt, the hook never runs and the dashboard freezes. After N
    /// consecutive failures the poller takes over: renames the file aside
    /// and writes a clean `{"sessions":{}}` so subsequent hooks repopulate.
    /// Reset on the first successful parse. Zero on the cold path.
    consecutive_parse_failures: Mutex<u32>,
    /// Cue's launch timestamp (seconds since UNIX epoch) — only sessions
    /// with activity after this are shown. Starts empty, reads forwards only.
    launched_at: f64,
}

impl Default for SessionMonitorState {
    fn default() -> Self {
        let launched_at = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        Self {
            enriched_sessions: Mutex::new(Vec::new()),
            metrics_cache: Mutex::new(HashMap::new()),
            jsonl_entry_cache: Mutex::new(HashMap::new()),
            file_mod_dates: Mutex::new(HashMap::new()),
            resolved_paths: Mutex::new(HashMap::new()),
            supplemental: Mutex::new(SupplementalCache::default()),
            git_status_cache: Mutex::new(HashMap::new()),
            config_counts_cache: Mutex::new(HashMap::new()),
            output_speed_cache: Mutex::new(HashMap::new()),
            sysinfo_system: Mutex::new(sysinfo::System::new()),
            process_identity: Mutex::new(HashMap::new()),
            active_since: Mutex::new(HashMap::new()),
            promoted_for_prompt: Mutex::new(HashMap::new()),
            subagent_rescued_for: Mutex::new(HashMap::new()),
            compacting_floor: Mutex::new(HashMap::new()),
            consecutive_parse_failures: Mutex::new(0),
            launched_at,
        }
    }
}

impl SessionMonitorState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Poll sessions.json for current session states (called every ~1s).
    pub fn poll_status(&self) {
        self.poll_status_with(
            paths::sessions_json_path(),
            paths::claude_projects_path(),
        );
    }

    /// Path-injected core of `poll_status`. Extracted so tests can drive the
    /// full reconcile pipeline (read → parse → liveness → stale-subagent →
    /// waiting verdict → turn-ended) against fixture files instead of the real
    /// `~/.../sessions.json` and `~/.claude/projects` (F-tests-001/003). The
    /// public wrapper above passes the production paths.
    fn poll_status_with(
        &self,
        status_path: std::path::PathBuf,
        projects_path: std::path::PathBuf,
    ) {
        // sessions.json is the untrusted boundary (the Python hook writes it,
        // but any local process can race-write that path). Read through the
        // size-bounded reader so a runaway/hostile producer can't OOM the
        // backend with one giant allocation — and so the cap is enforced
        // against the same handle we read, closing the stat-then-read TOCTOU a
        // separate metadata() pre-check would leave open. Normal sessions.json
        // is well under 100 KiB even with many sessions.
        const SESSIONS_JSON_MAX_BYTES: u64 = 4 * 1024 * 1024;
        // Shared by the parse-error and read-error arms below: keep showing the
        // prior state for this many consecutive bad polls before any recovery
        // action, so a single mid-rename read never flashes the UI.
        const REPAIR_THRESHOLD: u32 = 5;

        let status = match security::read_to_string_bounded(&status_path, SESSIONS_JSON_MAX_BYTES) {
            Ok(content) => match serde_json::from_str::<StatusData>(&content) {
                Ok(s) => {
                    // Successful parse — reset the failure counter so the
                    // self-repair threshold is fresh for any future incident.
                    *self.consecutive_parse_failures.lock_safe() = 0;
                    s
                }
                Err(e) => {
                    // Preserve the prior enriched list across a transient parse
                    // failure (mid-rename read from the Python hook, or a manual
                    // edit). Wiping would drop active_since timers and cause a
                    // one-poll UI flash of zero sessions.
                    //
                    // F-reliability-006 — the hook only renames corrupt files
                    // aside when a hook event actually fires. With all Claude
                    // Code processes idle, no hook runs and the dashboard
                    // freezes indefinitely. Track consecutive failures here
                    // and recover after 5 polls (~5s) of unbroken corruption.
                    let mut failures = self.consecutive_parse_failures.lock_safe();
                    *failures += 1;
                    if *failures < REPAIR_THRESHOLD {
                        log::warn!(
                            "sessions.json parse failed ({}); keeping previous state ({}/{} before self-repair)",
                            e, *failures, REPAIR_THRESHOLD
                        );
                        return;
                    }
                    // Persistent corruption — rename the file aside and seed
                    // a clean empty container. The next hook write will
                    // repopulate it. Best-effort; if the rename itself fails
                    // we just keep returning prior state.
                    let timestamp = SystemTime::now()
                        .duration_since(SystemTime::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let corrupt_path = format!(
                        "{}.corrupt-{}",
                        status_path.display(),
                        timestamp
                    );
                    if let Err(rename_err) = std::fs::rename(&status_path, &corrupt_path) {
                        log::warn!(
                            "sessions.json self-repair: rename aside failed: {}",
                            rename_err
                        );
                        return;
                    }
                    if let Err(write_err) = security::atomic_write(
                        &status_path,
                        b"{\"sessions\":{}}",
                    ) {
                        log::warn!(
                            "sessions.json self-repair: seed write failed: {}",
                            write_err
                        );
                        return;
                    }
                    log::warn!(
                        "sessions.json self-repaired after {} parse failures (corrupt copy at {})",
                        *failures, corrupt_path
                    );
                    *failures = 0;
                    return;
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::FileTooLarge => {
                // Abnormally large sessions.json (runaway/hostile writer). Keep
                // the prior state rather than clearing: a 4 MB+ file is far more
                // likely legit-but-bloated than gone, and blanking every card is
                // worse than a slightly stale view.
                log::warn!(
                    "sessions.json exceeds {} bytes; keeping previous state",
                    SESSIONS_JSON_MAX_BYTES
                );
                return;
            }
            Err(e) => {
                // Transient read failure — the file is momentarily absent during
                // the hook's atomic rename, or an EINTR/EIO blip. Preserve the
                // prior enriched list for a few polls instead of flashing zero
                // sessions (mirrors the parse-failure arm); only clear once the
                // file stays unreadable, which means the store was genuinely
                // removed (uninstall/reset). Previously this wiped on the very
                // first error, causing a one-frame "0 sessions" flash whenever a
                // poll landed inside the hook's rename window.
                let mut failures = self.consecutive_parse_failures.lock_safe();
                *failures += 1;
                if *failures < REPAIR_THRESHOLD {
                    log::warn!(
                        "sessions.json read failed ({}); keeping previous state ({}/{} before clear)",
                        e, *failures, REPAIR_THRESHOLD
                    );
                    return;
                }
                log::warn!(
                    "sessions.json unreadable after {} polls ({}); clearing session list",
                    *failures, e
                );
                *self.enriched_sessions.lock_safe() = Vec::new();
                *failures = 0;
                return;
            }
        };

        // Admission filter:
        //   - Active states (working/thinking/subagent/compacting/clearing) and
        //     `waiting` bypass the launched_at gate. The hook is event-driven, so
        //     a session mid-generation when Cue starts has stale timestamps even
        //     though it's very much alive — the PID + JSONL liveness checks
        //     below are the right signal for those.
        //   - Terminal/quiescent states (idle/done/error/ended) keep the gate
        //     so prior-run ghosts don't pile up. The post-demotion sweep below
        //     re-applies this to any session demoted from an active state.
        //   - Session id MUST pass `validate_session_id` — it's later joined
        //     into a JSONL path, and a hostile sessions.json entry could
        //     otherwise redirect Rust's file reads outside ~/.claude/projects.
        let launched_at = self.launched_at;
        let active = sort_sessions(status.sessions.into_values().filter(|s| {
            security::validate_session_id(&s.id).is_ok()
                && security::sanitize_workspace_path(&s.workspace).is_ok()
                && admit_session(&s.state, s.started_at, s.last_activity, launched_at)
        }));

        // Deduplicate sessions sharing the same workspace that started within
        // 3s of each other. Collapses phantom sessions (e.g. from agent teams)
        // that create a second short-lived process on startup.
        let active = {
            let team_ids: std::collections::HashSet<String> = {
                let cache = self.metrics_cache.lock_safe();
                active
                    .iter()
                    .filter(|s| {
                        s.team_name.is_some()
                            || cache.get(&s.id).is_some_and(|m| m.team_name.is_some())
                    })
                    .map(|s| s.id.clone())
                    .collect()
            };
            dedup_sessions(active, &team_ids)
        };

        // Promote team agent sessions from "idle" to "done" if inactive for 30s.
        // Team agents don't wait for user input — idle means they finished.
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        let active: Vec<_> = {
            let cache = self.metrics_cache.lock_safe();
            active
                .into_iter()
                .map(|mut s| {
                    if s.state == "idle" {
                        let metrics = cache.get(&s.id);
                        // Only promote teammates (have teamName on entries), not the
                        // team lead which only has agentName via agent-name entry.
                        let is_teammate =
                            s.team_name.is_some() || metrics.is_some_and(|m| m.team_name.is_some());
                        if is_teammate && (now_secs - s.last_activity) > 30.0 {
                            s.state = "done".to_string();
                        }
                    }
                    s
                })
                .collect()
        };

        // JSONL-presence check: demote liveness-sensitive sessions whose
        // ~/.claude/projects/<encoded-ws>/<id>.jsonl file no longer exists.
        // This catches the case where Claude Code rotates its session id
        // mid-process (e.g. /clear, new conversation in the same window) and
        // the prior id's transcript is gone — sysinfo liveness can't see it
        // because the rotated id shares the live pid, and the hook's Stop
        // event for the old id either never fires or gets clobbered by the
        // new id's events. JSONL deletion is the authoritative deterministic
        // signal that Claude Code dropped that session id; no timer needed.
        let active: Vec<_> = {
            let mut active_since = self.active_since.lock_safe();
            let mut identity = self.process_identity.lock_safe();
            active
                .into_iter()
                .map(|mut s| {
                    if !is_liveness_sensitive(&s.state) {
                        return s;
                    }
                    if !self.jsonl_exists_on_disk(&s.id, &s.workspace, &projects_path) {
                        log::debug!(
                            "session {} demoted: JSONL missing for state={}",
                            s.id,
                            s.state
                        );
                        s.state = "idle".to_string();
                        s.active_subagents = 0;
                        s.permission_mode = None;
                        active_since.remove(&s.id);
                        identity.remove(&s.id);
                    }
                    s
                })
                .collect()
        };

        // Liveness check: demote sessions whose owning Claude Code process has
        // died. This catches hooks that never fired a resolving event — e.g.
        // a crash during a tool call or an interrupted /compact leaves the
        // session stuck in "working" forever. The hook writes `pid` = parent
        // pid on every event; we verify the process still exists, comparing
        // start_time to the cached value so a recycled PID doesn't look alive.
        let active: Vec<_> = {
            let active_ids: std::collections::HashSet<String> =
                active.iter().map(|s| s.id.clone()).collect();
            let pids_to_check: Vec<sysinfo::Pid> = active
                .iter()
                .filter(|s| is_liveness_sensitive(&s.state))
                .filter_map(|s| s.pid.map(sysinfo::Pid::from_u32))
                .collect();
            let mut sys = self.sysinfo_system.lock_safe();
            if !pids_to_check.is_empty() {
                sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&pids_to_check), false);
            }
            let mut identity = self.process_identity.lock_safe();
            // Drop cache entries for sessions no longer present.
            identity.retain(|id, _| active_ids.contains(id));

            active
                .into_iter()
                .map(|mut s| {
                    if !is_liveness_sensitive(&s.state) {
                        return s;
                    }
                    let Some(pid) = s.pid else {
                        return s; // no pid recorded (old entries) — can't check
                    };
                    let process = sys.process(sysinfo::Pid::from_u32(pid));
                    let live_start = process.map(|p| p.start_time());
                    // Process name guards F-reliability-005: on first sight,
                    // accept only processes that look like Claude Code so a
                    // recycled PID doesn't get anchored.
                    let live_name = process
                        .and_then(|p| p.name().to_str())
                        .map(str::to_owned);
                    let cached = identity.get(&s.id).copied();
                    match resolve_liveness(pid, live_start, cached, live_name.as_deref()) {
                        LivenessOutcome::Alive { cache } => {
                            identity.insert(s.id.clone(), cache);
                        }
                        LivenessOutcome::Dead => {
                            identity.remove(&s.id);
                            s.state = "idle".to_string();
                            s.active_subagents = 0;
                        }
                    }
                    s
                })
                .collect()
        };

        // Turn-ended recovery: demote `working`/`thinking`/`waiting` cards
        // when the JSONL transcript shows `stop_reason == "end_turn"` newer
        // than the session's `stateChangedAt`. This catches the case where
        // the resolving hook (Stop, or the user dismissing a permission
        // prompt out-of-band) failed to fire but Claude's own transcript
        // records the turn finished. Deterministic (no timers).
        let active: Vec<_> = {
            let cache = self.metrics_cache.lock_safe();
            active
                .into_iter()
                .map(|mut s| {
                    let metrics = cache.get(&s.id);
                    if should_demote_turn_ended(&s.state, s.state_changed_at, metrics) {
                        s.state = "idle".to_string();
                    }
                    s
                })
                .collect()
        };

        // Stuck-active cap: `compacting`/`clearing` are transient by design
        // (the next hook event should clear them within a second). If a
        // `/compact` errors before its follow-up hook, or `/clear` is
        // interrupted, the card pins until the parent PID dies. Cap at 60s
        // past `stateChangedAt` so the dashboard self-heals. Deterministic
        // because `stateChangedAt` is reset only on real transitions.
        let active: Vec<_> = active
            .into_iter()
            .map(|mut s| {
                if should_demote_stuck_active(&s.state, s.state_changed_at, now_secs) {
                    s.state = "idle".to_string();
                }
                s
            })
            .collect();

        // Stalled-turn cap: recover `working`/`thinking` cards whose owning
        // process is alive but whose transcript has been frozen on an
        // unanswered turn past STALLED_TURN_SECS. This is the gap the
        // turn-ended pass can't close — when a fresh prompt lands after the
        // last `end_turn`, the newest `end_turn` is older than the prompt, so
        // `should_demote_turn_ended` never fires and the card pins on
        // `working` forever. Last-resort timer (see fn doc); deterministic
        // signals are exhausted by the time we reach it.
        let active: Vec<_> = {
            let cache = self.metrics_cache.lock_safe();
            active
                .into_iter()
                .map(|mut s| {
                    let metrics = cache.get(&s.id);
                    if should_demote_stalled_turn(&s.state, metrics, now_secs) {
                        log::debug!(
                            "stalled-turn-demote id={} state={} → idle",
                            s.id,
                            s.state,
                        );
                        s.state = "idle".to_string();
                    }
                    s
                })
                .collect()
        };

        // Stale-subagent recovery: demote `subagent` cards whose counter is
        // non-zero but no subagent JSONL has been touched recently. Catches
        // the case where a `SubagentStop` hook was missed, leaving
        // `activeSubagents` stuck at >0 — the hook then keeps overriding
        // every event to `subagent` forever. 15s grace after
        // `stateChangedAt` so a freshly-spawned subagent has time to create
        // its JSONL file before we second-guess the hook counter.
        let active: Vec<_> = {
            let cache = self.metrics_cache.lock_safe();
            active
                .into_iter()
                .map(|mut s| {
                    let metrics = cache.get(&s.id);
                    if should_demote_stale_subagent(
                        &s.state,
                        s.state_changed_at,
                        metrics,
                        now_secs,
                    ) {
                        log::debug!(
                            "stale-subagent-demote id={} active_subagents={} → idle",
                            s.id,
                            s.active_subagents,
                        );
                        s.state = "idle".to_string();
                        s.active_subagents = 0;
                    }
                    s
                })
                .collect()
        };

        // Waiting verdict — dual-source promote + JSONL-backed resolve.
        //
        // Two independent signals mint state="waiting":
        //   1. JSONL `awaiting_user_prompt` — an unmatched AskUserQuestion /
        //      ExitPlanMode tool_use sits in the transcript. Deterministic and
        //      self-resolving (the matching tool_result clears it), so this
        //      pass both PROMOTES and DEMOTES on it.
        //   2. Hook seed on `Notification(permission_prompt)` — a tool that
        //      needs consent has paused the turn behind a permission dialog.
        //      Permission prompts produce NO prompting tool_use, so the JSONL
        //      can't promote them (a pending tool_use is indistinguishable
        //      from a tool that's merely running) — only the hook knows the
        //      dialog is open. This pass therefore only PRESERVES such a card;
        //      it never invents one.
        //
        // The demote must not stomp a live permission seed. The earlier design
        // demoted on `!awaiting` alone, which erased every permission-prompt
        // card within one poll (its `awaiting` is always false). Gate the
        // demote on `!pending_tool_use` as well: while any tool_use is still
        // unresolved at the transcript tail (dialog open), hold `waiting`; the
        // instant it resolves — approved→result, denied→rejection, answered,
        // or the turn advances — `pending` clears and we demote. Abandonment
        // (ctrl-c, killed terminal, closed window) is caught by the liveness,
        // JSONL-deletion, and turn-ended passes above, so nothing pins forever.
        // Terminal states (done/ended/error/subagent/compacting) own their own
        // truth and are never touched here. View-only: the Rust poller never
        // writes sessions.json, so a racy demote self-corrects next tick.
        let active: Vec<_> = {
            let cache = self.metrics_cache.lock_safe();
            active
                .into_iter()
                .map(|mut s| {
                    let metrics = cache.get(&s.id);
                    let awaiting =
                        metrics.map(|m| m.awaiting_user_prompt).unwrap_or(false);
                    let pending =
                        metrics.map(|m| m.pending_tool_use).unwrap_or(false);
                    if awaiting && is_promotable_to_waiting(&s.state) {
                        s.state = "waiting".to_string();
                    } else if s.state == "waiting"
                        && should_resolve_waiting(awaiting, pending)
                        && metrics_caught_up(
                            metrics.and_then(|m| m.last_entry_ts),
                            s.state_changed_at,
                            metrics.and_then(|m| m.parsed_file_mtime),
                        )
                    {
                        s.state = "idle".to_string();
                    }
                    s
                })
                .collect()
        };

        // Post-demotion sweep: re-apply the launched_at gate to any session
        // that's no longer in a bypass state. Without this, a session admitted
        // via `bypasses_launch_gate` and then demoted (dead PID, missing JSONL,
        // turn-ended) would surface as a stale idle entry from a prior run.
        let active: Vec<SessionInfo> = active
            .into_iter()
            .filter(|s| admit_session(&s.state, s.started_at, s.last_activity, launched_at))
            .collect();

        // Latched promotions/rescues/floors. Each transform reads + writes
        // its own mutex so per-session decisions persist across polls and
        // don't re-fire on every tick. Crucially: this is the ONLY place
        // the thinking→working promotion and done→subagent rescue mutate
        // state — `EnrichedSession::from_info_and_metrics` no longer
        // re-evaluates them, which removes the per-poll bounce surface.
        let active: Vec<_> = {
            let cache = self.metrics_cache.lock_safe();
            let mut promoted = self.promoted_for_prompt.lock_safe();
            let mut rescued = self.subagent_rescued_for.lock_safe();
            let mut floor = self.compacting_floor.lock_safe();
            let current_ids: std::collections::HashSet<&str> =
                active.iter().map(|s| s.id.as_str()).collect();
            promoted.retain(|id, _| current_ids.contains(id.as_str()));
            rescued.retain(|id, _| current_ids.contains(id.as_str()));
            floor.retain(|id, _| current_ids.contains(id.as_str()));

            active
                .into_iter()
                .map(|mut s| {
                    let metrics = cache.get(&s.id);

                    // ── Compacting floor ───────────────────────────────
                    // When the hook writes `compacting`, set a 1500ms floor.
                    // Otherwise, if a non-active state would replace a still-
                    // valid floor, hold the card on `compacting` until the
                    // floor expires.
                    if s.state == "compacting" {
                        floor.insert(s.id.clone(), now_secs + 1.5);
                    } else if floor_extends(&s.state, floor.get(&s.id).copied(), now_secs) {
                        // Extend display: hook moved off compacting too
                        // quickly for the poll cadence to catch it.
                        s.state = "compacting".to_string();
                    } else {
                        floor.remove(&s.id);
                    }

                    // ── Thinking→working promotion latch ───────────────
                    let decision = promote_decision(
                        &s.state,
                        promoted.get(&s.id).copied(),
                        metrics.and_then(|m| m.last_user_prompt_ts),
                        metrics.and_then(|m| m.last_assistant_text_ts),
                        metrics.is_some_and(|m| m.last_assistant_has_text),
                    );
                    match decision {
                        PromoteDecision::Held => {
                            s.state = "working".to_string();
                        }
                        PromoteDecision::Promote { prompt_ts } => {
                            s.state = "working".to_string();
                            promoted.insert(s.id.clone(), prompt_ts);
                            log::debug!("promote-latch id={} prompt_ts={}", s.id, prompt_ts);
                        }
                        PromoteDecision::Keep => {}
                    }
                    if !matches!(s.state.as_str(), "thinking" | "working" | "subagent") {
                        // Anything that isn't a handoffable continuation of
                        // the current turn (idle / done / ended / error /
                        // waiting / compacting) clears the latch so the NEXT
                        // thinking entry waits for a fresh text-after-prompt
                        // signal before being promoted. Without this, a
                        // session that errors out and immediately retries
                        // with a stale prompt_ts in metrics could skip the
                        // visual handoff entirely.
                        promoted.remove(&s.id);
                    }

                    // ── Subagent rescue latch ──────────────────────────
                    // Counter-blind transcript fallback (F-reliability-009,
                    // re-rooted by the 2026-06-09 state audit). Note: the
                    // original flock-contention attribution did NOT reproduce
                    // (8 parallel SubagentStarts against a real-size
                    // sessions.json all landed at ~26ms each); the real
                    // failure was the old 60s-mtime liveness misreading long
                    // agent tool calls as "agents gone". Rescue now keys on
                    // the deterministic pair in `subagent_rescue_count`
                    // (unmatched Agent tool_use + tail-state JSONL liveness),
                    // the SAME signals `should_demote_stale_subagent` uses to
                    // LEAVE the state — enter and exit stay symmetric, so the
                    // card holds `subagent` across multi-minute agent tool
                    // calls and exits exactly when the demoter would.
                    //
                    // Assert `subagent` on EVERY qualifying poll, not once per
                    // cohort. The predecessor (F-reliability-008) keyed the
                    // state write on a stable per-cohort `started_at` plus a
                    // 10s `ended_at` window: after the first poll the latch
                    // matched, so the write was skipped and the card reverted
                    // to idle — and a batch whose agents went quiet >10s
                    // mid-tool-call never re-qualified. The `rescued` map now
                    // throttles only the debug log (once per cohort), never the
                    // state assignment.
                    if let Some(live) =
                        subagent_rescue_count(&s.state, s.active_subagents, metrics)
                    {
                        let latest_started = metrics
                            .map(|m| {
                                m.subagents
                                    .iter()
                                    .filter(|a| a.is_active)
                                    .filter_map(|a| a.started_at)
                                    .fold(0.0_f64, f64::max)
                            })
                            .unwrap_or(0.0);
                        let already = rescued.get(&s.id).copied().unwrap_or(0.0);
                        if (latest_started - already).abs() > 0.001 {
                            // Demoted from info→debug: session ids map 1:1 to
                            // JSONL files / conversation records, and the
                            // privacy posture only shows leaf workspace names.
                            // Surface with RUST_LOG=cue_desktop=debug when
                            // investigating rescue cycles.
                            log::debug!(
                                "subagent-rescue-latched id={} state={}→subagent live={}",
                                s.id, s.state, live
                            );
                            rescued.insert(s.id.clone(), latest_started);
                        }
                        s.state = "subagent".to_string();
                        s.active_subagents = live;
                    } else if !matches!(s.state.as_str(), "done" | "idle" | "working" | "subagent")
                    {
                        // Non-rescuable states clear the rescue latch so the
                        // NEXT qualifying window re-logs if needed.
                        rescued.remove(&s.id);
                    }

                    s
                })
                .collect()
        };

        // Update active-since timestamps: track when each session entered an
        // active state (working/thinking/waiting/error/subagent). Reset on
        // idle/done/compacting/clearing. Used for the "active duration" timer.
        let active_since_snapshot = {
            let mut active_since = self.active_since.lock_safe();
            let is_active_state = |st: &str| -> bool {
                matches!(
                    st,
                    "working" | "thinking" | "waiting" | "error" | "subagent"
                )
            };
            let current_ids: std::collections::HashSet<&str> =
                active.iter().map(|s| s.id.as_str()).collect();
            // Prune sessions that no longer exist
            active_since.retain(|id, _| current_ids.contains(id.as_str()));
            // Prune the five other per-session caches that previously
            // accumulated forever — metrics_cache, jsonl_entry_cache,
            // file_mod_dates, resolved_paths, output_speed_cache. Without
            // this, a long-running tray app grew linearly in memory per
            // session-id ever observed. Lock-ordering: we already hold
            // `active_since`; these caches are acquired AFTER it in the
            // documented order, so the chained locks below are safe.
            self.metrics_cache
                .lock()
                .unwrap()
                .retain(|id, _| current_ids.contains(id.as_str()));
            self.jsonl_entry_cache
                .lock()
                .unwrap()
                .retain(|id, _| current_ids.contains(id.as_str()));
            // `file_mod_dates` also stores subagent-dir entries keyed as
            // `<sid>-subagents`, so prefix-match the live ids.
            self.file_mod_dates.lock_safe().retain(|key, _| {
                let stripped = key.strip_suffix("-subagents").unwrap_or(key);
                current_ids.contains(stripped)
            });
            self.resolved_paths
                .lock()
                .unwrap()
                .retain(|id, _| current_ids.contains(id.as_str()));
            self.output_speed_cache
                .lock()
                .unwrap()
                .retain(|id, _| current_ids.contains(id.as_str()));
            for s in &active {
                if is_active_state(&s.state) {
                    // Prefer the hook-supplied stateChangedAt — it captures
                    // every transition, including ones too brief for the 1 Hz
                    // poll to see (e.g. compacting flashing between working).
                    // Fall back to first-seen-now for entries from older hooks.
                    match s.state_changed_at {
                        Some(ts) => {
                            active_since.insert(s.id.clone(), ts);
                        }
                        None => {
                            active_since.entry(s.id.clone()).or_insert(now_secs);
                        }
                    }
                } else {
                    active_since.remove(&s.id);
                }
            }
            active_since.clone()
        };

        let enriched: Vec<_> = {
            let cache = self.metrics_cache.lock_safe();
            let supp = self.supplemental.lock_safe().clone();
            let git_cache = self.git_status_cache.lock_safe();
            let config_cache = self.config_counts_cache.lock_safe();
            let speed_cache = self.output_speed_cache.lock_safe();

            active
                .into_iter()
                .map(|session| {
                    let metrics = cache.get(&session.id).cloned().unwrap_or_default();
                    let (prev_output, prev_ts) =
                        speed_cache.get(&session.id).cloned().unwrap_or((0, 0.0));
                    let active_since_ts = active_since_snapshot.get(&session.id).copied();
                    let supplemental = SupplementalData {
                        git_status: git_cache.get(&session.workspace).map(|(s, _)| s.clone()),
                        config_counts: config_cache.get(&session.workspace).map(|(c, _)| c.clone()),
                        rate_limits: supp.rate_limits.clone(),
                        system_memory: supp.system_memory.clone(),
                        claude_version: supp.claude_version.clone(),
                        claude_default_effort: supp.claude_default_effort.clone(),
                        claude_default_effort_ts: supp.claude_default_effort_ts,
                        prev_output_tokens: prev_output,
                        prev_timestamp: prev_ts,
                        active_since: active_since_ts,
                    };
                    EnrichedSession::from_info_and_metrics(session, metrics, &supplemental)
                })
                .collect()
        }; // all locks dropped before acquiring enriched_sessions lock

        *self.enriched_sessions.lock_safe() = enriched;
    }

    /// Parse JSONL conversation logs for token metrics (called every ~5s).
    pub fn refresh_metrics(&self) {
        // Only clone the three fields the loop actually needs (id, workspace,
        // state) instead of the full EnrichedSession vector — at every 5s tick
        // a 20-session list previously copied ~40 KB of nested supplemental
        // data through the allocator for no reason.
        let session_keys: Vec<(String, String, String)> = {
            let guard = self.enriched_sessions.lock_safe();
            guard
                .iter()
                .map(|s| {
                    (
                        s.info.id.clone(),
                        s.info.workspace.clone(),
                        s.info.state.clone(),
                    )
                })
                .collect()
        };
        let projects_path = paths::claude_projects_path();

        for (id, workspace, state) in &session_keys {
            let path = self.jsonl_path(id, workspace, &projects_path);

            if !Path::new(&path).exists() {
                continue;
            }

            // For active sessions (working/subagent/waiting), always reparse to
            // capture subagent token changes in real-time. For inactive sessions,
            // check file mod times before reparsing.
            let is_active = matches!(
                state.as_str(),
                "working" | "thinking" | "subagent" | "waiting"
            );

            if !is_active {
                let mut should_skip = false;
                if let Ok(metadata) = std::fs::metadata(&path) {
                    if let Ok(mod_time) = metadata.modified() {
                        let mut mod_dates = self.file_mod_dates.lock_safe();
                        if let Some(cached) = mod_dates.get(id) {
                            if *cached == mod_time {
                                // Parent unchanged — also check subagents dir
                                let session_stem = Path::new(&path)
                                    .file_stem()
                                    .and_then(|s| s.to_str())
                                    .unwrap_or("");
                                let subagents_dir = Path::new(&path)
                                    .parent()
                                    .map(|p| p.join(session_stem).join("subagents"));

                                let sub_changed = subagents_dir
                                    .as_ref()
                                    .filter(|d| d.is_dir())
                                    .and_then(|d| std::fs::metadata(d).ok())
                                    .and_then(|m| m.modified().ok())
                                    .map(|sub_mod| {
                                        let sub_key = format!("{}-subagents", id);
                                        let changed = mod_dates
                                            .get(&sub_key)
                                            .map(|c| *c != sub_mod)
                                            .unwrap_or(true);
                                        if changed {
                                            mod_dates.insert(sub_key, sub_mod);
                                        }
                                        changed
                                    })
                                    .unwrap_or(false);

                                if !sub_changed {
                                    should_skip = true;
                                }
                            }
                        }
                        mod_dates.insert(id.clone(), mod_time);
                    }
                }
                if should_skip {
                    continue;
                }
            }

            let metrics = {
                let mut cache_guard = self.jsonl_entry_cache.lock_safe();
                let entry_cache = cache_guard.entry(id.clone()).or_default();
                jsonl_parser::parse_jsonl_to_session_metrics_cached(Path::new(&path), entry_cache)
            };
            if let Some(metrics) = metrics {
                // Track output speed: snapshot previous output_tokens before overwriting
                let now_ts = SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs_f64();
                {
                    let mut speed_cache = self.output_speed_cache.lock_safe();
                    // Store current output_tokens as "previous" for next poll
                    speed_cache.insert(id.clone(), (metrics.output_tokens, now_ts));
                }

                self.metrics_cache
                    .lock()
                    .unwrap()
                    .insert(id.clone(), metrics);
            }
        }
    }

    /// Refresh supplemental data: rate limits, system memory, git status, config counts.
    /// Called on the 5s timer alongside refresh_metrics().
    pub fn refresh_supplemental(&self) {
        // Rate limits: read from bridge file. This file is written by an
        // external statusline bridge into the same user-writable data dir as
        // sessions.json, so it's an untrusted boundary like every other read
        // here — route it through the bounded reader (it's a handful of fields;
        // 1 MiB is generous) so a runaway/corrupt writer or a same-uid process
        // dropping a multi-GB file can't OOM the backend on the 5s tick.
        const RATE_LIMITS_MAX_BYTES: u64 = 1024 * 1024;
        let rate_path = paths::rate_limits_path();
        let new_rate_limits = security::read_to_string_bounded(&rate_path, RATE_LIMITS_MAX_BYTES)
            .ok()
            .and_then(|content| serde_json::from_str::<RateLimitInfo>(&content).ok());

        // System memory using cached System instance (avoids re-allocation)
        let new_system_memory = {
            let mut sys = self.sysinfo_system.lock_safe();
            system_info::get_system_memory_with(&mut sys)
        };

        // Global default effort from ~/.claude/settings.json (cheap read, no subprocess)
        let (new_default_effort, new_default_effort_ts) = system_info::get_claude_default_effort();

        // Single guard acquisition for all five fields.
        {
            let mut supp = self.supplemental.lock_safe();
            if let Some(rl) = new_rate_limits {
                supp.rate_limits = Some(rl);
            }
            supp.system_memory = new_system_memory;
            supp.claude_default_effort = new_default_effort;
            supp.claude_default_effort_ts = new_default_effort_ts;
        }

        // Git status and config counts per workspace (with staleness caching)
        let sessions = self.enriched_sessions.lock_safe().clone();
        let now = SystemTime::now();

        // Collect unique workspaces
        let mut workspaces: Vec<String> =
            sessions.iter().map(|s| s.info.workspace.clone()).collect();
        workspaces.sort();
        workspaces.dedup();

        // Prune cache entries for workspaces no longer in active sessions
        {
            let mut cache = self.git_status_cache.lock_safe();
            cache.retain(|ws, _| workspaces.contains(ws));
        }
        {
            let mut cache = self.config_counts_cache.lock_safe();
            cache.retain(|ws, _| workspaces.contains(ws));
        }

        for ws in &workspaces {
            // Git status: refresh every 10s
            {
                let mut cache = self.git_status_cache.lock_safe();
                let stale = cache
                    .get(ws.as_str())
                    .map(|(_, t)| t.elapsed().map(|e| e.as_secs() > 10).unwrap_or(true))
                    .unwrap_or(true);
                if stale {
                    if let Some(status) = git_status::get_git_status(ws) {
                        cache.insert(ws.clone(), (status, now));
                    }
                }
            }

            // Config counts: refresh every 30s
            {
                let mut cache = self.config_counts_cache.lock_safe();
                let stale = cache
                    .get(ws.as_str())
                    .map(|(_, t)| t.elapsed().map(|e| e.as_secs() > 30).unwrap_or(true))
                    .unwrap_or(true);
                if stale {
                    let counts = config_counter::count_config(ws);
                    cache.insert(ws.clone(), (counts, now));
                }
            }
        }
    }

    /// Find path to a session's JSONL log file.
    ///
    /// Claude Code uses the git root (not necessarily the CWD) as the project directory,
    /// so we try the exact workspace encoding first, then walk up parent directories,
    /// and finally search all project directories as a fallback.
    /// Authoritative check for whether Claude Code's JSONL transcript for
    /// this session id currently exists on disk. Walks workspace ancestors
    /// (matching `jsonl_path`'s resolution strategy) and falls back to a
    /// scan of all project dirs. On a hit, populates the `resolved_paths`
    /// cache so `jsonl_path` won't re-walk on its next call.
    ///
    /// Distinct from `jsonl_path`, which always returns *some* string —
    /// useful when the caller wants to retry, but unsuitable for "does the
    /// session id still exist as far as Claude Code is concerned?" checks.
    fn jsonl_exists_on_disk(
        &self,
        session_id: &str,
        workspace: &str,
        projects_path: &Path,
    ) -> bool {
        // If we already resolved a path for this id, just stat it. A deleted
        // JSONL still leaves the cached string in place; `Path::exists()`
        // returning false is exactly the signal we want.
        if let Some(cached) = self.resolved_paths.lock_safe().get(session_id).cloned() {
            return Path::new(&cached).exists();
        }

        let filename = format!("{}.jsonl", session_id);

        let mut path = PathBuf::from(workspace);
        loop {
            let path_str = path.to_string_lossy().to_string();
            if path_str.is_empty() || path_str == "/" {
                break;
            }
            let candidate = projects_path
                .join(encode_workspace_path(&path_str))
                .join(&filename);
            if candidate.exists() {
                self.resolved_paths
                    .lock()
                    .unwrap()
                    .insert(session_id.to_string(), candidate.to_string_lossy().to_string());
                return true;
            }
            match path.parent() {
                Some(parent) if parent != path => path = parent.to_path_buf(),
                _ => break,
            }
        }

        if let Ok(dirs) = std::fs::read_dir(projects_path) {
            for entry in dirs.flatten() {
                let candidate = entry.path().join(&filename);
                if candidate.exists() {
                    self.resolved_paths
                        .lock()
                        .unwrap()
                        .insert(session_id.to_string(), candidate.to_string_lossy().to_string());
                    return true;
                }
            }
        }

        false
    }

    fn jsonl_path(&self, session_id: &str, workspace: &str, projects_path: &Path) -> String {
        // Check cache
        {
            let cache = self.resolved_paths.lock_safe();
            if let Some(cached) = cache.get(session_id) {
                return cached.clone();
            }
        }

        let filename = format!("{}.jsonl", session_id);

        // Try exact workspace path and each parent directory
        let mut path = PathBuf::from(workspace);
        loop {
            let path_str = path.to_string_lossy().to_string();
            if path_str.is_empty() || path_str == "/" {
                break;
            }

            let encoded = encode_workspace_path(&path_str);
            let candidate = projects_path.join(&encoded).join(&filename);
            if candidate.exists() {
                let result = candidate.to_string_lossy().to_string();
                self.resolved_paths
                    .lock()
                    .unwrap()
                    .insert(session_id.to_string(), result.clone());
                return result;
            }

            // Walk up to parent
            match path.parent() {
                Some(parent) if parent != path => path = parent.to_path_buf(),
                _ => break,
            }
        }

        // Fallback: search all project directories
        if let Ok(dirs) = std::fs::read_dir(projects_path) {
            for entry in dirs.flatten() {
                let candidate = entry.path().join(&filename);
                if candidate.exists() {
                    let result = candidate.to_string_lossy().to_string();
                    self.resolved_paths
                        .lock()
                        .unwrap()
                        .insert(session_id.to_string(), result.clone());
                    return result;
                }
            }
        }

        // Not found — return the original encoding so it can be retried later
        let encoded = encode_workspace_path(workspace);
        projects_path
            .join(&encoded)
            .join(&filename)
            .to_string_lossy()
            .to_string()
    }
}

/// Encode a workspace path to a directory name, matching Claude Code's
/// convention: every non-alphanumeric character becomes `-`.
///
/// Example: `/Users/dev/my_app.v2` -> `-Users-dev-my-app-v2`
///
/// Previously only `/` was replaced, so any workspace containing `_` or `.`
/// (e.g. `codebase_visualizer` → real dir `-Users-…-codebase-visualizer`)
/// missed the direct lookup and fell through to the all-dirs scan on every
/// new session. Verified against the live `~/.claude/projects` dir names.
pub fn encode_workspace_path(workspace: &str) -> String {
    workspace
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// States that indicate the owning Claude Code process should still be alive.
/// Terminal states (idle, done, error, ended) are excluded — they don't claim
/// activity. `waiting` is included because a stale waiting prompt whose
/// process has died is just as misleading as a stale working state — if the
/// liveness check fails, it gets demoted to idle and falls through the
/// launched_at gate. A genuinely live waiting prompt has both an alive parent
/// PID and a JSONL on disk, so it survives both checks intact.
fn is_liveness_sensitive(state: &str) -> bool {
    // `clearing` was retained here for an event that Claude Code's canonical
    // hook list (https://code.claude.com/docs/en/hooks) does not include —
    // there is no `PreClear` event. The Python hook never writes "clearing"
    // (it's absent from `valid_actions` in hooks/cue-hook), so this arm was
    // unreachable from real data. Dropping it keeps the predicate honest.
    matches!(
        state,
        "working" | "thinking" | "subagent" | "compacting" | "waiting"
    )
}

/// States that deserve to bypass the `launched_at` admission gate.
/// Liveness-sensitive states have a strong signal (live PID + alive JSONL)
/// that the later checks in `poll_status` will use to demote stale entries,
/// so the launch-time filter would just suppress real in-progress sessions
/// that started before Cue did. `waiting` is included because user-attention
/// states should never be hidden — the user has to respond. Terminal states
/// (`idle`, `done`, `error`, `ended`) keep the launched_at gate to avoid
/// resurfacing ghosts from prior Cue runs.
fn bypasses_launch_gate(state: &str) -> bool {
    is_liveness_sensitive(state) || state == "waiting"
}

/// Decide whether a session should be admitted to the active list.
/// Active/waiting states bypass the launched_at gate; quiescent states
/// keep it so prior-run entries don't pile up. Used both at entry and
/// after demotions to clean up sessions that fell out of bypass states.
fn admit_session(state: &str, started_at: f64, last_activity: f64, launched_at: f64) -> bool {
    if bypasses_launch_gate(state) {
        return true;
    }
    last_activity >= launched_at || started_at >= launched_at
}

/// Result of comparing a session's recorded pid against live process state.
enum LivenessOutcome {
    /// Process is alive and matches the expected identity (or we're capturing
    /// it for the first time). The attached `(pid, start_time)` is what the
    /// caller should cache.
    Alive { cache: (u32, u64) },
    /// Process is gone, or the PID is now held by a different process. Caller
    /// should demote the session out of its active state.
    Dead,
}

/// Decide whether a session with the given recorded PID is still owned by a
/// live Claude Code process. Pure, so it's unit-testable without spawning
/// real processes. `live_start` is the `start_time` reported by sysinfo for
/// the recorded pid (or None if no process currently holds that pid).
/// `cached` is the `(pid, start_time)` we recorded on a previous poll, if any.
/// Pure predicate for the turn-ended recovery path. Returns true when the
/// session should be demoted to `idle` because the JSONL transcript records
/// a completed turn newer than the current state transition.
///
/// Gated on `{working, thinking}` only — `subagent`, `waiting`, `compacting`,
/// `clearing` are left alone. Suppressed when a pending tool_use is open
/// (the aggregator already cleared `last_end_turn_ts` in that case, but the
/// explicit check keeps the contract clear).
/// Priority used by `dedup_sessions` to choose which of two phantom-window
/// duplicates to keep. Ordered to put user-attention states ABOVE quiet
/// background states so a real `error` or `compacting` card is never
/// shadowed by a same-workspace `idle` sibling.
///
/// Previous priority table collapsed `error` / `compacting` / `clearing` /
/// `done` / `ended` all into priority 0 — *below* `idle` (1). Dedup
/// therefore replaced a real `error` card with a phantom `idle`, and a
/// `compacting` card got swapped for `idle` before the compacting floor
/// ever had a chance to extend it.
pub(crate) fn dedup_state_priority(state: &str) -> u8 {
    match state {
        "error" => 5,
        "waiting" => 4,
        "working" | "subagent" => 3,
        "thinking" | "compacting" => 2,
        "done" | "idle" => 1,
        // ended is a tombstone — treat as lowest. `clearing` falls here too:
        // see is_liveness_sensitive's note — the hook can't produce it.
        _ => 0,
    }
}

/// Collapse phantom duplicate sessions that share a workspace and started
/// within 3 seconds of each other. Team-agent ids in `team_ids` are
/// exempt — real parallel agents.
///
/// When two candidates compete, the higher `dedup_state_priority` wins;
/// ties break by `last_activity`. The kept session inherits the existing
/// stable id (so per-id latches on `promoted_for_prompt`, `compacting_floor`,
/// etc. don't churn).
pub(crate) fn dedup_sessions(
    sessions: Vec<SessionInfo>,
    team_ids: &std::collections::HashSet<String>,
) -> Vec<SessionInfo> {
    let mut deduped: Vec<SessionInfo> = Vec::new();
    for session in sessions {
        // Never deduplicate team agent sessions — they are real parallel
        // agents, not phantom startup duplicates.
        if team_ids.contains(&session.id) {
            deduped.push(session);
            continue;
        }
        if let Some(existing) = deduped.iter_mut().find(|s| {
            !team_ids.contains(&s.id)
                && s.workspace == session.workspace
                && (s.started_at - session.started_at).abs() < 3.0
        }) {
            let p_new = dedup_state_priority(&session.state);
            let p_old = dedup_state_priority(&existing.state);
            if p_new > p_old || (p_new == p_old && session.last_activity > existing.last_activity)
            {
                let stable_id = existing.id.clone();
                *existing = session;
                existing.id = stable_id;
            }
        } else {
            deduped.push(session);
        }
    }
    deduped
}

/// States that may be overwritten with "waiting" when the JSONL shows an
/// unmatched user-prompting tool_use. Terminal/specialized states (done,
/// ended, error, subagent, compacting, clearing) own their truth from
/// elsewhere — promoting them to waiting would lose information.
fn is_promotable_to_waiting(state: &str) -> bool {
    matches!(state, "working" | "thinking" | "idle" | "waiting")
}

/// Pure predicate for resolving (demoting) a card currently shown as
/// `waiting`. Returns true only when the transcript proves the block is over:
/// no unmatched prompting tool_use (`awaiting`) AND no tool_use still pending
/// at the tail (`pending`).
///
/// The `pending` guard is what lets a hook-seeded permission-prompt `waiting`
/// survive. Permission prompts never set `awaiting` (they produce no
/// AskUserQuestion/ExitPlanMode tool_use), so demoting on `!awaiting` alone
/// erased them on the next poll — the regression this restores. While the
/// gated tool_use sits unresolved (`pending == true`), the dialog is still
/// open, so we hold `waiting`; once it resolves (approved→tool_result,
/// denied→rejection result, answered, or the turn advances) `pending` clears
/// and the card demotes. An AskUserQuestion answer is itself a tool_result, so
/// the prompting-tool path also clears `pending`, keeping this correct for
/// both sources. Abandonment is covered by the liveness / JSONL-deletion /
/// turn-ended passes, so this predicate never needs a timer.
fn should_resolve_waiting(awaiting: bool, pending: bool) -> bool {
    !awaiting && !pending
}

/// Freshness gate for the `waiting` demote. The hook seeds `waiting` (and
/// `stateChangedAt`) the instant a dialog opens, but the JSONL-derived metrics
/// only refresh every ~5s while the poller runs every ~1s. In that window the
/// cached `awaiting`/`pending` are stale-false — they predate the dialog — so a
/// naive `should_resolve_waiting` would demote a just-opened question/permission
/// card to idle for up to a refresh cycle (the visible "doesn't catch the
/// question" flicker). Only allow the demote once the parse has caught up to (or
/// past) when the card became `waiting`: `last_entry_ts >= state_changed_at`.
///
/// Returns `true` (allow demote) when we can't prove staleness — no parsed
/// timestamp or no `stateChangedAt` — preserving the prior behavior for those
/// edge cases. The liveness / JSONL-deletion / turn-ended passes remain the
/// backstops for an abandoned prompt, so holding here never pins forever.
///
/// `parsed_file_mtime` is a second catch-up proof (audit F4): when `waiting`
/// is seeded at the very END of a turn (Stop's ask-question path), no newer
/// *timestamped* entry will ever arrive — the trailing `last-prompt` /
/// `ai-title` / `mode` rows carry no timestamps — so the entry-ts gate alone
/// would hold a phantom waiting card forever. The transcript file mtime
/// advancing past the transition proves the parse reflects the
/// post-transition file even when content timestamps can't show it.
fn metrics_caught_up(
    last_entry_ts: Option<f64>,
    state_changed_at: Option<f64>,
    parsed_file_mtime: Option<f64>,
) -> bool {
    match (last_entry_ts, state_changed_at) {
        (Some(last), Some(changed)) => {
            last >= changed || parsed_file_mtime.is_some_and(|m| m >= changed)
        }
        _ => true,
    }
}

fn should_demote_turn_ended(
    state: &str,
    state_changed_at: Option<f64>,
    metrics: Option<&crate::models::SessionMetrics>,
) -> bool {
    // `waiting` is included: a permission prompt resolved out-of-band
    // (user killed the prompt, switched to a different terminal, etc.)
    // can leave the session pinned on `waiting` forever — but the
    // assistant's next end_turn proves the turn finished without Cue's
    // observation. `error` is included for the same reason once
    // F-state-coverage-002 lands: a StopFailure or PostToolUseFailure
    // can leave the session red, and a subsequent successful turn (clean
    // `end_turn` newer than the error transition) is proof the user
    // retried and the issue resolved. `subagent`/`compacting` have their
    // own recovery paths and are excluded.
    if !matches!(state, "working" | "thinking" | "waiting" | "error") {
        return false;
    }
    let Some(metrics) = metrics else { return false };
    if metrics.pending_tool_use {
        return false;
    }
    let boundary = state_changed_at.unwrap_or(0.0);
    // ESC interrupt: Claude Code fires NO hook, but it writes a
    // "[Request interrupted by user]" user entry (and, for tool-use
    // interrupts, a synthetic tool_result that already cleared `pending`
    // above). A marker newer than the state transition proves the turn was
    // aborted — demote now instead of waiting out the stalled-turn timer.
    if metrics
        .last_interrupt_ts
        .is_some_and(|int_ts| int_ts > boundary)
    {
        return true;
    }
    let Some(end_turn_ts) = metrics.last_end_turn_ts else {
        return false;
    };
    if end_turn_ts > boundary {
        return true;
    }
    // Resume / stale-working recovery. `claude --resume` (and some other late
    // hook writes) stamp a fresh `working`/`thinking` with stateChangedAt NEWER
    // than the last end_turn while adding no new turn — the transcript's last
    // meaningful entry is still that end_turn, so the session is idle, but the
    // `end_turn_ts > boundary` check above can't see it. We're already past the
    // `pending_tool_use` guard and `last_end_turn_ts` is Some (a genuine new
    // prompt would have set it to None by stopping the backward scan at the new
    // user message), so the turn IS ended. Demote — but only once the parse has
    // provably re-read the transcript past stateChangedAt (file mtime advances
    // on the resume rewrite even though content timestamps don't). That gate
    // also absorbs the ~5s metrics-refresh lag on a real new turn, so a freshly
    // working card never flickers to idle before the parse catches up.
    metrics
        .parsed_file_mtime
        .is_some_and(|mtime| mtime >= boundary)
}

/// Pure predicate for the stuck-`compacting`/`clearing` cap. Demotes to
/// `idle` once 60 seconds have elapsed since `stateChangedAt`. Both
/// states are transient by design — the next hook event should clear
/// them within a second — so anything still pinned at 60s is the result
/// of an interrupted `/compact` or `/clear` whose resolving hook never
/// fired. Returns false when `stateChangedAt` is missing so the cap
/// can't fire on a record we can't time.
fn should_demote_stuck_active(state: &str, state_changed_at: Option<f64>, now: f64) -> bool {
    // Only `compacting` remains here; `clearing` removed alongside the rest
    // of its arms — see is_liveness_sensitive for the rationale.
    if state != "compacting" {
        return false;
    }
    let Some(state_changed_at) = state_changed_at else {
        return false;
    };
    (now - state_changed_at) > 60.0
}

/// How long a `working`/`thinking` card may sit with a frozen transcript
/// before the stalled-turn cap recovers it to `idle`. 5 minutes: Claude Code
/// writes incrementally (each tool call, thinking block, and text message
/// appends an entry), so this much total silence on an active card — with no
/// pending tool and no user prompt awaiting an answer — means the turn died
/// without a resolving Stop/StopFailure hook (interrupt, silent API failure,
/// or a TUI prompt outside the tracked elicitation types).
const STALLED_TURN_SECS: f64 = 300.0;

/// Pure predicate for the stalled-turn cap — the last-resort recovery for the
/// one gap the deterministic signals can't close. `should_demote_turn_ended`
/// only fires when an `end_turn` is *newer* than `stateChangedAt`; when the
/// user submits a fresh prompt after the last `end_turn` and the turn then
/// stalls, the newest `end_turn` is older than the new prompt, so that pass
/// can never trigger. Liveness also passes (the foreground Claude Code process
/// stays alive at ~0% CPU), and the JSONL still exists. With every
/// deterministic signal exhausted, this is the flagged timer of last resort.
///
/// Gated tightly to avoid clobbering a legitimately long turn:
/// - only `working`/`thinking` (terminal/specialized states own their truth);
/// - never while a tool_use is pending — a long-running tool (test suite,
///   build) keeps the transcript quiet but is genuine work;
/// - never while `awaiting_user_prompt` — that's the `waiting` path's job;
/// - keyed on the newest *conversational* timestamp (user prompt / assistant
///   text / end_turn / tool_result), not the file mtime, so trailing metadata
///   rows (`mode`, `permission-mode`, `file-history-snapshot`) can't mask a
///   stall. tool_result is included (audit F6) because a deep agentic stretch
///   can run >5 min with neither text nor end_turn — between a tool_result
///   landing and the next assistant message `pending_tool_use` is briefly
///   false, and without tool_result proof-of-life the cap misfired in that
///   seconds-wide window, flashing a working card to idle mid-turn.
fn should_demote_stalled_turn(
    state: &str,
    metrics: Option<&crate::models::SessionMetrics>,
    now: f64,
) -> bool {
    if !matches!(state, "working" | "thinking") {
        return false;
    }
    let Some(metrics) = metrics else { return false };
    if metrics.pending_tool_use || metrics.awaiting_user_prompt {
        return false;
    }
    let last_activity = [
        metrics.last_user_prompt_ts,
        metrics.last_assistant_text_ts,
        metrics.last_end_turn_ts,
        metrics.last_tool_result_ts,
    ]
    .into_iter()
    .flatten()
    .fold(0.0_f64, f64::max);
    if last_activity <= 0.0 {
        // No conversational timestamp parsed yet — can't time the stall.
        return false;
    }
    (now - last_activity) > STALLED_TURN_SECS
}

/// Pure predicate for the stale-subagent demotion path. Returns true when a
/// session is stuck on `subagent` because the hook's `SubagentStop` event
/// was missed: `activeSubagents` is non-zero so the hook keeps overriding
/// every subsequent event back to `subagent`, but both live signals say the
/// agents are gone — no unmatched Agent/Task tool_use in the parent
/// transcript, and every agent JSONL's tail reached `end_turn` (`is_active`
/// is tail-state with a 10-min crash backstop, not a recency window).
///
/// Gated on `state == "subagent"`. Requires a 15s grace after
/// `stateChangedAt` so a just-spawned subagent has time to create its
/// JSONL file.
fn should_demote_stale_subagent(
    state: &str,
    state_changed_at: Option<f64>,
    metrics: Option<&crate::models::SessionMetrics>,
    now: f64,
) -> bool {
    if state != "subagent" {
        return false;
    }
    let Some(state_changed_at) = state_changed_at else {
        // No transition timestamp recorded — be conservative and leave the
        // card alone rather than risk demoting a real subagent run.
        return false;
    };
    let age = now - state_changed_at;
    if age < 15.0 {
        return false;
    }
    match metrics {
        Some(m) => {
            // Metrics parsed at least once for this session. Two independent
            // live signals must BOTH be absent before we second-guess the
            // hook counter: no unmatched Agent/Task tool_use in the parent
            // transcript (foreground batch in flight), and no agent JSONL
            // whose tail is still mid-turn. The former catches the spawn
            // window before agent files exist; the latter catches background
            // agents whose parent turn already ended.
            m.pending_agent_tool_count == 0
                && m.subagents.iter().filter(|a| a.is_active).count() == 0
        }
        None => {
            // No metrics yet. With `refresh_metrics` running at ~5 Hz
            // separately from poll_status, there's a race window at
            // session-rotation time where a fresh subagent state can
            // appear before metrics is populated. Require a longer
            // grace so we don't second-guess the hook during that
            // window — 30s gives the metrics cache time to fill.
            age >= 30.0
        }
    }
}

/// Pure predicate for the subagent rescue — the transcript fallback that keeps
/// a card on `subagent` when the hook's `activeSubagents` counter is wrong
/// (missed SubagentStart, or zeroed by a heal mid-batch). Returns `Some(live)`
/// when a zero-counter card should be shown as `subagent`, else `None`.
///
/// Two deterministic live signals, the SAME pair `should_demote_stale_subagent`
/// uses to demote OUT of `subagent` (enter/exit stay symmetric):
///   1. `pending_agent_tool_count` — unmatched Agent/Task tool_use in the
///      parent transcript. While a foreground batch runs, the parent turn is
///      blocked on those tool calls by definition; agent-JSONL quiet periods
///      (real batches show 71–167s gaps inside long tool calls) don't matter.
///   2. `is_active` agent JSONLs — tail not yet `end_turn` (mtime only as a
///      10-min crash backstop). Covers background agents whose parent turn
///      already ended, where signal 1 is gone.
///
/// `working` is rescuable alongside `done`/`idle`: subagent tool events fire
/// PreToolUse/PostToolUse **on the parent session id**, so with a zeroed
/// counter every agent tool call rewrote the card to `working` mid-batch.
/// `thinking`/`waiting`/`error`/`compacting` keep their own truth.
fn subagent_rescue_count(
    state: &str,
    active_subagents: i64,
    metrics: Option<&crate::models::SessionMetrics>,
) -> Option<i64> {
    if !matches!(state, "done" | "idle" | "working") || active_subagents != 0 {
        return None;
    }
    let m = metrics?;
    let live_jsonls = m.subagents.iter().filter(|a| a.is_active).count() as i64;
    let live = m.pending_agent_tool_count.max(live_jsonls);
    (live > 0).then_some(live)
}

/// Outcome of the per-poll thinking→working latch decision. Pure so tests
/// can pin the exact bouncing scenarios (delayed text, stale prompt).
#[derive(Debug, PartialEq)]
pub(crate) enum PromoteDecision {
    /// Keep state as-is (not thinking, or no signal yet).
    Keep,
    /// Promote thinking→working AND record the prompt_ts in the latch.
    Promote { prompt_ts: f64 },
    /// Latch already held this prompt — keep the card on working without
    /// re-checking the JSONL signal.
    Held,
}

/// Pure predicate for the thinking→working promotion latch. `current_state`
/// is the post-floor state. `latched_prompt_ts` is what's currently in the
/// `promoted_for_prompt` map (None if no entry).
pub(crate) fn promote_decision(
    current_state: &str,
    latched_prompt_ts: Option<f64>,
    last_user_prompt_ts: Option<f64>,
    last_assistant_text_ts: Option<f64>,
    last_assistant_has_text: bool,
) -> PromoteDecision {
    if current_state != "thinking" {
        return PromoteDecision::Keep;
    }
    let prompt_ts = last_user_prompt_ts.unwrap_or(0.0);
    if let Some(already) = latched_prompt_ts {
        if already > 0.0 && (already - prompt_ts).abs() < 0.001 {
            return PromoteDecision::Held;
        }
    }
    if !last_assistant_has_text {
        return PromoteDecision::Keep;
    }
    let text_after_prompt = match (last_assistant_text_ts, last_user_prompt_ts) {
        (Some(t), Some(p)) => t >= p,
        _ => true, // tolerate older entries missing one or both timestamps
    };
    if text_after_prompt {
        PromoteDecision::Promote { prompt_ts }
    } else {
        PromoteDecision::Keep
    }
}

/// Pure predicate for "should we extend the compacting display floor?"
/// `until` is the floor's expiry ts (None if no floor active).
///
/// F-correctness-001 — narrowed to mask only neutral / done states. The
/// floor exists to keep the periwinkle "compacting" indicator visible for
/// a full poll tick when the hook writes `compacting` → `working` quickly,
/// but `error`/`waiting`/`subagent`/`compacting` itself are either user-
/// attention states (must surface immediately) or already the right
/// indicator. Previously the only guard was `state != "compacting"`, which
/// silently shadowed `error`/`waiting` behind compacting for up to 1.5 s.
pub(crate) fn floor_extends(state: &str, until: Option<f64>, now: f64) -> bool {
    if !matches!(state, "working" | "thinking" | "idle" | "done") {
        return false;
    }
    until.is_some_and(|u| u > now)
}

fn resolve_liveness(
    pid: u32,
    live_start: Option<u64>,
    cached: Option<(u32, u64)>,
    live_name: Option<&str>,
) -> LivenessOutcome {
    match (live_start, cached) {
        // First sight — capture identity, but require the process name to
        // contain "claude" before trusting it. Without this guard, a session
        // whose recorded `pid` was recycled by the OS between the hook write
        // and Cue's first poll would silently anchor onto an unrelated
        // process (any random PID) and survive every later liveness check
        // for the duration of that unrelated process. F-reliability-005.
        (Some(start), None) => {
            let name_ok = live_name
                .map(|n| n.to_ascii_lowercase().contains("claude"))
                .unwrap_or(false);
            if name_ok {
                LivenessOutcome::Alive {
                    cache: (pid, start),
                }
            } else {
                LivenessOutcome::Dead
            }
        }
        // Same PID, same start time — definitely the same process.
        (Some(start), Some((cached_pid, cached_start)))
            if cached_pid == pid && cached_start == start =>
        {
            LivenessOutcome::Alive {
                cache: (pid, start),
            }
        }
        // PID held by some process, but start_time or pid diverges from cache:
        // the original process died and its PID got reused. Treat as dead.
        (Some(_), Some(_)) => LivenessOutcome::Dead,
        // No process at that PID at all — dead.
        (None, _) => LivenessOutcome::Dead,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_workspace_path_unix() {
        assert_eq!(encode_workspace_path("/Users/dev/App"), "-Users-dev-App");
    }

    #[test]
    fn test_encode_workspace_path_deep() {
        assert_eq!(
            encode_workspace_path("/Users/dev/Projects/MyOrg/WebApp"),
            "-Users-dev-Projects-MyOrg-WebApp"
        );
    }

    #[test]
    fn test_encode_workspace_path_no_leading_slash() {
        // Every non-alphanumeric is encoded — including the drive colon.
        assert_eq!(
            encode_workspace_path("C:/Users/dev/App"),
            "C--Users-dev-App"
        );
    }

    #[test]
    fn test_encode_workspace_path_special_chars() {
        // Underscores, dots, and spaces all become '-' (Claude Code's rule).
        // Verified live: /Users/dev/Projects/Tools/codebase_visualizer maps
        // to -Users-dev-Projects-Tools-codebase-visualizer on disk.
        assert_eq!(
            encode_workspace_path("/Users/dev/my_app.v2"),
            "-Users-dev-my-app-v2"
        );
        assert_eq!(
            encode_workspace_path("/Users/dev/My Docs/proj"),
            "-Users-dev-My-Docs-proj"
        );
    }

    #[test]
    fn test_encode_workspace_path_root() {
        assert_eq!(encode_workspace_path("/"), "-");
    }

    #[test]
    fn test_liveness_first_sight_captures_identity_when_name_is_claude() {
        match resolve_liveness(1234, Some(5000), None, Some("claude")) {
            LivenessOutcome::Alive { cache } => assert_eq!(cache, (1234, 5000)),
            LivenessOutcome::Dead => panic!("expected Alive on first sight of claude"),
        }
    }

    #[test]
    fn test_liveness_first_sight_accepts_mixed_case_claude() {
        // Real binaries are sometimes "claude", "claude-code", "Claude.app/Contents/MacOS/Claude"
        // — the check is case-insensitive substring match on "claude".
        match resolve_liveness(1234, Some(5000), None, Some("Claude-Code")) {
            LivenessOutcome::Alive { cache } => assert_eq!(cache, (1234, 5000)),
            LivenessOutcome::Dead => panic!("expected Alive on Claude-Code"),
        }
    }

    #[test]
    fn test_liveness_first_sight_rejects_unrelated_process() {
        // F-reliability-005 — recycled PID anchored onto an unrelated process.
        assert!(matches!(
            resolve_liveness(1234, Some(5000), None, Some("nginx")),
            LivenessOutcome::Dead
        ));
    }

    #[test]
    fn test_liveness_first_sight_rejects_when_name_unavailable() {
        // sysinfo couldn't read the process name; conservatively treat as dead
        // on first sight. The hook will re-fire and we'll get another chance.
        assert!(matches!(
            resolve_liveness(1234, Some(5000), None, None),
            LivenessOutcome::Dead
        ));
    }

    #[test]
    fn test_liveness_matching_cache_stays_alive_regardless_of_name() {
        // Once we've cached identity, name no longer matters — the cached
        // (pid, start_time) tuple is the authoritative check.
        match resolve_liveness(1234, Some(5000), Some((1234, 5000)), Some("anything")) {
            LivenessOutcome::Alive { cache } => assert_eq!(cache, (1234, 5000)),
            LivenessOutcome::Dead => panic!("expected Alive when cache matches"),
        }
    }

    #[test]
    fn test_liveness_process_gone_is_dead() {
        assert!(matches!(
            resolve_liveness(1234, None, Some((1234, 5000)), Some("claude")),
            LivenessOutcome::Dead
        ));
    }

    #[test]
    fn test_liveness_never_alive_is_dead() {
        // Hook wrote a PID but there's no process at that pid and we never
        // cached one. Means it died before we ever polled — still dead.
        assert!(matches!(
            resolve_liveness(1234, None, None, None),
            LivenessOutcome::Dead
        ));
    }

    #[test]
    fn test_liveness_pid_reuse_different_start_time_is_dead() {
        // Same pid, but a different process now holds it (different start time).
        assert!(matches!(
            resolve_liveness(1234, Some(9999), Some((1234, 5000)), Some("claude")),
            LivenessOutcome::Dead
        ));
    }

    #[test]
    fn test_liveness_sensitive_states() {
        assert!(is_liveness_sensitive("working"));
        assert!(is_liveness_sensitive("thinking"));
        assert!(is_liveness_sensitive("subagent"));
        assert!(is_liveness_sensitive("compacting"));
        // `waiting` is liveness-sensitive: a stale prompt whose process died
        // shouldn't linger forever. A live waiting prompt has both PID + JSONL
        // intact, so liveness leaves it alone.
        assert!(is_liveness_sensitive("waiting"));
        assert!(!is_liveness_sensitive("idle"));
        assert!(!is_liveness_sensitive("done"));
        assert!(!is_liveness_sensitive("error"));
        // `clearing` is intentionally NOT liveness-sensitive — the canonical
        // Claude Code event list has no `PreClear`, the hook never writes
        // "clearing" (it's not in valid_actions), so any value reaching here
        // would be from an external mutator. Don't grant it active-state
        // privileges. See is_liveness_sensitive for the full rationale.
        assert!(!is_liveness_sensitive("clearing"));
    }

    #[test]
    fn test_session_monitor_state_new() {
        let state = SessionMonitorState::new();
        assert!(state.enriched_sessions.lock_safe().is_empty());
    }

    // ── admission filter ────────────────────────────────────────────────
    // Cue's launch-time admission gate is state-aware: active/waiting
    // states bypass it (the PID + JSONL liveness checks downstream are the
    // real gate), terminal states keep it so prior-run ghosts don't surface.

    #[test]
    fn test_bypasses_launch_gate_active_states() {
        for s in ["working", "thinking", "subagent", "compacting", "waiting"] {
            assert!(bypasses_launch_gate(s), "state {} should bypass", s);
        }
    }

    #[test]
    fn test_bypasses_launch_gate_terminal_states() {
        for s in ["idle", "done", "error", "ended"] {
            assert!(!bypasses_launch_gate(s), "state {} should not bypass", s);
        }
    }

    #[test]
    fn test_admit_active_session_with_old_timestamps() {
        // Working session that started before Cue launched and hasn't fired
        // a hook event since (mid-generation) must still be admitted.
        let launched = 1000.0;
        assert!(admit_session("working", 500.0, 600.0, launched));
        assert!(admit_session("thinking", 500.0, 600.0, launched));
        assert!(admit_session("subagent", 0.0, 0.0, launched));
    }

    #[test]
    fn test_admit_waiting_session_with_old_timestamps() {
        // User-attention state — must surface regardless of launch time.
        assert!(admit_session("waiting", 100.0, 100.0, 9999.0));
    }

    #[test]
    fn test_filter_terminal_session_before_launch() {
        // Stale idle/done/error from a prior run must stay hidden.
        let launched = 1000.0;
        assert!(!admit_session("idle", 500.0, 600.0, launched));
        assert!(!admit_session("done", 500.0, 600.0, launched));
        assert!(!admit_session("error", 500.0, 600.0, launched));
        assert!(!admit_session("ended", 500.0, 600.0, launched));
    }

    #[test]
    fn test_admit_terminal_session_with_recent_activity() {
        // Idle/done sessions whose last hook event is post-launch should
        // surface — their activity proves they're still relevant.
        let launched = 1000.0;
        assert!(admit_session("idle", 500.0, 1500.0, launched));
        assert!(admit_session("done", 1100.0, 1100.0, launched));
    }

    // ── promote_decision: thinking→working latch ────────────────────────

    #[test]
    fn promote_keeps_non_thinking_states() {
        // Latch only acts on `thinking` — never overrides working/idle/etc.
        for st in &["working", "idle", "done", "waiting", "error", "subagent"] {
            assert_eq!(
                promote_decision(st, None, Some(100.0), Some(200.0), true),
                PromoteDecision::Keep,
            );
        }
    }

    #[test]
    fn promote_held_when_latch_matches_prompt() {
        // The bounce-prevention path: same prompt_ts already promoted →
        // keep working without re-checking the JSONL signal (which may be
        // mid-flush and absent).
        let d = promote_decision("thinking", Some(50.0), Some(50.0), None, false);
        assert_eq!(d, PromoteDecision::Held);
    }

    #[test]
    fn promote_held_ignores_zero_latch() {
        // Default 0.0 latch must not match a 0.0 prompt_ts (no real prompt).
        let d = promote_decision("thinking", Some(0.0), Some(0.0), None, false);
        assert_eq!(d, PromoteDecision::Keep);
    }

    #[test]
    fn promote_fires_when_text_after_prompt() {
        // Prompt at t=10, text at t=15 → user-visible reply has begun.
        let d = promote_decision("thinking", None, Some(10.0), Some(15.0), true);
        assert_eq!(d, PromoteDecision::Promote { prompt_ts: 10.0 });
    }

    #[test]
    fn promote_keeps_when_text_predates_prompt() {
        // The previous turn's assistant text is still in JSONL after the
        // new UserPromptSubmit. Don't false-promote.
        let d = promote_decision("thinking", None, Some(20.0), Some(15.0), true);
        assert_eq!(d, PromoteDecision::Keep);
    }

    #[test]
    fn promote_keeps_when_no_text_block() {
        // Pure extended-thinking response — output_tokens accumulating in
        // `thinking` blocks, no `text` block yet.
        let d = promote_decision("thinking", None, Some(10.0), None, false);
        assert_eq!(d, PromoteDecision::Keep);
    }

    #[test]
    fn promote_tolerates_missing_timestamps() {
        // Old hook entries that lack last_assistant_text_ts must still
        // promote — the back-compat path matches the original behavior.
        let d = promote_decision("thinking", None, None, None, true);
        assert!(matches!(d, PromoteDecision::Promote { .. }));
    }

    #[test]
    fn promote_held_survives_text_disappearing() {
        // Once latched, transient JSONL flush misses don't unflip the
        // decision — that was the original bouncing bug.
        let latched = Some(42.0);
        let d = promote_decision(
            "thinking",
            latched,
            Some(42.0),
            None,   // text_ts not visible this poll
            false,  // last_assistant_has_text temporarily false
        );
        assert_eq!(d, PromoteDecision::Held);
    }

    // ── floor_extends: compacting display floor ─────────────────────────

    #[test]
    fn floor_extends_when_state_left_compacting_within_window() {
        assert!(floor_extends("working", Some(100.5), 100.0));
    }

    #[test]
    fn floor_does_not_extend_after_window_expired() {
        assert!(!floor_extends("idle", Some(99.0), 100.0));
    }

    #[test]
    fn floor_does_not_extend_when_no_floor_set() {
        assert!(!floor_extends("idle", None, 100.0));
    }

    #[test]
    fn floor_does_not_extend_when_state_already_compacting() {
        // The hook is currently writing compacting → no need to mask.
        assert!(!floor_extends("compacting", Some(101.0), 100.0));
    }

    #[test]
    fn test_poll_status_no_crash() {
        let state = SessionMonitorState::new();
        // Should not panic regardless of whether sessions.json exists
        state.poll_status();
        // Just verify it produces valid output (may be non-empty if real sessions.json exists)
        let sessions = state.enriched_sessions.lock_safe();
        let _ = sessions.len(); // accessible, not corrupted
    }

    #[test]
    fn test_jsonl_path_resolution_with_fixture() {
        let dir = std::env::temp_dir().join("cue_test_resolve");
        let _ = std::fs::remove_dir_all(&dir);

        // Create a fixture: projects/-Users-dev-App/session-1.jsonl
        let project_dir = dir.join("-Users-dev-App");
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(project_dir.join("session-1.jsonl"), "{}").unwrap();

        let state = SessionMonitorState::new();
        let path = state.jsonl_path("session-1", "/Users/dev/App", &dir);
        assert!(path.contains("session-1.jsonl"));
        assert!(path.contains("-Users-dev-App"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_jsonl_path_parent_walk() {
        let dir = std::env::temp_dir().join("cue_test_parent_walk");
        let _ = std::fs::remove_dir_all(&dir);

        // JSONL is stored under the git root (parent), not the exact workspace
        let project_dir = dir.join("-Users-dev-Projects");
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(project_dir.join("session-2.jsonl"), "{}").unwrap();

        let state = SessionMonitorState::new();
        let path = state.jsonl_path("session-2", "/Users/dev/Projects/SubDir", &dir);
        assert!(path.contains("session-2.jsonl"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn make_session(id: &str, state: &str, last_activity: f64, started_at: f64) -> SessionInfo {
        SessionInfo {
            id: id.to_string(),
            workspace: "/Users/dev/App".to_string(),
            state: state.to_string(),
            last_activity,
            started_at,
            state_changed_at: None,
            source: None,
            hook_input_tokens: 0,
            hook_output_tokens: 0,
            hook_model: String::new(),
            active_subagents: 0,
            subprocess: None,
            team_name: None,
            agent_name: None,
            pid: None,
            permission_mode: None,
            error_type: None,
            pending_permission: None,
        }
    }

    fn metrics_with_end_turn(
        end_turn_ts: Option<f64>,
        pending: bool,
    ) -> crate::models::SessionMetrics {
        crate::models::SessionMetrics {
            last_end_turn_ts: end_turn_ts,
            pending_tool_use: pending,
            ..Default::default()
        }
    }

    #[test]
    fn test_demote_on_interrupt_marker_newer_than_state_change() {
        // ESC interrupt: no hook fires; the transcript marker is the only
        // signal. Newer than stateChangedAt → demote working/thinking/waiting
        // immediately instead of waiting out the 5-min stalled-turn timer.
        let m = crate::models::SessionMetrics {
            last_interrupt_ts: Some(150.0),
            ..Default::default()
        };
        for st in ["working", "thinking", "waiting"] {
            assert!(
                should_demote_turn_ended(st, Some(100.0), Some(&m)),
                "state {} must demote on fresh interrupt",
                st
            );
        }
    }

    #[test]
    fn test_no_demote_on_stale_interrupt_marker() {
        // Marker from a PRIOR turn (user interrupted, then prompted again —
        // stateChangedAt advanced past the marker). Must not demote.
        let m = crate::models::SessionMetrics {
            last_interrupt_ts: Some(50.0),
            ..Default::default()
        };
        assert!(!should_demote_turn_ended("working", Some(100.0), Some(&m)));
    }

    #[test]
    fn test_no_demote_on_interrupt_while_tool_pending() {
        // A pending tool_use always wins: genuine in-flight work is never
        // demoted, marker or not (tool interrupts clear pending via the
        // synthetic tool_result, so a real abort never hits this guard).
        let m = crate::models::SessionMetrics {
            last_interrupt_ts: Some(150.0),
            pending_tool_use: true,
            ..Default::default()
        };
        assert!(!should_demote_turn_ended("working", Some(100.0), Some(&m)));
    }

    #[test]
    fn test_demote_when_end_turn_newer_than_state_change() {
        // Canonical stuck-working case: Stop hook missed, but JSONL has
        // end_turn timestamp after stateChangedAt → demote to idle.
        let m = metrics_with_end_turn(Some(200.0), false);
        assert!(should_demote_turn_ended("working", Some(100.0), Some(&m)));
        assert!(should_demote_turn_ended("thinking", Some(100.0), Some(&m)));
    }

    #[test]
    fn test_no_demote_when_end_turn_older_than_state_change() {
        // Stale end_turn from a prior turn (e.g. before /clear reset the
        // boundary, or before the user's new prompt). Must not demote.
        let m = metrics_with_end_turn(Some(50.0), false);
        assert!(!should_demote_turn_ended("working", Some(100.0), Some(&m)));
    }

    #[test]
    fn test_demote_resumed_idle_session_when_parse_caught_up() {
        // `claude --resume` bumped stateChangedAt (200) past the old end_turn
        // (100) with no new turn. Once the parse re-read the transcript past the
        // bump (file mtime 250 >= 200), the stuck `working` card demotes to idle.
        let m = crate::models::SessionMetrics {
            last_end_turn_ts: Some(100.0),
            pending_tool_use: false,
            parsed_file_mtime: Some(250.0),
            ..Default::default()
        };
        assert!(should_demote_turn_ended("working", Some(200.0), Some(&m)));
        assert!(should_demote_turn_ended("thinking", Some(200.0), Some(&m)));
    }

    #[test]
    fn test_no_demote_resumed_when_parse_not_caught_up() {
        // Same shape but the parse is still stale (mtime 150 < stateChangedAt
        // 200) — could be a real new turn mid-refresh, so HOLD (no idle flicker).
        let m = crate::models::SessionMetrics {
            last_end_turn_ts: Some(100.0),
            pending_tool_use: false,
            parsed_file_mtime: Some(150.0),
            ..Default::default()
        };
        assert!(!should_demote_turn_ended("working", Some(200.0), Some(&m)));
    }

    #[test]
    fn test_no_demote_when_pending_tool_use() {
        // Mid-turn with an unresolved tool_use: leave state alone.
        let m = metrics_with_end_turn(Some(200.0), true);
        assert!(!should_demote_turn_ended("working", Some(100.0), Some(&m)));
    }

    #[test]
    fn test_no_demote_for_non_active_states() {
        // Gate on {working, thinking, waiting, error} — don't touch subagent,
        // compacting, or terminal states. F-state-coverage-009 added `error`
        // because a clean end_turn after the error proves the user retried
        // and the issue resolved.
        let m = metrics_with_end_turn(Some(200.0), false);
        for st in [
            "subagent",
            "compacting",
            "idle",
            "done",
        ] {
            assert!(
                !should_demote_turn_ended(st, Some(100.0), Some(&m)),
                "state {} should not be demoted",
                st
            );
        }
    }

    #[test]
    fn test_no_demote_when_metrics_absent() {
        // Transcript not yet parsed or missing → stay put.
        assert!(!should_demote_turn_ended("working", Some(100.0), None));
    }

    #[test]
    fn test_no_demote_when_end_turn_ts_absent() {
        // Metrics exist but no end_turn observed → stay put.
        let m = metrics_with_end_turn(None, false);
        assert!(!should_demote_turn_ended("working", Some(100.0), Some(&m)));
    }

    // ── should_demote_stalled_turn ──────────────────────────────────────
    // Last-resort recovery for a working/thinking card whose process is
    // alive but whose transcript froze on an unanswered prompt.

    fn metrics_stalled(
        last_user_prompt_ts: Option<f64>,
        last_assistant_text_ts: Option<f64>,
        last_end_turn_ts: Option<f64>,
        pending: bool,
        awaiting: bool,
    ) -> crate::models::SessionMetrics {
        crate::models::SessionMetrics {
            last_user_prompt_ts,
            last_assistant_text_ts,
            last_end_turn_ts,
            pending_tool_use: pending,
            awaiting_user_prompt: awaiting,
            ..Default::default()
        }
    }

    #[test]
    fn test_stalled_turn_demotes_unanswered_prompt() {
        // Canonical case: user prompted at t=1000, no assistant output since,
        // now = 1000 + 6min. Last end_turn is from a *prior* turn (t=600), so
        // should_demote_turn_ended can't fire — but this cap does.
        let m = metrics_stalled(Some(1000.0), None, Some(600.0), false, false);
        assert!(should_demote_stalled_turn("working", Some(&m), 1000.0 + 360.0));
        assert!(should_demote_stalled_turn("thinking", Some(&m), 1000.0 + 360.0));
    }

    #[test]
    fn test_stalled_turn_no_demote_within_window() {
        // Same shape but only 4 minutes of silence — still inside the grace.
        let m = metrics_stalled(Some(1000.0), None, Some(600.0), false, false);
        assert!(!should_demote_stalled_turn("working", Some(&m), 1000.0 + 240.0));
    }

    #[test]
    fn test_stalled_turn_no_demote_pending_tool() {
        // A long-running tool keeps the transcript quiet but is genuine work.
        let m = metrics_stalled(Some(1000.0), None, Some(600.0), true, false);
        assert!(!should_demote_stalled_turn("working", Some(&m), 1000.0 + 600.0));
    }

    #[test]
    fn test_stalled_turn_no_demote_awaiting_user() {
        // Awaiting an AskUserQuestion/ExitPlanMode answer is the waiting
        // path's domain, not a stall.
        let m = metrics_stalled(Some(1000.0), None, Some(600.0), false, true);
        assert!(!should_demote_stalled_turn("working", Some(&m), 1000.0 + 600.0));
    }

    #[test]
    fn test_stalled_turn_uses_newest_activity_ts() {
        // Assistant began streaming text at t=1100 (after the prompt at 1000),
        // then stalled. The cap keys off the newest activity (1100), so at
        // 1100 + 4min it must NOT yet demote even though the prompt is older.
        let m = metrics_stalled(Some(1000.0), Some(1100.0), Some(600.0), false, false);
        assert!(!should_demote_stalled_turn("working", Some(&m), 1100.0 + 240.0));
        assert!(should_demote_stalled_turn("working", Some(&m), 1100.0 + 360.0));
    }

    #[test]
    fn test_stalled_turn_counts_tool_results_as_activity() {
        // Deep agentic stretch: no text for 10+ minutes, but a tool_result
        // landed seconds ago (and the next assistant message hasn't been
        // written yet, so pending_tool_use reads false). The cap must treat
        // the tool_result as proof-of-life and hold (audit F6).
        let mut m = metrics_stalled(Some(1000.0), None, Some(600.0), false, false);
        m.last_tool_result_ts = Some(1600.0);
        assert!(!should_demote_stalled_turn("working", Some(&m), 1600.0 + 5.0));
        // Once even the tool results go silent past the window, demote.
        assert!(should_demote_stalled_turn("working", Some(&m), 1600.0 + 360.0));
    }

    #[test]
    fn test_stalled_turn_no_demote_non_active_states() {
        let m = metrics_stalled(Some(1000.0), None, Some(600.0), false, false);
        for st in ["idle", "done", "ended", "error", "waiting", "subagent", "compacting"] {
            assert!(
                !should_demote_stalled_turn(st, Some(&m), 1000.0 + 600.0),
                "state {} should not be demoted by stalled-turn cap",
                st
            );
        }
    }

    #[test]
    fn test_stalled_turn_no_demote_without_metrics_or_ts() {
        assert!(!should_demote_stalled_turn("working", None, 1_000_000.0));
        // Metrics present but no conversational timestamp parsed yet.
        let m = metrics_stalled(None, None, None, false, false);
        assert!(!should_demote_stalled_turn("working", Some(&m), 1_000_000.0));
    }

    // ── is_promotable_to_waiting ────────────────────────────────────────
    // Guards which states the JSONL-driven waiting verdict is allowed to
    // overwrite. Terminal/specialized states own their truth from elsewhere.

    #[test]
    fn test_promotable_to_waiting_allows_active_and_waiting_states() {
        assert!(is_promotable_to_waiting("working"));
        assert!(is_promotable_to_waiting("thinking"));
        assert!(is_promotable_to_waiting("idle"));
        // Already-waiting must remain promotable so the no-op case is cheap
        // and explicit (and the inverse "demote stale waiting" check still
        // gates on awaiting_user_prompt being false).
        assert!(is_promotable_to_waiting("waiting"));
    }

    #[test]
    fn test_promotable_to_waiting_rejects_terminal_and_specialized() {
        for st in [
            "done",
            "ended",
            "error",
            "subagent",
            "compacting",
            "clearing",
            "remove",
        ] {
            assert!(
                !is_promotable_to_waiting(st),
                "state {} must not be overwritten by JSONL waiting verdict",
                st
            );
        }
    }

    // ── should_resolve_waiting ──────────────────────────────────────────
    // Decides when a card shown as `waiting` may demote back to `idle`. The
    // `pending` guard is what keeps a hook-seeded permission-prompt card alive
    // until the gated tool_use actually resolves.

    #[test]
    fn test_resolve_waiting_demotes_when_nothing_pending() {
        // AskUserQuestion answered (awaiting cleared, its tool_result is at the
        // tail so pending is false too) → safe to demote.
        assert!(should_resolve_waiting(false, false));
    }

    #[test]
    fn test_resolve_waiting_holds_open_permission_prompt() {
        // Permission prompt: no prompting tool_use (awaiting=false) but a real
        // tool_use is parked behind the dialog (pending=true). Must NOT demote
        // — this is the exact regression: demoting on !awaiting alone erased
        // every permission-prompt waiting within one poll.
        assert!(!should_resolve_waiting(false, true));
    }

    #[test]
    fn test_resolve_waiting_holds_unanswered_prompting_tool() {
        // AskUserQuestion / ExitPlanMode still unanswered (awaiting=true). The
        // promote arm re-asserts waiting; the resolve arm must keep its hands
        // off regardless of the pending flag.
        assert!(!should_resolve_waiting(true, false));
        assert!(!should_resolve_waiting(true, true));
    }

    // ── should_demote_stale_subagent ────────────────────────────────────

    fn metrics_with_subagents(
        subagents: Vec<crate::models::SubagentMetrics>,
    ) -> crate::models::SessionMetrics {
        crate::models::SessionMetrics {
            subagents,
            ..Default::default()
        }
    }

    fn subagent(is_active: bool) -> crate::models::SubagentMetrics {
        crate::models::SubagentMetrics {
            agent_id: "test".to_string(),
            description: "test".to_string(),
            slug: "test".to_string(),
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            model: String::new(),
            tool_counts: std::collections::HashMap::new(),
            message_count: 0,
            is_active,
            started_at: None,
            ended_at: None,
        }
    }

    #[test]
    fn test_demote_stale_subagent_when_no_live_jsonl_after_grace() {
        // Canonical stuck-subagent: counter > 0, state was set 30s ago,
        // no JSONL touched in the live window → demote.
        let m = metrics_with_subagents(vec![subagent(false)]);
        let now = 1000.0;
        assert!(should_demote_stale_subagent(
            "subagent",
            Some(now - 30.0),
            Some(&m),
            now,
        ));
    }

    #[test]
    fn test_demote_stale_subagent_when_metrics_have_no_subagents() {
        // Counter is positive but no JSONLs exist for this session at all
        // (likely deleted, never created, or wrong dir). Treat as stale.
        let m = metrics_with_subagents(vec![]);
        let now = 1000.0;
        assert!(should_demote_stale_subagent(
            "subagent",
            Some(now - 30.0),
            Some(&m),
            now,
        ));
    }

    #[test]
    fn test_no_demote_stale_subagent_within_grace_window() {
        // Just entered subagent state — JSONL may not exist yet. Grace
        // period must protect this case so we don't bounce off legit
        // subagent spawns.
        let m = metrics_with_subagents(vec![]);
        let now = 1000.0;
        assert!(!should_demote_stale_subagent(
            "subagent",
            Some(now - 5.0),
            Some(&m),
            now,
        ));
    }

    #[test]
    fn test_no_demote_stale_subagent_when_jsonl_is_active() {
        // Subagent JSONL was modified within 60s — agent is still working.
        let m = metrics_with_subagents(vec![subagent(true)]);
        let now = 1000.0;
        assert!(!should_demote_stale_subagent(
            "subagent",
            Some(now - 30.0),
            Some(&m),
            now,
        ));
    }

    #[test]
    fn test_no_demote_stale_subagent_when_any_jsonl_is_active() {
        // Mixed: one active, one stale → still live, don't demote.
        let m = metrics_with_subagents(vec![subagent(false), subagent(true)]);
        let now = 1000.0;
        assert!(!should_demote_stale_subagent(
            "subagent",
            Some(now - 30.0),
            Some(&m),
            now,
        ));
    }

    #[test]
    fn test_subagent_rescue_when_counter_zero_and_jsonl_active() {
        // The core fix: the hook counter reads 0 mid-batch (missed
        // SubagentStart, or zeroed by a heal) but an agent JSONL is still
        // mid-turn. Both idle and done must be rescued on every poll.
        let m = metrics_with_subagents(vec![subagent(true)]);
        assert_eq!(subagent_rescue_count("idle", 0, Some(&m)), Some(1));
        assert_eq!(subagent_rescue_count("done", 0, Some(&m)), Some(1));
    }

    #[test]
    fn test_subagent_rescue_counts_only_active_jsonls() {
        // The live count reflects only still-running agents (tail not yet
        // end_turn) — a finished agent must not inflate `activeSubagents`.
        let m = metrics_with_subagents(vec![subagent(true), subagent(false), subagent(true)]);
        assert_eq!(subagent_rescue_count("idle", 0, Some(&m)), Some(2));
    }

    #[test]
    fn test_no_subagent_rescue_when_no_active_jsonl() {
        // Every agent finished (tail end_turn) and no Agent tool_use pending →
        // the batch is over; don't rescue. Symmetric with
        // should_demote_stale_subagent's exit, so a genuinely-finished batch
        // lands on idle rather than flapping.
        let m = metrics_with_subagents(vec![subagent(false), subagent(false)]);
        assert_eq!(subagent_rescue_count("idle", 0, Some(&m)), None);
    }

    #[test]
    fn test_no_subagent_rescue_when_counter_nonzero() {
        // Counter > 0 means the hook already owns the subagent state — the
        // rescue is strictly the counter-is-zero fallback.
        let m = metrics_with_subagents(vec![subagent(true)]);
        assert_eq!(subagent_rescue_count("idle", 2, Some(&m)), None);
    }

    #[test]
    fn test_no_subagent_rescue_for_attention_states() {
        // Only done/idle/working are rescuable; never override an attention
        // or specialized state (or re-enter an already-subagent card).
        let m = metrics_with_subagents(vec![subagent(true)]);
        for st in ["thinking", "waiting", "error", "compacting", "subagent"] {
            assert_eq!(
                subagent_rescue_count(st, 0, Some(&m)),
                None,
                "state {} must not be rescued",
                st
            );
        }
    }

    #[test]
    fn test_subagent_rescue_lifts_working_mid_batch() {
        // Subagent tool events fire PreToolUse/PostToolUse on the PARENT
        // session id, so a zeroed counter rewrites the card to `working` on
        // every agent tool call. The rescue must lift working back to
        // subagent while either live signal holds.
        let m = metrics_with_subagents(vec![subagent(true)]);
        assert_eq!(subagent_rescue_count("working", 0, Some(&m)), Some(1));
    }

    #[test]
    fn test_subagent_rescue_from_pending_agent_tool_alone() {
        // Foreground batch in flight (unmatched Agent tool_use) but agent
        // JSONLs quiet/missing — e.g. the spawn window before files exist, or
        // every agent stuck inside a long tool call. The parent-transcript
        // signal alone must hold the card on subagent.
        let mut m = metrics_with_subagents(vec![]);
        m.pending_agent_tool_count = 3;
        assert_eq!(subagent_rescue_count("idle", 0, Some(&m)), Some(3));
        // Larger of the two signals wins for the displayed count.
        let mut m2 = metrics_with_subagents(vec![subagent(true)]);
        m2.pending_agent_tool_count = 2;
        assert_eq!(subagent_rescue_count("done", 0, Some(&m2)), Some(2));
    }

    #[test]
    fn test_no_demote_stale_subagent_while_agent_tool_pending() {
        // Counter says subagent, all agent JSONLs look quiet — but the parent
        // transcript still has an unmatched Agent tool_use. The batch is
        // running; don't demote.
        let mut m = metrics_with_subagents(vec![subagent(false)]);
        m.pending_agent_tool_count = 1;
        let now = 1000.0;
        assert!(!should_demote_stale_subagent(
            "subagent",
            Some(now - 30.0),
            Some(&m),
            now,
        ));
    }

    #[test]
    fn test_no_subagent_rescue_when_metrics_absent_or_empty() {
        // No transcript parsed yet, or no subagent JSONLs at all → nothing to
        // rescue from.
        assert_eq!(subagent_rescue_count("idle", 0, None), None);
        let m = metrics_with_subagents(vec![]);
        assert_eq!(subagent_rescue_count("idle", 0, Some(&m)), None);
    }

    #[test]
    fn test_no_demote_stale_subagent_for_non_subagent_states() {
        // Predicate gates strictly on state == "subagent".
        let m = metrics_with_subagents(vec![]);
        let now = 1000.0;
        for st in [
            "working",
            "thinking",
            "waiting",
            "compacting",
            "clearing",
            "idle",
            "done",
            "error",
        ] {
            assert!(
                !should_demote_stale_subagent(st, Some(now - 30.0), Some(&m), now),
                "state {} should not be demoted by stale-subagent path",
                st
            );
        }
    }

    #[test]
    fn test_no_demote_stale_subagent_without_state_changed_at() {
        // Missing stateChangedAt → can't compute the grace window. Stay put.
        let m = metrics_with_subagents(vec![]);
        assert!(!should_demote_stale_subagent("subagent", None, Some(&m), 1000.0));
    }

    #[test]
    fn test_demote_stale_subagent_when_metrics_absent() {
        // Transcript not yet parsed. When metrics is None we use a longer
        // 30s grace (vs the 15s applied when metrics is present) so the
        // ~5 Hz refresh_metrics has time to populate the cache after a
        // session-id rotation. At age 30s exactly, demote.
        let now = 1000.0;
        assert!(should_demote_stale_subagent(
            "subagent",
            Some(now - 30.0),
            None,
            now,
        ));
    }

    #[test]
    fn test_no_demote_stale_subagent_when_metrics_absent_inside_extended_grace() {
        // metrics=None at age 20s — inside the 30s extended grace. Stay put.
        let now = 1000.0;
        assert!(!should_demote_stale_subagent(
            "subagent",
            Some(now - 20.0),
            None,
            now,
        ));
    }

    #[test]
    fn test_demote_stale_subagent_with_metrics_at_standard_grace_boundary() {
        // metrics present + no live JSONL: standard 15s grace applies.
        // At age 15.0001 exactly — demote.
        let m = metrics_with_subagents(vec![]);
        let now = 1000.0;
        assert!(should_demote_stale_subagent(
            "subagent",
            Some(now - 15.0001),
            Some(&m),
            now,
        ));
    }

    #[test]
    fn test_no_demote_stale_subagent_just_inside_standard_grace() {
        // The contract is `age < 15.0` → grace-protected. Pin age=14.999
        // as "just inside, don't demote" so a regression to `<= 15.0`
        // would still pass this test (with metrics absent and short
        // enough age) — we instead pin the strict-<15.0 boundary in
        // test_demote_stale_subagent_with_metrics_at_standard_grace_boundary.
        let m = metrics_with_subagents(vec![]);
        let now = 1000.0;
        assert!(!should_demote_stale_subagent(
            "subagent",
            Some(now - 14.999),
            Some(&m),
            now,
        ));
    }

    // ── should_demote_turn_ended waiting extension ──────────────────────

    #[test]
    fn test_demote_turn_ended_for_waiting_state() {
        // Permission prompt resolved out-of-band (user killed terminal or
        // dismissed prompt without producing a hook). Transcript shows
        // end_turn newer than stateChangedAt — demote.
        let m = metrics_with_end_turn(Some(200.0), false);
        assert!(should_demote_turn_ended("waiting", Some(100.0), Some(&m)));
    }

    #[test]
    fn test_no_demote_turn_ended_for_waiting_when_end_turn_stale() {
        // end_turn from a prior turn, before the user's most recent prompt.
        // The waiting state was a response to the most recent prompt — leave it.
        let m = metrics_with_end_turn(Some(50.0), false);
        assert!(!should_demote_turn_ended("waiting", Some(100.0), Some(&m)));
    }

    // ── should_demote_stuck_active (compacting 60s cap) ─────────────────

    #[test]
    fn test_demote_stuck_active_compacting_past_60s() {
        // /compact errored before its resolving hook; card is pinned on
        // `compacting` for >60s. Cap fires.
        assert!(should_demote_stuck_active("compacting", Some(900.0), 1000.0));
    }

    #[test]
    fn test_no_demote_stuck_active_clearing() {
        // `clearing` no longer participates — the hook can't produce it. If
        // an external mutator wrote it, we'd rather show it indefinitely
        // than apply a 60s cap to data we don't produce.
        assert!(!should_demote_stuck_active("clearing", Some(900.0), 1000.0));
    }

    #[test]
    fn test_no_demote_stuck_active_within_cap() {
        // 30s in — still in the normal transient window.
        assert!(!should_demote_stuck_active("compacting", Some(970.0), 1000.0));
    }

    #[test]
    fn test_no_demote_stuck_active_for_unrelated_states() {
        for st in ["working", "thinking", "idle", "done", "error", "waiting", "subagent"] {
            assert!(
                !should_demote_stuck_active(st, Some(900.0), 1000.0),
                "stuck-active cap must only fire for compacting, not {}",
                st
            );
        }
    }

    #[test]
    fn test_no_demote_stuck_active_without_state_changed_at() {
        // Can't compute age → don't fire.
        assert!(!should_demote_stuck_active("compacting", None, 1000.0));
    }

    // ── dedup_state_priority ────────────────────────────────────────────

    #[test]
    fn test_dedup_priority_error_beats_idle() {
        // Regression guard for F-correctness-003: previously `error` had
        // priority 0 and `idle` had priority 1, so dedup hid a real error
        // behind a phantom idle when two sessions collided in the
        // workspace + started_at < 3s window.
        assert!(dedup_state_priority("error") > dedup_state_priority("idle"));
    }

    #[test]
    fn test_dedup_priority_waiting_beats_working() {
        // `waiting` needs user attention more urgently than `working` —
        // surface it preferentially when in a collision.
        assert!(dedup_state_priority("waiting") > dedup_state_priority("working"));
    }

    #[test]
    fn test_dedup_priority_compacting_beats_idle() {
        // Compacting must NOT be replaced by an idle phantom — doing so
        // would skip the compacting floor which is the only thing keeping
        // the periwinkle dot visible during a fast /compact.
        assert!(dedup_state_priority("compacting") > dedup_state_priority("idle"));
    }

    #[test]
    fn test_dedup_priority_clearing_falls_to_bottom() {
        // `clearing` collapses into the catch-all priority-0 bucket along
        // with `ended` — the hook can't produce it so any inbound value is
        // a non-canonical entry that shouldn't outrank `idle`.
        assert_eq!(dedup_state_priority("clearing"), 0);
    }

    #[test]
    fn test_dedup_priority_ordering_top_to_bottom() {
        // Pin the full ordering. error > waiting > {working,subagent} >
        // {thinking,compacting,clearing} > {done,idle} > {ended}.
        let order = [
            "error", "waiting", "working", "thinking", "idle", "ended",
        ];
        for pair in order.windows(2) {
            assert!(
                dedup_state_priority(pair[0]) > dedup_state_priority(pair[1]),
                "{} should outrank {}", pair[0], pair[1]
            );
        }
    }

    // ── dedup_sessions ──────────────────────────────────────────────────

    #[test]
    fn test_dedup_collapses_same_workspace_within_3s() {
        let now = 1000.0;
        let sessions = vec![
            make_session("s1", "idle", now - 5.0, now - 100.0),
            make_session("s2", "working", now - 5.0, now - 99.0), // 1s apart
        ];
        let team_ids = std::collections::HashSet::new();
        let out = dedup_sessions(sessions, &team_ids);
        assert_eq!(out.len(), 1, "expected dedup to collapse");
        assert_eq!(out[0].state, "working", "higher-priority state survives");
    }

    #[test]
    fn test_dedup_keeps_team_agents_untouched() {
        let now = 1000.0;
        let mut sessions = vec![
            make_session("s1", "idle", now - 5.0, now - 100.0),
            make_session("s2", "working", now - 5.0, now - 99.0),
        ];
        // Mark s2 as a team agent.
        sessions[1].team_name = Some("auditors".to_string());
        let mut team_ids = std::collections::HashSet::new();
        team_ids.insert("s2".to_string());
        let out = dedup_sessions(sessions, &team_ids);
        assert_eq!(out.len(), 2, "team agents must not be deduplicated");
    }

    #[test]
    fn test_dedup_keeps_sessions_more_than_3s_apart() {
        let now = 1000.0;
        let sessions = vec![
            make_session("s1", "working", now - 5.0, now - 100.0),
            make_session("s2", "working", now - 5.0, now - 96.5), // 3.5s apart
        ];
        let team_ids = std::collections::HashSet::new();
        let out = dedup_sessions(sessions, &team_ids);
        assert_eq!(out.len(), 2, "outside 3s window — independent sessions");
    }

    #[test]
    fn test_dedup_error_survives_against_idle_phantom() {
        // Regression test for F-correctness-003: a phantom `idle` sibling
        // must NOT shadow a real `error` card. Order of insertion
        // shouldn't matter — try both.
        let now = 1000.0;
        let team_ids = std::collections::HashSet::new();

        let sessions = vec![
            make_session("s1", "idle", now - 5.0, now - 100.0),
            make_session("s2", "error", now - 5.0, now - 99.0),
        ];
        let out = dedup_sessions(sessions, &team_ids);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].state, "error");

        // Inverted order — same result.
        let sessions = vec![
            make_session("s1", "error", now - 5.0, now - 100.0),
            make_session("s2", "idle", now - 5.0, now - 99.0),
        ];
        let out = dedup_sessions(sessions, &team_ids);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].state, "error");
    }

    #[test]
    fn test_dedup_compacting_survives_against_idle_phantom() {
        // F-correctness-003 corollary: compacting must not be replaced
        // by idle, otherwise the compacting_floor never gets a chance
        // to fire.
        let now = 1000.0;
        let team_ids = std::collections::HashSet::new();
        let sessions = vec![
            make_session("s1", "idle", now - 5.0, now - 100.0),
            make_session("s2", "compacting", now - 5.0, now - 99.0),
        ];
        let out = dedup_sessions(sessions, &team_ids);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].state, "compacting");
    }

    #[test]
    fn test_dedup_tie_breaks_by_last_activity() {
        let now = 1000.0;
        // Both `working` — equal priority. Newer last_activity wins.
        let sessions = vec![
            make_session("s_old", "working", now - 100.0, now - 50.0),
            make_session("s_new", "working", now - 5.0, now - 49.0),
        ];
        let team_ids = std::collections::HashSet::new();
        let out = dedup_sessions(sessions, &team_ids);
        assert_eq!(out.len(), 1);
        // Stable-id semantics: the surviving entry keeps the FIRST id seen.
        // Last activity determines which state/payload survives.
        assert_eq!(out[0].id, "s_old");
        assert!((out[0].last_activity - (now - 5.0)).abs() < 0.001);
    }

    #[test]
    fn test_dedup_preserves_stable_id_when_replacing() {
        // When a higher-priority duplicate wins, the kept entry inherits
        // the original (stable) id so per-id latches don't churn.
        let now = 1000.0;
        let sessions = vec![
            make_session("orig", "idle", now - 5.0, now - 100.0),
            make_session("new", "working", now - 5.0, now - 99.0),
        ];
        let team_ids = std::collections::HashSet::new();
        let out = dedup_sessions(sessions, &team_ids);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "orig", "stable id must survive");
        assert_eq!(out[0].state, "working", "higher-priority state survives");
    }

    #[test]
    fn test_sort_sessions_by_started_at() {
        let now = 1000.0;
        let sessions = vec![
            make_session("s3", "working", now - 5.0, now - 30.0),
            make_session("s1", "working", now - 5.0, now - 100.0),
            make_session("s2", "working", now - 5.0, now - 50.0),
        ];
        let sorted = sort_sessions(sessions);
        assert_eq!(sorted.len(), 3);
        assert_eq!(sorted[0].id, "s1"); // started_at = 900
        assert_eq!(sorted[1].id, "s2"); // started_at = 950
        assert_eq!(sorted[2].id, "s3"); // started_at = 970
    }

    #[test]
    fn test_jsonl_exists_on_disk_present() {
        let dir = std::env::temp_dir().join("cue_test_exists_present");
        let _ = std::fs::remove_dir_all(&dir);

        let project_dir = dir.join("-Users-dev-App");
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(project_dir.join("sess-a.jsonl"), "{}").unwrap();

        let state = SessionMonitorState::new();
        assert!(state.jsonl_exists_on_disk("sess-a", "/Users/dev/App", &dir));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_jsonl_exists_on_disk_missing() {
        let dir = std::env::temp_dir().join("cue_test_exists_missing");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let state = SessionMonitorState::new();
        assert!(!state.jsonl_exists_on_disk("sess-gone", "/Users/dev/App", &dir));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_jsonl_exists_on_disk_detects_deletion_after_cache() {
        // Reproduces the session-id rotation case: a session id that was
        // resolvable once gets its JSONL deleted by Claude Code. The cached
        // path remains but the file is gone — the helper must report false.
        let dir = std::env::temp_dir().join("cue_test_exists_after_delete");
        let _ = std::fs::remove_dir_all(&dir);

        let project_dir = dir.join("-Users-dev-App");
        std::fs::create_dir_all(&project_dir).unwrap();
        let jsonl = project_dir.join("sess-rotated.jsonl");
        std::fs::write(&jsonl, "{}").unwrap();

        let state = SessionMonitorState::new();
        // First call resolves and caches.
        assert!(state.jsonl_exists_on_disk("sess-rotated", "/Users/dev/App", &dir));
        // Now Claude Code rotates the id and removes the file.
        std::fs::remove_file(&jsonl).unwrap();
        assert!(!state.jsonl_exists_on_disk("sess-rotated", "/Users/dev/App", &dir));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_jsonl_path_fallback_scan() {
        let dir = std::env::temp_dir().join("cue_test_fallback");
        let _ = std::fs::remove_dir_all(&dir);

        // JSONL is in a completely different project dir
        let project_dir = dir.join("some-other-project");
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(project_dir.join("session-3.jsonl"), "{}").unwrap();

        let state = SessionMonitorState::new();
        let path = state.jsonl_path("session-3", "/Users/dev/Unrelated", &dir);
        assert!(path.contains("session-3.jsonl"));
        assert!(path.contains("some-other-project"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── F-correctness-001: floor_extends narrowing ──────────────────────

    #[test]
    fn test_floor_extends_keeps_working_in_floor() {
        // Active floor + working state → extend (no change visible to user).
        assert!(floor_extends("working", Some(1000.5), 1000.0));
    }

    #[test]
    fn test_floor_extends_keeps_idle_in_floor() {
        // The floor's whole point is to mask brief working→idle transitions
        // back to compacting display.
        assert!(floor_extends("idle", Some(1000.5), 1000.0));
        assert!(floor_extends("done", Some(1000.5), 1000.0));
        assert!(floor_extends("thinking", Some(1000.5), 1000.0));
    }

    #[test]
    fn test_floor_extends_never_masks_error() {
        // Prior bug: `error` written during the floor window was repainted
        // as "compacting" until the floor expired. User attention lost.
        assert!(!floor_extends("error", Some(1000.5), 1000.0));
    }

    #[test]
    fn test_floor_extends_never_masks_waiting() {
        // PermissionRequest during a /compact must not be hidden behind the
        // periwinkle "compacting" indicator.
        assert!(!floor_extends("waiting", Some(1000.5), 1000.0));
    }

    #[test]
    fn test_floor_extends_never_masks_subagent() {
        // A subagent kick-off mid-/compact should surface immediately.
        assert!(!floor_extends("subagent", Some(1000.5), 1000.0));
    }

    #[test]
    fn test_floor_extends_does_not_self_extend_compacting() {
        // The floor never extends the state it's named for — that would
        // be a no-op anyway, but the predicate documents the intent.
        assert!(!floor_extends("compacting", Some(1000.5), 1000.0));
    }

    #[test]
    fn test_floor_extends_no_floor_means_no_extension() {
        assert!(!floor_extends("working", None, 1000.0));
    }

    #[test]
    fn test_floor_extends_expired_floor_no_extension() {
        // Floor's `until` has passed — let the state through.
        assert!(!floor_extends("working", Some(999.0), 1000.0));
    }

    // ── F-state-coverage-009: error participates in turn-ended demotion ──

    #[test]
    fn test_demote_turn_ended_clears_error_on_clean_end_turn() {
        // Closes the "red latch" — a session that errored out and was then
        // successfully retried (new end_turn newer than the state change)
        // must drop the red pill once the turn proves recovery.
        let m = metrics_with_end_turn(Some(200.0), false);
        assert!(should_demote_turn_ended("error", Some(100.0), Some(&m)));
    }

    #[test]
    fn test_no_demote_error_when_end_turn_predates_state_change() {
        // end_turn that fired BEFORE the error transition is no proof of
        // recovery — keep the red pill.
        let m = metrics_with_end_turn(Some(50.0), false);
        assert!(!should_demote_turn_ended("error", Some(100.0), Some(&m)));
    }

    #[test]
    fn test_no_demote_error_when_tool_use_pending() {
        // Mid-tool-call when the error happened — the open tool_use vetoes
        // the demote so we don't drop the state mid-recovery.
        let m = metrics_with_end_turn(Some(200.0), true);
        assert!(!should_demote_turn_ended("error", Some(100.0), Some(&m)));
    }

    // ── poll_status end-to-end (F-tests-001 / F-tests-003) ───────────────
    // These drive the path-injected `poll_status_with` against fixture files so
    // the full reconcile pipeline (read → parse → recovery → liveness →
    // waiting verdict) is locked, not just the pure predicates.

    #[test]
    fn test_metrics_caught_up_via_file_mtime() {
        // End-of-turn seeded waiting: entries stop advancing (trailing
        // metadata rows are timestampless) but the file mtime moved past the
        // transition — the parse provably reflects the post-transition file,
        // so the demote must be allowed (audit F4: phantom waiting pin).
        assert!(metrics_caught_up(Some(100.0), Some(200.0), Some(200.0)));
        assert!(metrics_caught_up(Some(100.0), Some(200.0), Some(250.0)));
        // mtime older than the transition proves nothing — keep holding.
        assert!(!metrics_caught_up(Some(100.0), Some(200.0), Some(150.0)));
        assert!(!metrics_caught_up(Some(100.0), Some(200.0), None));
    }

    #[test]
    fn test_metrics_caught_up_gate() {
        // Stale parse (predates the seed) → hold (don't allow demote).
        assert!(!metrics_caught_up(Some(100.0), Some(200.0), None));
        // Caught-up parse → allow demote.
        assert!(metrics_caught_up(Some(200.0), Some(200.0), None));
        assert!(metrics_caught_up(Some(250.0), Some(200.0), None));
        // Unknown freshness → preserve prior behavior (allow).
        assert!(metrics_caught_up(None, Some(200.0), None));
        assert!(metrics_caught_up(Some(100.0), None, None));
    }

    #[test]
    fn test_poll_holds_question_waiting_while_metrics_stale() {
        // The regression behind "Cue stopped catching questions": the hook
        // seeds `waiting` the instant a question opens, but the 1s poll runs
        // before the 5s metrics refresh catches up. With the cache still stale
        // (awaiting=false, pending=false, last_entry_ts predating stateChangedAt)
        // the card must HOLD `waiting`, not flicker to idle.
        let dir = std::env::temp_dir().join("cue_test_poll_stale_hold");
        let _ = std::fs::remove_dir_all(&dir);
        let projects = dir.join("projects");
        let ws_dir = projects.join("-Users-dev-App");
        std::fs::create_dir_all(&ws_dir).unwrap();
        std::fs::write(ws_dir.join("sess-q.jsonl"), "{}").unwrap();

        let status_path = dir.join("sessions.json");
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64();
        let changed = now + 5.0; // hook just seeded waiting "now"
        let sessions = format!(
            r#"{{"sessions":{{"sess-q":{{"id":"sess-q","workspace":"/Users/dev/App","state":"waiting","lastActivity":{},"startedAt":{},"stateChangedAt":{}}}}}}}"#,
            changed, changed, changed
        );
        std::fs::write(&status_path, sessions).unwrap();

        let m = SessionMonitorState::new();
        // Stale metrics: parsed BEFORE the question opened, so they don't yet see
        // the unmatched AskUserQuestion (awaiting/pending both false).
        m.metrics_cache.lock_safe().insert(
            "sess-q".to_string(),
            crate::models::SessionMetrics {
                awaiting_user_prompt: false,
                pending_tool_use: false,
                last_entry_ts: Some(changed - 100.0),
                ..Default::default()
            },
        );
        m.poll_status_with(status_path.clone(), projects.clone());
        {
            let e = m.enriched_sessions.lock_safe();
            let s = e.iter().find(|s| s.info.id == "sess-q").expect("present");
            assert_eq!(
                s.info.state, "waiting",
                "must HOLD waiting while metrics are stale (pre-refresh)"
            );
        }

        // Metrics catch up and show genuine resolution (question answered):
        // last_entry_ts now past stateChangedAt, awaiting/pending false → demote.
        m.metrics_cache.lock_safe().insert(
            "sess-q".to_string(),
            crate::models::SessionMetrics {
                awaiting_user_prompt: false,
                pending_tool_use: false,
                last_entry_ts: Some(changed + 10.0),
                ..Default::default()
            },
        );
        m.poll_status_with(status_path.clone(), projects.clone());
        {
            let e = m.enriched_sessions.lock_safe();
            let s = e.iter().find(|s| s.info.id == "sess-q").expect("present");
            assert_eq!(
                s.info.state, "idle",
                "must demote once metrics catch up and show resolution"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn dummy_enriched(id: &str) -> crate::models::EnrichedSession {
        crate::models::EnrichedSession::from_info_and_metrics(
            make_session(id, "idle", 100.0, 100.0),
            crate::models::SessionMetrics::default(),
            &crate::models::SupplementalData::default(),
        )
    }

    #[test]
    fn test_poll_holds_permission_waiting_then_resolves() {
        // F-tests-001: the exact wiring the cd2a32b regression broke. A
        // permission-prompt `waiting` card (no prompting tool_use, so
        // awaiting=false) must HOLD while the JSONL still parks an unresolved
        // tool_use (pending=true), then demote to `idle` the instant the tool
        // resolves and pending clears. (Revert should_resolve_waiting to the old
        // `!awaiting`-only gate and the hold assertion fails.)
        let dir = std::env::temp_dir().join("cue_test_poll_waiting");
        let _ = std::fs::remove_dir_all(&dir);
        let projects = dir.join("projects");
        // The transcript must exist on disk or the JSONL-presence backstop
        // demotes the liveness-sensitive `waiting` state before the verdict.
        let ws_dir = projects.join("-Users-dev-App");
        std::fs::create_dir_all(&ws_dir).unwrap();
        std::fs::write(ws_dir.join("sess-perm.jsonl"), "{}").unwrap();

        let status_path = dir.join("sessions.json");
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64();
        let ts = now + 5.0; // safely >= launched_at so idle survives the sweep
        let sessions = format!(
            r#"{{"sessions":{{"sess-perm":{{"id":"sess-perm","workspace":"/Users/dev/App","state":"waiting","lastActivity":{},"startedAt":{}}}}}}}"#,
            ts, ts
        );
        std::fs::write(&status_path, sessions).unwrap();

        let m = SessionMonitorState::new();
        // Seed the metrics cache as refresh_metrics would for a permission
        // prompt: an unresolved tool_use at the tail, no prompting tool_use.
        m.metrics_cache.lock_safe().insert(
            "sess-perm".to_string(),
            crate::models::SessionMetrics {
                pending_tool_use: true,
                awaiting_user_prompt: false,
                ..Default::default()
            },
        );
        m.poll_status_with(status_path.clone(), projects.clone());
        {
            let enriched = m.enriched_sessions.lock_safe();
            let s = enriched
                .iter()
                .find(|s| s.info.id == "sess-perm")
                .expect("waiting session present");
            assert_eq!(
                s.info.state, "waiting",
                "must HOLD waiting while pending_tool_use is set"
            );
        }

        // Tool approved → tool_result lands → pending clears.
        m.metrics_cache.lock_safe().insert(
            "sess-perm".to_string(),
            crate::models::SessionMetrics {
                pending_tool_use: false,
                awaiting_user_prompt: false,
                ..Default::default()
            },
        );
        m.poll_status_with(status_path.clone(), projects.clone());
        {
            let enriched = m.enriched_sessions.lock_safe();
            let s = enriched
                .iter()
                .find(|s| s.info.id == "sess-perm")
                .expect("session present after resolve");
            assert_eq!(
                s.info.state, "idle",
                "must demote to idle once pending_tool_use clears"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_poll_keeps_prior_state_on_transient_read_error() {
        // F-tests-003: a momentarily-absent sessions.json (the hook's atomic
        // rename window) must preserve the prior list for a few polls — never
        // flash zero sessions — and only clear once it stays gone.
        let dir = std::env::temp_dir().join("cue_test_poll_read_err");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let status_path = dir.join("sessions.json"); // intentionally absent
        let projects = dir.join("projects");
        std::fs::create_dir_all(&projects).unwrap();

        let m = SessionMonitorState::new();
        *m.enriched_sessions.lock_safe() = vec![dummy_enriched("d1")];
        *m.consecutive_parse_failures.lock_safe() = 0;

        for _ in 0..4 {
            m.poll_status_with(status_path.clone(), projects.clone());
            assert_eq!(
                m.enriched_sessions.lock_safe().len(),
                1,
                "prior state preserved below the repair threshold"
            );
        }
        m.poll_status_with(status_path.clone(), projects.clone());
        assert_eq!(
            m.enriched_sessions.lock_safe().len(),
            0,
            "cleared once the store stays unreadable past the threshold"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_poll_keeps_prior_state_on_oversized_file() {
        // F-tests-003: a >4 MiB sessions.json (runaway/hostile writer) hits the
        // FileTooLarge arm, which must KEEP the prior list — blanking every card
        // is worse than a slightly stale view — and never reach the clear path.
        let dir = std::env::temp_dir().join("cue_test_poll_oversized");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let status_path = dir.join("sessions.json");
        std::fs::write(&status_path, vec![b' '; 5 * 1024 * 1024]).unwrap();
        let projects = dir.join("projects");
        std::fs::create_dir_all(&projects).unwrap();

        let m = SessionMonitorState::new();
        *m.enriched_sessions.lock_safe() = vec![dummy_enriched("d1")];

        for _ in 0..7 {
            m.poll_status_with(status_path.clone(), projects.clone());
            assert_eq!(
                m.enriched_sessions.lock_safe().len(),
                1,
                "oversized file must never clear the prior list"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_poll_self_repairs_on_persistent_parse_failure() {
        // F-tests-003: a persistently malformed sessions.json must preserve
        // prior state for <REPAIR_THRESHOLD polls (no UI flash), then rename the
        // corrupt file aside and reseed an empty container.
        let dir = std::env::temp_dir().join("cue_test_poll_parsefail");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let status_path = dir.join("sessions.json");
        std::fs::write(&status_path, b"{ this is not valid json").unwrap();
        let projects = dir.join("projects");
        std::fs::create_dir_all(&projects).unwrap();

        let m = SessionMonitorState::new();
        *m.enriched_sessions.lock_safe() = vec![dummy_enriched("d1")];
        *m.consecutive_parse_failures.lock_safe() = 0;

        for _ in 0..4 {
            m.poll_status_with(status_path.clone(), projects.clone());
            assert_eq!(
                m.enriched_sessions.lock_safe().len(),
                1,
                "prior state preserved below the repair threshold"
            );
            // The malformed file is left untouched until the threshold.
            assert_eq!(
                std::fs::read(&status_path).unwrap(),
                b"{ this is not valid json"
            );
        }
        // Threshold reached → rename aside + reseed an empty, VALID container.
        m.poll_status_with(status_path.clone(), projects.clone());
        let reseeded = std::fs::read_to_string(&status_path).unwrap();
        let parsed: StatusData =
            serde_json::from_str(&reseeded).expect("reseeded file must be valid");
        assert!(parsed.sessions.is_empty(), "reseeded container is empty");
        let has_corrupt = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().contains(".corrupt-"));
        assert!(has_corrupt, "malformed file must be renamed aside");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
