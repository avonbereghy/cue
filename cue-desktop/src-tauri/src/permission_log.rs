//! Permission audit log — append-only JSONL file.
//!
//! Each permission decision is recorded as a single JSON line in
//! `{STATUS_DIR}/permission-log.jsonl`. The log is append-only and
//! file permissions are set to 0600 (owner-only) on Unix.

use crate::models::PermissionLogEntry;
use crate::paths;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Resolve the path to the permission log file.
fn log_path() -> Result<PathBuf, String> {
    let status_dir = paths::sessions_json_path()
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or("Cannot determine status directory")?;
    Ok(status_dir.join("permission-log.jsonl"))
}

/// Append a permission entry to `path`. Creates the file at 0600 on unix so
/// the audit log is never briefly world-readable before a subsequent
/// set_permissions call (the previous race window).
fn append_entry(path: &Path, entry: &PermissionLogEntry) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create log directory: {}", e))?;
    }

    let line = serde_json::to_string(entry)
        .map_err(|e| format!("Failed to serialize log entry: {}", e))?;

    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(path)
        .map_err(|e| format!("Failed to open permission log: {}", e))?;

    writeln!(file, "{}", line).map_err(|e| format!("Failed to write log entry: {}", e))?;

    file.sync_all()
        .map_err(|e| format!("Failed to fsync permission log: {}", e))?;

    Ok(())
}

/// Append a permission decision to the audit log.
pub fn append_permission_log(entry: &PermissionLogEntry) -> Result<(), String> {
    append_entry(&log_path()?, entry)
}

/// Append a permission decision to a specific log file path (for testing).
#[cfg(test)]
fn append_permission_log_to(path: &Path, entry: &PermissionLogEntry) -> Result<(), String> {
    append_entry(path, entry)
}

/// Read permission log entries for a specific session.
pub fn read_permission_log(session_id: &str) -> Vec<PermissionLogEntry> {
    let log_path = match log_path() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    read_permission_log_from(&log_path, session_id)
}

/// Read permission log entries from a specific file path, filtered by session_id.
fn read_permission_log_from(path: &Path, session_id: &str) -> Vec<PermissionLogEntry> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    content
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| serde_json::from_str::<PermissionLogEntry>(line).ok())
        .filter(|entry| entry.session_id == session_id)
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::PermissionLogEntry;

    fn make_entry(session_id: &str, tool: &str, decision: &str) -> PermissionLogEntry {
        PermissionLogEntry {
            timestamp: 1700000000.0,
            session_id: session_id.to_string(),
            tool_name: tool.to_string(),
            tool_input_summary: format!("Run: `{}`", tool),
            decision: decision.to_string(),
        }
    }

    #[test]
    fn test_write_and_read_roundtrip() {
        let dir = std::env::temp_dir().join("cue_test_perm_log_roundtrip");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("permission-log.jsonl");

        let entry = make_entry("sess-1", "Bash", "Allow");
        append_permission_log_to(&path, &entry).unwrap();

        let entries = read_permission_log_from(&path, "sess-1");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].session_id, "sess-1");
        assert_eq!(entries[0].tool_name, "Bash");
        assert_eq!(entries[0].decision, "Allow");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_multiple_entries_append() {
        let dir = std::env::temp_dir().join("cue_test_perm_log_multi");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("permission-log.jsonl");

        append_permission_log_to(&path, &make_entry("sess-1", "Bash", "Allow")).unwrap();
        append_permission_log_to(&path, &make_entry("sess-2", "Read", "Deny")).unwrap();
        append_permission_log_to(&path, &make_entry("sess-1", "Edit", "Allow")).unwrap();

        // Read all for sess-1
        let entries = read_permission_log_from(&path, "sess-1");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].tool_name, "Bash");
        assert_eq!(entries[1].tool_name, "Edit");

        // Read all for sess-2
        let entries = read_permission_log_from(&path, "sess-2");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].tool_name, "Read");
        assert_eq!(entries[0].decision, "Deny");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_filter_by_session_id() {
        let dir = std::env::temp_dir().join("cue_test_perm_log_filter");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("permission-log.jsonl");

        append_permission_log_to(&path, &make_entry("alpha", "Bash", "Allow")).unwrap();
        append_permission_log_to(&path, &make_entry("beta", "Read", "Deny")).unwrap();
        append_permission_log_to(&path, &make_entry("alpha", "Write", "Allow")).unwrap();

        let alpha = read_permission_log_from(&path, "alpha");
        assert_eq!(alpha.len(), 2);

        let beta = read_permission_log_from(&path, "beta");
        assert_eq!(beta.len(), 1);

        let gamma = read_permission_log_from(&path, "gamma");
        assert_eq!(gamma.len(), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_missing_file_returns_empty() {
        let path = std::env::temp_dir().join("cue_test_perm_log_missing/nonexistent.jsonl");
        let entries = read_permission_log_from(&path, "any-session");
        assert!(entries.is_empty());
    }

    #[test]
    fn test_empty_file_returns_empty() {
        let dir = std::env::temp_dir().join("cue_test_perm_log_empty");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("permission-log.jsonl");
        std::fs::write(&path, "").unwrap();

        let entries = read_permission_log_from(&path, "any-session");
        assert!(entries.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_malformed_lines_are_skipped() {
        let dir = std::env::temp_dir().join("cue_test_perm_log_malformed");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("permission-log.jsonl");
        let content = format!(
            "{}\n{}\n{}\n",
            serde_json::to_string(&make_entry("sess-1", "Bash", "Allow")).unwrap(),
            "THIS IS NOT VALID JSON",
            serde_json::to_string(&make_entry("sess-1", "Edit", "Deny")).unwrap(),
        );
        std::fs::write(&path, content).unwrap();

        let entries = read_permission_log_from(&path, "sess-1");
        assert_eq!(entries.len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn test_file_permissions_are_restricted() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join("cue_test_perm_log_perms");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("permission-log.jsonl");
        append_permission_log_to(&path, &make_entry("sess-1", "Bash", "Allow")).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
