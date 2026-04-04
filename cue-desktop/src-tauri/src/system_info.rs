//! System information: RAM usage and Claude Code version detection.

use crate::models::SystemMemory;

/// Get current system memory usage using a cached System instance.
pub fn get_system_memory_with(sys: &mut sysinfo::System) -> SystemMemory {
    sys.refresh_memory();
    let total = sys.total_memory() / (1024 * 1024); // bytes → MB
    // Use available_memory() to match Activity Monitor: used = total - available
    // sysinfo's used_memory() includes file cache which inflates the number.
    let available = sys.available_memory() / (1024 * 1024);
    let used = total.saturating_sub(available);
    SystemMemory {
        total_mb: total,
        used_mb: used,
        usage_percent: if total > 0 {
            used as f64 / total as f64 * 100.0
        } else {
            0.0
        },
    }
}

/// Get current system memory usage (creates a temporary System instance).
pub fn get_system_memory() -> SystemMemory {
    let mut sys = sysinfo::System::new();
    get_system_memory_with(&mut sys)
}

/// Detect Claude Code version by running `claude --version`.
/// Returns None if the binary is not found or fails.
pub fn get_claude_version() -> Option<String> {
    std::process::Command::new("claude")
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                let raw = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if raw.is_empty() {
                    None
                } else {
                    Some(raw)
                }
            } else {
                None
            }
        })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_system_memory_returns_nonzero() {
        let mem = get_system_memory();
        assert!(mem.total_mb > 0, "total_mb should be positive");
        assert!(mem.usage_percent >= 0.0);
        assert!(mem.usage_percent <= 100.0);
    }

    #[test]
    fn test_claude_version_no_panic() {
        // May return None if claude is not installed, but should not panic
        let _ = get_claude_version();
    }
}
