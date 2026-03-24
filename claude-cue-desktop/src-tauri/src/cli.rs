//! CLI for monitoring Claude Code sessions from the terminal.
//!
//! When the binary is invoked with `--status`, session data is printed to stdout
//! instead of launching the GUI. Supports:
//!   `--pretty`      Human-readable multi-line card output (default rich format)
//!   `--compact`     Single-line-per-session output (requires `--pretty`)
//!   `--show-paths`  Reveal full workspace paths (leaf name only by default)
//!
//! ANSI colors are auto-detected: enabled when stdout is a TTY, disabled when piped.

use crate::jsonl_parser;
use crate::models::{EnrichedSession, SessionMetrics, StatusData};
use crate::paths;
use crate::security;
use crate::session_monitor::{encode_workspace_path, filter_and_sort_active};
use std::collections::HashMap;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
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
    let compact = args.iter().any(|a| a == "--compact");
    let show_paths = args.iter().any(|a| a == "--show-paths");
    let use_color = std::io::stdout().is_terminal();

    let sessions = load_sessions();

    if pretty {
        if compact {
            print_pretty_compact(&sessions, show_paths, use_color);
        } else {
            print_pretty_rich(&sessions, show_paths, use_color);
        }
    } else {
        print_json(&sessions, show_paths);
    }

    Some(())
}

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const RESET: &str = "\x1b[0m";
const BOLD: &str = "\x1b[1m";
const DIM: &str = "\x1b[2m";
const GREEN: &str = "\x1b[32m";
const YELLOW: &str = "\x1b[33m";
const RED: &str = "\x1b[31m";
const CYAN: &str = "\x1b[36m";
const WHITE: &str = "\x1b[37m";

fn state_color(state: &str) -> &'static str {
    match state {
        "working" => WHITE,
        "waiting" => YELLOW,
        "error" => RED,
        "subagent" => CYAN,
        "idle" => WHITE,
        "done" => GREEN,
        _ => WHITE,
    }
}

/// Wrap text in ANSI codes only if color is enabled.
fn color(text: &str, code: &str, use_color: bool) -> String {
    if use_color {
        format!("{}{}{}", code, text, RESET)
    } else {
        text.to_string()
    }
}

fn bold(text: &str, use_color: bool) -> String {
    color(text, BOLD, use_color)
}

fn dim(text: &str, use_color: bool) -> String {
    color(text, DIM, use_color)
}

// ---------------------------------------------------------------------------
// Session loading with JSONL enrichment
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

    let active = filter_and_sort_active(
        status.sessions.into_values().filter(|s| {
            security::sanitize_workspace_path(&s.workspace).is_ok()
        }),
        now,
    );

    let projects_path = paths::claude_projects_path();

    let mut enriched: Vec<_> = active
        .into_iter()
        .map(|info| {
            let metrics = resolve_jsonl_metrics(&info.id, &info.workspace, &projects_path);
            EnrichedSession::from_info_and_metrics(info, metrics)
        })
        .collect();

    // Sort: active states first (working, waiting, subagent), then idle, then done/error
    enriched.sort_by(|a, b| {
        let priority = |s: &EnrichedSession| -> u8 {
            match s.info.state.as_str() {
                "working" | "waiting" | "subagent" => 0,
                "idle" => 1,
                _ => 2, // done, error
            }
        };
        let pa = priority(a);
        let pb = priority(b);
        pa.cmp(&pb).then_with(|| {
            // Within same priority group: most recent first
            b.info.started_at.partial_cmp(&a.info.started_at).unwrap_or(std::cmp::Ordering::Equal)
        })
    });

    enriched
}

/// Resolve JSONL log file path and parse metrics for a session.
/// Mirrors the path resolution logic from session_monitor::jsonl_path.
fn resolve_jsonl_metrics(session_id: &str, workspace: &str, projects_path: &Path) -> SessionMetrics {
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
            return parse_metrics(&candidate);
        }

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
                return parse_metrics(&candidate);
            }
        }
    }

    SessionMetrics::default()
}

fn parse_metrics(path: &Path) -> SessionMetrics {
    // Skip files larger than 50MB for CLI responsiveness
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > 50 * 1024 * 1024 {
            return SessionMetrics::default();
        }
    }
    jsonl_parser::parse_jsonl_to_session_metrics(path).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Privacy: workspace display helpers
// ---------------------------------------------------------------------------

fn leaf_name(workspace: &str) -> String {
    Path::new(workspace)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| workspace.to_string())
}

fn workspace_display(session: &EnrichedSession, show_paths: bool) -> String {
    if show_paths {
        session.info.workspace.clone()
    } else {
        leaf_name(&session.info.workspace)
    }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

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
        format!("{:.1}M", tokens as f64 / 1_000_000.0)
    } else if tokens >= 1_000 {
        format!("{:.1}K", tokens as f64 / 1_000.0)
    } else {
        format!("{}", tokens)
    }
}

fn format_context_bar(percent: f64, width: usize) -> String {
    let filled = ((percent * width as f64).round() as usize).min(width);
    let empty = width - filled;
    format!(
        "{}{}",
        "\u{2588}".repeat(filled),  // █
        "\u{2591}".repeat(empty),   // ░
    )
}

fn format_cache_percent(metrics: &SessionMetrics) -> Option<String> {
    let total = metrics.cache_creation_tokens + metrics.cache_read_tokens;
    if total > 0 {
        Some(format!("{}%", (metrics.cache_hit_rate() * 100.0).round() as i64))
    } else {
        None
    }
}

fn format_tool_chips(metrics: &SessionMetrics) -> String {
    let tools = metrics.top_tools();
    if tools.is_empty() {
        return String::new();
    }
    tools
        .iter()
        .map(|(name, count)| format!("{} {}", name, count))
        .collect::<Vec<_>>()
        .join(" | ")
}

// ---------------------------------------------------------------------------
// JSON output (fully enriched)
// ---------------------------------------------------------------------------

fn print_json(sessions: &[EnrichedSession], show_paths: bool) {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct JsonSession {
        id: String,
        workspace: String,
        display_title: String,
        state: String,
        state_icon: String,
        state_display_name: String,
        duration_secs: f64,
        message_count: i64,
        user_message_count: i64,
        input_tokens: i64,
        output_tokens: i64,
        total_tokens: i64,
        cache_creation_tokens: i64,
        cache_read_tokens: i64,
        cache_hit_percent: f64,
        model_display_name: String,
        source_display: String,
        tool_counts: HashMap<String, i64>,
        total_tool_uses: i64,
        context_usage_percent: f64,
        context_limit: i64,
        last_input_tokens: i64,
        git_branch: Option<String>,
    }

    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct JsonSummary {
        session_count: usize,
        total_messages: i64,
        total_tokens: i64,
    }

    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct JsonOutput {
        summary: JsonSummary,
        sessions: Vec<JsonSession>,
    }

    let total_messages: i64 = sessions.iter().map(|s| s.metrics.message_count).sum();
    let total_tokens: i64 = sessions.iter().map(|s| s.metrics.total_tokens()).sum();

    let output = JsonOutput {
        summary: JsonSummary {
            session_count: sessions.len(),
            total_messages,
            total_tokens,
        },
        sessions: sessions
            .iter()
            .map(|s| JsonSession {
                id: s.info.id.clone(),
                workspace: workspace_display(s, show_paths),
                display_title: s.display_title.clone(),
                state: s.info.state.clone(),
                state_icon: s.state_icon.clone(),
                state_display_name: s.state_display_name.clone(),
                duration_secs: s.duration_secs,
                message_count: s.metrics.message_count,
                user_message_count: s.metrics.user_message_count,
                input_tokens: s.metrics.input_tokens,
                output_tokens: s.metrics.output_tokens,
                total_tokens: s.metrics.total_tokens(),
                cache_creation_tokens: s.metrics.cache_creation_tokens,
                cache_read_tokens: s.metrics.cache_read_tokens,
                cache_hit_percent: s.metrics.cache_hit_rate() * 100.0,
                model_display_name: s.model_display_name.clone(),
                source_display: s.source_display.clone(),
                tool_counts: s.metrics.tool_counts.clone(),
                total_tool_uses: s.metrics.total_tool_uses(),
                context_usage_percent: s.context_usage_percent * 100.0,
                context_limit: s.context_limit,
                last_input_tokens: s.metrics.last_input_tokens,
                git_branch: s.metrics.git_branch.clone(),
            })
            .collect(),
    };

    if let Ok(json) = serde_json::to_string_pretty(&output) {
        println!("{}", json);
    }
}

// ---------------------------------------------------------------------------
// Pretty rich output (multi-line cards)
// ---------------------------------------------------------------------------

fn print_pretty_rich(sessions: &[EnrichedSession], show_paths: bool, use_color: bool) {
    if sessions.is_empty() {
        println!("No active sessions");
        return;
    }

    // Summary header
    let total_messages: i64 = sessions.iter().map(|s| s.metrics.message_count).sum();
    let total_tokens: i64 = sessions.iter().map(|s| s.metrics.total_tokens()).sum();

    println!(
        "{}",
        bold("Claude Cue Sessions", use_color)
    );
    println!(
        "{} {} sessions  {} {} messages  {} {} tokens",
        color("\u{25CF}", GREEN, use_color), // ●
        sessions.len(),
        "\u{1F4AC}", // 💬
        total_messages,
        "\u{2195}",  // ↕
        format_tokens(total_tokens),
    );
    println!();

    for s in sessions {
        let sc = state_color(&s.info.state);

        // Line 1: icon + title + state badge + duration
        let title = if show_paths {
            s.info.workspace.clone()
        } else {
            s.display_title.clone()
        };
        let badge = &s.state_display_name;
        let duration = format_duration(s.duration_secs);
        let branch_str = s.metrics.git_branch.as_ref()
            .map(|b| format!("  {}", dim(&format!("[{}]", b), use_color)))
            .unwrap_or_default();

        println!(
            "{}  {}  {}  {}{}",
            color(state_icon(&s.info.state), sc, use_color),
            bold(&title, use_color),
            color(badge, sc, use_color),
            dim(&duration, use_color),
            branch_str,
        );

        // Line 2: session ID + messages + tokens in/out + tools + model + source
        let id_short = if s.info.id.len() >= 8 {
            &s.info.id[..8]
        } else {
            &s.info.id
        };
        let msgs = format!(
            "\u{1F4AC} {}/{}",
            s.metrics.user_message_count,
            s.metrics.message_count
        );
        let tokens_in = format!("\u{2193} {} in", format_tokens(s.metrics.input_tokens));
        let tokens_out = format!("\u{2191} {} out", format_tokens(s.metrics.output_tokens));

        let mut detail_parts = vec![
            dim(id_short, use_color),
            msgs,
            tokens_in,
            tokens_out,
        ];

        let total_tools = s.metrics.total_tool_uses();
        if total_tools > 0 {
            detail_parts.push(format!("\u{1F527} {} tools", total_tools));
        }

        if s.model_display_name != "\u{2014}" {
            detail_parts.push(s.model_display_name.clone());
        }

        if s.source_display != "\u{2014}" {
            detail_parts.push(s.source_display.clone());
        }

        println!("  {}", detail_parts.join("  "));

        // Line 3: tool breakdown (if any)
        let tool_chips = format_tool_chips(&s.metrics);
        if !tool_chips.is_empty() {
            println!("  {}", tool_chips);
        }

        // Line 4: context bar + cache (if any meaningful data)
        if s.context_usage_percent > 0.0 || s.metrics.cache_read_tokens > 0 {
            let bar = format_context_bar(s.context_usage_percent, 10);
            let pct = format!("{}%", (s.context_usage_percent * 100.0).round() as i64);
            let ctx_tokens = format!(
                "{}/{}",
                format_tokens(s.metrics.last_input_tokens),
                format_tokens(s.context_limit),
            );

            let mut ctx_parts = vec![
                format!("Context {}", bar),
                pct,
                ctx_tokens,
            ];

            if let Some(cache_pct) = format_cache_percent(&s.metrics) {
                ctx_parts.push(format!("Cache {}", cache_pct));
            }

            println!("  {}", dim(&ctx_parts.join("  "), use_color));
        }

        println!();
    }
}

// ---------------------------------------------------------------------------
// Pretty compact output (single line per session)
// ---------------------------------------------------------------------------

fn print_pretty_compact(sessions: &[EnrichedSession], show_paths: bool, use_color: bool) {
    if sessions.is_empty() {
        println!("No active sessions");
        return;
    }

    for s in sessions {
        let sc = state_color(&s.info.state);
        let icon = color(state_icon(&s.info.state), sc, use_color);
        let title = if show_paths {
            s.info.workspace.clone()
        } else {
            s.display_title.clone()
        };
        let badge = color(&s.state_display_name, sc, use_color);
        let id_short = if s.info.id.len() >= 8 {
            &s.info.id[..8]
        } else {
            &s.info.id
        };
        let msgs = format!(
            "{}/{}",
            s.metrics.user_message_count,
            s.metrics.message_count,
        );
        let tokens_in = format!("{}\u{2193}", format_tokens(s.metrics.input_tokens));
        let tokens_out = format!("{}\u{2191}", format_tokens(s.metrics.output_tokens));
        let tools = format!("{}T", s.metrics.total_tool_uses());
        let model = if s.model_display_name != "\u{2014}" {
            s.model_display_name.replace(' ', "")
        } else {
            "---".to_string()
        };
        let duration = format_duration(s.duration_secs);
        let ctx_pct = format!("{}%ctx", (s.context_usage_percent * 100.0).round() as i64);

        println!(
            "{}  {:<16} {:<8} {}  {:>5}  {:>6} {:>6}  {:>4}  {:>10}  {:>10}  {:>6}",
            icon, title, badge, dim(id_short, use_color),
            msgs, tokens_in, tokens_out, tools, model, duration, ctx_pct,
        );
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
    fn test_try_run_cli_compact_returns_some() {
        let args = vec![
            "claude-cue-desktop".to_string(),
            "--status".to_string(),
            "--pretty".to_string(),
            "--compact".to_string(),
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

    fn make_test_info(id: &str, workspace: &str, state: &str) -> crate::models::SessionInfo {
        crate::models::SessionInfo {
            id: id.to_string(),
            workspace: workspace.to_string(),
            state: state.to_string(),
            last_activity: 0.0,
            started_at: 0.0,
            source: None,
            hook_input_tokens: 0,
            hook_output_tokens: 0,
            hook_model: String::new(),
        }
    }

    #[test]
    fn test_workspace_display_hides_path_by_default() {
        let info = make_test_info("t", "/Users/dev/Projects/WebApp", "working");
        let enriched =
            EnrichedSession::from_info_and_metrics(info, SessionMetrics::default());
        assert_eq!(workspace_display(&enriched, false), "WebApp");
    }

    #[test]
    fn test_workspace_display_shows_path_when_flag_set() {
        let info = make_test_info("t", "/Users/dev/Projects/WebApp", "working");
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
        assert_eq!(format_duration(38.0 * 60.0 + 12.0), "38m 12s");
    }

    // -- format_tokens tests --

    #[test]
    fn test_format_tokens_zero() {
        assert_eq!(format_tokens(0), "0");
    }

    #[test]
    fn test_format_tokens_small() {
        assert_eq!(format_tokens(500), "500");
    }

    #[test]
    fn test_format_tokens_thousands() {
        assert_eq!(format_tokens(48_200), "48.2K");
    }

    #[test]
    fn test_format_tokens_millions() {
        assert_eq!(format_tokens(1_500_000), "1.5M");
    }

    // -- context bar tests --

    #[test]
    fn test_format_context_bar_zero() {
        let bar = format_context_bar(0.0, 10);
        assert_eq!(bar, "\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}");
    }

    #[test]
    fn test_format_context_bar_half() {
        let bar = format_context_bar(0.5, 10);
        assert_eq!(bar, "\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}");
    }

    #[test]
    fn test_format_context_bar_full() {
        let bar = format_context_bar(1.0, 10);
        assert_eq!(bar, "\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}");
    }

    // -- cache percent tests --

    #[test]
    fn test_format_cache_percent_none_when_zero() {
        let m = SessionMetrics::default();
        assert!(format_cache_percent(&m).is_none());
    }

    #[test]
    fn test_format_cache_percent_with_data() {
        let m = SessionMetrics {
            cache_creation_tokens: 100,
            cache_read_tokens: 900,
            ..Default::default()
        };
        assert_eq!(format_cache_percent(&m), Some("90%".to_string()));
    }

    // -- tool chips tests --

    #[test]
    fn test_format_tool_chips_empty() {
        let m = SessionMetrics::default();
        assert_eq!(format_tool_chips(&m), "");
    }

    #[test]
    fn test_format_tool_chips_sorted_by_count() {
        let m = SessionMetrics {
            tool_counts: HashMap::from([
                ("Read".to_string(), 3),
                ("Edit".to_string(), 10),
                ("Bash".to_string(), 5),
            ]),
            ..Default::default()
        };
        let chips = format_tool_chips(&m);
        // Edit should come first (10), then Bash (5), then Read (3)
        assert!(chips.starts_with("Edit 10"));
        assert!(chips.contains("Bash 5"));
        assert!(chips.contains("Read 3"));
    }

    // -- color helper tests --

    #[test]
    fn test_color_enabled() {
        let result = color("hello", GREEN, true);
        assert!(result.contains("\x1b[32m"));
        assert!(result.contains("\x1b[0m"));
        assert!(result.contains("hello"));
    }

    #[test]
    fn test_color_disabled() {
        let result = color("hello", GREEN, false);
        assert_eq!(result, "hello");
        assert!(!result.contains("\x1b["));
    }

    // -- sort order tests --

    #[test]
    fn test_sort_active_first() {
        let make = |id: &str, state: &str, started: f64| -> EnrichedSession {
            let mut info = make_test_info(id, "/tmp/test", state);
            info.last_activity = 1000.0;
            info.started_at = started;
            EnrichedSession::from_info_and_metrics(info, SessionMetrics::default())
        };

        let mut sessions = vec![
            make("done1", "done", 100.0),
            make("working1", "working", 200.0),
            make("idle1", "idle", 150.0),
            make("waiting1", "waiting", 300.0),
        ];

        sessions.sort_by(|a, b| {
            let priority = |s: &EnrichedSession| -> u8 {
                match s.info.state.as_str() {
                    "working" | "waiting" | "subagent" => 0,
                    "idle" => 1,
                    _ => 2,
                }
            };
            let pa = priority(a);
            let pb = priority(b);
            pa.cmp(&pb).then_with(|| {
                b.info.started_at.partial_cmp(&a.info.started_at).unwrap_or(std::cmp::Ordering::Equal)
            })
        });

        // Active states first (waiting started later so it's first within group)
        assert_eq!(sessions[0].info.id, "waiting1");
        assert_eq!(sessions[1].info.id, "working1");
        // Then idle
        assert_eq!(sessions[2].info.id, "idle1");
        // Then done
        assert_eq!(sessions[3].info.id, "done1");
    }

    // -- JSON output structure tests --

    #[test]
    fn test_json_output_empty_sessions() {
        let _sessions: Vec<EnrichedSession> = Vec::new();
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
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        let mut info = make_test_info("test-123", "/home/user/my-project", "working");
        info.last_activity = now;
        info.started_at = now - 100.0;
        let sessions = vec![EnrichedSession::from_info_and_metrics(
            info,
            SessionMetrics::default(),
        )];

        assert_eq!(sessions[0].workspace_name, "my-project");
        assert_eq!(sessions[0].state_icon, "\u{27F3}");
        assert!(sessions[0].duration_secs > 0.0);
    }

    #[test]
    fn test_load_sessions_no_crash() {
        let sessions = load_sessions();
        let _ = sessions.len();
    }

    // -- JSONL resolution tests --

    #[test]
    fn test_resolve_jsonl_metrics_missing_returns_default() {
        let dir = std::env::temp_dir().join("claude_cue_cli_test_missing");
        let _ = std::fs::create_dir_all(&dir);
        let metrics = resolve_jsonl_metrics("nonexistent-session", "/tmp/fake", &dir);
        assert_eq!(metrics.total_tokens(), 0);
        assert_eq!(metrics.message_count, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_resolve_jsonl_metrics_with_fixture() {
        let dir = std::env::temp_dir().join("claude_cue_cli_test_fixture");
        let _ = std::fs::remove_dir_all(&dir);

        let project_dir = dir.join("-Users-dev-App");
        std::fs::create_dir_all(&project_dir).unwrap();

        // Write a minimal JSONL file with usage data
        let jsonl = concat!(
            r#"{"type":"user","timestamp":1710000000.0}"#, "\n",
            r#"{"type":"assistant","timestamp":1710000001.0,"message":{"usage":{"input_tokens":1000,"output_tokens":500}}}"#, "\n",
        );
        std::fs::write(project_dir.join("sess-1.jsonl"), jsonl).unwrap();

        let metrics = resolve_jsonl_metrics("sess-1", "/Users/dev/App", &dir);
        assert_eq!(metrics.input_tokens, 1000);
        assert_eq!(metrics.output_tokens, 500);
        assert_eq!(metrics.user_message_count, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_id_truncation() {
        let full_id = "1616b203abcdef1234567890";
        let short = if full_id.len() >= 8 { &full_id[..8] } else { full_id };
        assert_eq!(short, "1616b203");
    }
}
