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

/// Sort sessions by start time. Used by both the monitor and CLI.
pub fn sort_sessions(sessions: impl IntoIterator<Item = SessionInfo>) -> Vec<SessionInfo> {
    let mut list: Vec<_> = sessions.into_iter().collect();
    list.sort_by(|a, b| a.started_at.total_cmp(&b.started_at));
    list
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
    // Supplemental data caches
    rate_limits: Mutex<Option<RateLimitInfo>>,
    pub system_memory: Mutex<SystemMemory>,
    pub claude_version: Mutex<Option<String>>,
    /// Global default effort level from `~/.claude/settings.json`.
    pub claude_default_effort: Mutex<Option<String>>,
    /// `~/.claude/settings.json` mtime (unix secs). Used to resolve which is
    /// fresher: a session's last `/effort` command or the global default.
    pub claude_default_effort_ts: Mutex<Option<f64>>,
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
            rate_limits: Mutex::new(None),
            system_memory: Mutex::new(SystemMemory::default()),
            claude_version: Mutex::new(None),
            claude_default_effort: Mutex::new(None),
            claude_default_effort_ts: Mutex::new(None),
            git_status_cache: Mutex::new(HashMap::new()),
            config_counts_cache: Mutex::new(HashMap::new()),
            output_speed_cache: Mutex::new(HashMap::new()),
            sysinfo_system: Mutex::new(sysinfo::System::new()),
            process_identity: Mutex::new(HashMap::new()),
            active_since: Mutex::new(HashMap::new()),
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
        let status_path = paths::sessions_json_path();

        let status = match std::fs::read_to_string(&status_path) {
            Ok(content) => match serde_json::from_str::<StatusData>(&content) {
                Ok(s) => s,
                Err(e) => {
                    // Preserve the prior enriched list across a transient parse
                    // failure (mid-rename read from the Python hook, or a manual
                    // edit). Wiping would drop active_since timers and cause a
                    // one-poll UI flash of zero sessions.
                    log::warn!("sessions.json parse failed, keeping previous state: {}", e);
                    return;
                }
            },
            Err(_) => {
                *self.enriched_sessions.lock().unwrap() = Vec::new();
                return;
            }
        };

        // Only show sessions that appeared after Cue launched.
        // Check both started_at and last_activity so sessions that were
        // already idle when Cue opened aren't hidden until their next event.
        let launched_at = self.launched_at;
        let active = sort_sessions(status.sessions.into_values().filter(|s| {
            (s.last_activity >= launched_at || s.started_at >= launched_at)
                && security::sanitize_workspace_path(&s.workspace).is_ok()
        }));

        // Deduplicate sessions sharing the same workspace that started within
        // 3s of each other. Collapses phantom sessions (e.g. from agent teams)
        // that create a second short-lived process on startup. Kept tight to
        // avoid merging real sessions in the same project.
        let active = {
            let state_priority = |s: &str| -> u8 {
                match s {
                    "working" | "subagent" => 3,
                    "thinking" | "waiting" => 2,
                    "idle" => 1,
                    _ => 0, // done, error
                }
            };
            // Collect team session IDs so we never merge them
            let team_ids: std::collections::HashSet<String> = {
                let cache = self.metrics_cache.lock().unwrap();
                active
                    .iter()
                    .filter(|s| {
                        s.team_name.is_some()
                            || cache.get(&s.id).is_some_and(|m| m.team_name.is_some())
                    })
                    .map(|s| s.id.clone())
                    .collect()
            };
            let mut deduped: Vec<SessionInfo> = Vec::new();
            for session in active {
                // Never deduplicate team agent sessions — they are real
                // parallel agents, not phantom startup duplicates.
                if team_ids.contains(&session.id) {
                    deduped.push(session);
                } else if let Some(existing) = deduped.iter_mut().find(|s| {
                    !team_ids.contains(&s.id)
                        && s.workspace == session.workspace
                        && (s.started_at - session.started_at).abs() < 3.0
                }) {
                    if state_priority(&session.state) > state_priority(&existing.state)
                        || (state_priority(&session.state) == state_priority(&existing.state)
                            && session.last_activity > existing.last_activity)
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
        };

        // Promote team agent sessions from "idle" to "done" if inactive for 30s.
        // Team agents don't wait for user input — idle means they finished.
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        let active: Vec<_> = {
            let cache = self.metrics_cache.lock().unwrap();
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
            let mut sys = self.sysinfo_system.lock().unwrap();
            if !pids_to_check.is_empty() {
                sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&pids_to_check), false);
            }
            let mut identity = self.process_identity.lock().unwrap();
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
                    let live_start = sys
                        .process(sysinfo::Pid::from_u32(pid))
                        .map(|p| p.start_time());
                    let cached = identity.get(&s.id).copied();
                    match resolve_liveness(pid, live_start, cached) {
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

        // Turn-ended recovery: demote `working`/`thinking` cards when the
        // JSONL transcript shows `stop_reason == "end_turn"` newer than the
        // session's `stateChangedAt`. This catches the case where the Stop
        // hook failed to fire but Claude's own transcript records the turn
        // finished. Deterministic (no timers). We only demote the two states
        // — `subagent`, `waiting`, `compacting`, `clearing` are left alone.
        let active: Vec<_> = {
            let cache = self.metrics_cache.lock().unwrap();
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

        // Update active-since timestamps: track when each session entered an
        // active state (working/thinking/waiting/error/subagent). Reset on
        // idle/done/compacting/clearing. Used for the "active duration" timer.
        let active_since_snapshot = {
            let mut active_since = self.active_since.lock().unwrap();
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
            let cache = self.metrics_cache.lock().unwrap();
            let rate_limits = self.rate_limits.lock().unwrap().clone();
            let system_memory = self.system_memory.lock().unwrap().clone();
            let claude_version = self.claude_version.lock().unwrap().clone();
            let claude_default_effort = self.claude_default_effort.lock().unwrap().clone();
            let claude_default_effort_ts = *self.claude_default_effort_ts.lock().unwrap();
            let git_cache = self.git_status_cache.lock().unwrap();
            let config_cache = self.config_counts_cache.lock().unwrap();
            let speed_cache = self.output_speed_cache.lock().unwrap();

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
                        rate_limits: rate_limits.clone(),
                        system_memory: system_memory.clone(),
                        claude_version: claude_version.clone(),
                        claude_default_effort: claude_default_effort.clone(),
                        claude_default_effort_ts,
                        prev_output_tokens: prev_output,
                        prev_timestamp: prev_ts,
                        active_since: active_since_ts,
                    };
                    EnrichedSession::from_info_and_metrics(session, metrics, &supplemental)
                })
                .collect()
        }; // all locks dropped before acquiring enriched_sessions lock

        *self.enriched_sessions.lock().unwrap() = enriched;
    }

    /// Parse JSONL conversation logs for token metrics (called every ~5s).
    pub fn refresh_metrics(&self) {
        // Only clone the three fields the loop actually needs (id, workspace,
        // state) instead of the full EnrichedSession vector — at every 5s tick
        // a 20-session list previously copied ~40 KB of nested supplemental
        // data through the allocator for no reason.
        let session_keys: Vec<(String, String, String)> = {
            let guard = self.enriched_sessions.lock().unwrap();
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
                        let mut mod_dates = self.file_mod_dates.lock().unwrap();
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
                let mut cache_guard = self.jsonl_entry_cache.lock().unwrap();
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
                    let mut speed_cache = self.output_speed_cache.lock().unwrap();
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
        // Rate limits: read from bridge file
        let rate_path = paths::rate_limits_path();
        if let Ok(content) = std::fs::read_to_string(&rate_path) {
            if let Ok(rl) = serde_json::from_str::<RateLimitInfo>(&content) {
                *self.rate_limits.lock().unwrap() = Some(rl);
            }
        }

        // System memory using cached System instance (avoids re-allocation)
        {
            let mut sys = self.sysinfo_system.lock().unwrap();
            *self.system_memory.lock().unwrap() = system_info::get_system_memory_with(&mut sys);
        }

        // Global default effort from ~/.claude/settings.json (cheap read, no subprocess)
        {
            let (level, ts) = system_info::get_claude_default_effort();
            *self.claude_default_effort.lock().unwrap() = level;
            *self.claude_default_effort_ts.lock().unwrap() = ts;
        }

        // Git status and config counts per workspace (with staleness caching)
        let sessions = self.enriched_sessions.lock().unwrap().clone();
        let now = SystemTime::now();

        // Collect unique workspaces
        let mut workspaces: Vec<String> =
            sessions.iter().map(|s| s.info.workspace.clone()).collect();
        workspaces.sort();
        workspaces.dedup();

        // Prune cache entries for workspaces no longer in active sessions
        {
            let mut cache = self.git_status_cache.lock().unwrap();
            cache.retain(|ws, _| workspaces.contains(ws));
        }
        {
            let mut cache = self.config_counts_cache.lock().unwrap();
            cache.retain(|ws, _| workspaces.contains(ws));
        }

        for ws in &workspaces {
            // Git status: refresh every 10s
            {
                let mut cache = self.git_status_cache.lock().unwrap();
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
                let mut cache = self.config_counts_cache.lock().unwrap();
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
    fn jsonl_path(&self, session_id: &str, workspace: &str, projects_path: &Path) -> String {
        // Check cache
        {
            let cache = self.resolved_paths.lock().unwrap();
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

/// Encode a workspace path to a directory name, matching Claude Code's convention.
///
/// All `/` characters are replaced with `-`.
/// Example: `/Users/dev/App` -> `-Users-dev-App`
pub fn encode_workspace_path(workspace: &str) -> String {
    workspace.replace('/', "-")
}

/// States that indicate the owning Claude Code process should still be alive.
/// Terminal states (idle, done, error, ended) and states the user is explicitly
/// interacting with (waiting) are excluded — the former don't claim activity,
/// the latter stay put until the user responds.
fn is_liveness_sensitive(state: &str) -> bool {
    matches!(
        state,
        "working" | "thinking" | "subagent" | "compacting" | "clearing"
    )
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
fn should_demote_turn_ended(
    state: &str,
    state_changed_at: Option<f64>,
    metrics: Option<&crate::models::SessionMetrics>,
) -> bool {
    if !matches!(state, "working" | "thinking") {
        return false;
    }
    let Some(metrics) = metrics else { return false };
    if metrics.pending_tool_use {
        return false;
    }
    let Some(end_turn_ts) = metrics.last_end_turn_ts else {
        return false;
    };
    let boundary = state_changed_at.unwrap_or(0.0);
    end_turn_ts > boundary
}

fn resolve_liveness(
    pid: u32,
    live_start: Option<u64>,
    cached: Option<(u32, u64)>,
) -> LivenessOutcome {
    match (live_start, cached) {
        // First sight — capture identity.
        (Some(start), None) => LivenessOutcome::Alive {
            cache: (pid, start),
        },
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
        assert_eq!(
            encode_workspace_path("C:/Users/dev/App"),
            "C:-Users-dev-App"
        );
    }

    #[test]
    fn test_encode_workspace_path_root() {
        assert_eq!(encode_workspace_path("/"), "-");
    }

    #[test]
    fn test_liveness_first_sight_captures_identity() {
        match resolve_liveness(1234, Some(5000), None) {
            LivenessOutcome::Alive { cache } => assert_eq!(cache, (1234, 5000)),
            LivenessOutcome::Dead => panic!("expected Alive on first sight"),
        }
    }

    #[test]
    fn test_liveness_matching_cache_stays_alive() {
        match resolve_liveness(1234, Some(5000), Some((1234, 5000))) {
            LivenessOutcome::Alive { cache } => assert_eq!(cache, (1234, 5000)),
            LivenessOutcome::Dead => panic!("expected Alive when cache matches"),
        }
    }

    #[test]
    fn test_liveness_process_gone_is_dead() {
        assert!(matches!(
            resolve_liveness(1234, None, Some((1234, 5000))),
            LivenessOutcome::Dead
        ));
    }

    #[test]
    fn test_liveness_never_alive_is_dead() {
        // Hook wrote a PID but there's no process at that pid and we never
        // cached one. Means it died before we ever polled — still dead.
        assert!(matches!(
            resolve_liveness(1234, None, None),
            LivenessOutcome::Dead
        ));
    }

    #[test]
    fn test_liveness_pid_reuse_different_start_time_is_dead() {
        // Same pid, but a different process now holds it (different start time).
        assert!(matches!(
            resolve_liveness(1234, Some(9999), Some((1234, 5000))),
            LivenessOutcome::Dead
        ));
    }

    #[test]
    fn test_liveness_sensitive_states() {
        assert!(is_liveness_sensitive("working"));
        assert!(is_liveness_sensitive("thinking"));
        assert!(is_liveness_sensitive("subagent"));
        assert!(is_liveness_sensitive("compacting"));
        assert!(is_liveness_sensitive("clearing"));
        assert!(!is_liveness_sensitive("idle"));
        assert!(!is_liveness_sensitive("done"));
        assert!(!is_liveness_sensitive("waiting"));
        assert!(!is_liveness_sensitive("error"));
    }

    #[test]
    fn test_session_monitor_state_new() {
        let state = SessionMonitorState::new();
        assert!(state.enriched_sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn test_poll_status_no_crash() {
        let state = SessionMonitorState::new();
        // Should not panic regardless of whether sessions.json exists
        state.poll_status();
        // Just verify it produces valid output (may be non-empty if real sessions.json exists)
        let sessions = state.enriched_sessions.lock().unwrap();
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
    fn test_no_demote_when_pending_tool_use() {
        // Mid-turn with an unresolved tool_use: leave state alone.
        let m = metrics_with_end_turn(Some(200.0), true);
        assert!(!should_demote_turn_ended("working", Some(100.0), Some(&m)));
    }

    #[test]
    fn test_no_demote_for_non_working_states() {
        // Gate on {working, thinking} — don't touch subagent, waiting, etc.
        let m = metrics_with_end_turn(Some(200.0), false);
        for st in [
            "subagent",
            "waiting",
            "compacting",
            "clearing",
            "idle",
            "done",
            "error",
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
}
