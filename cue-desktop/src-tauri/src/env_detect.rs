//! Environment detection and hook configuration.
//!
//! Detects platform capabilities and configures Claude Code hooks.
//! No network calls or subprocess invocations — uses filesystem and
//! environment variable inspection only.

use crate::security;
use serde::Serialize;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Environment Info
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInfo {
    pub platform: String,
    pub desktop_env: Option<String>,
    pub wayland: bool,
    pub has_appindicator: bool,
    pub wsl_distros: Vec<String>,
    pub claude_code_found: bool,
    pub claude_settings_exists: bool,
}

/// Detect the current platform environment.
pub fn detect_environment() -> EnvironmentInfo {
    let platform = detect_platform();
    let desktop_env = detect_desktop_env();
    let wayland = detect_wayland();
    let has_appindicator = detect_appindicator(&desktop_env);
    let wsl_distros = detect_wsl_distros();

    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let claude_dir = home.join(".claude");
    let claude_settings = claude_dir.join("settings.json");

    EnvironmentInfo {
        platform,
        desktop_env,
        wayland,
        has_appindicator,
        wsl_distros,
        claude_code_found: claude_dir.exists(),
        claude_settings_exists: claude_settings.exists(),
    }
}

fn detect_platform() -> String {
    if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "windows") {
        "windows".to_string()
    } else {
        "linux".to_string()
    }
}

fn detect_desktop_env() -> Option<String> {
    // XDG_CURRENT_DESKTOP is the standard on Linux desktop environments
    if let Ok(desktop) = std::env::var("XDG_CURRENT_DESKTOP") {
        if !desktop.is_empty() {
            return Some(desktop);
        }
    }
    // Fallback to DESKTOP_SESSION (older convention)
    if let Ok(session) = std::env::var("DESKTOP_SESSION") {
        if !session.is_empty() {
            return Some(session);
        }
    }
    None
}

fn detect_wayland() -> bool {
    std::env::var("WAYLAND_DISPLAY")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

fn detect_appindicator(desktop_env: &Option<String>) -> bool {
    // Only relevant on Linux with GNOME — other desktops have native tray support
    if cfg!(not(target_os = "linux")) {
        return true; // Not applicable on macOS/Windows, report as available
    }

    let is_gnome = desktop_env
        .as_ref()
        .map(|d| d.to_uppercase().contains("GNOME"))
        .unwrap_or(false);

    if !is_gnome {
        return true; // KDE, XFCE, etc. have native tray support
    }

    // Check user-local extension directory
    if let Some(home) = dirs::home_dir() {
        let ext_dir =
            home.join(".local/share/gnome-shell/extensions/appindicatorsupport@rgcjonas.gmail.com");
        if ext_dir.exists() {
            return true;
        }
    }

    // Check system-wide extension path
    let system_ext = std::path::Path::new(
        "/usr/share/gnome-shell/extensions/appindicatorsupport@rgcjonas.gmail.com",
    );
    if system_ext.exists() {
        return true;
    }

    false
}

fn detect_wsl_distros() -> Vec<String> {
    // On Windows, detect WSL distros by reading the WSL filesystem mounts
    if cfg!(target_os = "windows") {
        let wsl_path = PathBuf::from(r"\\wsl$");
        if let Ok(entries) = std::fs::read_dir(&wsl_path) {
            let distros: Vec<String> = entries
                .filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .collect();
            if !distros.is_empty() {
                return distros;
            }
        }

        // Fallback: newer WSL uses \\wsl.localhost
        let wsl_localhost = PathBuf::from(r"\\wsl.localhost");
        if let Ok(entries) = std::fs::read_dir(&wsl_localhost) {
            return entries
                .filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .collect();
        }
    }

    // On Linux, detect if running inside WSL
    if cfg!(target_os = "linux") {
        if let Ok(release) = std::fs::read_to_string("/proc/version") {
            if release.to_lowercase().contains("microsoft") {
                // Running inside WSL — report own distro name
                if let Ok(name) = std::env::var("WSL_DISTRO_NAME") {
                    return vec![name];
                }
                return vec!["WSL (unknown distro)".to_string()];
            }
        }
    }

    Vec::new()
}

// ---------------------------------------------------------------------------
// Hook Configuration
// ---------------------------------------------------------------------------

/// Hook events and their corresponding cue-hook state arguments.
///
/// Covers all Claude Code lifecycle events from
/// https://code.claude.com/docs/en/hooks. The hook's main() does final
/// per-event filtering (e.g. Notification subtype dispatch), so the value
/// here is the *default* action; the hook may early-return when a subtype
/// shouldn't change state. Must stay aligned with the manual instructions
/// in OnboardingWizard.tsx.
pub const HOOK_EVENTS: &[(&str, &str)] = &[
    ("SessionStart", "idle"),
    ("PreToolUse", "working"),
    ("PostToolUse", "working"),
    ("UserPromptSubmit", "thinking"),
    ("PermissionRequest", "waiting"),
    ("PostToolUseFailure", "error"),
    ("SubagentStart", "subagent"),
    ("SubagentStop", "subagent_stop"),
    ("Stop", "idle"),
    ("StopFailure", "error"),
    ("TaskCompleted", "done"),
    ("Notification", "waiting"),
    ("PreCompact", "compacting"),
    ("PostCompact", "working"),
    ("SessionEnd", "remove"),
];

/// Shell metacharacters that must not appear in hook paths.
const SHELL_METACHARACTERS: &[char] = &[
    ';', '|', '&', '`', '(', ')', '>', '<', '\n', '\r', '\'', '"',
];

/// Verify a resolved hook-path string contains no shell metacharacters before
/// it is interpolated into a hook command serialized to settings.json. Paths
/// flow through dirs::home_dir() which is ultimately user-controlled via $HOME
/// or %USERPROFILE%, so this is defense-in-depth against an exotic home dir
/// that breaks the JSON command string at execution time.
fn assert_safe_for_command(path: &str, label: &str) -> Result<(), String> {
    if path.chars().any(|c| SHELL_METACHARACTERS.contains(&c)) {
        return Err(format!("{} path contains invalid characters", label));
    }
    Ok(())
}

/// Resolve and validate a hook path. Rejects shell metacharacters and
/// expands `~` or `$HOME`-style references to the actual home directory.
fn resolve_hook_path(raw: &str) -> Result<PathBuf, String> {
    // Reject shell metacharacters
    if raw.chars().any(|c| SHELL_METACHARACTERS.contains(&c)) {
        return Err("Hook path contains invalid characters".to_string());
    }

    // Reject $ unless it's $HOME at the start (which we expand below)
    if raw.contains('$')
        && !raw.starts_with("$HOME/")
        && !raw.starts_with("$HOME\\")
        && raw != "$HOME"
    {
        return Err("Hook path contains invalid characters".to_string());
    }

    // Reject path traversal
    if raw.contains("..") {
        return Err("Hook path contains path traversal".to_string());
    }

    // Reject empty path
    if raw.trim().is_empty() {
        return Err("Hook path is empty".to_string());
    }

    // Expand ~ and $HOME to actual home directory
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let expanded = if let Some(rest) = raw.strip_prefix("~/") {
        home.join(rest)
    } else if raw == "~" {
        home.clone()
    } else if let Some(rest) = raw
        .strip_prefix("$HOME/")
        .or_else(|| raw.strip_prefix("$HOME\\"))
    {
        home.join(rest)
    } else if let Some(rest) = raw.strip_prefix("%USERPROFILE%") {
        home.join(rest.trim_start_matches(['/', '\\']))
    } else {
        PathBuf::from(raw)
    };

    // Require absolute path after expansion
    if !expanded.is_absolute() {
        return Err("Hook path must be an absolute path".to_string());
    }

    Ok(expanded)
}

/// Configure Claude Code hooks in `~/.claude/settings.json`.
///
/// Reads the existing settings, backs up the original to `settings.json.bak`,
/// and adds/updates hook entries for Claude Code lifecycle events.
/// Uses `security::atomic_write()` for safe file writes.
pub fn configure_hooks(hook_path: &str) -> Result<(), String> {
    // Security: validate hook_path to prevent command injection
    let resolved = resolve_hook_path(hook_path)?;
    let hook_path = resolved.to_string_lossy().to_string();

    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let settings_path = home.join(".claude/settings.json");

    // Read existing settings or start with empty object
    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = std::fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse settings: {}", e))?
    } else {
        serde_json::json!({})
    };

    // Backup existing settings before modification. Write through atomic_write
    // so the backup lands at 0600 (fs::copy would inherit source perms or apply
    // umask, potentially exposing the hook config to other local users on a
    // shared system).
    if settings_path.exists() {
        let backup_path = settings_path.with_extension("json.bak");
        let backup_bytes = std::fs::read(&settings_path)
            .map_err(|e| format!("Failed to read settings for backup: {}", e))?;
        security::atomic_write(&backup_path, &backup_bytes)
            .map_err(|e| format!("Failed to backup settings: {}", e))?;
    }

    // Ensure "hooks" key exists as an object
    if !settings.get("hooks").is_some_and(|h| h.is_object()) {
        settings["hooks"] = serde_json::json!({});
    }

    let hooks = settings["hooks"].as_object_mut().unwrap();

    for (event, state) in HOOK_EVENTS {
        let new_entry = serde_json::json!({
            "matcher": "",
            "hooks": [{
                "type": "command",
                "command": format!("{} {}", hook_path, state)
            }]
        });

        // Get or create the event's hook array
        if !hooks.contains_key(*event) {
            hooks.insert(event.to_string(), serde_json::json!([]));
        }

        let event_hooks = hooks.get_mut(*event).unwrap();

        // Check if a hook from this path already exists (update rather than duplicate)
        let existing_idx = event_hooks.as_array().and_then(|arr| {
            arr.iter().position(|entry| {
                entry
                    .get("hooks")
                    .and_then(|h| h.as_array())
                    .map(|hooks_arr| {
                        hooks_arr.iter().any(|h| {
                            h.get("command")
                                .and_then(|c| c.as_str())
                                .map(|c| c.starts_with(hook_path.as_str()))
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false)
            })
        });

        if let Some(idx) = existing_idx {
            // Update existing entry in place
            if let Some(arr) = event_hooks.as_array_mut() {
                arr[idx] = new_entry;
            }
        } else {
            // Append new entry
            if let Some(arr) = event_hooks.as_array_mut() {
                arr.push(new_entry);
            }
        }
    }

    // Serialize and write atomically
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    // Ensure the .claude directory exists
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    security::atomic_write(&settings_path, content.as_bytes())
        .map_err(|e| format!("Failed to write settings: {}", e))?;

    Ok(())
}

/// Install cue hooks into `~/.claude/settings.json`.
///
/// Finds the cue-hook script and hook-runner, then adds entries for all
/// lifecycle events using the hook-runner wrapper pattern with 5s timeouts.
/// Idempotent — safe to call repeatedly.
pub fn install_hooks() -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let settings_path = home.join(".claude/settings.json");

    // Find the cue-hook script
    let hook_candidates = [
        home.join(".claude/symphony-root/cue/hooks/cue-hook"),
        home.join(".claude/hooks/cue-hook"),
    ];
    let hook_path = hook_candidates
        .iter()
        .find(|p| p.exists())
        .ok_or("cue-hook script not found")?;

    // Find hook-runner.sh
    let runner = home.join(".claude/hooks/hook-runner.sh");
    if !runner.exists() {
        return Err("hook-runner.sh not found".to_string());
    }

    let runner_str = runner.to_string_lossy();
    let hook_str = hook_path.to_string_lossy();

    // Defense-in-depth: paths derived from $HOME/%USERPROFILE% should not
    // contain shell metacharacters, but if they do we'd be writing a broken
    // (or worse) command string into Claude Code's settings.json.
    assert_safe_for_command(&runner_str, "hook-runner")?;
    assert_safe_for_command(&hook_str, "cue-hook")?;

    // Read existing settings
    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = std::fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse settings: {}", e))?
    } else {
        serde_json::json!({})
    };

    if !settings.get("hooks").is_some_and(|h| h.is_object()) {
        settings["hooks"] = serde_json::json!({});
    }
    let hooks = settings["hooks"].as_object_mut().unwrap();

    for (event, state) in HOOK_EVENTS {
        let command = format!("{} cue-hook {} {}", runner_str, hook_str, state);
        let new_entry = serde_json::json!({
            "hooks": [{
                "type": "command",
                "command": command,
                "timeout": 5000
            }]
        });

        if !hooks.contains_key(*event) {
            hooks.insert(event.to_string(), serde_json::json!([]));
        }

        let event_hooks = hooks.get_mut(*event).unwrap();
        let arr = event_hooks
            .as_array_mut()
            .ok_or("hooks entry is not an array")?;

        // Remove any existing cue-hook entries first (clean reinstall)
        arr.retain(|entry| !entry_contains_cue_hook(entry));

        // Insert cue-hook as the first entry so state updates happen before
        // slower hooks (retenir, symphony-audit, etc.)
        arr.insert(0, new_entry);
    }

    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    security::atomic_write(&settings_path, content.as_bytes())
        .map_err(|e| format!("Failed to write settings: {}", e))?;

    // Remove .disabled file if present
    let disabled = home.join(".claude/hooks/cue-hook.disabled");
    let _ = std::fs::remove_file(disabled);

    Ok(())
}

/// Remove all cue hooks from `~/.claude/settings.json`.
///
/// Strips every hook entry containing "cue-hook" from all events.
/// Also clears sessions.json so the dashboard shows a clean state.
pub fn uninstall_hooks() -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let settings_path = home.join(".claude/settings.json");

    if !settings_path.exists() {
        return Ok(()); // Nothing to uninstall
    }

    let content = std::fs::read_to_string(&settings_path)
        .map_err(|e| format!("Failed to read settings: {}", e))?;
    let mut settings: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse settings: {}", e))?;

    if let Some(hooks) = settings.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for (_event, entries) in hooks.iter_mut() {
            if let Some(arr) = entries.as_array_mut() {
                arr.retain(|entry| !entry_contains_cue_hook(entry));
            }
        }
    }

    let out = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    security::atomic_write(&settings_path, out.as_bytes())
        .map_err(|e| format!("Failed to write settings: {}", e))?;

    // Clear sessions.json
    let sessions_path = crate::paths::sessions_json_path();
    if sessions_path.exists() {
        security::atomic_write(&sessions_path, b"{\"sessions\":{}}")
            .map_err(|e| format!("Failed to clear sessions: {}", e))?;
    }

    Ok(())
}

/// Check if a hook entry contains a cue-hook command.
fn entry_contains_cue_hook(entry: &serde_json::Value) -> bool {
    entry
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|arr| {
            arr.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains("cue-hook"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_platform() {
        let platform = detect_platform();
        assert!(
            platform == "macos" || platform == "linux" || platform == "windows",
            "Unexpected platform: {}",
            platform
        );
    }

    #[test]
    fn test_detect_environment_returns_valid_struct() {
        let env = detect_environment();
        assert!(!env.platform.is_empty());
        // These depend on the actual system — just verify no panic
        let _ = env.claude_code_found;
        let _ = env.claude_settings_exists;
    }

    #[test]
    fn test_detect_wayland_no_panic() {
        // Should not panic regardless of env state
        let _ = detect_wayland();
    }

    #[test]
    fn test_detect_wsl_distros_no_panic() {
        let _ = detect_wsl_distros();
    }

    #[test]
    fn test_environment_info_serialization() {
        let info = EnvironmentInfo {
            platform: "linux".to_string(),
            desktop_env: Some("GNOME".to_string()),
            wayland: true,
            has_appindicator: false,
            wsl_distros: vec![],
            claude_code_found: true,
            claude_settings_exists: false,
        };

        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"platform\":\"linux\""));
        assert!(json.contains("\"desktopEnv\":\"GNOME\""));
        assert!(json.contains("\"wayland\":true"));
        assert!(json.contains("\"hasAppindicator\":false"));
        assert!(json.contains("\"claudeCodeFound\":true"));
        assert!(json.contains("\"claudeSettingsExists\":false"));
    }

    #[test]
    fn test_environment_info_serialization_none_desktop() {
        let info = EnvironmentInfo {
            platform: "macos".to_string(),
            desktop_env: None,
            wayland: false,
            has_appindicator: true,
            wsl_distros: vec![],
            claude_code_found: false,
            claude_settings_exists: false,
        };

        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"desktopEnv\":null"));
        assert!(json.contains("\"wayland\":false"));
    }

    #[test]
    fn test_detect_appindicator_non_gnome() {
        // Non-GNOME desktops should report appindicator as available
        let non_gnome = Some("KDE".to_string());
        let result = detect_appindicator(&non_gnome);
        if cfg!(target_os = "linux") {
            assert!(result);
        }
    }

    #[test]
    fn test_detect_appindicator_no_desktop() {
        let none: Option<String> = None;
        let result = detect_appindicator(&none);
        if cfg!(target_os = "linux") {
            // No desktop env means not GNOME, so returns true
            assert!(result);
        }
    }

    #[test]
    fn test_hook_events_count() {
        assert_eq!(HOOK_EVENTS.len(), 15);
    }

    #[test]
    fn test_hook_events_mappings() {
        // Verify the state mappings match OnboardingWizard manual instructions
        let events: std::collections::HashMap<&str, &str> = HOOK_EVENTS.iter().copied().collect();
        assert_eq!(events["SessionStart"], "idle");
        assert_eq!(events["PreToolUse"], "working");
        assert_eq!(events["PostToolUse"], "working");
        assert_eq!(events["UserPromptSubmit"], "thinking");
        assert_eq!(events["PermissionRequest"], "waiting");
        assert_eq!(events["PostToolUseFailure"], "error");
        assert_eq!(events["SubagentStart"], "subagent");
        assert_eq!(events["SubagentStop"], "subagent_stop");
        assert_eq!(events["Stop"], "idle");
        assert_eq!(events["StopFailure"], "error");
        assert_eq!(events["TaskCompleted"], "done");
        // Notification carries six subtypes; three are user-attention prompts
        // (permission_prompt, idle_prompt, elicitation_dialog) and three are
        // informational (auth_success, elicitation_complete, elicitation_response).
        // The hook treats "waiting" as the default for the prompt subtypes and
        // returns without writing for the informational ones — see
        // hooks/cue-hook for the dispatch.
        assert_eq!(events["Notification"], "waiting");
        assert_eq!(events["PreCompact"], "compacting");
        // PostCompact resolves the compacting state when the resolving event
        // arrives; absent it, the Rust side's 60s stuck-active cap demotes.
        assert_eq!(events["PostCompact"], "working");
        assert_eq!(events["SessionEnd"], "remove");
    }

    #[test]
    fn test_hook_events_actions_in_valid_set() {
        // Every state argument we install must be in the hook's valid_actions
        // set. If this fails, the hook silently no-ops every event that maps
        // to the missing action.
        let valid_actions: std::collections::HashSet<&str> = [
            "idle", "working", "thinking", "waiting", "done",
            "remove", "error", "subagent", "subagent_stop", "compacting",
        ].iter().copied().collect();
        for (event, action) in HOOK_EVENTS {
            assert!(
                valid_actions.contains(*action),
                "HOOK_EVENTS row ({event}, {action}) has an action the hook would silently drop",
            );
        }
    }

    #[test]
    fn test_configure_hooks_json_structure() {
        // Test the JSON manipulation logic without touching the real filesystem
        let mut settings: serde_json::Value = serde_json::json!({});
        settings["hooks"] = serde_json::json!({});

        let hook_path = "/usr/local/bin/cue-hook";
        let hooks = settings["hooks"].as_object_mut().unwrap();

        for (event, state) in HOOK_EVENTS {
            let entry = serde_json::json!({
                "matcher": "",
                "hooks": [{
                    "type": "command",
                    "command": format!("{} {}", hook_path, state)
                }]
            });
            hooks.insert(event.to_string(), serde_json::json!([entry]));
        }

        // Verify all events were configured
        let hooks_obj = settings["hooks"].as_object().unwrap();
        assert_eq!(hooks_obj.len(), HOOK_EVENTS.len());

        // Verify key event commands
        let check = |event: &str, expected_state: &str| {
            let hook = &hooks_obj[event];
            let cmd = hook[0]["hooks"][0]["command"].as_str().unwrap();
            assert_eq!(cmd, format!("/usr/local/bin/cue-hook {}", expected_state));
        };
        check("SessionStart", "idle");
        check("PreToolUse", "working");
        check("PostToolUse", "working");
        check("PermissionRequest", "waiting");
        check("Stop", "idle");
        check("SessionEnd", "remove");
    }

    #[test]
    fn test_configure_hooks_preserves_existing_settings() {
        // Verify that hook configuration preserves other settings keys
        let mut settings: serde_json::Value = serde_json::json!({
            "apiKey": "sk-test",
            "model": "claude-sonnet-4-6",
            "hooks": {}
        });

        let hook_path = "/path/to/cue-hook";
        let hooks = settings["hooks"].as_object_mut().unwrap();

        let entry = serde_json::json!({
            "matcher": "",
            "hooks": [{"type": "command", "command": format!("{} working", hook_path)}]
        });
        hooks.insert("PreToolUse".to_string(), serde_json::json!([entry]));

        // Original keys should still be present
        assert_eq!(settings["apiKey"].as_str().unwrap(), "sk-test");
        assert_eq!(settings["model"].as_str().unwrap(), "claude-sonnet-4-6");
        assert!(settings["hooks"]["PreToolUse"].is_array());
    }

    #[test]
    fn test_resolve_hook_path_rejects_shell_metacharacters() {
        // Semicolons, pipes, backticks, etc. must be rejected
        let cases = vec![
            "/usr/bin/hook; rm -rf /",
            "/usr/bin/hook | cat",
            "/usr/bin/hook & bg",
            "/usr/bin/hook$(whoami)",
            "/usr/bin/hook`id`",
            "/usr/bin/hook > /tmp/out",
            "/usr/bin/hook < /dev/null",
        ];
        for input in cases {
            let result = resolve_hook_path(input);
            assert!(
                result.is_err(),
                "Should reject metacharacters in: {}",
                input
            );
            assert!(
                result.unwrap_err().contains("invalid characters"),
                "Error message should mention invalid characters"
            );
        }
    }

    #[test]
    fn test_resolve_hook_path_allows_dollar_home() {
        // $HOME at the start should be allowed and expanded
        let result = resolve_hook_path("$HOME/.claude/hooks/cue-hook");
        assert!(result.is_ok(), "Should allow $HOME prefix: {:?}", result);
        let expanded = result.unwrap();
        assert!(expanded.is_absolute());
        assert!(!expanded.to_string_lossy().contains("$HOME"));
    }

    #[test]
    fn test_resolve_hook_path_rejects_traversal() {
        let result = resolve_hook_path("/usr/local/../bin/hook");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("traversal"));
    }

    #[test]
    fn test_resolve_hook_path_rejects_empty() {
        let result = resolve_hook_path("");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));

        let result2 = resolve_hook_path("   ");
        assert!(result2.is_err());
        assert!(result2.unwrap_err().contains("empty"));
    }

    #[test]
    fn test_resolve_hook_path_tilde_expansion() {
        let result = resolve_hook_path("~/bin/cue-hook");
        assert!(result.is_ok());
        let expanded = result.unwrap();
        // Should NOT start with ~, should be an absolute path
        assert!(
            expanded.is_absolute(),
            "Tilde should be expanded to absolute path"
        );
        assert!(
            !expanded.to_string_lossy().starts_with('~'),
            "Tilde should be expanded"
        );
        assert!(
            expanded.to_string_lossy().ends_with("bin/cue-hook"),
            "Rest of path should be preserved"
        );
    }

    #[test]
    fn test_resolve_hook_path_valid_absolute() {
        let result = resolve_hook_path("/usr/local/bin/cue-hook");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), PathBuf::from("/usr/local/bin/cue-hook"));
    }

    #[test]
    fn test_resolve_hook_path_rejects_relative() {
        // A relative path with no tilde or $HOME should be rejected
        let result = resolve_hook_path("bin/cue-hook");
        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("absolute"),
            "Error should mention absolute path requirement"
        );
    }

    #[test]
    fn test_configure_hooks_dedup_by_path() {
        // Simulate the deduplication logic
        let hook_path = "/usr/local/bin/cue-hook";
        let entry = serde_json::json!({
            "matcher": "",
            "hooks": [{"type": "command", "command": format!("{} working", hook_path)}]
        });

        let mut arr = vec![entry.clone()];

        // Check if hook already exists
        let already_exists = arr.iter().any(|e| {
            e.get("hooks")
                .and_then(|h| h.as_array())
                .map(|hooks_arr| {
                    hooks_arr.iter().any(|h| {
                        h.get("command")
                            .and_then(|c| c.as_str())
                            .map(|c| c.starts_with(hook_path))
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false)
        });

        assert!(already_exists, "Should detect existing hook by path prefix");

        // Should not add a duplicate
        if !already_exists {
            arr.push(entry);
        }
        assert_eq!(arr.len(), 1);
    }
}
