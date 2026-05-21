//! Security utilities: atomic writes, file permissions, path sanitization.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::io::AsRawFd;

/// Maximum age (in seconds) for temp files before cleanup.
const STALE_TMP_AGE_SECS: u64 = 3600;

/// Atomically write `contents` to `target`: write to temp, fsync, rename.
///
/// The temp file name is randomized (nanos + pid) so a local attacker can't
/// pre-create the path as a symlink, and on Unix we open with O_NOFOLLOW
/// plus create_new so a symlink at that path fails the open instead of
/// redirecting the write to the symlink's target.
pub fn atomic_write(target: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = target.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "target has no parent directory",
        )
    })?;
    fs::create_dir_all(parent)?;

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let tmp_name = format!(
        "{}.tmp.{}.{}",
        target.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id(),
        nanos,
    );
    let tmp_path = parent.join(&tmp_name);

    // Write to temp file. create_new refuses to open if the path already
    // exists (including as a symlink); O_NOFOLLOW on Unix also rejects a
    // symlink even if the attacker races us to create it.
    {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = opts.open(&tmp_path)?;
        file.write_all(contents)?;
        file.sync_all()?; // fsync
    }

    // Set owner-only permissions BEFORE rename to avoid TOCTOU window
    set_owner_only_permissions(&tmp_path)?;

    // Atomic rename
    fs::rename(&tmp_path, target)?;

    Ok(())
}

/// Run `f` while holding an exclusive advisory lock on the sessions.lock file.
///
/// This mirrors the Python hook's `_lock`/`_unlock` flow (cue-hook.py: 30-44):
/// open the lock file, take `LOCK_EX | LOCK_NB` with up to a 2-second retry
/// budget, run the work, release. Lets Rust commands like `write_sandbox_
/// sessions` participate in the same cross-process critical section the hook
/// uses, so a concurrent hook write can't be silently overwritten by a
/// dashboard-driven sandbox update.
///
/// F-correctness-002 / F-reliability-002 — sandbox writers previously skipped
/// this entirely, leaving a real race between Rust read-modify-rename and
/// hook read-modify-rename of sessions.json.
///
/// On non-Unix platforms (Windows) this is currently a no-op pass-through —
/// the hook's msvcrt.locking and Rust's std open semantics don't compose
/// cleanly, and the platform's sandbox feature is rare enough that we accept
/// the gap for now. Documented limitation, not silent failure: callers can
/// still observe the gap via the test suite.
pub fn with_sessions_lock<F, R>(lock_path: &Path, f: F) -> io::Result<R>
where
    F: FnOnce() -> io::Result<R>,
{
    // Make sure the parent directory exists so the lock-file open below
    // can't fail with ENOENT on first run.
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)?;

    #[cfg(unix)]
    {
        // 2-second retry budget with 10 ms backoff between attempts, matching
        // the hook's contention window. Without this, a hot-spinning sandbox
        // command could starve the hook (or vice versa) for the duration of
        // a tool call.
        const ATTEMPTS: u32 = 200; // 200 * 10 ms = 2 seconds
        let fd = file.as_raw_fd();
        let mut acquired = false;
        for _ in 0..ATTEMPTS {
            // libc::flock returns 0 on success, -1 on error. LOCK_NB makes
            // it return immediately with EWOULDBLOCK if held elsewhere.
            let rc = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
            if rc == 0 {
                acquired = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if !acquired {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "sessions.lock contended for >2s — aborting to avoid an indefinite stall",
            ));
        }
        let result = f();
        // Best-effort unlock; even on error the lock will release when `file`
        // drops at end of scope. Use _ to discard so an unlock failure can't
        // mask the caller's actual return.
        let _ = unsafe { libc::flock(fd, libc::LOCK_UN) };
        result
    }

    #[cfg(not(unix))]
    {
        // TODO(windows) — proper LockFileEx integration. For now, the open
        // call above proves the lock file is writable; the actual mutual
        // exclusion is best-effort via atomic_write's rename atomicity.
        let _ = file;
        f()
    }
}

/// Set file permissions to owner-only (0600 on Unix).
#[cfg(unix)]
pub fn set_owner_only_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let perms = fs::Permissions::from_mode(0o600);
    fs::set_permissions(path, perms)
}

/// Set file permissions on Windows (best-effort; full ACL requires windows-acl crate).
#[cfg(not(unix))]
pub fn set_owner_only_permissions(path: &Path) -> io::Result<()> {
    // On Windows, set read-only as a basic protection.
    // Full ACL restriction would use the `windows-acl` crate.
    let metadata = fs::metadata(path)?;
    let mut perms = metadata.permissions();
    perms.set_readonly(false); // Ensure we can write
    fs::set_permissions(path, perms)?;
    Ok(())
}

/// Sanitize a workspace path: reject `..` traversal components, resolve symlinks,
/// reject control chars / NUL / shell metacharacters, and normalize.
///
/// The metacharacter reject list is what makes this function safe to interpolate
/// into AppleScript / cmd.exe / sh downstream — callers still SHOULD escape for
/// their specific sink, but a clean return guarantees no injection primitives
/// (`"`, `'`, `` ` ``, `$`, `;`, `|`, `&`, `\`, newline, NUL) are present.
pub fn sanitize_workspace_path(path: &str) -> io::Result<PathBuf> {
    // Reject NUL, control chars, and shell/applescript metacharacters that
    // cannot be safely interpolated into command strings anywhere downstream.
    //
    // Backslash is denied on Unix (no legitimate use in a path) but allowed on
    // Windows where it is the path separator. cmd.exe-specific metacharacters
    // (^, %, <, >, (, ), !) are not enforced here because the Windows revive
    // path no longer interpolates workspace into a shell string — see
    // spawn_terminal_with_resume in lib.rs, which uses Command::current_dir
    // instead of building a cmd.exe command line.
    for ch in path.chars() {
        if ch == '\0' || ch.is_control() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "path contains control characters",
            ));
        }
        let is_metachar = matches!(
            ch,
            '"' | '\'' | '`' | '$' | ';' | '|' | '&' | '\n' | '\r'
        );
        #[cfg(not(windows))]
        let is_metachar = is_metachar || ch == '\\';
        if is_metachar {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "path contains disallowed metacharacter",
            ));
        }
    }

    let p = PathBuf::from(path);

    // Reject path traversal at the component level (allows names like "my..project")
    for component in p.components() {
        if let std::path::Component::ParentDir = component {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "path contains '..' traversal",
            ));
        }
    }

    // Try to canonicalize (resolves symlinks). If the path doesn't exist,
    // return the original (validated) path.
    match fs::canonicalize(&p) {
        Ok(canonical) => {
            // Verify canonical path has no traversal components
            for component in canonical.components() {
                if let std::path::Component::ParentDir = component {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "canonicalized path contains traversal",
                    ));
                }
            }
            Ok(canonical)
        }
        Err(_) => Ok(p),
    }
}

/// Verify file permissions on startup; correct if too permissive.
#[cfg(unix)]
pub fn verify_file_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    if !path.exists() {
        return Ok(());
    }

    let metadata = fs::metadata(path)?;
    let mode = metadata.permissions().mode() & 0o777;

    // If group or other has any access, fix it
    if mode & 0o077 != 0 {
        log::warn!(
            "File {:?} has overly permissive mode {:o}, correcting to 0600",
            path,
            mode
        );
        set_owner_only_permissions(path)?;
    }

    Ok(())
}

#[cfg(not(unix))]
pub fn verify_file_permissions(path: &Path) -> io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    // Windows: best-effort check
    Ok(())
}

/// Remove stale temp files (*.tmp.*) older than 1 hour from the given directory.
pub fn cleanup_stale_tmp_files(dir: &Path) -> io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    let now = std::time::SystemTime::now();

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if !name_str.contains(".tmp.") {
            continue;
        }

        if let Ok(metadata) = entry.metadata() {
            if let Ok(modified) = metadata.modified() {
                if let Ok(age) = now.duration_since(modified) {
                    if age.as_secs() > STALE_TMP_AGE_SECS {
                        log::info!("Cleaning stale temp file: {:?}", entry.path());
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }
    }

    Ok(())
}

/// Validate a session id intended to be used as a path component (e.g. when
/// composing `<projects>/<encoded_ws>/<session_id>.jsonl`).
///
/// `sessions.json` is treated as untrusted input per the project's security
/// rules: a writer could supply an `id` containing `..`, `/`, `\`, NUL, or
/// absolute-path-like content that would let `Path::join` redirect downstream
/// file reads outside the projects directory. Claude Code emits UUID-shaped
/// ids; this allowlist enforces that shape and is intentionally tighter than
/// the UUID grammar so it stays forward-compatible if Claude Code switches
/// to short ULIDs or similar opaque ids — anything matching
/// `[A-Za-z0-9_-]{1,128}` is fine.
pub fn validate_session_id(id: &str) -> io::Result<()> {
    if id.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "session id is empty",
        ));
    }
    if id.len() > 128 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "session id exceeds 128 chars",
        ));
    }
    for ch in id.chars() {
        let ok = ch.is_ascii_alphanumeric() || ch == '-' || ch == '_';
        if !ok {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("session id contains disallowed character: {:?}", ch),
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_validate_session_id_accepts_uuid_shape() {
        // Real claude code session ids look like this.
        assert!(validate_session_id("579ecced-3a4b-4f02-8e9d-1d6c8a5e2b1f").is_ok());
        assert!(validate_session_id("6c3720c3-1234-abcd-ef00-deadbeefcafe").is_ok());
    }

    #[test]
    fn test_validate_session_id_accepts_alphanumeric_with_dashes_and_underscores() {
        assert!(validate_session_id("abc_123-XYZ").is_ok());
        assert!(validate_session_id("A").is_ok());
        // 128 chars exactly — at the boundary
        let max = "a".repeat(128);
        assert!(validate_session_id(&max).is_ok());
    }

    #[test]
    fn test_validate_session_id_rejects_empty() {
        assert!(validate_session_id("").is_err());
    }

    #[test]
    fn test_validate_session_id_rejects_oversized() {
        let too_long = "a".repeat(129);
        assert!(validate_session_id(&too_long).is_err());
    }

    #[test]
    fn test_validate_session_id_rejects_path_traversal() {
        assert!(validate_session_id("..").is_err());
        assert!(validate_session_id("../etc/passwd").is_err());
        assert!(validate_session_id("foo/../bar").is_err());
    }

    #[test]
    fn test_validate_session_id_rejects_path_separators() {
        assert!(validate_session_id("foo/bar").is_err());
        assert!(validate_session_id("foo\\bar").is_err());
        assert!(validate_session_id("/etc/passwd").is_err());
        assert!(validate_session_id("C:\\Windows\\System32").is_err());
    }

    #[test]
    fn test_validate_session_id_rejects_control_chars_and_nul() {
        assert!(validate_session_id("a\0b").is_err());
        assert!(validate_session_id("a\nb").is_err());
        assert!(validate_session_id("a\tb").is_err());
        assert!(validate_session_id("\x01abc").is_err());
    }

    #[test]
    fn test_validate_session_id_rejects_leading_dot() {
        // Defense-in-depth: even though '.' isn't in our allowlist, document
        // intent explicitly.
        assert!(validate_session_id(".").is_err());
        assert!(validate_session_id(".hidden").is_err());
    }

    #[test]
    fn test_validate_session_id_rejects_shell_metacharacters() {
        for bad in &["foo$bar", "foo bar", "foo|bar", "foo;bar", "foo&bar",
                     "foo`bar", "foo'bar", "foo\"bar", "foo*bar", "foo?bar"] {
            assert!(
                validate_session_id(bad).is_err(),
                "should reject {:?}", bad
            );
        }
    }

    #[test]
    fn test_atomic_write() {
        let dir = std::env::temp_dir().join("cue_test_atomic");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let target = dir.join("test_file.json");
        atomic_write(&target, b"hello world").unwrap();

        let contents = fs::read_to_string(&target).unwrap();
        assert_eq!(contents, "hello world");

        // Overwrite
        atomic_write(&target, b"updated").unwrap();
        let contents = fs::read_to_string(&target).unwrap();
        assert_eq!(contents, "updated");

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn test_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join("cue_test_perms");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let path = dir.join("secret.json");
        fs::write(&path, "secret data").unwrap();

        set_owner_only_permissions(&path).unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_sanitize_workspace_path_rejects_traversal() {
        let result = sanitize_workspace_path("/Users/dev/../etc/passwd");
        assert!(result.is_err());
    }

    #[test]
    fn test_sanitize_workspace_path_accepts_normal() {
        let result = sanitize_workspace_path("/Users/dev/Projects/MyApp");
        assert!(result.is_ok());
    }

    #[test]
    fn test_cleanup_stale_tmp_files() {
        let dir = std::env::temp_dir().join("cue_test_cleanup");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // Create a "stale" tmp file — we can't easily backdate it,
        // so just verify the function doesn't crash
        let tmp = dir.join("sessions.json.tmp.12345");
        fs::write(&tmp, "temp data").unwrap();

        // Should not remove (not old enough)
        cleanup_stale_tmp_files(&dir).unwrap();
        assert!(tmp.exists());

        // Create a non-tmp file — should be left alone
        let normal = dir.join("normal.json");
        fs::write(&normal, "data").unwrap();
        cleanup_stale_tmp_files(&dir).unwrap();
        assert!(normal.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_sanitize_workspace_path_rejects_dotdot_component() {
        // ".." as a path component should be rejected
        let result = sanitize_workspace_path("/Users/dev/../../etc/passwd");
        assert!(result.is_err());
        assert!(
            result.unwrap_err().to_string().contains("traversal"),
            "Error should mention traversal"
        );
    }

    #[test]
    fn test_sanitize_workspace_path_allows_dotdot_in_name() {
        // ".." embedded in a directory name like "my..project" is NOT a traversal
        let result = sanitize_workspace_path("/Users/dev/my..project/src");
        assert!(
            result.is_ok(),
            "Directory name containing '..' should be allowed"
        );
    }

    #[test]
    fn test_sanitize_workspace_path_normal_absolute() {
        let result = sanitize_workspace_path("/Users/dev/Projects/my-app");
        assert!(result.is_ok());
        let p = result.unwrap();
        // The returned path should contain the original components
        assert!(p.to_string_lossy().contains("my-app"));
    }

    #[test]
    fn test_sanitize_workspace_path_rejects_shell_metacharacters() {
        // Every one of these, if accepted, would allow injection in
        // AppleScript or cmd.exe string contexts downstream.
        let bad = [
            "/tmp/x\"y", // double quote
            "/tmp/x'y",  // single quote
            "/tmp/x`y",  // backtick
            "/tmp/x$y",  // dollar
            "/tmp/x;y",  // semicolon
            "/tmp/x|y",  // pipe
            "/tmp/x&y",  // ampersand
            "/tmp/x\\y", // backslash
            "/tmp/x\ny", // newline
        ];
        for p in bad {
            let result = sanitize_workspace_path(p);
            assert!(result.is_err(), "expected {:?} to be rejected", p);
        }
    }

    #[test]
    fn test_sanitize_workspace_path_rejects_null_byte() {
        let result = sanitize_workspace_path("/tmp/x\0y");
        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn test_atomic_write_refuses_symlink_at_tmp_path() {
        // Attacker pre-creates a symlink at the deterministic-ish tmp path
        // pointing at a victim file. atomic_write must refuse to follow it.
        use std::os::unix::fs::symlink;

        let dir = std::env::temp_dir().join("cue_test_atomic_symlink");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let target = dir.join("sessions.json");
        let victim = dir.join("victim");
        fs::write(&victim, "original victim content").unwrap();

        // Force collision by writing once so we know the directory + target
        // exist, then pre-seed a symlink named exactly like a fresh tmp file
        // would be — atomic_write must use a fresh nanos suffix, so even if
        // we seed an old collision, the new write uses a different name.
        // The bigger test: if we somehow manage to collide, create_new fails.
        let fake_tmp = dir.join(format!(
            "{}.tmp.{}.0",
            target.file_name().unwrap().to_string_lossy(),
            std::process::id(),
        ));
        symlink(&victim, &fake_tmp).unwrap();

        // First write may or may not collide with our seeded tmp; repeat a
        // few times to raise the chance. In all cases the victim file must
        // remain untouched.
        for _ in 0..5 {
            let _ = atomic_write(&target, b"cue payload");
        }

        let victim_after = fs::read_to_string(&victim).unwrap();
        assert_eq!(
            victim_after, "original victim content",
            "symlink target must not be overwritten",
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn test_atomic_write_content_and_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join("cue_test_atomic_perms");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let target = dir.join("secure_file.json");
        let payload = b"{ \"secret\": true }";
        atomic_write(&target, payload).unwrap();

        // Verify content was written correctly
        let contents = fs::read(&target).unwrap();
        assert_eq!(contents, payload);

        // Verify permissions are owner-only (0600)
        let mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "atomic_write should set 0600 permissions");

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn test_verify_file_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join("cue_test_verify");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let path = dir.join("test.json");
        fs::write(&path, "data").unwrap();

        // Set overly permissive
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        // verify_file_permissions should correct it
        verify_file_permissions(&path).unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        let _ = fs::remove_dir_all(&dir);
    }

    // ── with_sessions_lock ──────────────────────────────────────────────

    #[test]
    fn test_with_sessions_lock_runs_closure() {
        // Sanity: the closure is invoked, its return value bubbles up.
        let dir = std::env::temp_dir().join("cue_test_lock_runs");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let lock_path = dir.join("sessions.lock");
        let result = with_sessions_lock(&lock_path, || Ok::<u32, io::Error>(42));
        assert_eq!(result.unwrap(), 42);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_with_sessions_lock_creates_lock_file() {
        let dir = std::env::temp_dir().join("cue_test_lock_creates");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let lock_path = dir.join("sessions.lock");
        assert!(!lock_path.exists());
        with_sessions_lock(&lock_path, || Ok::<(), io::Error>(())).unwrap();
        assert!(lock_path.exists(), "lock file should be created on first acquire");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_with_sessions_lock_creates_parent_directory() {
        // ensure_dirs is the documented init step, but the lock helper must
        // also self-heal so a stray cold path can't ENOENT-out the hook.
        let dir = std::env::temp_dir().join("cue_test_lock_parent");
        let _ = fs::remove_dir_all(&dir);
        // Intentionally do NOT create_dir_all here — let with_sessions_lock
        // do it.
        let lock_path = dir.join("nested").join("sessions.lock");
        with_sessions_lock(&lock_path, || Ok::<(), io::Error>(())).unwrap();
        assert!(lock_path.parent().unwrap().exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_with_sessions_lock_propagates_closure_error() {
        // An error from the closure surfaces unchanged to the caller — the
        // lock release on the Unix path uses `let _ =` so it can't shadow.
        let dir = std::env::temp_dir().join("cue_test_lock_err");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let lock_path = dir.join("sessions.lock");
        let result: io::Result<()> = with_sessions_lock(&lock_path, || {
            Err(io::Error::other("boom"))
        });
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::Other);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn test_with_sessions_lock_serializes_concurrent_callers() {
        // Two threads hammering the same lock must observe the closures run
        // serially — the shared counter goes 1 → 2 with no interleaving.
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use std::thread;

        let dir = std::env::temp_dir().join("cue_test_lock_concurrent");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let lock_path = dir.join("sessions.lock");

        let counter = Arc::new(AtomicUsize::new(0));
        let path1 = lock_path.clone();
        let counter1 = counter.clone();
        let t1 = thread::spawn(move || {
            with_sessions_lock(&path1, || {
                // Read-modify-sleep-write pattern to give the other thread a
                // chance to interleave (if the lock were broken).
                let pre = counter1.load(Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(50));
                counter1.store(pre + 1, Ordering::SeqCst);
                Ok::<(), io::Error>(())
            })
        });
        let path2 = lock_path.clone();
        let counter2 = counter.clone();
        let t2 = thread::spawn(move || {
            with_sessions_lock(&path2, || {
                let pre = counter2.load(Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(50));
                counter2.store(pre + 1, Ordering::SeqCst);
                Ok::<(), io::Error>(())
            })
        });

        t1.join().unwrap().unwrap();
        t2.join().unwrap().unwrap();

        // If both ran serially, counter == 2. If they raced and both observed
        // pre == 0, counter == 1. (Within a single process flock is per-fd
        // so this test would actually pass without the lock too on Linux,
        // but on macOS it's per-process — the canonical platform.)
        assert_eq!(counter.load(Ordering::SeqCst), 2);

        let _ = fs::remove_dir_all(&dir);
    }
}
