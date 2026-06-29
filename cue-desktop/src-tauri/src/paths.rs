//! OS-specific path resolution for Cue data files.
//!
//! - macOS: ~/Library/Application Support/
//! - Windows: %LOCALAPPDATA%
//! - Linux: XDG directories

use std::env;
use std::path::{Path, PathBuf};

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

/// Claude Code's config directory. Honors the `CLAUDE_CONFIG_DIR` environment
/// variable — Claude Code's own mechanism for relocating `~/.claude` — and
/// falls back to `~/.claude`. Kept in lockstep with `_claude_config_dir()` in
/// the Python hook (`hooks/cue-hook`) so the hook and the desktop app agree on
/// where JSONL transcripts live; if they diverge, the hook records sessions the
/// app can't read.
///
/// Caveat: a GUI launch from the Dock/Finder does not inherit the shell
/// environment, so a `CLAUDE_CONFIG_DIR` exported in a shell rc is only visible
/// here when Cue is launched from a terminal (or the variable is set
/// machine-wide). A persisted settings override is the planned escape hatch for
/// that case; the hook — spawned by Claude Code itself — always sees the var.
pub fn claude_config_dir() -> PathBuf {
    claude_config_dir_for(&home_dir())
}

/// Like [`claude_config_dir`] but resolves against an explicit `home`, for
/// callers that have already obtained it and must degrade gracefully when
/// there is no home directory rather than panic (e.g. the config-count and
/// default-effort readers). Honors `CLAUDE_CONFIG_DIR` identically.
pub fn claude_config_dir_for(home: &Path) -> PathBuf {
    resolve_claude_config_dir(env::var("CLAUDE_CONFIG_DIR").ok().as_deref(), home)
}

/// Path to `<claude-config-dir>/projects` — where Claude Code stores JSONL
/// conversation logs (default `~/.claude/projects`).
pub fn claude_projects_path() -> PathBuf {
    claude_config_dir().join("projects")
}

/// Resolve the projects directory from an explicit user-provided config-dir
/// override (the persisted `claudeConfigDir` setting). The override is treated
/// as a `.claude`-equivalent directory, so the result is `<override>/projects`;
/// a leading `~` is expanded. Callers must only invoke this for a non-empty
/// override — an empty/whitespace value means "auto-detect", which is
/// [`claude_projects_path`].
pub fn claude_projects_path_from_override(config_dir: &str) -> PathBuf {
    expand_tilde(config_dir.trim(), &home_dir()).join("projects")
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

/// Pure resolver for [`claude_config_dir`], split out so the override logic is
/// unit-testable without mutating process-global env or depending on the real
/// home directory. An unset, empty, or whitespace-only override falls back to
/// `<home>/.claude`; a leading `~` is expanded against `home` to mirror the
/// Python hook's `os.path.expanduser`.
fn resolve_claude_config_dir(env_override: Option<&str>, home: &Path) -> PathBuf {
    if let Some(raw) = env_override {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return expand_tilde(trimmed, home);
        }
    }
    home.join(".claude")
}

/// Expand a leading `~` / `~/` against `home`, mirroring `os.path.expanduser`.
/// Any other path (absolute or relative) is taken verbatim.
fn expand_tilde(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return home.join(rest);
    }
    PathBuf::from(path)
}

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
        // Always ends in `projects`, regardless of any CLAUDE_CONFIG_DIR set in
        // the ambient environment (asserting `.claude/projects` here would make
        // the test depend on the dev's own env). The default `.claude` base is
        // covered deterministically by `resolve_claude_config_dir_*` below.
        let p = claude_projects_path();
        assert!(p.ends_with("projects"));
    }

    #[test]
    fn resolve_claude_config_dir_defaults_to_dot_claude() {
        let home = Path::new("/home/jane");
        assert_eq!(
            resolve_claude_config_dir(None, home),
            PathBuf::from("/home/jane/.claude")
        );
    }

    #[test]
    fn resolve_claude_config_dir_blank_override_falls_back() {
        let home = Path::new("/home/jane");
        // Empty and whitespace-only overrides are treated as unset.
        assert_eq!(
            resolve_claude_config_dir(Some(""), home),
            PathBuf::from("/home/jane/.claude")
        );
        assert_eq!(
            resolve_claude_config_dir(Some("   "), home),
            PathBuf::from("/home/jane/.claude")
        );
    }

    #[test]
    fn resolve_claude_config_dir_honors_absolute_override() {
        let home = Path::new("/home/jane");
        assert_eq!(
            resolve_claude_config_dir(Some("/custom/claude-home"), home),
            PathBuf::from("/custom/claude-home")
        );
    }

    #[test]
    fn resolve_claude_config_dir_expands_leading_tilde() {
        let home = Path::new("/home/jane");
        assert_eq!(
            resolve_claude_config_dir(Some("~/alt-claude"), home),
            PathBuf::from("/home/jane/alt-claude")
        );
        assert_eq!(
            resolve_claude_config_dir(Some("~"), home),
            PathBuf::from("/home/jane")
        );
    }

    #[test]
    fn claude_projects_path_from_override_appends_projects() {
        // An absolute override is taken verbatim with `/projects` appended;
        // surrounding whitespace is trimmed.
        assert_eq!(
            claude_projects_path_from_override("/custom/cfg"),
            PathBuf::from("/custom/cfg/projects")
        );
        assert_eq!(
            claude_projects_path_from_override("  /custom/cfg  "),
            PathBuf::from("/custom/cfg/projects")
        );
    }

    #[test]
    fn expand_tilde_passes_through_non_tilde_paths() {
        let home = Path::new("/home/jane");
        assert_eq!(expand_tilde("/abs/path", home), PathBuf::from("/abs/path"));
        assert_eq!(
            expand_tilde("relative/x", home),
            PathBuf::from("relative/x")
        );
        // A bare `~user` form is NOT expanded (matches our `~`/`~/` only rule).
        assert_eq!(expand_tilde("~bob/x", home), PathBuf::from("~bob/x"));
    }

    #[test]
    fn test_platform_specific_paths() {
        // Just verify they don't panic
        let _ = sessions_json_path();
        let _ = settings_path();
        let _ = claude_projects_path();
    }
}
