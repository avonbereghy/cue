//! OS-specific path resolution for Cue data files.
//!
//! - macOS: ~/Library/Application Support/
//! - Windows: %LOCALAPPDATA%
//! - Linux: XDG directories

use std::path::PathBuf;

/// Path to sessions.json — the hook-written status file.
pub fn sessions_json_path() -> PathBuf {
    if cfg!(target_os = "macos") {
        home_dir().join("Library/Application Support/Cue/sessions.json")
    } else if cfg!(target_os = "windows") {
        appdata_local().join("Cue").join("sessions.json")
    } else {
        // Linux — XDG
        xdg_data_home().join("cue").join("sessions.json")
    }
}

/// Path to sessions.lock — the cross-process advisory lock file co-located
/// with sessions.json. Both the Python hook and the Rust sandbox writers
/// acquire an exclusive flock on this file before touching sessions.json,
/// so a concurrent hook event can't lose its update to a sandbox write
/// (or vice versa). See `security::with_sessions_lock`.
pub fn sessions_lock_path() -> PathBuf {
    sessions_json_path().with_file_name("sessions.lock")
}

/// Path to permission-token — a per-launch shared secret the Python hook
/// must present in the `X-Cue-Token` header on POSTs to the localhost
/// permission server. Co-located with sessions.json under the user's
/// 0700 status directory and itself written 0600, so only the same OS
/// user can read it. Without this header any local process could win
/// the loopback bind race and forge {"behavior":"allow"} responses.
pub fn permission_token_path() -> PathBuf {
    sessions_json_path().with_file_name("permission-token")
}

/// Path to settings.json — app preferences.
pub fn settings_path() -> PathBuf {
    if cfg!(target_os = "macos") {
        home_dir().join("Library/Application Support/com.cueapp/settings.json")
    } else if cfg!(target_os = "windows") {
        appdata_local().join("Cue").join("settings.json")
    } else {
        xdg_config_home().join("cue").join("settings.json")
    }
}

/// Path to ~/.claude/projects — where Claude Code stores JSONL conversation logs.
pub fn claude_projects_path() -> PathBuf {
    home_dir().join(".claude").join("projects")
}

/// Directory for saved signal presets (extracted frequency envelopes).
pub fn presets_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        home_dir().join("Library/Application Support/com.cueapp/presets")
    } else if cfg!(target_os = "windows") {
        appdata_local().join("Cue").join("presets")
    } else {
        xdg_config_home().join("cue").join("presets")
    }
}

/// Path to rate_limits.json — written by the statusline bridge script.
/// Lives alongside sessions.json in the same data directory.
pub fn rate_limits_path() -> PathBuf {
    if cfg!(target_os = "macos") {
        home_dir().join("Library/Application Support/Cue/rate_limits.json")
    } else if cfg!(target_os = "windows") {
        appdata_local().join("Cue").join("rate_limits.json")
    } else {
        xdg_data_home().join("cue").join("rate_limits.json")
    }
}

/// Ensure all required directories exist.
pub fn ensure_dirs() -> std::io::Result<()> {
    if let Some(parent) = sessions_json_path().parent() {
        std::fs::create_dir_all(parent)?;
    }
    if let Some(parent) = settings_path().parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn home_dir() -> PathBuf {
    dirs::home_dir().expect("Cannot determine home directory — refusing to use /tmp fallback")
}

fn appdata_local() -> PathBuf {
    // Windows: typically C:\Users\<user>\AppData\Local
    dirs::data_local_dir().unwrap_or_else(|| home_dir().join("AppData").join("Local"))
}

fn xdg_data_home() -> PathBuf {
    dirs::data_dir().unwrap_or_else(|| home_dir().join(".local").join("share"))
}

fn xdg_config_home() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| home_dir().join(".config"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sessions_json_path_not_empty() {
        let p = sessions_json_path();
        assert!(p.to_str().unwrap().contains("sessions.json"));
    }

    #[test]
    fn test_settings_path_not_empty() {
        let p = settings_path();
        assert!(p.to_str().unwrap().contains("settings.json"));
    }

    #[test]
    fn test_claude_projects_path() {
        let p = claude_projects_path();
        assert!(p.to_str().unwrap().contains(".claude/projects"));
    }

    #[test]
    fn test_platform_specific_paths() {
        // Just verify they don't panic
        let _ = sessions_json_path();
        let _ = settings_path();
        let _ = claude_projects_path();
    }
}
