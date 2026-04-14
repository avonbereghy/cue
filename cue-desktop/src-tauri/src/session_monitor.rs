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
    list.sort_by(|a, b| a.started_at.partial_cmp(&b.started_at).unwrap_or(std::cmp::Ordering::Equal));
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
    file_mod_dates: Mutex<HashMap<String, SystemTime>>,
    resolved_paths: Mutex<HashMap<String, String>>,
    // Supplemental data caches
    rate_limits: Mutex<Option<RateLimitInfo>>,
    pub system_memory: Mutex<SystemMemory>,
    pub claude_version: Mutex<Option<String>>,
    git_status_cache: Mutex<HashMap<String, (GitStatus, SystemTime)>>,
    config_counts_cache: Mutex<HashMap<String, (ConfigCounts, SystemTime)>>,
    /// Tracks previous output_tokens per session for speed calculation
    output_speed_cache: Mutex<HashMap<String, (i64, f64)>>, // session_id → (prev_output_tokens, prev_timestamp)
    /// Cached sysinfo::System instance to avoid re-allocation every poll
    sysinfo_system: Mutex<sysinfo::System>,
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
            file_mod_dates: Mutex::new(HashMap::new()),
            resolved_paths: Mutex::new(HashMap::new()),
            rate_limits: Mutex::new(None),
            system_memory: Mutex::new(SystemMemory::default()),
            claude_version: Mutex::new(None),
            git_status_cache: Mutex::new(HashMap::new()),
            config_counts_cache: Mutex::new(HashMap::new()),
            output_speed_cache: Mutex::new(HashMap::new()),
            sysinfo_system: Mutex::new(sysinfo::System::new()),
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
                    log::debug!("Failed to parse sessions.json: {}", e);
                    *self.enriched_sessions.lock().unwrap() = Vec::new();
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
        let now_epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        let active = sort_sessions(
            status.sessions.into_values().filter(|s| {
                (s.last_activity >= launched_at || s.started_at >= launched_at)
                    && security::sanitize_workspace_path(&s.workspace).is_ok()
                    // Remove stale "clearing" sessions (>30s old). The hook
                    // does this too, but only when another hook event fires.
                    // If the user's last session exits, no more hooks fire and
                    // the card lingers indefinitely without this check.
                    && !(s.state == "clearing" && now_epoch - s.last_activity > 30.0)
            }),
        );


        // Deduplicate sessions sharing the same workspace that started within
        // 30s of each other. Collapses phantom sessions (e.g. from agent teams)
        // that create a second short-lived process on startup.
        let active = {
            let state_priority = |s: &str| -> u8 {
                match s {
                    "working" | "subagent" => 3,
                    "thinking" | "waiting" => 2,
                    "idle" => 1,
                    _ => 0, // done, error
                }
            };
            let mut deduped: Vec<SessionInfo> = Vec::new();
            for session in active {
                if let Some(existing) = deduped.iter_mut().find(|s| {
                    s.workspace == session.workspace
                        && (s.started_at - session.started_at).abs() < 30.0
                }) {
                    if state_priority(&session.state) > state_priority(&existing.state)
                        || (state_priority(&session.state)
                            == state_priority(&existing.state)
                            && session.last_activity > existing.last_activity)
                    {
                        // Keep the original session's ID so the frontend sees a
                        // stable identity. Without this, the winner's ID flips
                        // on every poll (parent vs subagent) whenever
                        // last_activity alternates, causing the UI to reorder
                        // cards continuously.
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

        let enriched: Vec<_> = {
            let cache = self.metrics_cache.lock().unwrap();
            let rate_limits = self.rate_limits.lock().unwrap().clone();
            let system_memory = self.system_memory.lock().unwrap().clone();
            let claude_version = self.claude_version.lock().unwrap().clone();
            let git_cache = self.git_status_cache.lock().unwrap();
            let config_cache = self.config_counts_cache.lock().unwrap();
            let speed_cache = self.output_speed_cache.lock().unwrap();

            active
                .into_iter()
                .map(|session| {
                    let metrics = cache.get(&session.id).cloned().unwrap_or_default();
                    let (prev_output, prev_ts) = speed_cache
                        .get(&session.id)
                        .cloned()
                        .unwrap_or((0, 0.0));
                    let supplemental = SupplementalData {
                        git_status: git_cache.get(&session.workspace).map(|(s, _)| s.clone()),
                        config_counts: config_cache.get(&session.workspace).map(|(c, _)| c.clone()),
                        rate_limits: rate_limits.clone(),
                        system_memory: system_memory.clone(),
                        claude_version: claude_version.clone(),
                        prev_output_tokens: prev_output,
                        prev_timestamp: prev_ts,
                    };
                    EnrichedSession::from_info_and_metrics(session, metrics, &supplemental)
                })
                .collect()
        }; // all locks dropped before acquiring enriched_sessions lock

        *self.enriched_sessions.lock().unwrap() = enriched;
    }

    /// Parse JSONL conversation logs for token metrics (called every ~5s).
    pub fn refresh_metrics(&self) {
        let sessions = self.enriched_sessions.lock().unwrap().clone();
        let projects_path = paths::claude_projects_path();

        for session in &sessions {
            let path = self.jsonl_path(&session.info.id, &session.info.workspace, &projects_path);

            if !Path::new(&path).exists() {
                continue;
            }

            // For active sessions (working/subagent/waiting), always reparse to
            // capture subagent token changes in real-time. For inactive sessions,
            // check file mod times before reparsing.
            let is_active = matches!(
                session.info.state.as_str(),
                "working" | "thinking" | "subagent" | "waiting"
            );

            if !is_active {
                let mut should_skip = false;
                if let Ok(metadata) = std::fs::metadata(&path) {
                    if let Ok(mod_time) = metadata.modified() {
                        let mut mod_dates = self.file_mod_dates.lock().unwrap();
                        if let Some(cached) = mod_dates.get(&session.info.id) {
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
                                        let sub_key = format!("{}-subagents", session.info.id);
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
                        mod_dates.insert(session.info.id.clone(), mod_time);
                    }
                }
                if should_skip {
                    continue;
                }
            }

            if let Some(metrics) = jsonl_parser::parse_jsonl_to_session_metrics(Path::new(&path)) {
                // Track output speed: snapshot previous output_tokens before overwriting
                let now_ts = SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs_f64();
                {
                    let mut speed_cache = self.output_speed_cache.lock().unwrap();
                    // Store current output_tokens as "previous" for next poll
                    speed_cache.insert(
                        session.info.id.clone(),
                        (metrics.output_tokens, now_ts),
                    );
                }

                self.metrics_cache
                    .lock()
                    .unwrap()
                    .insert(session.info.id.clone(), metrics);
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

        // Git status and config counts per workspace (with staleness caching)
        let sessions = self.enriched_sessions.lock().unwrap().clone();
        let now = SystemTime::now();

        // Collect unique workspaces
        let mut workspaces: Vec<String> = sessions
            .iter()
            .map(|s| s.info.workspace.clone())
            .collect();
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_workspace_path_unix() {
        assert_eq!(
            encode_workspace_path("/Users/dev/App"),
            "-Users-dev-App"
        );
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
            source: None,
            hook_input_tokens: 0,
            hook_output_tokens: 0,
            hook_model: String::new(),
            active_subagents: 0,
            subprocess: None,
        }
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
