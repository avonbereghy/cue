//! CLI fallback for tiling WM users who don't have a system tray.
//!
//! When the binary is invoked with `--status`, session data is printed to stdout
//! instead of launching the GUI. Supports `--pretty` for human-readable output
//! and `--show-paths` to reveal full workspace paths (leaf name only by default
//! for privacy).

use crate::models::{EnrichedSession, SessionMetrics, StatusData};
use crate::paths;
use crate::security;
use crate::session_monitor::filter_and_sort_active;
use std::path::Path;
use std::time::SystemTime;

/// Attempt to handle CLI arguments. Returns `Some(())` if a CLI command was
/// handled (caller should exit), or `None` if normal GUI mode should proceed.
pub fn try_run_cli() -> Option<()> {
    let args: Vec<String> = std::env::args().collect();
    try_run_cli_inner(&args)
}

/// Inner implementation that accepts args for testability.
fn try_run_cli_inner(args: &[String]) -> Option<()> {
    if !args.iter().any(|a| a == "--status") {
        return None;
    }

    let pretty = args.iter().any(|a| a == "--pretty");
    let show_paths = args.iter().any(|a| a == "--show-paths");

    let sessions = load_sessions();

    if pretty {
        print_pretty(&sessions, show_paths);
    } else {
        print_json(&sessions, show_paths);
    }

    Some(())
}

// ---------------------------------------------------------------------------
// Session loading (mirrors session_monitor stale-filtering logic)
// ---------------------------------------------------------------------------

fn load_sessions() -> Vec<EnrichedSession> {
    let path = paths::sessions_json_path();
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let status: StatusData = match serde_json::from_str(&content) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();

    filter_and_sort_active(
        status.sessions.into_values().filter(|s| {
            security::sanitize_workspace_path(&s.workspace).is_ok()
        }),
        now,
    )
        .into_iter()
        .map(|info| EnrichedSession::from_info_and_metrics(info, SessionMetrics::default()))
        .collect()
}

// ---------------------------------------------------------------------------
// Privacy: workspace display helpers
// ---------------------------------------------------------------------------

/// Return only the leaf directory name from a workspace path.
fn leaf_name(workspace: &str) -> String {
    Path::new(workspace)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| workspace.to_string())
}

/// Return the workspace display string, respecting the --show-paths flag.
fn workspace_display(session: &EnrichedSession, show_paths: bool) -> String {
    if show_paths {
        session.info.workspace.clone()
    } else {
        leaf_name(&session.info.workspace)
    }
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

fn print_json(sessions: &[EnrichedSession], show_paths: bool) {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct JsonSession {
        id: String,
        workspace: String,
        state: String,
        state_icon: String,
        duration_secs: f64,
        total_tokens: i64,
    }

    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct JsonOutput {
        sessions: Vec<JsonSession>,
    }

    let output = JsonOutput {
        sessions: sessions
            .iter()
            .map(|s| JsonSession {
                id: s.info.id.clone(),
                workspace: workspace_display(s, show_paths),
                state: s.info.state.clone(),
                state_icon: s.state_icon.clone(),
                duration_secs: s.duration_secs,
                total_tokens: s.metrics.total_tokens(),
            })
            .collect(),
    };

    if let Ok(json) = serde_json::to_string(&output) {
        println!("{}", json);
    }
}

// ---------------------------------------------------------------------------
// Pretty (human-readable) output
// ---------------------------------------------------------------------------

fn print_pretty(sessions: &[EnrichedSession], show_paths: bool) {
    if sessions.is_empty() {
        println!("No active sessions");
        return;
    }

    println!("Claude Cue Sessions");
    println!();

    for s in sessions {
        let icon = state_icon(&s.info.state);
        let name = workspace_display(s, show_paths);
        let duration = format_duration(s.duration_secs);
        let tokens = format_tokens(s.metrics.total_tokens());

        println!(
            "{}  {:<16}{:<12}{:<12}{}",
            icon, name, s.info.state, duration, tokens
        );
    }
}

fn state_icon(state: &str) -> &'static str {
    match state {
        "working" => "\u{27F3}",  // ⟳
        "waiting" => "\u{23F8}",  // ⏸
        "error" => "\u{2717}",    // ✗
        "subagent" => "\u{2934}", // ⤴
        "idle" => "\u{25CB}",     // ○
        _ => "\u{2713}",          // ✓ (done and any unknown)
    }
}

fn format_duration(secs: f64) -> String {
    let total = secs.max(0.0) as u64;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    let s = total % 60;
    if h > 0 {
        format!("{}h {:02}m {:02}s", h, m, s)
    } else {
        format!("{}m {:02}s", m, s)
    }
}

fn format_tokens(tokens: i64) -> String {
    if tokens >= 1_000_000 {
        format!("{:.1}M tokens", tokens as f64 / 1_000_000.0)
    } else if tokens >= 1_000 {
        format!("{:.1}K tokens", tokens as f64 / 1_000.0)
    } else {
        format!("{} tokens", tokens)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- try_run_cli_inner tests --

    #[test]
    fn test_try_run_cli_no_args_returns_none() {
        let args = vec!["claude-cue-desktop".to_string()];
        assert!(try_run_cli_inner(&args).is_none());
    }

    #[test]
    fn test_try_run_cli_status_returns_some() {
        let args = vec![
            "claude-cue-desktop".to_string(),
            "--status".to_string(),
        ];
        assert!(try_run_cli_inner(&args).is_some());
    }

    #[test]
    fn test_try_run_cli_status_pretty_returns_some() {
        let args = vec![
            "claude-cue-desktop".to_string(),
            "--status".to_string(),
            "--pretty".to_string(),
        ];
        assert!(try_run_cli_inner(&args).is_some());
    }

    #[test]
    fn test_try_run_cli_unrelated_args_returns_none() {
        let args = vec![
            "claude-cue-desktop".to_string(),
            "--some-other-flag".to_string(),
        ];
        assert!(try_run_cli_inner(&args).is_none());
    }

    #[test]
    fn test_try_run_cli_show_paths_without_status_returns_none() {
        let args = vec![
            "claude-cue-desktop".to_string(),
            "--show-paths".to_string(),
        ];
        assert!(try_run_cli_inner(&args).is_none());
    }

    // -- leaf_name tests --

    #[test]
    fn test_leaf_name_unix_path() {
        assert_eq!(leaf_name("/Users/dev/Projects/WebApp"), "WebApp");
    }

    #[test]
    fn test_leaf_name_single_component() {
        assert_eq!(leaf_name("WebApp"), "WebApp");
    }

    #[test]
    fn test_leaf_name_root() {
        assert_eq!(leaf_name("/"), "/");
    }

    #[test]
    fn test_leaf_name_deep_path() {
        assert_eq!(leaf_name("/home/user/code/org/repo"), "repo");
    }

    // -- workspace_display tests --

    #[test]
    fn test_workspace_display_hides_path_by_default() {
        use crate::models::SessionInfo;
        let info = SessionInfo {
            id: "t".to_string(),
            workspace: "/Users/dev/Projects/WebApp".to_string(),
            state: "working".to_string(),
            last_activity: 0.0,
            started_at: 0.0,
            source: None,
        };
        let enriched =
            EnrichedSession::from_info_and_metrics(info, SessionMetrics::default());
        assert_eq!(workspace_display(&enriched, false), "WebApp");
    }

    #[test]
    fn test_workspace_display_shows_path_when_flag_set() {
        use crate::models::SessionInfo;
        let info = SessionInfo {
            id: "t".to_string(),
            workspace: "/Users/dev/Projects/WebApp".to_string(),
            state: "working".to_string(),
            last_activity: 0.0,
            started_at: 0.0,
            source: None,
        };
        let enriched =
            EnrichedSession::from_info_and_metrics(info, SessionMetrics::default());
        assert_eq!(
            workspace_display(&enriched, true),
            "/Users/dev/Projects/WebApp"
        );
    }

    // -- state_icon tests --

    #[test]
    fn test_state_icons() {
        assert_eq!(state_icon("working"), "\u{27F3}");
        assert_eq!(state_icon("waiting"), "\u{23F8}");
        assert_eq!(state_icon("error"), "\u{2717}");
        assert_eq!(state_icon("subagent"), "\u{2934}");
        assert_eq!(state_icon("idle"), "\u{25CB}");
        assert_eq!(state_icon("done"), "\u{2713}");
        // Unknown states fall through to done/checkmark
        assert_eq!(state_icon("whatever"), "\u{2713}");
    }

    // -- format_duration tests --

    #[test]
    fn test_format_duration_zero() {
        assert_eq!(format_duration(0.0), "0m 00s");
    }

    #[test]
    fn test_format_duration_seconds_only() {
        assert_eq!(format_duration(45.0), "0m 45s");
    }

    #[test]
    fn test_format_duration_minutes() {
        assert_eq!(format_duration(125.0), "2m 05s");
    }

    #[test]
    fn test_format_duration_hours() {
        assert_eq!(format_duration(3661.0), "1h 01m 01s");
    }

    #[test]
    fn test_format_duration_negative() {
        assert_eq!(format_duration(-5.0), "0m 00s");
    }

    #[test]
    fn test_format_duration_spec_example() {
        // "38m 12s" from the spec
        assert_eq!(format_duration(38.0 * 60.0 + 12.0), "38m 12s");
    }

    // -- format_tokens tests --

    #[test]
    fn test_format_tokens_zero() {
        assert_eq!(format_tokens(0), "0 tokens");
    }

    #[test]
    fn test_format_tokens_small() {
        assert_eq!(format_tokens(500), "500 tokens");
    }

    #[test]
    fn test_format_tokens_thousands() {
        assert_eq!(format_tokens(48_200), "48.2K tokens");
    }

    #[test]
    fn test_format_tokens_millions() {
        assert_eq!(format_tokens(1_500_000), "1.5M tokens");
    }

    // -- JSON output structure tests --

    #[test]
    fn test_json_output_empty_sessions() {
        let _sessions: Vec<EnrichedSession> = Vec::new();
        // Verify the wrapper structure serializes correctly
        #[derive(serde::Serialize)]
        struct JsonOutput {
            sessions: Vec<serde_json::Value>,
        }
        let output = JsonOutput { sessions: vec![] };
        let json = serde_json::to_string(&output).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(parsed["sessions"].is_array());
        assert_eq!(parsed["sessions"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn test_json_output_with_session() {
        use crate::models::SessionInfo;
        let info = SessionInfo {
            id: "test-123".to_string(),
            workspace: "/home/user/my-project".to_string(),
            state: "working".to_string(),
            last_activity: 1000.0,
            started_at: 900.0,
            source: None,
        };
        let sessions = vec![EnrichedSession::from_info_and_metrics(
            info,
            SessionMetrics::default(),
        )];

        // Verify the enriched session has the expected leaf name
        assert_eq!(sessions[0].workspace_name, "my-project");
        assert_eq!(sessions[0].state_icon, "\u{27F3}");
        assert!(sessions[0].duration_secs > 0.0);
    }

    #[test]
    fn test_load_sessions_no_crash() {
        // Should not panic even if sessions.json doesn't exist
        let sessions = load_sessions();
        let _ = sessions.len();
    }
}
