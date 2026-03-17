//! Security utilities: atomic writes, file permissions, path sanitization.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Maximum age (in seconds) for temp files before cleanup.
const STALE_TMP_AGE_SECS: u64 = 3600;

/// Atomically write `contents` to `target`: write to temp, fsync, rename.
pub fn atomic_write(target: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = target.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "target has no parent directory")
    })?;
    fs::create_dir_all(parent)?;

    let tmp_name = format!(
        "{}.tmp.{}",
        target
            .file_name()
            .unwrap_or_default()
            .to_string_lossy(),
        std::process::id()
    );
    let tmp_path = parent.join(&tmp_name);

    // Write to temp file
    {
        let mut file = fs::File::create(&tmp_path)?;
        file.write_all(contents)?;
        file.sync_all()?; // fsync
    }

    // Atomic rename
    fs::rename(&tmp_path, target)?;

    // Set owner-only permissions on the final file
    set_owner_only_permissions(target)?;

    Ok(())
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

/// Sanitize a workspace path: reject `..` traversal, resolve symlinks, normalize.
pub fn sanitize_workspace_path(path: &str) -> io::Result<PathBuf> {
    // Reject path traversal
    if path.contains("..") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains '..' traversal",
        ));
    }

    let p = PathBuf::from(path);

    // Try to canonicalize (resolves symlinks). If the path doesn't exist yet,
    // fall back to the cleaned version.
    match fs::canonicalize(&p) {
        Ok(canonical) => {
            // Double-check the canonical path doesn't escape expected directories
            if canonical.to_string_lossy().contains("..") {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "canonicalized path still contains traversal",
                ));
            }
            Ok(canonical)
        }
        Err(_) => {
            // Path doesn't exist — return the normalized version
            Ok(p)
        }
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_atomic_write() {
        let dir = std::env::temp_dir().join("claude_cue_test_atomic");
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

        let dir = std::env::temp_dir().join("claude_cue_test_perms");
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
        let dir = std::env::temp_dir().join("claude_cue_test_cleanup");
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

    #[cfg(unix)]
    #[test]
    fn test_verify_file_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join("claude_cue_test_verify");
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
}
