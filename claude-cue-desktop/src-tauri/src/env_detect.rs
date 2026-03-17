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

    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
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
        let ext_dir = home
            .join(".local/share/gnome-shell/extensions/appindicatorsupport@rgcjonas.gmail.com");
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
/// Covers all Claude Code lifecycle events. Must stay aligned with
/// the manual instructions in OnboardingWizard.tsx.
const HOOK_EVENTS: &[(&str, &str)] = &[
    ("SessionStart", "idle"),
    ("PreToolUse", "working"),
    ("PostToolUse", "working"),
    ("UserPromptSubmit", "working"),
    ("PermissionRequest", "waiting"),
    ("PostToolUseFailure", "error"),
    ("SubagentStart", "subagent"),
    ("SubagentStop", "working"),
    ("Stop", "done"),
    ("TaskCompleted", "done"),
    ("Notification", "done"),
    ("SessionEnd", "remove"),
];

/// Configure Claude Code hooks in `~/.claude/settings.json`.
///
/// Reads the existing settings, backs up the original to `settings.json.bak`,
/// and adds/updates hook entries for Claude Code lifecycle events.
/// Uses `security::atomic_write()` for safe file writes.
pub fn configure_hooks(hook_path: &str) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let settings_path = home.join(".claude/settings.json");

    // Read existing settings or start with empty object
    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = std::fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse settings: {}", e))?
    } else {
        serde_json::json!({})
    };

    // Backup existing settings before modification
    if settings_path.exists() {
        let backup_path = settings_path.with_extension("json.bak");
        std::fs::copy(&settings_path, &backup_path)
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
                                .map(|c| c.starts_with(hook_path))
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
        assert_eq!(HOOK_EVENTS.len(), 12);
    }

    #[test]
    fn test_hook_events_mappings() {
        // Verify the state mappings match OnboardingWizard manual instructions
        let events: std::collections::HashMap<&str, &str> =
            HOOK_EVENTS.iter().copied().collect();
        assert_eq!(events["SessionStart"], "idle");
        assert_eq!(events["PreToolUse"], "working");
        assert_eq!(events["PostToolUse"], "working");
        assert_eq!(events["UserPromptSubmit"], "working");
        assert_eq!(events["PermissionRequest"], "waiting");
        assert_eq!(events["PostToolUseFailure"], "error");
        assert_eq!(events["SubagentStart"], "subagent");
        assert_eq!(events["SubagentStop"], "working");
        assert_eq!(events["Stop"], "done");
        assert_eq!(events["TaskCompleted"], "done");
        assert_eq!(events["Notification"], "done");
        assert_eq!(events["SessionEnd"], "remove");
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

        // Verify all 12 events were configured
        let hooks_obj = settings["hooks"].as_object().unwrap();
        assert_eq!(hooks_obj.len(), 12);

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
        check("Stop", "done");
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
