//! Session monitoring — port of SessionMonitor.swift.
//!
//! Polls sessions.json for current session states and parses JSONL conversation
//! logs for token metrics. Maintains enriched sessions and usage metrics.

use crate::jsonl_parser;
use crate::models::{EnrichedSession, SessionInfo, SessionMetrics, StatusData, UsageWindow, WindowMetrics};
use crate::paths;
use crate::security;
use crate::usage_aggregator;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// Staleness thresholds (seconds) by session state.
/// Shared between poll_status and CLI to avoid divergence.
pub fn is_session_stale(state: &str, age_secs: f64) -> bool {
    match state {
        "idle" => age_secs >= 60.0,
        "error" => age_secs >= 300.0,
        _ => age_secs >= 1800.0,
    }
}

/// Filter stale sessions and sort by start time. Used by both the monitor and CLI.
pub fn filter_and_sort_active(sessions: impl IntoIterator<Item = SessionInfo>, now: f64) -> Vec<SessionInfo> {
    let mut active: Vec<_> = sessions
        .into_iter()
        .filter(|s| !is_session_stale(&s.state, now - s.last_activity))
        .collect();
    active.sort_by(|a, b| a.started_at.partial_cmp(&b.started_at).unwrap_or(std::cmp::Ordering::Equal));
    active
}

/// Shared state for the session monitor.
pub struct SessionMonitorState {
    pub enriched_sessions: Mutex<Vec<EnrichedSession>>,
    pub usage_metrics: Mutex<HashMap<UsageWindow, WindowMetrics>>,
    metrics_cache: Mutex<HashMap<String, SessionMetrics>>,
    file_mod_dates: Mutex<HashMap<String, SystemTime>>,
    resolved_paths: Mutex<HashMap<String, String>>,
}

impl Default for SessionMonitorState {
    fn default() -> Self {
        Self {
            enriched_sessions: Mutex::new(Vec::new()),
            usage_metrics: Mutex::new(HashMap::new()),
            metrics_cache: Mutex::new(HashMap::new()),
            file_mod_dates: Mutex::new(HashMap::new()),
            resolved_paths: Mutex::new(HashMap::new()),
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

        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();

        // Filter stale sessions and sanitize workspace paths
        let active = filter_and_sort_active(
            status.sessions.into_values().filter(|s| {
                // Reject sessions with path traversal in workspace
                security::sanitize_workspace_path(&s.workspace).is_ok()
            }),
            now,
        );

        let cache = self.metrics_cache.lock().unwrap();
        let enriched: Vec<_> = active
            .into_iter()
            .map(|session| {
                let metrics = cache.get(&session.id).cloned().unwrap_or_default();
                EnrichedSession::from_info_and_metrics(session, metrics)
            })
            .collect();

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

            // Skip if file hasn't changed since last parse
            if let Ok(metadata) = std::fs::metadata(&path) {
                if let Ok(mod_time) = metadata.modified() {
                    let mut mod_dates = self.file_mod_dates.lock().unwrap();
                    if let Some(cached) = mod_dates.get(&session.info.id) {
                        if *cached == mod_time {
                            continue;
                        }
                    }
                    mod_dates.insert(session.info.id.clone(), mod_time);
                }
            }

            if let Some(metrics) = jsonl_parser::parse_jsonl_to_session_metrics(Path::new(&path)) {
                self.metrics_cache
                    .lock()
                    .unwrap()
                    .insert(session.info.id.clone(), metrics);
            }
        }

        // Also refresh usage aggregation
        self.refresh_usage();
    }

    /// Aggregate usage data across all JSONL files for time windows.
    pub fn refresh_usage(&self) {
        let metrics = usage_aggregator::aggregate();
        *self.usage_metrics.lock().unwrap() = metrics;
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
        assert!(state.usage_metrics.lock().unwrap().is_empty());
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
        let dir = std::env::temp_dir().join("claude_cue_test_resolve");
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
        let dir = std::env::temp_dir().join("claude_cue_test_parent_walk");
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
        }
    }

    #[test]
    fn test_filter_and_sort_active_filters_idle_over_60s() {
        let now = 1000.0;
        let sessions = vec![
            make_session("s1", "idle", now - 61.0, now - 200.0), // stale (idle > 60s)
            make_session("s2", "idle", now - 30.0, now - 100.0), // fresh
        ];
        let active = filter_and_sort_active(sessions, now);
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "s2");
    }

    #[test]
    fn test_filter_and_sort_active_keeps_working_under_1800s() {
        let now = 1000000.0;
        let sessions = vec![
            make_session("s1", "working", now - 1799.0, now - 2000.0), // fresh (under 1800s)
            make_session("s2", "working", now - 1801.0, now - 3000.0), // stale (over 1800s)
        ];
        let active = filter_and_sort_active(sessions, now);
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "s1");
    }

    #[test]
    fn test_filter_and_sort_active_filters_error_over_300s() {
        let now = 5000.0;
        let sessions = vec![
            make_session("s1", "error", now - 301.0, now - 500.0), // stale (error > 300s)
            make_session("s2", "error", now - 100.0, now - 400.0), // fresh
        ];
        let active = filter_and_sort_active(sessions, now);
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "s2");
    }

    #[test]
    fn test_filter_and_sort_active_sorts_by_started_at() {
        let now = 1000.0;
        let sessions = vec![
            make_session("s3", "working", now - 5.0, now - 30.0),
            make_session("s1", "working", now - 5.0, now - 100.0),
            make_session("s2", "working", now - 5.0, now - 50.0),
        ];
        let active = filter_and_sort_active(sessions, now);
        assert_eq!(active.len(), 3);
        // Should be sorted by started_at ascending
        assert_eq!(active[0].id, "s1"); // started_at = 900
        assert_eq!(active[1].id, "s2"); // started_at = 950
        assert_eq!(active[2].id, "s3"); // started_at = 970
    }

    #[test]
    fn test_is_session_stale_idle() {
        assert!(!is_session_stale("idle", 59.0));
        assert!(is_session_stale("idle", 60.0));
        assert!(is_session_stale("idle", 120.0));
    }

    #[test]
    fn test_is_session_stale_error() {
        assert!(!is_session_stale("error", 299.0));
        assert!(is_session_stale("error", 300.0));
        assert!(is_session_stale("error", 600.0));
    }

    #[test]
    fn test_is_session_stale_working_and_other() {
        // "working", "waiting", "subagent", "done" all use the 1800s threshold
        for state in &["working", "waiting", "subagent", "done"] {
            assert!(!is_session_stale(state, 1799.0), "{} at 1799s should not be stale", state);
            assert!(is_session_stale(state, 1800.0), "{} at 1800s should be stale", state);
        }
    }

    #[test]
    fn test_jsonl_path_fallback_scan() {
        let dir = std::env::temp_dir().join("claude_cue_test_fallback");
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
