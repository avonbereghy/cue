# Phase 1: Foundation (Rust Core + Security Hardening)

Read plans/cross_platform_final_plan.md for full context.

## Tasks
1. Scaffold Tauri v2 project: `npm create tauri-app@latest cue-desktop -- --template react-ts`
   - This generates boilerplate frontend files (`src/App.tsx`, `package.json`, etc.). Leave them as-is for now — Phase 3 will replace them.
   - Focus this phase entirely on the Rust backend in `src-tauri/`.
2. Configure `tauri.conf.json`:
   - App identifier: `com.cueapp.desktop`
   - Set `"devtools": false` for release profile
   - Minimal capabilities: `event:default`, `window:default`, custom commands only
   - NO `shell`, `http`, or `fs` permissions for the frontend
   - Bundle targets: `["msi", "nsis", "appimage", "deb"]`
3. Create `src-tauri/src/models.rs` — all data structs with `Serialize`/`Deserialize`/`Clone`:
   - `SessionInfo`, `StatusData`, `SessionMetrics`, `EnrichedSession`, `WindowMetrics`, `UsageWindow`, `Settings`
   - Match the Swift models exactly (see `../Sources/Models.swift`)
4. Create `src-tauri/src/paths.rs` — OS-specific path resolution:
   - `sessions_json_path()`, `settings_path()`, `claude_projects_path()`
   - XDG on Linux, `%LOCALAPPDATA%` on Windows, `~/Library/` on macOS
5. Create `src-tauri/src/security.rs`:
   - `atomic_write(path, contents)` — write to temp, fsync, rename
   - `set_owner_only_permissions(path)` — 0600 on Unix, ACL on Windows
   - `sanitize_workspace_path(path)` — reject `..` traversal, resolve symlinks
   - `verify_file_permissions(path)` — check and correct on startup
   - `cleanup_stale_tmp_files(dir)` — remove `*.tmp.*` files older than 1 hour
6. Create `src-tauri/src/jsonl_parser.rs`:
   - Line-by-line `serde_json::Value` parsing
   - Extract: `type`, `timestamp`/`isoTimestamp`, `message.usage.*`, `message.content[].tool_use`, `message.model`, `customTitle`, `gitBranch`
   - Handle 3 timestamp formats: Unix f64, ISO 8601 string, `isoTimestamp` field
   - Return `ParsedEntry` structs
   - MAX file size: skip files > 500 MB
   - Create `src-tauri/tests/fixtures/` with 3-5 real JSONL snippets covering: basic assistant message with usage, tool_use content blocks, custom-title entry, user message, malformed line. Write explicit `#[cfg(test)] mod tests` with test cases for each.
7. Create `src-tauri/src/session_monitor.rs`:
   - `poll_status()` — read and validate `sessions.json`, filter stale sessions
   - `refresh_metrics()` — parse JSONL per session, cache by mod date
   - Workspace path encoding: same scheme as Swift (`/` → `-`, leading `/` → `_`)
   - Three-tier JSONL path resolution: exact, parent walk, full scan
8. Create `src-tauri/src/usage_aggregator.rs`:
   - Discover `.jsonl` files, skip files older than oldest window
   - Bucket entries into 5hr/daily/weekly windows
   - Return `HashMap<UsageWindow, WindowMetrics>`
9. Create `src-tauri/src/settings.rs`:
   - Wrap `tauri-plugin-store` with permission enforcement
   - On write: use `security.rs::set_owner_only_permissions()` post-write
   - Plan presets: Pro, Max Standard, Max Plus
10. Wire up `src-tauri/src/main.rs`:
    - Add module declarations: `mod models; mod paths; mod security; mod jsonl_parser; mod session_monitor; mod usage_aggregator; mod settings;`
    - Tauri commands: `get_sessions`, `get_usage_metrics`, `get_settings`, `update_settings`
    - Tokio interval timers: 1s poll, 5s metrics
    - Event emission: `sessions-updated`, `usage-updated`
    - Custom panic handler that suppresses session data from crash dumps
    - Startup: verify file permissions, clean stale temp files

## Files to create
- `cue-desktop/src-tauri/Cargo.toml`
- `cue-desktop/src-tauri/tauri.conf.json`
- `cue-desktop/src-tauri/src/main.rs`
- `cue-desktop/src-tauri/src/models.rs`
- `cue-desktop/src-tauri/src/paths.rs`
- `cue-desktop/src-tauri/src/security.rs`
- `cue-desktop/src-tauri/src/jsonl_parser.rs`
- `cue-desktop/src-tauri/src/session_monitor.rs`
- `cue-desktop/src-tauri/src/usage_aggregator.rs`
- `cue-desktop/src-tauri/src/settings.rs`
- `cue-desktop/src-tauri/tests/fixtures/*.jsonl` (test data)

## Files NOT to touch
- Everything in `Sources/` (macOS Swift app)
- `hooks/cue-hook` (already fixed in Phase 0)
- Scaffold-generated frontend files in `src/` (Phase 3 will replace these)

## Verification
- `cargo test` passes all unit tests
- `cargo audit` returns zero vulnerabilities
- `cargo check` compiles clean with no warnings
- Tauri commands return correct data from real `~/.claude/projects/` JSONL files
- File permission tests pass (create test file, verify 0600)
- Temp file cleanup works on startup
- JSONL parser handles all 3 timestamp formats correctly
- JSONL parser handles malformed lines gracefully (skip, don't crash)
