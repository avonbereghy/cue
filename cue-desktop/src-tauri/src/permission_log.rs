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
///
/// Exposed so `startup_checks` can verify the audit log's owner-only (0600)
/// permissions on launch alongside sessions.json and settings.json.
pub fn log_path() -> Result<PathBuf, String> {
    let status_dir = paths::sessions_json_path()
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or("Cannot determine status directory")?;
    Ok(status_dir.join("permission-log.jsonl"))
}

/// Append a permission entry to `path`. Creates the file at 0600 on unix so
/// the audit log is never briefly world-readable before a subsequent
/// set_permissions call (the previous race window). Opens with `O_NOFOLLOW` so
/// a symlink dropped at the log path can't redirect audit appends at another
/// file (e.g. `~/.bash_profile`).
fn append_entry(path: &Path, entry: &PermissionLogEntry) -> Result<(), String> {
    // Serialize append + rotation within the process. Tauri commands run on a
    // thread pool, so two decisions can append concurrently; without this, an
    // append landing between another thread's rotate tail-read and its atomic
    // rename would write to the soon-orphaned inode and vanish from the audit
    // log despite returning Ok. Cue is the only writer, so a process-local lock
    // fully closes it. Recover a poisoned lock rather than panic the audit path.
    static APPEND_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = APPEND_LOCK.lock().unwrap_or_else(|e| e.into_inner());

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
        // Reject a symlink at the path (ELOOP) instead of following it — mirrors
        // the write guard in security::atomic_write and the reader's no-follow
        // open. A regular file (existing or freshly created) opens normally.
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = opts
        .open(path)
        .map_err(|e| format!("Failed to open permission log: {}", e))?;

    writeln!(file, "{}", line).map_err(|e| format!("Failed to write log entry: {}", e))?;

    file.sync_all()
        .map_err(|e| format!("Failed to fsync permission log: {}", e))?;

    // Keep the log bounded so it never grows without limit and never crosses the
    // reader's 16 MiB cap (which would make history silently read back empty).
    rotate_if_needed(path);

    Ok(())
}

/// When the log crosses `PERMISSION_LOG_ROTATE_BYTES` we rewrite it down to its
/// most recent `PERMISSION_LOG_KEEP_BYTES` of complete lines. Rotating this way
/// (rather than spilling to a `.1`) keeps the audit log a single readable JSONL
/// and holds it well under the reader's cap, so `read_permission_log_from`
/// never fails closed to `[]` from hitting that bound.
const PERMISSION_LOG_ROTATE_BYTES: u64 = 8 * 1024 * 1024;
const PERMISSION_LOG_KEEP_BYTES: u64 = 4 * 1024 * 1024;

/// Trim `path` to its most recent complete lines if it has grown past the
/// rotation threshold. Best-effort: the append already succeeded, so any error
/// here just skips the trim this round and leaves the (intact) log to be
/// retried on the next append. Uses `security::atomic_write` for the rewrite so
/// the trimmed log keeps 0600 + O_NOFOLLOW + atomic-rename semantics.
fn rotate_if_needed(path: &Path) {
    use std::io::{Read, Seek, SeekFrom};

    let len = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return,
    };
    if len <= PERMISSION_LOG_ROTATE_BYTES {
        return;
    }

    // Read only the tail we intend to keep (bounded allocation), no-follow.
    let start = len.saturating_sub(PERMISSION_LOG_KEEP_BYTES);
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = match opts.open(path) {
        Ok(f) => f,
        Err(_) => return,
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut buf = Vec::new();
    if file
        .take(PERMISSION_LOG_KEEP_BYTES)
        .read_to_end(&mut buf)
        .is_err()
    {
        return;
    }

    // Drop the partial first line so the rewritten log starts on a clean JSONL
    // boundary (unless we happened to seek to byte 0).
    let tail: &[u8] = match buf.iter().position(|&b| b == b'\n') {
        Some(idx) if start > 0 => &buf[idx + 1..],
        _ => &buf[..],
    };

    let _ = crate::security::atomic_write(path, tail);
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
    // Bound the read at 16 MiB. The log is append-only and only Cue writes
    // it, but the file lives in a user-writable dir; without a cap, a
    // co-resident process race-writing a multi-GiB blob would OOM the
    // backend when the user opens the history panel. 16 MiB comfortably
    // holds tens of thousands of decisions while still being a hard ceiling.
    const PERMISSION_LOG_MAX_BYTES: u64 = 16 * 1024 * 1024;
    let content = match crate::security::read_to_string_bounded(path, PERMISSION_LOG_MAX_BYTES) {
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

    #[test]
    fn test_rotation_trims_oversized_log() {
        // A log that has grown past the rotation threshold is trimmed to its
        // most recent lines on the next append, so it never grows unbounded and
        // never crosses the reader's 16 MiB cap (which would read back empty).
        let dir = std::env::temp_dir().join("cue_test_perm_log_rotate");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("permission-log.jsonl");

        // Seed just over the rotation threshold with valid JSONL lines.
        let line = serde_json::to_string(&make_entry("old", "Bash", "Allow")).unwrap();
        let mut content = String::new();
        while (content.len() as u64) <= PERMISSION_LOG_ROTATE_BYTES {
            content.push_str(&line);
            content.push('\n');
        }
        std::fs::write(&path, &content).unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() > PERMISSION_LOG_ROTATE_BYTES);

        // One append trips rotation.
        append_permission_log_to(&path, &make_entry("fresh", "Edit", "Deny")).unwrap();

        let after = std::fs::metadata(&path).unwrap().len();
        assert!(
            after <= PERMISSION_LOG_KEEP_BYTES + 4096,
            "log should be trimmed to ~KEEP_BYTES, got {after}"
        );
        // The newest entry survives and is still readable after the trim.
        assert_eq!(read_permission_log_from(&path, "fresh").len(), 1);

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
