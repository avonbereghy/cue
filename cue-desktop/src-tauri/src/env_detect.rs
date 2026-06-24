//! Environment detection and hook configuration.
//!
//! Detects platform capabilities and configures Claude Code hooks.
//! No network calls or subprocess invocations — uses filesystem and
//! environment variable inspection only.

use crate::security;
use serde::Serialize;
use std::path::{Path, PathBuf};

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

/// Shell metacharacters that must not appear in raw user-supplied hook
/// path inputs (pre-expansion). The post-expansion check below uses a
/// stricter allowlist, but at the raw stage we still need to permit `~`
/// and `$HOME/` literals — the expansion logic strips them — so we can't
/// allowlist there.
const SHELL_METACHARACTERS: &[char] = &[
    ';', '|', '&', '`', '(', ')', '>', '<', '\n', '\r', '\'', '"',
];

/// Allowlist of characters permitted in a *resolved, expanded* hook-path
/// string before it gets interpolated into Claude Code's settings.json
/// command line. The check is allowlist-style (not deny-list) so anything
/// not explicitly enumerated — space, $, *, ?, {, }, [, ], #, tab,
/// non-ASCII whitespace, etc. — is rejected. The set below covers every
/// legitimate character a filesystem path can produce on macOS, Linux,
/// and Windows after `dirs::home_dir()` expansion: ASCII alphanumerics
/// plus the path-structure punctuation `_ - . / \ :` (colon for Windows
/// drive letters; backslash for the Windows path separator).
fn is_path_safe_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | '\\' | ':')
}

/// Verify a *resolved* hook-path string is safe to interpolate into the
/// hook command stored in Claude Code's settings.json. Paths flow through
/// `dirs::home_dir()` which is ultimately user-controlled via $HOME or
/// %USERPROFILE%, so an exotic home directory could otherwise smuggle in
/// a space (breaking command tokenisation), `$` (variable expansion), `*`
/// (glob), or other shell-sensitive bytes. An allowlist closes the whole
/// class — anything outside `is_path_safe_char` is rejected.
fn assert_safe_for_command(path: &str, label: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err(format!("{} path is empty", label));
    }
    if let Some(bad) = path.chars().find(|c| !is_path_safe_char(*c)) {
        return Err(format!(
            "{} path contains disallowed character {:?}",
            label, bad
        ));
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

/// Configure Claude Code hooks in `~/.claude/settings.json` for a hook script
/// at an explicit path. Validates the path (rejecting shell metacharacters and
/// path traversal), resolves a Python 3 interpreter, and registers entries for
/// every lifecycle event with a 5s timeout. Used by `deploy_bundled_hook` and
/// available for advanced/manual installs.
pub fn configure_hooks(hook_path: &str) -> Result<(), String> {
    // Security: validate hook_path to prevent command injection.
    let resolved = resolve_hook_path(hook_path)?;
    configure_hooks_via_interpreter(&resolved)
}

/// Standard per-user install location for the cue-hook script.
/// `~/.claude/hooks/cue-hook` — the same directory Claude Code uses for its
/// own hook scripts, so it survives a Cue reinstall and is easy to find.
pub fn deployed_hook_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude/hooks/cue-hook"))
}

/// Locate a Python 3 interpreter by scanning `PATH` (no subprocess spawn — this
/// module stays side-effect free). Returns the absolute path to the first
/// match. Claude Code invokes the hook as `<python> <hook> <state>`, so the
/// script needs no execute bit; this is what makes the hook portable to
/// Windows, where shebang lines are not honored.
pub fn find_python() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(target_os = "windows") {
        &["python.exe", "python3.exe", "py.exe"]
    } else {
        &["python3", "python"]
    };
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Deploy the bundled `cue-hook` script to `~/.claude/hooks/cue-hook` and wire
/// it into Claude Code's `settings.json`. `bundled_hook` is the path to the
/// script shipped inside the app bundle (resolved by the caller through the
/// Tauri resource API). Returns the deployed path on success.
///
/// This is the single, platform-agnostic install path used by both the
/// onboarding wizard and the Settings "reinstall" button — it does not depend
/// on any pre-existing files outside the app bundle.
pub fn deploy_bundled_hook(bundled_hook: &std::path::Path) -> Result<String, String> {
    let bytes = std::fs::read(bundled_hook).map_err(|e| {
        format!(
            "Could not read the bundled cue-hook script at {}: {e}",
            bundled_hook.display()
        )
    })?;

    let dest = deployed_hook_path().ok_or("Cannot determine home directory")?;
    let hooks_dir = dest
        .parent()
        .ok_or("Invalid hook destination path")?
        .to_path_buf();
    std::fs::create_dir_all(&hooks_dir)
        .map_err(|e| format!("Failed to create {}: {e}", hooks_dir.display()))?;

    // atomic_write lands the file at 0600. Because the hook is invoked via the
    // Python interpreter (not executed directly), 0600 is correct and the
    // least-privilege choice — no execute bit required.
    security::atomic_write(&dest, &bytes)
        .map_err(|e| format!("Failed to write cue-hook script: {e}"))?;

    configure_hooks_via_interpreter(&dest)?;
    Ok(dest.to_string_lossy().to_string())
}

/// Build the `<python> <hook>` command prefix and register hook entries.
///
/// We verify a Python 3 interpreter exists on `PATH`, but write its *bare name*
/// (e.g. `python3`) into the command rather than its absolute path. This keeps
/// the command portable: the shell resolves it at hook time, and we never trip
/// over an install path that contains a space (common on Windows, e.g.
/// `C:\Program Files\Python\python.exe`) — which the command-safety allowlist
/// would otherwise reject.
fn configure_hooks_via_interpreter(hook: &std::path::Path) -> Result<(), String> {
    let hook_str = hook.to_string_lossy();
    assert_safe_for_command(&hook_str, "cue-hook")?;

    let python = find_python().ok_or(
        "Python 3 was not found on your PATH. Cue's hook is a Python 3 script — \
         install Python 3 (python.org or your package manager) and run setup again.",
    )?;
    // Use the interpreter's file name (python3 / python / python.exe), not its
    // absolute path. file_name() is always present for a resolved interpreter.
    let interpreter = python
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "python3".to_string());
    assert_safe_for_command(&interpreter, "python")?;

    let prefix = format!("{} {}", interpreter, hook_str);
    write_hook_settings(&prefix)
}

/// Write/refresh cue-hook entries in `~/.claude/settings.json`.
///
/// `command_prefix` is everything before the per-event state argument, e.g.
/// `/usr/bin/python3 /home/u/.claude/hooks/cue-hook`. Backs up the existing
/// settings to `settings.json.bak`, preserves every other key, and is
/// idempotent — any prior cue-hook entry for an event is replaced (other
/// tools' hooks on the same event are left untouched). Each entry carries a
/// 5s timeout so a wedged hook can never stall Claude Code.
fn write_hook_settings(command_prefix: &str) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    write_hook_settings_at(&home.join(".claude/settings.json"), command_prefix)
}

/// Cap for reading the user's `settings.json`. It lives outside Cue's data dir
/// and is touched by other tooling; a runaway writer must not stall install or
/// uninstall on a multi-GB read.
const SETTINGS_JSON_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Path-injected core of `write_hook_settings` so the file behaviour (backup,
/// preservation, idempotence) is unit-testable against a temp dir.
fn write_hook_settings_at(settings_path: &Path, command_prefix: &str) -> Result<(), String> {
    let existing = if settings_path.exists() {
        Some(
            security::read_to_string_bounded(settings_path, SETTINGS_JSON_MAX_BYTES)
                .map_err(|e| format!("Failed to read settings: {}", e))?,
        )
    } else {
        None
    };

    let mut settings: serde_json::Value = match existing {
        Some(ref content) => {
            serde_json::from_str(content).map_err(|e| format!("Failed to parse settings: {}", e))?
        }
        None => serde_json::json!({}),
    };

    // Back up the ORIGINAL settings exactly once — the first time Cue touches
    // them — so the pristine pre-Cue copy survives later reinstalls (both the
    // onboarding wizard and the Settings "reinstall" button re-run this). The
    // README/INSTALL advertise this `.bak` as the revert path; overwriting it
    // on every reinstall (the old behaviour) destroyed that guarantee.
    if let Some(ref content) = existing {
        let backup_path = settings_path.with_extension("json.bak");
        if !backup_path.exists() {
            security::atomic_write(&backup_path, content.as_bytes())
                .map_err(|e| format!("Failed to backup settings: {}", e))?;
        }
    }

    apply_cue_hook_entries(&mut settings, command_prefix)?;

    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    security::atomic_write(settings_path, content.as_bytes())
        .map_err(|e| format!("Failed to write settings: {}", e))?;

    Ok(())
}

/// Insert/refresh cue-hook entries for every `HOOK_EVENTS` event on `settings`.
/// Pure JSON transform (no I/O) so it's directly unit-testable. Idempotent: any
/// prior cue entry on an event is replaced and ours is inserted first (so state
/// updates land before slower hooks); other tools' hooks are left untouched.
fn apply_cue_hook_entries(
    settings: &mut serde_json::Value,
    command_prefix: &str,
) -> Result<(), String> {
    if !settings.get("hooks").is_some_and(|h| h.is_object()) {
        settings["hooks"] = serde_json::json!({});
    }
    let hooks = settings["hooks"].as_object_mut().unwrap();

    for (event, state) in HOOK_EVENTS {
        let new_entry = serde_json::json!({
            "matcher": "",
            "hooks": [{
                "type": "command",
                "command": format!("{} {}", command_prefix, state),
                "timeout": 5000
            }]
        });

        if !hooks.contains_key(*event) {
            hooks.insert(event.to_string(), serde_json::json!([]));
        }
        let arr = hooks
            .get_mut(*event)
            .unwrap()
            .as_array_mut()
            .ok_or("hooks entry is not an array")?;

        arr.retain(|e| !entry_contains_cue_hook(e));
        arr.insert(0, new_entry);
    }
    Ok(())
}

/// Remove all cue hooks from `~/.claude/settings.json` and reverse install.
///
/// Strips every cue-hook entry from all events, drops the hook-event arrays Cue
/// created and emptied, removes the `hooks` object if nothing else uses it, and
/// removes the `settings.json.bak` Cue wrote — a clean reversal of install.
/// Also clears sessions.json so the dashboard shows a clean state.
pub fn uninstall_hooks() -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    uninstall_hooks_at(&home.join(".claude/settings.json"))?;

    // Clear sessions.json so the dashboard shows a clean state.
    let sessions_path = crate::paths::sessions_json_path();
    if sessions_path.exists() {
        security::atomic_write(&sessions_path, b"{\"sessions\":{}}")
            .map_err(|e| format!("Failed to clear sessions: {}", e))?;
    }

    Ok(())
}

/// Path-injected core of `uninstall_hooks` so the full-reversal behaviour is
/// unit-testable against a temp dir.
fn uninstall_hooks_at(settings_path: &Path) -> Result<(), String> {
    if !settings_path.exists() {
        return Ok(()); // Nothing to uninstall
    }

    let content = security::read_to_string_bounded(settings_path, SETTINGS_JSON_MAX_BYTES)
        .map_err(|e| format!("Failed to read settings: {}", e))?;
    let mut settings: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse settings: {}", e))?;

    if let Some(hooks) = settings.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for (_event, entries) in hooks.iter_mut() {
            if let Some(arr) = entries.as_array_mut() {
                arr.retain(|entry| !entry_contains_cue_hook(entry));
            }
        }
        // Install creates a fresh `"<event>": []` for any HOOK_EVENTS event the
        // user lacked; drop the cue-managed arrays we just emptied so a clean
        // install→uninstall round trip leaves no orphaned cue keys. Non-cue
        // events (and any the user populated) are untouched.
        hooks.retain(|event, entries| {
            let cue_managed = HOOK_EVENTS.iter().any(|(e, _)| e == event);
            let emptied = entries.as_array().is_some_and(|a| a.is_empty());
            !(cue_managed && emptied)
        });
    }

    // If the hooks object is now empty (Cue was the only thing using it), drop
    // it entirely so the file returns to its pre-Cue shape.
    let hooks_empty = settings
        .get("hooks")
        .and_then(|h| h.as_object())
        .is_some_and(|o| o.is_empty());
    if hooks_empty {
        if let Some(obj) = settings.as_object_mut() {
            obj.remove("hooks");
        }
    }

    let out = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    security::atomic_write(settings_path, out.as_bytes())
        .map_err(|e| format!("Failed to write settings: {}", e))?;

    // Remove the backup Cue wrote. The live settings are now cue-free, so the
    // `.bak` (Cue's pre-install snapshot) is residue after a "full uninstall".
    let backup_path = settings_path.with_extension("json.bak");
    let _ = std::fs::remove_file(&backup_path);

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
    fn test_find_python_no_panic() {
        // Resolution scans PATH; on CI runners Python is usually present, but
        // either outcome is valid — we only assert it doesn't panic and, when
        // found, returns an absolute path that exists.
        if let Some(p) = find_python() {
            assert!(p.is_absolute(), "python path should be absolute: {p:?}");
            assert!(p.is_file(), "resolved python should be a file: {p:?}");
        }
    }

    #[test]
    fn test_deployed_hook_path_under_claude_hooks() {
        // Should resolve to ~/.claude/hooks/cue-hook when a home dir exists.
        if let Some(p) = deployed_hook_path() {
            assert!(p.ends_with("cue-hook"));
            assert!(p.to_string_lossy().contains(".claude"));
            // The deployed path must itself pass the command-safety allowlist
            // (otherwise we could never wire it into settings.json).
            assert!(assert_safe_for_command(&p.to_string_lossy(), "deployed").is_ok());
        }
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
        // Notification carries six subtypes. The hook writes "waiting" for the
        // two JSONL-backed dialog subtypes (permission_prompt → pending_tool_use,
        // elicitation_dialog → awaiting_user_prompt) and returns without writing
        // for the rest (idle_prompt is plain idle; auth_success /
        // elicitation_complete / elicitation_response are informational). The
        // install-map action below is just the CLI arg; the per-subtype dispatch
        // lives in hooks/cue-hook.
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
            "idle",
            "working",
            "thinking",
            "waiting",
            "done",
            "remove",
            "error",
            "subagent",
            "subagent_stop",
            "compacting",
        ]
        .iter()
        .copied()
        .collect();
        for (event, action) in HOOK_EVENTS {
            assert!(
                valid_actions.contains(*action),
                "HOOK_EVENTS row ({event}, {action}) has an action the hook would silently drop",
            );
        }
    }

    // F-tests-001: exercise the REAL install/uninstall functions (not a
    // hand-copied reimplementation) against an injected settings path, so a
    // regression that corrupts the user's settings.json is actually caught.

    /// command of the first hook registered for `event`, if any.
    fn first_command<'a>(settings: &'a serde_json::Value, event: &str) -> Option<&'a str> {
        settings["hooks"][event][0]["hooks"][0]["command"].as_str()
    }

    #[test]
    fn test_write_hook_settings_structure_and_preserves_other_keys() {
        let dir = std::env::temp_dir().join("cue_test_write_hooks_structure");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        // Seed with unrelated keys and a non-cue hook that must survive.
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&serde_json::json!({
                "model": "claude-sonnet-4-6",
                "hooks": {
                    "PreToolUse": [{
                        "matcher": "",
                        "hooks": [{"type": "command", "command": "/opt/retenir/run"}]
                    }]
                }
            }))
            .unwrap(),
        )
        .unwrap();

        write_hook_settings_at(&path, "python3 /home/u/.claude/hooks/cue-hook").unwrap();

        let out: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        // Every HOOK_EVENTS event is registered with the right state arg.
        for (event, state) in HOOK_EVENTS {
            assert_eq!(
                first_command(&out, event),
                Some(format!("python3 /home/u/.claude/hooks/cue-hook {state}").as_str()),
                "cue entry missing/wrong for {event}"
            );
        }
        // Unrelated key preserved; the user's non-cue PreToolUse hook preserved
        // (cue is inserted first, the retenir hook follows).
        assert_eq!(out["model"].as_str(), Some("claude-sonnet-4-6"));
        let pre = out["hooks"]["PreToolUse"].as_array().unwrap();
        assert!(
            pre.iter()
                .any(|e| e["hooks"][0]["command"] == "/opt/retenir/run"),
            "user's non-cue hook was dropped"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_install_uninstall_round_trip() {
        let dir = std::env::temp_dir().join("cue_test_install_round_trip");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let original = serde_json::json!({
            "model": "claude-sonnet-4-6",
            "hooks": {
                "Stop": [{
                    "matcher": "",
                    "hooks": [{"type": "command", "command": "/opt/other-tool/run"}]
                }]
            }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&original).unwrap()).unwrap();

        write_hook_settings_at(&path, "python3 /h/cue-hook").unwrap();
        uninstall_hooks_at(&path).unwrap();

        let out: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        // No cue residue anywhere.
        let serialized = serde_json::to_string(&out).unwrap();
        assert!(
            !serialized.contains("cue-hook"),
            "cue residue after uninstall"
        );
        // No orphaned empty cue-managed arrays.
        for (event, _) in HOOK_EVENTS {
            if event == &"Stop" {
                continue;
            }
            assert!(
                out["hooks"].get(event).is_none(),
                "orphaned empty array left for {event}"
            );
        }
        // Unrelated key + the user's own hook survive.
        assert_eq!(out["model"].as_str(), Some("claude-sonnet-4-6"));
        assert_eq!(first_command(&out, "Stop"), Some("/opt/other-tool/run"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_uninstall_drops_empty_hooks_object() {
        // A user with no prior hooks: install creates the hooks object, uninstall
        // must remove it entirely so the file returns to its pre-Cue shape.
        let dir = std::env::temp_dir().join("cue_test_uninstall_drops_hooks");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, r#"{"model":"x"}"#).unwrap();

        write_hook_settings_at(&path, "python3 /h/cue-hook").unwrap();
        uninstall_hooks_at(&path).unwrap();

        let out: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(out.get("hooks").is_none(), "empty hooks object not removed");
        assert_eq!(out["model"].as_str(), Some("x"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_reinstall_is_idempotent() {
        let dir = std::env::temp_dir().join("cue_test_reinstall_idempotent");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, "{}").unwrap();

        write_hook_settings_at(&path, "python3 /h/cue-hook").unwrap();
        write_hook_settings_at(&path, "python3 /h/cue-hook").unwrap();

        let out: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        // Exactly one cue entry per event after two installs.
        for (event, _) in HOOK_EVENTS {
            let arr = out["hooks"][event].as_array().unwrap();
            let cue_count = arr.iter().filter(|e| entry_contains_cue_hook(e)).count();
            assert_eq!(cue_count, 1, "reinstall duplicated cue entry on {event}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_backup_is_not_clobbered_on_reinstall() {
        // F-dx-002 / F-correctness-002: the pristine pre-Cue .bak must survive a
        // reinstall. The first install snapshots the original; the second must
        // NOT overwrite it with the already-cue-modified settings.
        let dir = std::env::temp_dir().join("cue_test_backup_preserved");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let pristine = r#"{"model":"pristine"}"#;
        std::fs::write(&path, pristine).unwrap();

        write_hook_settings_at(&path, "python3 /h/cue-hook").unwrap();
        write_hook_settings_at(&path, "python3 /h/cue-hook").unwrap();

        let bak = path.with_extension("json.bak");
        let bak_content = std::fs::read_to_string(&bak).unwrap();
        assert!(
            !bak_content.contains("cue-hook"),
            ".bak was clobbered with cue-modified settings: {bak_content}"
        );
        assert!(bak_content.contains("pristine"), "pristine backup lost");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_install_into_invalid_json_errors_without_writing() {
        let dir = std::env::temp_dir().join("cue_test_invalid_json");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, "{ this is not json").unwrap();

        let result = write_hook_settings_at(&path, "python3 /h/cue-hook");
        assert!(
            result.is_err(),
            "invalid JSON must error, not silently overwrite"
        );
        // The malformed file is left untouched (atomic_write never ran).
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{ this is not json"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // F-tests-004: deploy_bundled_hook is the single production install entry
    // point (onboarding + Settings reinstall). Cover its failure modes.

    #[test]
    fn test_deploy_bundled_hook_missing_bundle_errors() {
        let missing = std::env::temp_dir().join("cue_test_no_such_bundle/cue-hook");
        let _ = std::fs::remove_dir_all(missing.parent().unwrap());
        let result = deploy_bundled_hook(&missing);
        assert!(result.is_err(), "missing bundle must error");
        assert!(
            result.unwrap_err().contains(&missing.display().to_string()),
            "error should name the missing bundle path"
        );
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
    fn test_assert_safe_for_command_allows_typical_paths() {
        assert!(assert_safe_for_command("/Users/foo/.claude/hooks/cue-hook", "x").is_ok());
        assert!(assert_safe_for_command("/home/foo/.claude/hooks/cue-hook", "x").is_ok());
        assert!(assert_safe_for_command(r"C:\Users\foo\.claude\hooks\cue-hook.exe", "x").is_ok());
        assert!(assert_safe_for_command("/opt/hyphen-named_dir/cue-hook", "x").is_ok());
    }

    #[test]
    fn test_assert_safe_for_command_rejects_space_and_metachars() {
        // The old deny-list missed space, $, *, ?, etc. The new allowlist
        // closes the whole class.
        for bad in [
            "/Users/My Apps/cue-hook",   // space — broke shell tokenisation
            "/Users/foo/$HOME/cue-hook", // literal $ leak
            "/tmp/*/cue-hook",           // glob
            "/tmp/cue-hook?",            // glob
            "/tmp/cue-hook;rm",          // semicolon
            "/tmp/cue-hook|cat",         // pipe
            "/tmp/cue\thook",            // tab
            "/tmp/cue\nhook",            // newline
            "/tmp/cue#hook",             // comment char
            "/tmp/cue~hook",             // tilde mid-path
            "/tmp/{a,b}/cue-hook",       // brace expansion
            "/tmp/cue-hook ",            // trailing space
        ] {
            assert!(
                assert_safe_for_command(bad, "x").is_err(),
                "expected {:?} to be rejected by the allowlist",
                bad
            );
        }
    }

    #[test]
    fn test_assert_safe_for_command_rejects_empty() {
        assert!(assert_safe_for_command("", "x").is_err());
    }

    #[test]
    fn test_assert_safe_for_command_rejects_non_ascii() {
        // Non-ASCII letters are filesystem-legal but cannot round-trip
        // safely through arbitrary shells (different normalisation forms,
        // homoglyph confusion) — reject defensively.
        assert!(assert_safe_for_command("/tmp/cue-hökk", "x").is_err());
    }
}
