//! Discover open Codex root sessions independently of Cue hooks.
//!
//! Codex keeps a writer lock for every open thread in
//! `$CODEX_HOME/thread-writer-locks` and stores the corresponding rollout under
//! `$CODEX_HOME/sessions/YYYY/MM/DD`. Hooks add precise state transitions, but
//! they are opt-in/trusted and are loaded when a Codex client starts. The lock
//! plus rollout metadata therefore form the reliable baseline for showing an
//! already-open Codex session in Cue.

use crate::security;
use serde_json::Value;
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_LOCK_FILES: usize = 4_096;
const MAX_ROLLOUT_FILES: usize = 20_000;
const MAX_SCAN_DEPTH: usize = 4;
const MAX_META_LINE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Default)]
pub struct CodexDiscoverySnapshot {
    pub sessions: Vec<DiscoveredCodexSession>,
    /// True when the writer-lock directory was readable and lock ownership
    /// could be checked. In this mode, absence from `sessions` is meaningful.
    pub authoritative: bool,
}

#[derive(Debug, Clone)]
pub struct DiscoveredCodexSession {
    pub id: String,
    pub workspace: String,
    pub transcript_path: PathBuf,
    pub started_at: f64,
    pub last_activity: f64,
    pub source: Option<String>,
}

/// Find open, user-owned Codex sessions below an explicit Codex home.
///
/// On Unix, held writer locks are authoritative. On platforms where the lock
/// primitive is unavailable (or when the lock directory cannot be read), the
/// fallback admits only rollout files modified after Cue launched. The latter
/// is intentionally conservative: it cannot prove an old idle client is open.
pub fn discover_codex_sessions(codex_home: &Path, launched_at: f64) -> CodexDiscoverySnapshot {
    let Ok(codex_home) = codex_home.canonicalize() else {
        return CodexDiscoverySnapshot::default();
    };
    let sessions_root = codex_home.join("sessions");
    let Ok(sessions_root) = sessions_root.canonicalize() else {
        return CodexDiscoverySnapshot::default();
    };
    if !sessions_root.starts_with(&codex_home) || !sessions_root.is_dir() {
        return CodexDiscoverySnapshot::default();
    }

    let (open_ids, authoritative) = open_thread_ids(&codex_home);
    if authoritative && open_ids.is_empty() {
        return CodexDiscoverySnapshot {
            sessions: Vec::new(),
            authoritative: true,
        };
    }

    let mut candidate_paths = Vec::new();
    let mut visited = 0usize;
    scan_rollouts(
        &sessions_root,
        0,
        &open_ids,
        authoritative,
        launched_at,
        &mut visited,
        &mut candidate_paths,
    );

    let mut sessions = Vec::new();
    for path in candidate_paths {
        if let Some(session) = parse_root_session(&path, &sessions_root) {
            sessions.push(session);
        }
    }
    sessions.sort_by(|a, b| a.started_at.total_cmp(&b.started_at));
    CodexDiscoverySnapshot {
        sessions,
        authoritative,
    }
}

fn open_thread_ids(codex_home: &Path) -> (HashSet<String>, bool) {
    #[cfg(unix)]
    {
        let locks_dir = codex_home.join("thread-writer-locks");
        let Ok(entries) = fs::read_dir(&locks_dir) else {
            return (HashSet::new(), false);
        };
        let mut held = HashSet::new();
        for entry in entries.flatten().take(MAX_LOCK_FILES) {
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Some(id) = name.strip_suffix(".lock") else {
                continue;
            };
            if security::validate_session_id(id).is_err() {
                continue;
            }
            if lock_is_held(&path) {
                held.insert(id.to_string());
            }
        }
        (held, true)
    }
    #[cfg(not(unix))]
    {
        let _ = codex_home;
        (HashSet::new(), false)
    }
}

#[cfg(unix)]
fn lock_is_held(path: &Path) -> bool {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let Ok(file) = options.open(path) else {
        return false;
    };
    // SAFETY: `file` owns a valid fd for this scope. A successful shared lock
    // is immediately released; EWOULDBLOCK/EAGAIN means Codex holds its writer
    // lock, which is the signal we need.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) };
    if result == 0 {
        unsafe {
            libc::flock(file.as_raw_fd(), libc::LOCK_UN);
        }
        false
    } else {
        std::io::Error::last_os_error()
            .raw_os_error()
            .is_some_and(|code| code == libc::EWOULDBLOCK || code == libc::EAGAIN)
    }
}

#[allow(clippy::too_many_arguments)]
fn scan_rollouts(
    dir: &Path,
    depth: usize,
    open_ids: &HashSet<String>,
    authoritative: bool,
    launched_at: f64,
    visited: &mut usize,
    out: &mut Vec<PathBuf>,
) {
    if depth > MAX_SCAN_DEPTH || *visited >= MAX_ROLLOUT_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *visited >= MAX_ROLLOUT_FILES {
            break;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        let kind = metadata.file_type();
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            scan_rollouts(
                &path,
                depth + 1,
                open_ids,
                authoritative,
                launched_at,
                visited,
                out,
            );
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        *visited += 1;
        let Some(id) = rollout_id(&path) else {
            continue;
        };
        let candidate = if authoritative {
            open_ids.contains(id)
        } else {
            modified_secs(&metadata).is_some_and(|mtime| mtime >= launched_at)
        };
        if candidate {
            out.push(path);
        }
    }
}

fn rollout_id(path: &Path) -> Option<&str> {
    let name = path.file_name()?.to_str()?;
    let stem = name.strip_suffix(".jsonl")?;
    if !stem.starts_with("rollout-") || stem.len() < 36 {
        return None;
    }
    let id = &stem[stem.len() - 36..];
    (uuid::Uuid::parse_str(id).is_ok()).then_some(id)
}

fn parse_root_session(path: &Path, sessions_root: &Path) -> Option<DiscoveredCodexSession> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    let resolved = path.canonicalize().ok()?;
    if !resolved.starts_with(sessions_root) {
        return None;
    }
    let filename_id = rollout_id(&resolved)?;
    let file = open_no_follow(&resolved).ok()?;
    let mut first_line = String::new();
    let mut reader = BufReader::new(file.take(MAX_META_LINE_BYTES + 1));
    reader.read_line(&mut first_line).ok()?;
    if first_line.is_empty() || first_line.len() as u64 > MAX_META_LINE_BYTES {
        return None;
    }
    let root: Value = serde_json::from_str(&first_line).ok()?;
    if root.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let payload = root.get("payload")?;
    let id = payload
        .get("session_id")
        .or_else(|| payload.get("id"))
        .and_then(Value::as_str)?;
    if id != filename_id || security::validate_session_id(id).is_err() {
        return None;
    }
    // Root threads use a string source ("cli", "vscode", ...). Codex
    // subagents use a structured source object and must remain nested under
    // their parent card rather than becoming duplicate top-level sessions.
    let source = payload.get("source").and_then(Value::as_str)?;
    let workspace = payload.get("cwd").and_then(Value::as_str)?;
    let workspace = security::sanitize_workspace_path(workspace)
        .ok()?
        .to_string_lossy()
        .to_string();
    let started_at = payload
        .get("timestamp")
        .and_then(Value::as_str)
        .or_else(|| root.get("timestamp").and_then(Value::as_str))
        .and_then(parse_timestamp)
        .unwrap_or_else(|| modified_secs(&metadata).unwrap_or_default());
    let last_activity = modified_secs(&metadata).unwrap_or(started_at);

    Some(DiscoveredCodexSession {
        id: id.to_string(),
        workspace,
        transcript_path: resolved,
        started_at,
        last_activity,
        source: Some(source.to_string()),
    })
}

fn open_no_follow(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    options.open(path)
}

fn modified_secs(metadata: &fs::Metadata) -> Option<f64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs_f64())
}

fn parse_timestamp(raw: &str) -> Option<f64> {
    let parsed = chrono::DateTime::parse_from_rfc3339(raw).ok()?;
    Some(parsed.timestamp_micros() as f64 / 1_000_000.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "cue_codex_discovery_{name}_{}",
            uuid::Uuid::new_v4()
        ))
    }

    fn write_rollout(home: &Path, id: &str, source: Value) -> PathBuf {
        let dir = home.join("sessions/2026/08/26");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("rollout-2026-08-26T12-00-00-{id}.jsonl"));
        let record = serde_json::json!({
            "timestamp": "2026-08-26T19:00:00.000Z",
            "type": "session_meta",
            "payload": {
                "id": id,
                "session_id": id,
                "timestamp": "2026-08-26T19:00:00.000Z",
                "cwd": home,
                "source": source
            }
        });
        fs::write(&path, format!("{record}\n")).unwrap();
        path
    }

    #[cfg(unix)]
    fn held_lock(home: &Path, id: &str) -> File {
        use std::os::fd::AsRawFd;
        fs::create_dir_all(home.join("thread-writer-locks")).unwrap();
        let path = home.join("thread-writer-locks").join(format!("{id}.lock"));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .unwrap();
        assert_eq!(unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) }, 0);
        file
    }

    #[cfg(unix)]
    #[test]
    fn discovers_held_root_and_ignores_unlocked_thread() {
        let home = fixture("held_root");
        fs::create_dir_all(home.join("thread-writer-locks")).unwrap();
        let open_id = "01a03fc0-0b91-74a3-bfa4-ca850b36ad72";
        let closed_id = "11a03fc0-0b91-74a3-bfa4-ca850b36ad73";
        write_rollout(&home, open_id, Value::String("cli".into()));
        write_rollout(&home, closed_id, Value::String("cli".into()));
        let _lock = held_lock(&home, open_id);
        File::create(
            home.join("thread-writer-locks")
                .join(format!("{closed_id}.lock")),
        )
        .unwrap();

        let snapshot = discover_codex_sessions(&home, 0.0);
        assert!(snapshot.authoritative);
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.sessions[0].id, open_id);
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn skips_held_subagent_source_objects() {
        let home = fixture("subagent");
        let id = "21a03fc0-0b91-74a3-bfa4-ca850b36ad74";
        write_rollout(
            &home,
            id,
            serde_json::json!({"subagent": {"type": "spawn"}}),
        );
        let _lock = held_lock(&home, id);

        let snapshot = discover_codex_sessions(&home, 0.0);
        assert!(snapshot.authoritative);
        assert!(snapshot.sessions.is_empty());
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinked_rollout_and_oversized_metadata() {
        use std::os::unix::fs::symlink;

        let home = fixture("unsafe");
        let symlink_id = "31a03fc0-0b91-74a3-bfa4-ca850b36ad75";
        let oversized_id = "41a03fc0-0b91-74a3-bfa4-ca850b36ad76";
        let outside = fixture("outside");
        fs::create_dir_all(&outside).unwrap();
        let outside_rollout = write_rollout(&outside, symlink_id, Value::String("cli".into()));
        let target_dir = home.join("sessions/2026/08/26");
        fs::create_dir_all(&target_dir).unwrap();
        symlink(
            outside_rollout,
            target_dir.join(format!("rollout-2026-08-26T12-00-00-{symlink_id}.jsonl")),
        )
        .unwrap();
        let oversized =
            target_dir.join(format!("rollout-2026-08-26T12-00-00-{oversized_id}.jsonl"));
        let mut file = File::create(oversized).unwrap();
        file.write_all(&vec![b'x'; MAX_META_LINE_BYTES as usize + 1])
            .unwrap();
        let _symlink_lock = held_lock(&home, symlink_id);
        let _oversized_lock = held_lock(&home, oversized_id);

        let snapshot = discover_codex_sessions(&home, 0.0);
        assert!(snapshot.sessions.is_empty());
        fs::remove_dir_all(home).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
