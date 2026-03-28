//! Data models for Claude Cue — port of Models.swift.
//!
//! All structs use serde for JSON serialization to/from the React frontend.

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
    /// Number of currently active subagents (written by hook).
    #[serde(default)]
    pub active_subagents: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusData {
    pub sessions: HashMap<String, SessionInfo>,
}

// ---------------------------------------------------------------------------
// Supplemental data (git, config, rate limits, system info)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub content: String,
    /// One of: "pending", "in_progress", "completed"
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitInfo {
    pub five_hour_percent: f64,
    pub seven_day_percent: f64,
    pub five_hour_reset_at: Option<f64>,
    pub seven_day_reset_at: Option<f64>,
    pub limit_reached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub dirty: bool,
    pub ahead: i64,
    pub behind: i64,
    pub modified: i64,
    pub added: i64,
    pub deleted: i64,
    pub untracked: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConfigCounts {
    pub claude_md_count: i64,
    pub rules_count: i64,
    pub mcp_servers: i64,
    pub hooks_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemMemory {
    pub total_mb: u64,
    pub used_mb: u64,
    pub usage_percent: f64,
}

/// Supplemental data gathered outside of JSONL parsing (git, config, system info).
/// Built by session_monitor and passed to EnrichedSession construction.
#[derive(Debug, Clone, Default)]
pub struct SupplementalData {
    pub git_status: Option<GitStatus>,
    pub config_counts: Option<ConfigCounts>,
    pub rate_limits: Option<RateLimitInfo>,
    pub system_memory: SystemMemory,
    pub claude_version: Option<String>,
    /// Previous output_tokens for this session (for speed calculation)
    pub prev_output_tokens: i64,
    /// Timestamp of previous measurement
    pub prev_timestamp: f64,
}

// ---------------------------------------------------------------------------
// Session Metrics (parsed from JSONL conversation logs)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMetrics {
    pub agent_id: String,
    /// Human-readable description from .meta.json
    pub description: String,
    /// Random slug from JSONL entries (e.g., "refactored-sprouting-hellman")
    pub slug: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    pub model: String,
    pub tool_counts: HashMap<String, i64>,
    pub message_count: i64,
    /// True if the subagent's JSONL was modified recently (within 60s)
    #[serde(default)]
    pub is_active: bool,
}

impl SubagentMetrics {
    pub fn total_tokens(&self) -> i64 {
        self.input_tokens + self.output_tokens
    }

    pub fn total_tool_uses(&self) -> i64 {
        self.tool_counts.values().sum()
    }
}

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
    pub subagents: Vec<SubagentMetrics>,
    /// True if the last assistant message has a pending tool_use with no tool_result.
    /// Used to infer "waiting" state from the JSONL when the hook doesn't fire.
    #[serde(default)]
    pub pending_tool_use: bool,
    /// Name of the currently running tool (from last pending tool_use)
    #[serde(default)]
    pub running_tool_name: Option<String>,
    /// Target of the running tool (file path, command, pattern)
    #[serde(default)]
    pub running_tool_target: Option<String>,
    /// Todo/task items parsed from TodoWrite/TaskCreate tool uses
    #[serde(default)]
    pub todo_items: Vec<TodoItem>,
}

impl SessionMetrics {
    pub fn total_tokens(&self) -> i64 {
        self.input_tokens + self.output_tokens
            + self.subagents.iter().map(|s| s.total_tokens()).sum::<i64>()
    }

    pub fn total_tool_uses(&self) -> i64 {
        self.tool_counts.values().sum::<i64>()
            + self.subagents.iter().map(|s| s.total_tool_uses()).sum::<i64>()
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
    /// Whether this session has active or completed subagents
    pub has_subagents: bool,
    /// Git status for the workspace (dirty, ahead/behind, file stats)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_status: Option<GitStatus>,
    /// Claude config file counts for this workspace
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_counts: Option<ConfigCounts>,
    /// Rate limit information (from statusline bridge)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limits: Option<RateLimitInfo>,
    /// Provider: "Bedrock", "Vertex", "API", or "" (default Anthropic)
    pub provider: String,
    /// Output tokens per second (computed from delta between polls)
    pub output_tokens_per_sec: f64,
    /// Currently running tool name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running_tool_name: Option<String>,
    /// Target of the running tool (file path, command, pattern)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running_tool_target: Option<String>,
    /// Todo items from the session
    pub todo_items: Vec<TodoItem>,
    /// Number of completed todo items
    pub todo_completed: i64,
    /// Total number of todo items
    pub todo_total: i64,
    /// Content of the current in-progress todo item (truncated)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub todo_current: Option<String>,
    /// System memory information
    pub system_memory: SystemMemory,
    /// Claude Code version string
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_version: Option<String>,
}

impl EnrichedSession {
    pub fn from_info_and_metrics(info: SessionInfo, metrics: SessionMetrics, supplemental: &SupplementalData) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();

        // Stale "working" detection: if a session claims working/subagent but
        // lastActivity is older than 90s, the hook stopped firing (session ended
        // without a Stop event). Downgrade to "idle" so the UI doesn't show
        // animated working state for dead sessions.
        // Exception: sessions with active subagents — the parent is legitimately
        // idle while waiting for long-running subagents to complete.
        let mut info = info;
        if (info.state == "working" || info.state == "subagent")
            && (now - info.last_activity) > 90.0
            && info.active_subagents <= 0
        {
            info.state = "idle".to_string();
        }

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
            if m.contains("4-6") || m.contains("4.6") || m.contains("4-5") || m.contains("4.5") || m == "<synthetic>" {
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
        let has_subagents = !metrics.subagents.is_empty();

        let provider = detect_provider(&effective_model);

        // Output speed: tokens/sec from delta between polls
        let output_tokens_per_sec = if supplemental.prev_output_tokens > 0
            && supplemental.prev_timestamp > 0.0
        {
            let delta_tokens = metrics.output_tokens - supplemental.prev_output_tokens;
            let delta_secs = now - supplemental.prev_timestamp;
            if delta_secs > 0.0 && delta_tokens > 0 {
                delta_tokens as f64 / delta_secs
            } else {
                0.0
            }
        } else {
            0.0
        };

        // Todo aggregation
        let todo_completed = metrics
            .todo_items
            .iter()
            .filter(|t| t.status == "completed" || t.status == "done" || t.status == "complete")
            .count() as i64;
        let todo_total = metrics.todo_items.len() as i64;
        let todo_current = metrics
            .todo_items
            .iter()
            .find(|t| t.status == "in_progress" || t.status == "running")
            .map(|t| truncate_string(&t.content, 60));

        Self {
            info,
            running_tool_name: metrics.running_tool_name.clone(),
            running_tool_target: metrics.running_tool_target.clone(),
            todo_items: metrics.todo_items.clone(),
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
            has_subagents,
            git_status: supplemental.git_status.clone(),
            config_counts: supplemental.config_counts.clone(),
            rate_limits: supplemental.rate_limits.clone(),
            provider,
            output_tokens_per_sec,
            todo_completed,
            todo_total,
            todo_current,
            system_memory: supplemental.system_memory.clone(),
            claude_version: supplemental.claude_version.clone(),
        }
    }
}

fn detect_provider(model: &str) -> String {
    let m = model.to_lowercase();
    if m.starts_with("bedrock-") || m.contains("bedrock") {
        return "Bedrock".to_string();
    }
    if m.starts_with("vertex-") || m.contains("vertex") {
        return "Vertex".to_string();
    }
    // Note: we don't check ANTHROPIC_API_KEY because the Tauri app's env
    // may differ from the Claude CLI's env, leading to false positives.
    String::new()
}

fn truncate_string(s: &str, max_len: usize) -> String {
    crate::summary_formatter::truncate(s, max_len)
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
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Legacy fields — kept for backwards compatibility with existing settings.json.
    /// No longer exposed in the UI.
    #[serde(default)]
    pub five_hour_token_limit: i64,
    #[serde(default)]
    pub daily_token_limit: i64,
    #[serde(default)]
    pub weekly_token_limit: i64,
    #[serde(default)]
    pub plan_preset: String,
    #[serde(default)]
    pub onboarding_complete: bool,
    #[serde(default)]
    pub permissions_enabled: bool,
    /// Theme preference: "light", "dark", or "auto" (follows system)
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_title_animation")]
    pub title_animation: String,
    /// Animation speed in seconds (e.g. 0.6 = fast, 1.2 = normal, 2.4 = slow)
    #[serde(default = "default_animation_speed")]
    pub animation_speed: f64,
    /// Randomize per-character animation delay instead of uniform wave
    #[serde(default)]
    pub random_animation: bool,
    /// Show animated signal string separator in session cards
    #[serde(default = "default_true")]
    pub signal_string: bool,
    /// Signal string frequency multiplier (0.3 = slow, 1.0 = normal, 3.0 = fast)
    #[serde(default = "default_signal_frequency")]
    pub signal_frequency: f64,
    /// Signal string mode: "simulated" (piano strikes) or "audio" (uploaded audio file)
    #[serde(default = "default_signal_mode")]
    pub signal_mode: String,
    /// Signal string alpha/opacity multiplier (0.0 = invisible, 1.0 = full)
    #[serde(default = "default_signal_alpha")]
    pub signal_alpha: f64,
    /// Signal string amplitude/gain multiplier (0.1 = subtle, 1.0 = normal, 3.0 = intense)
    #[serde(default = "default_one")]
    pub signal_amplitude: f64,
    /// Signal string echo/trail intensity (0.0 = no trails, 1.0 = full trails)
    #[serde(default = "default_one")]
    pub signal_echo: f64,
    /// Noise gate threshold (0.0 = no gate, values below are zeroed)
    #[serde(default = "default_gate")]
    pub signal_gate: f64,
    /// Which frequency bands are enabled (bass, mids, treble)
    #[serde(default = "default_true")]
    pub signal_bass: bool,
    #[serde(default = "default_true")]
    pub signal_mids: bool,
    #[serde(default = "default_true")]
    pub signal_treble: bool,
    /// UUID of the active signal preset
    #[serde(default)]
    pub active_preset_id: String,
    /// Signal string color for dark mode (hex, e.g. "#ffffff")
    #[serde(default = "default_signal_color_dark")]
    pub signal_color_dark: String,
    /// Signal string color for light mode (hex, e.g. "#000000")
    #[serde(default = "default_signal_color_light")]
    pub signal_color_light: String,
    /// Active signal theme ID (e.g. "default", "neon", "ember")
    #[serde(default)]
    pub active_theme_id: String,
    /// Audio offset: randomizes position/speed per session (0 = sync, 1 = full random)
    #[serde(default = "default_signal_offset")]
    pub signal_offset: f64,
    /// Whether pulse particles are enabled
    #[serde(default = "default_true")]
    pub particle_enabled: bool,
    /// Particle speed multiplier (1.0 = default 150-350 px/s)
    #[serde(default = "default_one")]
    pub particle_speed: f64,
    /// Particle spawn rate multiplier (1.0 = default ~2/sec/band)
    #[serde(default = "default_one")]
    pub particle_rate: f64,
    /// Number of spark trails per particle (0-6)
    #[serde(default = "default_sparks")]
    pub particle_sparks: f64,
    /// Particle opacity (independent of string opacity)
    #[serde(default = "default_one")]
    pub particle_alpha: f64,
    /// Piano key press-down speed in seconds
    #[serde(default = "default_key_press_speed")]
    pub key_press_speed: f64,
    /// Piano key release speed in seconds
    #[serde(default = "default_key_release_speed")]
    pub key_release_speed: f64,
    /// Auto-reorder sessions by state priority (working first)
    #[serde(default)]
    pub auto_reorder: bool,
    /// Global font size scale (1.0 = default, 1.25 = larger)
    #[serde(default = "default_font_scale")]
    pub font_scale: f64,
    /// Test mode: adds a synthetic session for previewing animations
    #[serde(default)]
    pub test_mode: bool,
    /// Show animated vine border on working/subagent session cards
    #[serde(default)]
    pub vine_border: bool,
    /// Compact mode: strip cards to title, status, and animation only
    #[serde(default)]
    pub compact_mode: bool,
    /// Slim mode: hide metrics and tool chips, keep title, timer, context bar, and animations
    #[serde(default = "default_true")]
    pub slim_mode: bool,
    /// Only show context bar when usage >= 200k tokens
    #[serde(default)]
    pub context_threshold: bool,
    /// Context display mode: "percent", "tokens", "remaining", or "both"
    #[serde(default = "default_context_display")]
    pub context_display: String,
    /// Low power mode: disables animations, signal strings, particles, backdrop-filter
    #[serde(default)]
    pub low_power: bool,
}

fn default_theme() -> String {
    "auto".to_string()
}

fn default_title_animation() -> String {
    "none".to_string()
}

fn default_animation_speed() -> f64 {
    1.2
}

fn default_signal_frequency() -> f64 {
    1.0
}

fn default_signal_mode() -> String {
    "preset".to_string()
}

fn default_true() -> bool {
    true
}

fn default_signal_alpha() -> f64 {
    0.25
}

fn default_one() -> f64 {
    1.0
}

fn default_signal_color_dark() -> String {
    "#ffffff".to_string()
}

fn default_signal_color_light() -> String {
    "#000000".to_string()
}

fn default_signal_offset() -> f64 {
    0.5
}

fn default_sparks() -> f64 {
    3.0
}

fn default_key_press_speed() -> f64 {
    0.35
}

fn default_key_release_speed() -> f64 {
    0.4
}

fn default_gate() -> f64 {
    0.05
}

fn default_font_scale() -> f64 {
    1.0
}

fn default_context_display() -> String {
    "percent".to_string()
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
            theme: "auto".to_string(),
            title_animation: "none".to_string(),
            animation_speed: 1.2,
            random_animation: false,
            signal_string: true,
            signal_frequency: 1.0,
            signal_mode: "preset".to_string(),
            signal_alpha: 0.25,
            signal_amplitude: 0.25,
            signal_echo: 1.0,
            signal_gate: 0.05,
            signal_bass: true,
            signal_mids: true,
            signal_treble: true,
            active_preset_id: String::new(),
            signal_color_dark: "#ffffff".to_string(),
            signal_color_light: "#000000".to_string(),
            active_theme_id: String::new(),
            signal_offset: 0.5,
            particle_enabled: true,
            particle_speed: 1.0,
            particle_rate: 1.0,
            particle_sparks: 3.0,
            particle_alpha: 1.0,
            key_press_speed: 0.35,
            key_release_speed: 0.4,
            auto_reorder: false,
            font_scale: 1.0,
            test_mode: false,
            vine_border: false,
            compact_mode: false,
            slim_mode: true,
            context_threshold: false,
            context_display: "percent".to_string(),
            low_power: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Signal Presets (extracted frequency envelopes)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetBands {
    pub bass: Vec<f64>,
    pub mids: Vec<f64>,
    pub treble: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalPreset {
    pub id: String,
    pub name: String,
    pub created_at: f64,
    pub duration_secs: f64,
    pub sample_rate: u32,
    pub bands: PresetBands,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetSummary {
    pub id: String,
    pub name: String,
    pub created_at: f64,
    pub duration_secs: f64,
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

    fn make_test_info(id: &str, workspace: &str, state: &str) -> SessionInfo {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        SessionInfo {
            id: id.to_string(),
            workspace: workspace.to_string(),
            state: state.to_string(),
            last_activity: now,
            started_at: now - 60.0,
            source: None,
            hook_input_tokens: 0,
            hook_output_tokens: 0,
            hook_model: String::new(),
            active_subagents: 0,
        }
    }

    #[test]
    fn test_enriched_session_state_icons() {
        let make = |state: &str| {
            let info = make_test_info("test", "/tmp/test", state);
            EnrichedSession::from_info_and_metrics(info, SessionMetrics::default(), &SupplementalData::default())
        };
        assert_eq!(make("working").state_icon, "\u{27F3}");
        assert_eq!(make("waiting").state_icon, "\u{23F8}");
        assert_eq!(make("error").state_icon, "\u{2717}");
        assert_eq!(make("done").state_display_name, "Done");
    }

    #[test]
    fn test_stale_working_downgrades_to_idle() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();

        // Fresh working session (10s ago) — stays working
        let mut info = make_test_info("s1", "/tmp", "working");
        info.last_activity = now - 10.0;
        let es = EnrichedSession::from_info_and_metrics(info, SessionMetrics::default(), &SupplementalData::default());
        assert_eq!(es.info.state, "working");

        // Stale working session (120s ago) — downgraded to idle
        let mut info = make_test_info("s2", "/tmp", "working");
        info.last_activity = now - 120.0;
        let es = EnrichedSession::from_info_and_metrics(info, SessionMetrics::default(), &SupplementalData::default());
        assert_eq!(es.info.state, "idle");

        // Stale subagent (100s ago) — downgraded to idle
        let mut info = make_test_info("s3", "/tmp", "subagent");
        info.last_activity = now - 100.0;
        let es = EnrichedSession::from_info_and_metrics(info, SessionMetrics::default(), &SupplementalData::default());
        assert_eq!(es.info.state, "idle");

        // Idle session stays idle regardless of age
        let mut info = make_test_info("s4", "/tmp", "idle");
        info.last_activity = now - 500.0;
        let es = EnrichedSession::from_info_and_metrics(info, SessionMetrics::default(), &SupplementalData::default());
        assert_eq!(es.info.state, "idle");

        // Done session stays done regardless of age
        let mut info = make_test_info("s5", "/tmp", "done");
        info.last_activity = now - 500.0;
        let es = EnrichedSession::from_info_and_metrics(info, SessionMetrics::default(), &SupplementalData::default());
        assert_eq!(es.info.state, "done");
    }

    #[test]
    fn test_context_limit_by_model() {
        let info = make_test_info("t", "/test", "working");
        let metrics_opus = SessionMetrics {
            model: "claude-opus-4-6".to_string(),
            last_input_tokens: 500_000,
            ..Default::default()
        };
        let es = EnrichedSession::from_info_and_metrics(info.clone(), metrics_opus, &SupplementalData::default());
        assert_eq!(es.context_limit, 1_000_000);
        assert!((es.context_usage_percent - 0.5).abs() < 0.001);

        let metrics_synthetic = SessionMetrics {
            model: "<synthetic>".to_string(),
            last_input_tokens: 500_000,
            ..Default::default()
        };
        let es_syn = EnrichedSession::from_info_and_metrics(info.clone(), metrics_synthetic, &SupplementalData::default());
        assert_eq!(es_syn.context_limit, 1_000_000);

        let metrics_old = SessionMetrics {
            model: "claude-sonnet-3-5".to_string(),
            last_input_tokens: 100_000,
            ..Default::default()
        };
        let es2 = EnrichedSession::from_info_and_metrics(info, metrics_old, &SupplementalData::default());
        assert_eq!(es2.context_limit, 200_000);
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

    #[test]
    fn test_detect_provider() {
        assert_eq!(detect_provider("bedrock-claude-sonnet-4-6"), "Bedrock");
        assert_eq!(detect_provider("vertex-claude-opus-4-6"), "Vertex");
        assert_eq!(detect_provider("claude-sonnet-4-6"), "");
        assert_eq!(detect_provider("claude-opus-4-6"), "");
        assert_eq!(detect_provider(""), "");
    }

    #[test]
    fn test_todo_aggregation_in_enriched_session() {
        let info = make_test_info("t", "/test", "working");
        let metrics = SessionMetrics {
            todo_items: vec![
                TodoItem { content: "Task A".to_string(), status: "completed".to_string() },
                TodoItem { content: "Task B".to_string(), status: "in_progress".to_string() },
                TodoItem { content: "Task C".to_string(), status: "pending".to_string() },
            ],
            ..Default::default()
        };
        let es = EnrichedSession::from_info_and_metrics(info, metrics, &SupplementalData::default());
        assert_eq!(es.todo_total, 3);
        assert_eq!(es.todo_completed, 1);
        assert_eq!(es.todo_current.as_deref(), Some("Task B"));
    }

    #[test]
    fn test_supplemental_data_populates_enriched_session() {
        let info = make_test_info("t", "/test", "working");
        let supplemental = SupplementalData {
            git_status: Some(GitStatus { dirty: true, ahead: 2, behind: 1, ..Default::default() }),
            claude_version: Some("CC v2.1.6".to_string()),
            ..Default::default()
        };
        let es = EnrichedSession::from_info_and_metrics(info, SessionMetrics::default(), &supplemental);
        assert!(es.git_status.is_some());
        assert!(es.git_status.as_ref().unwrap().dirty);
        assert_eq!(es.git_status.as_ref().unwrap().ahead, 2);
        assert_eq!(es.claude_version.as_deref(), Some("CC v2.1.6"));
    }
}
