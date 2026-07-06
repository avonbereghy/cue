//! Count Claude Code configuration files for a workspace.
//!
//! Counts CLAUDE.md files, rules, MCP servers, and hooks from both
//! user-scope (~/.claude/, or $CLAUDE_CONFIG_DIR if set) and project-scope
//! ({workspace}/.claude/).

use crate::models::ConfigCounts;
use std::path::Path;

/// Cap for reading `settings.json`. These files live outside Cue's data dir
/// and project-scope copies come from attacker-influenceable workspaces, so
/// bound the read (this runs on the 30s supplemental refresh for every active
/// workspace) — a runaway/huge settings file must not stall the poll thread.
const SETTINGS_JSON_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Count all Claude configuration files relevant to a workspace.
pub fn count_config(workspace: &str) -> ConfigCounts {
    let mut counts = ConfigCounts::default();
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return counts,
    };
    // User-scope Claude config honors CLAUDE_CONFIG_DIR (default ~/.claude);
    // project-scope reads below stay relative to the workspace.
    let user_claude = crate::paths::claude_config_dir_for(&home);

    // CLAUDE.md files
    // User scope
    if user_claude.join("CLAUDE.md").exists() {
        counts.claude_md_count += 1;
    }
    if user_claude.join("CLAUDE.local.md").exists() {
        counts.claude_md_count += 1;
    }
    // Project scope
    let ws = Path::new(workspace);
    if ws.join("CLAUDE.md").exists() {
        counts.claude_md_count += 1;
    }
    if ws.join(".claude/CLAUDE.md").exists() {
        counts.claude_md_count += 1;
    }
    if ws.join("CLAUDE.local.md").exists() {
        counts.claude_md_count += 1;
    }
    if ws.join(".claude/CLAUDE.local.md").exists() {
        counts.claude_md_count += 1;
    }

    // Rules files: count .md files in rules directories
    counts.rules_count += count_md_files_recursive(&user_claude.join("rules"));
    counts.rules_count += count_md_files_recursive(&ws.join(".claude/rules"));

    // MCP servers and hooks from the user-scope settings.json
    let settings_path = user_claude.join("settings.json");
    // User-owned config (may be symlinked by a dotfile manager) → follow.
    if let Ok(content) =
        crate::security::read_to_string_bounded_follow(&settings_path, SETTINGS_JSON_MAX_BYTES)
    {
        if let Ok(settings) = serde_json::from_str::<serde_json::Value>(&content) {
            // Count MCP servers (minus disabled ones)
            if let Some(mcp) = settings.get("mcpServers").and_then(|v| v.as_object()) {
                counts.mcp_servers = mcp
                    .iter()
                    .filter(|(_, v)| !v.get("disabled").and_then(|d| d.as_bool()).unwrap_or(false))
                    .count() as i64;
            }
            // Count hook event types configured
            if let Some(hooks) = settings.get("hooks").and_then(|v| v.as_object()) {
                counts.hooks_count = hooks.len() as i64;
            }
        }
    }

    // Also check project-scope settings
    let project_settings = ws.join(".claude/settings.json");
    // Project .claude/settings.json is user-managed (may be symlinked) → follow.
    if let Ok(content) =
        crate::security::read_to_string_bounded_follow(&project_settings, SETTINGS_JSON_MAX_BYTES)
    {
        if let Ok(settings) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(mcp) = settings.get("mcpServers").and_then(|v| v.as_object()) {
                counts.mcp_servers += mcp
                    .iter()
                    .filter(|(_, v)| !v.get("disabled").and_then(|d| d.as_bool()).unwrap_or(false))
                    .count() as i64;
            }
        }
    }

    counts
}

/// Count .md files in a directory (recursive, depth-limited to prevent symlink cycles).
fn count_md_files_recursive(dir: &Path) -> i64 {
    if !dir.is_dir() {
        return 0;
    }
    count_md_files_inner(dir, 5) // max 5 levels deep
}

fn count_md_files_inner(dir: &Path, depth: u8) -> i64 {
    if depth == 0 {
        return 0;
    }
    let mut count = 0;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                count += count_md_files_inner(&path, depth - 1);
            } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
                count += 1;
            }
        }
    }
    count
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_count_md_files_empty_dir() {
        let dir = std::env::temp_dir().join("cue_test_config_empty");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(count_md_files_recursive(&dir), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_count_md_files_with_files() {
        let dir = std::env::temp_dir().join("cue_test_config_md");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("rule1.md"), "test").unwrap();
        std::fs::write(dir.join("rule2.md"), "test").unwrap();
        std::fs::write(dir.join("not_a_rule.txt"), "test").unwrap();
        assert_eq!(count_md_files_recursive(&dir), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_count_md_files_recursive_subdirs() {
        let dir = std::env::temp_dir().join("cue_test_config_recursive");
        let _ = std::fs::remove_dir_all(&dir);
        let sub = dir.join("subdir");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(dir.join("top.md"), "test").unwrap();
        std::fs::write(sub.join("nested.md"), "test").unwrap();
        assert_eq!(count_md_files_recursive(&dir), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_count_md_files_nonexistent_dir() {
        assert_eq!(count_md_files_recursive(Path::new("/nonexistent")), 0);
    }

    #[test]
    fn test_count_config_nonexistent_workspace() {
        let counts = count_config("/nonexistent/workspace/path");
        // Should not panic, just return zeros for project-scope items
        assert_eq!(counts.rules_count, 0);
    }
}
