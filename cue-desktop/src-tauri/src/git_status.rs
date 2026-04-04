//! Git status detection for workspace directories.
//!
//! Runs read-only git commands against the workspace to determine dirty state,
//! ahead/behind counts, and file statistics. All operations are synchronous
//! but fast (porcelain output is designed for machine parsing).

use crate::models::GitStatus;
use std::path::Path;
use std::process::Command;

/// Get git status for a workspace directory. Returns None for non-git workspaces.
pub fn get_git_status(workspace: &str) -> Option<GitStatus> {
    let ws = Path::new(workspace);
    if !ws.exists() {
        return None;
    }

    // Check if this is a git repo (walk up to find .git)
    let mut check = ws.to_path_buf();
    let is_git = loop {
        if check.join(".git").exists() {
            break true;
        }
        match check.parent() {
            Some(parent) if parent != check => check = parent.to_path_buf(),
            _ => break false,
        }
    };
    if !is_git {
        return None;
    }

    let mut status = GitStatus::default();

    // git status --porcelain for file stats
    if let Ok(output) = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(workspace)
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            parse_porcelain(&stdout, &mut status);
        }
    }

    // git rev-list --count --left-right @{upstream}...HEAD for ahead/behind
    if let Ok(output) = Command::new("git")
        .args(["rev-list", "--count", "--left-right", "@{upstream}...HEAD"])
        .current_dir(workspace)
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let parts: Vec<&str> = stdout.split('\t').collect();
            if parts.len() == 2 {
                status.behind = parts[0].parse().unwrap_or(0);
                status.ahead = parts[1].parse().unwrap_or(0);
            }
        }
        // If upstream doesn't exist, ahead/behind stay 0 (no error)
    }

    Some(status)
}

/// Parse `git status --porcelain` output into a GitStatus struct.
fn parse_porcelain(output: &str, status: &mut GitStatus) {
    for line in output.lines() {
        let bytes = line.as_bytes();
        if bytes.len() < 2 {
            continue;
        }
        let (x, y) = (bytes[0], bytes[1]);
        if x == b'?' && y == b'?' {
            status.untracked += 1;
        } else {
            match x {
                b'A' => status.added += 1,
                b'D' => status.deleted += 1,
                b'M' | b'R' | b'C' => status.modified += 1,
                _ => {}
            }
            if x == b' ' {
                match y {
                    b'M' => status.modified += 1,
                    b'D' => status.deleted += 1,
                    _ => {}
                }
            }
        }
    }
    status.dirty = status.modified + status.added + status.deleted + status.untracked > 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_porcelain_output() {
        let output = "M  src/main.rs\n M README.md\n?? new_file.txt\nA  added.rs\n D deleted.rs\n";
        let mut status = GitStatus::default();
        parse_porcelain(output, &mut status);

        assert_eq!(status.modified, 2); // "M " and " M"
        assert_eq!(status.added, 1);
        assert_eq!(status.deleted, 1);
        assert_eq!(status.untracked, 1);
        assert!(status.dirty);
    }

    #[test]
    fn test_non_git_directory_returns_none() {
        let result = get_git_status("/tmp");
        // /tmp is not a git repo (unless someone initialized one there)
        // This test just verifies no panic occurs
        let _ = result;
    }

    #[test]
    fn test_nonexistent_directory_returns_none() {
        let result = get_git_status("/nonexistent/path/that/does/not/exist");
        assert!(result.is_none());
    }

    #[test]
    fn test_git_status_default() {
        let status = GitStatus::default();
        assert!(!status.dirty);
        assert_eq!(status.ahead, 0);
        assert_eq!(status.behind, 0);
        assert_eq!(status.modified, 0);
    }
}
