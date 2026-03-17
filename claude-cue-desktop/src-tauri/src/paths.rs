//! OS-specific path resolution for Claude Cue data files.
//!
//! - macOS: ~/Library/Application Support/
//! - Windows: %LOCALAPPDATA%
//! - Linux: XDG directories

use std::path::PathBuf;

/// Path to sessions.json — the hook-written status file.
pub fn sessions_json_path() -> PathBuf {
    if cfg!(target_os = "macos") {
        home_dir()
            .join("Library/Application Support/Claude Cue/sessions.json")
    } else if cfg!(target_os = "windows") {
        appdata_local().join("Claude Cue").join("sessions.json")
    } else {
        // Linux — XDG
        xdg_data_home().join("claude-cue").join("sessions.json")
    }
}

/// Path to settings.json — app preferences.
pub fn settings_path() -> PathBuf {
    if cfg!(target_os = "macos") {
        home_dir()
            .join("Library/Application Support/com.claude-cue.app/settings.json")
    } else if cfg!(target_os = "windows") {
        appdata_local().join("Claude Cue").join("settings.json")
    } else {
        xdg_config_home().join("claude-cue").join("settings.json")
    }
}

/// Path to ~/.claude/projects — where Claude Code stores JSONL conversation logs.
pub fn claude_projects_path() -> PathBuf {
    home_dir().join(".claude").join("projects")
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
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"))
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
