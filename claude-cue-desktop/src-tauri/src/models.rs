//! Data models for Claude Cue — port of Models.swift.
//!
//! All structs use serde for JSON serialization to/from the React frontend.

use chrono::Datelike;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Session Status (from sessions.json via hooks)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub workspace: String,
    /// One of: "working", "waiting", "error", "subagent", "idle", "done"
    pub state: String,
    pub last_activity: f64,
    pub started_at: f64,
    /// Client that launched the session: "vscode", "cursor", "iterm", "terminal", etc.
    #[serde(default)]
    pub source: Option<String>,
    /// Total input tokens from last API call (written by hook from JSONL).
    #[serde(default, rename = "inputTokens")]
    pub hook_input_tokens: i64,
    /// Output tokens from last API call (written by hook from JSONL).
    #[serde(default, rename = "outputTokens")]
    pub hook_output_tokens: i64,
    /// Model name from last API call (written by hook from JSONL).
    #[serde(default, rename = "model")]
    pub hook_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusData {
    pub sessions: HashMap<String, SessionInfo>,
}

// ---------------------------------------------------------------------------
// Session Metrics (parsed from JSONL conversation logs)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetrics {
    pub message_count: i64,
    pub user_message_count: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    pub model: String,
    pub last_input_tokens: i64,
    pub custom_title: Option<String>,
    pub git_branch: Option<String>,
    pub tool_counts: HashMap<String, i64>,
}

impl SessionMetrics {
    pub fn total_tokens(&self) -> i64 {
        self.input_tokens + self.output_tokens
    }

    pub fn total_tool_uses(&self) -> i64 {
        self.tool_counts.values().sum()
    }

    pub fn top_tools(&self) -> Vec<(String, i64)> {
        let mut tools: Vec<_> = self.tool_counts.iter().map(|(k, v)| (k.clone(), *v)).collect();
        tools.sort_by(|a, b| b.1.cmp(&a.1));
        tools
    }

    pub fn cache_hit_rate(&self) -> f64 {
        let total = self.cache_creation_tokens + self.cache_read_tokens;
        if total == 0 {
            return 0.0;
        }
        self.cache_read_tokens as f64 / total as f64
    }
}

// ---------------------------------------------------------------------------
// Enriched Session (combines hook state + JSONL metrics)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichedSession {
    pub info: SessionInfo,
    pub metrics: SessionMetrics,
    pub workspace_name: String,
    pub display_title: String,
    pub state_icon: String,
    pub state_display_name: String,
    pub duration_secs: f64,
    pub context_limit: i64,
    pub context_usage_percent: f64,
    pub model_display_name: String,
    /// Human-readable source label (e.g. "VSCode", "iTerm", "Terminal")
    pub source_display: String,
}

impl EnrichedSession {
    pub fn from_info_and_metrics(info: SessionInfo, metrics: SessionMetrics) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();

        let workspace_name = std::path::Path::new(&info.workspace)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| info.workspace.clone());

        let display_title = metrics
            .custom_title
            .clone()
            .unwrap_or_else(|| workspace_name.clone());

        let state_icon = match info.state.as_str() {
            "working" => "\u{27F3}",   // ⟳
            "waiting" => "\u{23F8}",   // ⏸
            "error" => "\u{2717}",     // ✗
            "subagent" => "\u{2934}",  // ⤴
            "idle" => "\u{25CB}",      // ○
            _ => "\u{2713}",           // ✓
        }
        .to_string();

        let state_display_name = match info.state.as_str() {
            "working" => "Working",
            "waiting" => "Waiting",
            "error" => "Error",
            "subagent" => "Subagent",
            "idle" => "Idle",
            "done" => "Done",
            other => other,
        }
        .to_string();

        let duration_secs = now - info.started_at;

        // Prefer hook-sourced token counts (written at hook time from JSONL)
        // over the background-polled metrics, as they're fresher.
        let effective_input_tokens = if info.hook_input_tokens > 0 {
            info.hook_input_tokens
        } else {
            metrics.last_input_tokens
        };

        let effective_model = if !info.hook_model.is_empty() {
            info.hook_model.clone()
        } else {
            metrics.model.clone()
        };

        let context_limit = {
            let m = effective_model.to_lowercase();
            if (m.contains("opus") || m.contains("sonnet")) && m.contains("4-6") {
                1_000_000
            } else {
                200_000
            }
        };

        let context_usage_percent = if effective_input_tokens > 0 {
            (effective_input_tokens as f64 / context_limit as f64).min(1.0)
        } else {
            0.0
        };

        let model_display_name = format_model_name(&effective_model);

        let source_display = format_source_name(info.source.as_deref());

        Self {
            info,
            metrics,
            workspace_name,
            display_title,
            state_icon,
            state_display_name,
            duration_secs,
            context_limit,
            context_usage_percent,
            model_display_name,
            source_display,
        }
    }
}

fn format_model_name(model: &str) -> String {
    if model == "unknown" || model.is_empty() {
        return "\u{2014}".to_string(); // em dash
    }
    let cleaned = model.replace("claude-", "");
    let parts: Vec<&str> = cleaned.split('-').collect();
    if parts.len() >= 3 {
        let name = {
            let mut chars = parts[0].chars();
            match chars.next() {
                Some(c) => c.to_uppercase().to_string() + chars.as_str(),
                None => String::new(),
            }
        };
        let version = parts[1..].join(".");
        format!("{} {}", name, version)
    } else {
        model.to_string()
    }
}

fn format_source_name(source: Option<&str>) -> String {
    match source {
        Some("vscode") => "VSCode".to_string(),
        Some("cursor") => "Cursor".to_string(),
        Some("iterm") => "iTerm".to_string(),
        Some("terminal") => "Terminal".to_string(),
        Some("wezterm") => "WezTerm".to_string(),
        Some("alacritty") => "Alacritty".to_string(),
        Some("kitty") => "Kitty".to_string(),
        Some("ghostty") => "Ghostty".to_string(),
        Some("tmux") => "tmux".to_string(),
        Some("screen") => "screen".to_string(),
        Some("hyper") => "Hyper".to_string(),
        Some("unknown") | None => "\u{2014}".to_string(), // em dash
        Some(other) => {
            // Capitalize first letter for unknown sources
            let mut chars = other.chars();
            match chars.next() {
                Some(c) => c.to_uppercase().to_string() + chars.as_str(),
                None => "\u{2014}".to_string(),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Usage Aggregation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum UsageWindow {
    FiveHour,
    Daily,
    Weekly,
}

impl UsageWindow {
    pub const ALL: [UsageWindow; 3] = [
        UsageWindow::FiveHour,
        UsageWindow::Daily,
        UsageWindow::Weekly,
    ];

    pub fn display_name(&self) -> &'static str {
        match self {
            UsageWindow::FiveHour => "Session (5hr)",
            UsageWindow::Daily => "Today",
            UsageWindow::Weekly => "This Week",
        }
    }

    pub fn settings_key(&self) -> &'static str {
        match self {
            UsageWindow::FiveHour => "fiveHourTokenLimit",
            UsageWindow::Daily => "dailyTokenLimit",
            UsageWindow::Weekly => "weeklyTokenLimit",
        }
    }

    /// Returns the start timestamp (Unix seconds) for this window.
    pub fn start_timestamp(&self, now_secs: f64) -> f64 {
        match self {
            UsageWindow::FiveHour => now_secs - 5.0 * 3600.0,
            UsageWindow::Daily => {
                // Start of today (local time); handle DST ambiguity
                let now = chrono::Local::now();
                now.date_naive()
                    .and_hms_opt(0, 0, 0)
                    .unwrap()
                    .and_local_timezone(chrono::Local)
                    .earliest()
                    .map(|dt| dt.timestamp() as f64)
                    .unwrap_or(now_secs - 86400.0)
            }
            UsageWindow::Weekly => {
                // Start of this week (Monday); handle DST ambiguity
                let now = chrono::Local::now();
                let weekday = now.weekday().num_days_from_monday(); // 0=Mon
                let start_of_week = now.date_naive()
                    - chrono::Duration::days(weekday as i64);
                start_of_week
                    .and_hms_opt(0, 0, 0)
                    .unwrap()
                    .and_local_timezone(chrono::Local)
                    .earliest()
                    .map(|dt| dt.timestamp() as f64)
                    .unwrap_or(now_secs - 7.0 * 86400.0)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Window Metrics
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WindowMetrics {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub session_count: i64,
    pub user_message_count: i64,
    pub assistant_message_count: i64,
    pub tool_counts: HashMap<String, i64>,
    /// Map of model name -> (input_tokens, output_tokens)
    pub model_tokens: HashMap<String, (i64, i64)>,
}

impl WindowMetrics {
    pub fn total_tokens(&self) -> i64 {
        self.input_tokens + self.output_tokens
    }

    pub fn total_tool_uses(&self) -> i64 {
        self.tool_counts.values().sum()
    }

    pub fn top_tools(&self) -> Vec<(String, i64)> {
        let mut tools: Vec<_> = self.tool_counts.iter().map(|(k, v)| (k.clone(), *v)).collect();
        tools.sort_by(|a, b| b.1.cmp(&a.1));
        tools
    }

    pub fn estimated_cost_usd(&self) -> f64 {
        let mut cost = 0.0;
        for (model, (input, output)) in &self.model_tokens {
            let pricing = ModelPricing::for_model(model);
            cost += *input as f64 * pricing.input_per_token;
            cost += *output as f64 * pricing.output_per_token;
        }
        cost
    }
}

// ---------------------------------------------------------------------------
// Model Pricing
// ---------------------------------------------------------------------------

pub struct ModelPricing {
    pub input_per_token: f64,
    pub output_per_token: f64,
}

impl ModelPricing {
    /// Published API pricing as of 2025 (per token, not per million)
    pub fn for_model(model: &str) -> Self {
        let m = model.to_lowercase();
        if m.contains("opus") {
            return ModelPricing {
                input_per_token: 15.0 / 1_000_000.0,
                output_per_token: 75.0 / 1_000_000.0,
            };
        }
        if m.contains("sonnet") {
            return ModelPricing {
                input_per_token: 3.0 / 1_000_000.0,
                output_per_token: 15.0 / 1_000_000.0,
            };
        }
        if m.contains("haiku") {
            return ModelPricing {
                input_per_token: 0.80 / 1_000_000.0,
                output_per_token: 4.0 / 1_000_000.0,
            };
        }
        // Default to Sonnet pricing
        ModelPricing {
            input_per_token: 3.0 / 1_000_000.0,
            output_per_token: 15.0 / 1_000_000.0,
        }
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub five_hour_token_limit: i64,
    pub daily_token_limit: i64,
    pub weekly_token_limit: i64,
    pub plan_preset: String,
    #[serde(default)]
    pub onboarding_complete: bool,
    #[serde(default)]
    pub permissions_enabled: bool,
}

impl Default for Settings {
    fn default() -> Self {
        // Default to Max Standard ($100/mo)
        Self {
            five_hour_token_limit: 2_000_000,
            daily_token_limit: 8_000_000,
            weekly_token_limit: 40_000_000,
            plan_preset: "Max ($100/mo)".to_string(),
            onboarding_complete: false,
            permissions_enabled: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Plan Presets
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PlanPreset {
    Custom,
    Pro,
    MaxStandard,
    MaxPlus,
}

impl PlanPreset {
    pub const ALL: [PlanPreset; 4] = [
        PlanPreset::Custom,
        PlanPreset::Pro,
        PlanPreset::MaxStandard,
        PlanPreset::MaxPlus,
    ];

    pub fn display_name(&self) -> &'static str {
        match self {
            PlanPreset::Custom => "Custom",
            PlanPreset::Pro => "Pro ($20/mo)",
            PlanPreset::MaxStandard => "Max ($100/mo)",
            PlanPreset::MaxPlus => "Max ($200/mo)",
        }
    }

    pub fn limits(&self) -> (i64, i64, i64) {
        match self {
            PlanPreset::Custom => (0, 0, 0),
            PlanPreset::Pro => (500_000, 2_000_000, 10_000_000),
            PlanPreset::MaxStandard => (2_000_000, 8_000_000, 40_000_000),
            PlanPreset::MaxPlus => (4_000_000, 16_000_000, 80_000_000),
        }
    }
}

// ---------------------------------------------------------------------------
// Permission Request (for HTTP hook integration)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub request_id: String,
    pub session_id: String,
    pub tool_name: String,
    pub tool_input: serde_json::Value,
    pub hook_event_name: String,
    pub received_at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PermissionDecision {
    Allow,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionLogEntry {
    pub timestamp: f64,
    pub session_id: String,
    pub tool_name: String,
    pub tool_input_summary: String,
    pub decision: String,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_model_name() {
        assert_eq!(format_model_name("claude-sonnet-4-6"), "Sonnet 4.6");
        assert_eq!(format_model_name("claude-opus-4-6"), "Opus 4.6");
        assert_eq!(format_model_name("unknown"), "\u{2014}");
        assert_eq!(format_model_name(""), "\u{2014}");
    }

    #[test]
    fn test_session_metrics_defaults() {
        let m = SessionMetrics::default();
        assert_eq!(m.total_tokens(), 0);
        assert_eq!(m.total_tool_uses(), 0);
        assert!(m.top_tools().is_empty());
        assert_eq!(m.cache_hit_rate(), 0.0);
    }

    #[test]
    fn test_session_metrics_calculations() {
        let m = SessionMetrics {
            input_tokens: 1000,
            output_tokens: 2000,
            cache_creation_tokens: 100,
            cache_read_tokens: 900,
            tool_counts: HashMap::from([
                ("Bash".to_string(), 5),
                ("Read".to_string(), 3),
            ]),
            ..Default::default()
        };
        assert_eq!(m.total_tokens(), 3000);
        assert_eq!(m.total_tool_uses(), 8);
        assert_eq!(m.cache_hit_rate(), 0.9);
        let top = m.top_tools();
        assert_eq!(top[0].0, "Bash");
        assert_eq!(top[0].1, 5);
    }

    #[test]
    fn test_plan_preset_limits() {
        assert_eq!(PlanPreset::Pro.limits(), (500_000, 2_000_000, 10_000_000));
        assert_eq!(PlanPreset::MaxStandard.limits(), (2_000_000, 8_000_000, 40_000_000));
        assert_eq!(PlanPreset::MaxPlus.limits(), (4_000_000, 16_000_000, 80_000_000));
        assert_eq!(PlanPreset::Custom.limits(), (0, 0, 0));
    }

    #[test]
    fn test_window_metrics_cost() {
        let m = WindowMetrics {
            model_tokens: HashMap::from([
                ("claude-sonnet-4-6".to_string(), (1_000_000, 100_000)),
            ]),
            ..Default::default()
        };
        let cost = m.estimated_cost_usd();
        // 1M input * $3/M + 100K output * $15/M = $3 + $1.5 = $4.5
        assert!((cost - 4.5).abs() < 0.001);
    }

    #[test]
    fn test_enriched_session_state_icons() {
        let make = |state: &str| {
            let info = SessionInfo {
                id: "test".to_string(),
                workspace: "/tmp/test".to_string(),
                state: state.to_string(),
                last_activity: 0.0,
                started_at: 0.0,
                source: None,
            };
            EnrichedSession::from_info_and_metrics(info, SessionMetrics::default())
        };
        assert_eq!(make("working").state_icon, "\u{27F3}");
        assert_eq!(make("waiting").state_icon, "\u{23F8}");
        assert_eq!(make("error").state_icon, "\u{2717}");
        assert_eq!(make("done").state_display_name, "Done");
    }

    #[test]
    fn test_context_limit_by_model() {
        let info = SessionInfo {
            id: "t".to_string(),
            workspace: "/test".to_string(),
            state: "working".to_string(),
            last_activity: 0.0,
            started_at: 0.0,
            source: None,
        };
        let metrics_opus = SessionMetrics {
            model: "claude-opus-4-6".to_string(),
            last_input_tokens: 500_000,
            ..Default::default()
        };
        let es = EnrichedSession::from_info_and_metrics(info.clone(), metrics_opus);
        assert_eq!(es.context_limit, 1_000_000);
        assert!((es.context_usage_percent - 0.5).abs() < 0.001);

        let metrics_old = SessionMetrics {
            model: "claude-sonnet-3-5".to_string(),
            last_input_tokens: 100_000,
            ..Default::default()
        };
        let es2 = EnrichedSession::from_info_and_metrics(info, metrics_old);
        assert_eq!(es2.context_limit, 200_000);
    }

    #[test]
    fn test_usage_window_properties() {
        assert_eq!(UsageWindow::FiveHour.display_name(), "Session (5hr)");
        assert_eq!(UsageWindow::Daily.settings_key(), "dailyTokenLimit");
        assert_eq!(UsageWindow::Weekly.settings_key(), "weeklyTokenLimit");
    }

    #[test]
    fn test_permission_request_serialization() {
        let req = PermissionRequest {
            request_id: "req-123".to_string(),
            session_id: "sess-456".to_string(),
            tool_name: "Bash".to_string(),
            tool_input: serde_json::json!({"command": "npm install"}),
            hook_event_name: "PermissionRequest".to_string(),
            received_at: 1700000000.0,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("requestId"));
        assert!(json.contains("sessionId"));
        assert!(json.contains("hookEventName"));
        assert!(json.contains("receivedAt"));

        let parsed: PermissionRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.request_id, "req-123");
        assert_eq!(parsed.tool_name, "Bash");
    }

    #[test]
    fn test_permission_decision_variants() {
        assert_eq!(PermissionDecision::Allow, PermissionDecision::Allow);
        assert_eq!(PermissionDecision::Deny, PermissionDecision::Deny);
        assert_ne!(PermissionDecision::Allow, PermissionDecision::Deny);

        let json = serde_json::to_string(&PermissionDecision::Allow).unwrap();
        assert_eq!(json, "\"Allow\"");
        let json = serde_json::to_string(&PermissionDecision::Deny).unwrap();
        assert_eq!(json, "\"Deny\"");
    }

    #[test]
    fn test_permission_log_entry_serialization() {
        let entry = PermissionLogEntry {
            timestamp: 1700000000.0,
            session_id: "sess-789".to_string(),
            tool_name: "Read".to_string(),
            tool_input_summary: "Read: `src/main.rs`".to_string(),
            decision: "Allow".to_string(),
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("toolInputSummary"));
        assert!(json.contains("sessionId"));

        let parsed: PermissionLogEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.tool_name, "Read");
        assert_eq!(parsed.decision, "Allow");
    }
}
