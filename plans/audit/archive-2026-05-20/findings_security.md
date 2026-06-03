# Security Findings

## Summary
The Rust backend sanitizes `workspace` and uses `O_NOFOLLOW` on the JSONL tail-reader, but skips equivalent validation on `session_id`, which becomes a path component. Two additional high issues: the Rust read of `sessions.json` has no size cap (single-allocation DoS), and the localhost permission HTTP server is unauthenticated.

## Findings

### F-security-001: Untrusted `session_id` is used as a path component without validation
- **Severity:** high
- **Confidence:** 90
- **Files:** cue-desktop/src-tauri/src/session_monitor.rs:777-889, 131-166; hooks/cue-hook:483
- **What:** `jsonl_path` / `jsonl_exists_on_disk` build `projects_path.join(encoded_workspace).join(format!("{}.jsonl", session_id))`. `session_id` comes from `sessions.json` (untrusted per CLAUDE.md). `poll_status` validates `workspace` (line 163) but not `id`. `Path::join` resets to absolute when given an absolute fragment, and tolerates `..` traversal. Derived `subagents/` directory at `parent.join(session_stem).join("subagents")` is also influenced, and `parse_jsonl_file` (jsonl_parser.rs:119) uses `read_to_string` without symlink guard.
- **Why it matters:** A writer of sessions.json can force the backend to read any file the user can read (SSH keys, secrets) and surface contents in `SessionMetrics` (crossing IPC to the frontend).
- **Suggested fix:** Add `validate_session_id` to security.rs (UUID-like regex `[A-Za-z0-9_-]{1,128}`, reject `/ \ ..` and leading `.`). Call from `poll_status` admission filter; reject in Python hook before write; add defense-in-depth check in `jsonl_path`.
- **Verification:** `grep -n 'validate_session_id' cue-desktop/src-tauri/src/security.rs` shows the helper; `cargo test validate_session_id` covers traversal cases.

### F-security-002: Rust reads `sessions.json` with no size cap
- **Severity:** high
- **Confidence:** 85
- **Files:** cue-desktop/src-tauri/src/session_monitor.rs:134; hooks/cue-hook:122-143
- **What:** `read_to_string(&status_path)` runs every poll with no limit. JSONL parser caps at 500 MB but sessions.json has no ceiling. `_validate_sessions` checks shape but not value-length.
- **Why it matters:** A 1+ GB sessions.json OOMs the backend and freezes the UI. Even 200 MB causes per-poll allocation churn.
- **Suggested fix:** `metadata().len()` check against 4 MiB cap, read via `File::take(cap).read_to_string`. On excess, log and preserve previous enriched list. Tighten `_validate_sessions` to per-field length caps.
- **Verification:** Test writes 10 MiB sessions.json, asserts `poll_status` doesn't panic and prior state is preserved.

### F-security-003: Unauthenticated localhost permission HTTP grants arbitrary allow/deny
- **Severity:** high
- **Confidence:** 80
- **Files:** hooks/cue-hook:229-257, 524-533
- **What:** Hook POSTs to `127.0.0.1:3002/permission-request` and pipes response to stdout for Claude Code. No token, no nonce. Any local process can answer `{"decision":"allow"}`.
- **Why it matters:** Forges allow on tool-call permission prompts — authorization-bypass primitive equivalent to RCE.
- **Suggested fix:** Switch to unix-domain socket in STATUS_DIR (0700), or generate a per-launch random token persisted to a 0600 file in STATUS_DIR; hook reads, server rejects unauthenticated requests. Validate response payload shape.
- **Verification:** `nc -l 3002` while Cue offline, trigger permission, confirm hook rejects unauthenticated forged response.

## Out of scope
- `parse_jsonl_file` follows symlinks (jsonl_parser.rs:119); subagent enumeration uses unguarded variant — medium.
- Hook lockfile/dir permissions (cue-hook:156, 513, 537) inherit default umask — medium.
- Workspace string length not bounded (covered partially by F-002).
- `encode_workspace_path` `/`→`-` collisions enable post-dedup workspace overwrite — medium.
- `atomic_write` tmp filename leaks writer PID (security.rs:33) — low.
- `.lock().unwrap()` panics poison locks — reliability concern.
- `permission_mode` not validated against enum — misuse trap, not security.
