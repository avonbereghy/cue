//! Reachable, size-bounded file logging for the packaged app (F-observability-001).
//!
//! A Finder/Dock-launched `.app` has its stderr discarded by Launch Services,
//! and there is no supported way to inject `RUST_LOG` into that launch — so the
//! previous bare `env_logger::init()` sent every state-transition trace and
//! every anomaly (`warn!`/`error!`, the panic hook) into the void in the one
//! build users actually run. That is the amplifier that made wrong-state bugs
//! take weeks to diagnose: no captured evidence of which pass demoted a card.
//!
//! This module tees logs to a durable file under the OS log directory AND to
//! stderr (useful for `tauri dev`), at an `info` floor a user can raise to
//! `debug` without a terminal by creating a `CUE_DEBUG` marker file next to
//! `sessions.json` (or, for terminal runs, by setting `RUST_LOG`). The file is
//! rotated once at startup when it exceeds a cap, bounding disk use.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Max log-file size before startup rotation (bytes). On-disk footprint stays
/// bounded to ~2×this (the live file plus one rotated `.old`).
const LOG_CAP_BYTES: u64 = 5 * 1024 * 1024;

/// Decide the level-filter string. Precedence: an explicit non-empty `RUST_LOG`
/// (terminal power users) > the `CUE_DEBUG` marker (GUI users with no terminal)
/// > the default `info` floor (captures state traces + anomalies, not the 1 Hz
/// tick spam which stays at `debug`).
fn resolve_filter(rust_log: Option<&str>, cue_debug: bool) -> String {
    if let Some(v) = rust_log {
        if !v.is_empty() {
            return v.to_string();
        }
    }
    if cue_debug {
        // Raise Cue's own crates to debug; keep dependencies at info.
        return "cue_desktop_lib=debug,info".to_string();
    }
    "info".to_string()
}

/// Sibling `<path>.old` used for the single rotation slot.
fn rotated_path(path: &Path) -> PathBuf {
    let mut s = path.to_path_buf().into_os_string();
    s.push(".old");
    PathBuf::from(s)
}

/// If `path` exists and exceeds `cap`, move it aside to `<path>.old`
/// (overwriting any prior rotation) so the log can't grow without bound.
fn rotate_if_oversized(path: &Path, cap: u64) {
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() > cap {
            let _ = fs::rename(path, rotated_path(path));
        }
    }
}

/// Writer that fans each log line out to both stderr and (best-effort) the log
/// file. stderr is harmless when it's void (packaged app) and visible in dev;
/// the file is the durable sink. Neither failure aborts logging.
struct Tee {
    file: Option<File>,
}

impl Write for Tee {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let _ = io::stderr().write_all(buf);
        if let Some(f) = self.file.as_mut() {
            let _ = f.write_all(buf);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        let _ = io::stderr().flush();
        if let Some(f) = self.file.as_mut() {
            let _ = f.flush();
        }
        Ok(())
    }
}

/// Initialize logging. Idempotent-safe (`try_init` won't panic if a logger is
/// already installed). Replaces the bare `env_logger::init()`.
pub fn init() {
    let path = crate::paths::log_file_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    rotate_if_oversized(&path, LOG_CAP_BYTES);

    let file = OpenOptions::new().create(true).append(true).open(&path).ok();
    // The log can carry session ids and workspace paths; keep it owner-only,
    // matching the 0600 posture of sessions.json.
    #[cfg(unix)]
    if let Some(ref f) = file {
        use std::os::unix::fs::PermissionsExt;
        let _ = f.set_permissions(fs::Permissions::from_mode(0o600));
    }

    let cue_debug =
        crate::paths::debug_marker_path().exists() || std::env::var_os("CUE_DEBUG").is_some();
    let filter = resolve_filter(std::env::var("RUST_LOG").ok().as_deref(), cue_debug);

    let mut builder = env_logger::Builder::new();
    builder.parse_filters(&filter);
    builder.format(|buf, record| {
        writeln!(
            buf,
            "[{} {:>5} {}] {}",
            buf.timestamp(),
            record.level(),
            record.target(),
            record.args()
        )
    });
    builder.target(env_logger::Target::Pipe(Box::new(Tee { file })));
    let _ = builder.try_init();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_filter_rust_log_wins() {
        assert_eq!(
            resolve_filter(Some("cue_desktop_lib=trace"), true),
            "cue_desktop_lib=trace"
        );
    }

    #[test]
    fn test_resolve_filter_empty_rust_log_ignored() {
        // An empty RUST_LOG must not shadow the CUE_DEBUG marker.
        assert_eq!(resolve_filter(Some(""), true), "cue_desktop_lib=debug,info");
    }

    #[test]
    fn test_resolve_filter_cue_debug_marker() {
        assert_eq!(resolve_filter(None, true), "cue_desktop_lib=debug,info");
    }

    #[test]
    fn test_resolve_filter_default_info() {
        assert_eq!(resolve_filter(None, false), "info");
    }

    #[test]
    fn test_rotate_moves_oversized_file() {
        let dir = std::env::temp_dir().join(format!("cue_test_logrot_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cue.log");
        fs::write(&path, vec![b'x'; 100]).unwrap();

        // Cap above size → no rotation.
        rotate_if_oversized(&path, 1000);
        assert!(path.exists());
        assert!(!rotated_path(&path).exists());

        // Cap below size → rotate to .old, original gone.
        rotate_if_oversized(&path, 10);
        assert!(!path.exists());
        assert!(rotated_path(&path).exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_rotate_noop_when_absent() {
        let dir = std::env::temp_dir().join(format!("cue_test_lognoop_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("cue.log");
        // Must not panic when the file doesn't exist yet.
        rotate_if_oversized(&path, 10);
        assert!(!path.exists());
    }
}
