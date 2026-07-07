//! Git status detection for workspace directories.
//!
//! Runs read-only git commands against the workspace to determine dirty state,
//! ahead/behind counts, and file statistics. All operations are synchronous
//! but fast (porcelain output is designed for machine parsing).

use crate::models::GitStatus;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Wall-clock ceiling for any single git subprocess. This module runs on the
/// 5s supplemental-refresh task (a single `spawn_blocking` the loop awaits), so
/// an indefinitely-hung git (stale `.git/index.lock`, stalled NFS/SMB/sshfs
/// mount, slow `core.fsmonitor`/credential helper) would otherwise freeze every
/// refresh — git status, rate limits, memory, config counts, JSONL metrics —
/// and leak the blocking thread. Bound each call instead.
const GIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Run a child process with a wall-clock timeout. stdout is drained on a
/// reader thread so output larger than the OS pipe buffer can't deadlock the
/// child while we poll for completion. Returns captured stdout only on a
/// successful exit within `timeout`; None on spawn failure, timeout, or
/// non-zero exit. On timeout the child is killed and reaped (no leak).
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Option<Vec<u8>> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });

    let deadline = Instant::now() + timeout;
    let exit = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };

    // The reader unblocks once the pipe closes (process exit or kill).
    let buf = reader.join().unwrap_or_default();
    match exit {
        Some(status) if status.success() => Some(buf),
        _ => None,
    }
}

/// Run `git <args>` in `workspace` with the module timeout, returning stdout on success.
///
/// Every invocation is hardened against a hostile checkout turning a read-only
/// `git` call into arbitrary code execution: `core.fsmonitor` and hook paths in
/// a repo-local `.git/config` are programs git will spawn during `status`/
/// `rev-list`. We pin `core.fsmonitor=false` and `core.hooksPath=/dev/null` via
/// leading `-c` flags (repo config can't override flags given on the command
/// line) so no repo-controlled program runs, and set `GIT_OPTIONAL_LOCKS=0` so
/// a status read never takes a lock / mutates the repo. The `-c` flags MUST
/// precede the subcommand, hence the prepend.
fn run_git(workspace: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    // Hardening (F-security-002): Cue polls git in every tracked workspace on a
    // timer with no user action. A workspace that carries an attacker-planted
    // `.git/config` (e.g. an archive/shared folder that includes `.git`) would
    // otherwise let `git status`/`rev-list` execute config-driven commands.
    // A `-c` on the git command line overrides both repo-local and global config,
    // so we neutralize every repo-config value git can spawn as a subprocess:
    //   - `core.fsmonitor` — spawned during `status`; pin false.
    //   - `core.hooksPath` — where git looks for hooks; point at /dev/null.
    //   - `core.alternateRefsCommand` — `rev-list` can execute it (higher
    //     preconditions, but zero-cost to neutralize); empty it.
    // `GIT_OPTIONAL_LOCKS=0` additionally stops status from taking/refreshing
    // the index lock, so background polling has no write side effects on the
    // user's repos.
    cmd.arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("core.hooksPath=/dev/null")
        .arg("-c")
        .arg("core.alternateRefsCommand=")
        .args(args)
        .current_dir(workspace)
        .env("GIT_OPTIONAL_LOCKS", "0");
    run_with_timeout(cmd, GIT_TIMEOUT).map(|b| String::from_utf8_lossy(&b).into_owned())
}

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
    if let Some(stdout) = run_git(workspace, &["status", "--porcelain"]) {
        parse_porcelain(&stdout, &mut status);
    }

    // git rev-list --count --left-right @{upstream}...HEAD for ahead/behind
    if let Some(stdout) = run_git(
        workspace,
        &["rev-list", "--count", "--left-right", "@{upstream}...HEAD"],
    ) {
        let stdout = stdout.trim();
        let parts: Vec<&str> = stdout.split('\t').collect();
        if parts.len() == 2 {
            status.behind = parts[0].parse().unwrap_or(0);
            status.ahead = parts[1].parse().unwrap_or(0);
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
            continue;
        }
        // Porcelain v1 is "XY <path>": X = index/staged column, Y = worktree
        // column, each independently signalling a change (e.g. "MM" = staged
        // AND worktree modified, "MD" = staged-modified + worktree-deleted,
        // "AM" = staged-added + worktree-modified). Count both columns —
        // previously Y was only read when X was blank, so combined statuses
        // were undercounted and worktree deletes in "MD" were missed.
        match x {
            b'A' => status.added += 1,
            b'D' => status.deleted += 1,
            b'M' | b'R' | b'C' => status.modified += 1,
            _ => {}
        }
        match y {
            b'M' => status.modified += 1,
            b'D' => status.deleted += 1,
            _ => {}
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
    fn test_parse_porcelain_combined_statuses() {
        // Combined index+worktree statuses must count BOTH columns.
        let output = "MM a.rs\nAM b.rs\nMD c.rs\n";
        let mut status = GitStatus::default();
        parse_porcelain(output, &mut status);
        // MM → modified+modified; AM → added+modified; MD → modified+deleted.
        assert_eq!(status.modified, 4, "MM(2)+AM(1)+MD(1)");
        assert_eq!(status.added, 1, "AM");
        assert_eq!(status.deleted, 1, "MD worktree delete");
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

    // F-reliability-002: a hung git must not freeze the refresh loop.
    #[cfg(unix)]
    #[test]
    fn test_run_with_timeout_kills_slow_process() {
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        let start = Instant::now();
        let out = run_with_timeout(cmd, Duration::from_millis(150));
        assert!(
            out.is_none(),
            "a process exceeding the timeout returns None"
        );
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "must return shortly after the deadline, not wait for the process to finish"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_run_with_timeout_captures_fast_process() {
        let mut cmd = Command::new("printf");
        cmd.arg("hello");
        let out = run_with_timeout(cmd, Duration::from_secs(5));
        assert_eq!(out.as_deref(), Some(&b"hello"[..]));
    }

    #[cfg(unix)]
    #[test]
    fn test_run_with_timeout_nonzero_exit_is_none() {
        let cmd = Command::new("false");
        let out = run_with_timeout(cmd, Duration::from_secs(5));
        assert!(out.is_none(), "non-zero exit yields None even when fast");
    }

    #[cfg(unix)]
    #[test]
    fn test_get_git_status_does_not_execute_repo_fsmonitor() {
        // F-security-002: a repo-local `core.fsmonitor` must NOT be executed by
        // Cue's background git polling. Build a real repo whose fsmonitor is a
        // command that would drop a marker file, run get_git_status, and assert
        // the marker never appears (the `-c core.fsmonitor=` override wins).
        use std::process::Command;
        // Skip gracefully if git is unavailable in the test environment.
        if Command::new("git")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| !s.success())
            .unwrap_or(true)
        {
            return;
        }

        let dir = std::env::temp_dir().join(format!("cue_test_fsmon_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ws = dir.to_string_lossy().into_owned();
        let marker = dir.join("PWNED");

        let git = |args: &[&str]| {
            Command::new("git")
                .args(args)
                .current_dir(&dir)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        };
        // Minimal repo with a commit so status/rev-list have something to read.
        assert!(git(&["init", "-q"]));
        let _ = git(&["config", "user.email", "t@t"]);
        let _ = git(&["config", "user.name", "t"]);
        std::fs::write(dir.join("f.txt"), "x").unwrap();
        let _ = git(&["add", "f.txt"]);
        let _ = git(&["commit", "-q", "-m", "init"]);
        // Plant the malicious repo-local fsmonitor command.
        let fsmon = format!("touch {}", marker.to_string_lossy());
        assert!(git(&["config", "core.fsmonitor", &fsmon]));
        // Make the tree dirty so `git status` actually queries fsmonitor.
        std::fs::write(dir.join("f.txt"), "y").unwrap();

        let _ = get_git_status(&ws);

        assert!(
            !marker.exists(),
            "core.fsmonitor command was executed by git polling — hardening failed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
