# Agent Plan: Permission Request UI + CLAUDE.md Hardening

**Spec:** `specs/permission_request_ui.spec.md`
**Prerequisite:** V1 Tauri app must be built first (phases 0-6 from existing plan).

---

## Dependency Graph

```
Wave 0 (Foundation — sequential)
  ├─ Task A: Rust data models + Tauri commands
  └─ Task B: CLAUDE.md hardening (FR-DOC-001 through FR-DOC-006)

Wave 1 (Parallel Build — 3 tracks, all new files)
  ├─ Track 1: Rust permission server + log writer + summary formatter
  ├─ Track 2: React PermissionPrompt + PermissionHistory + types
  └─ Track 3: Hook configuration (install.sh + README)

Wave 2 (Integration — sequential)
  └─ Task C: Wire server into app startup, components into session rows, settings UI
```

## File Ownership Matrix

| File | Wave 0 | Track 1 (Rust) | Track 2 (React) | Track 3 (Hook) | Wave 2 |
|---|---|---|---|---|---|
| `src-tauri/src/models.rs` (or equivalent) | ✏️ | | | | |
| `src-tauri/src/commands.rs` (or equivalent) | ✏️ | | | | |
| `src-tauri/src/permission_server.rs` | | ✨ | | | |
| `src-tauri/src/permission_log.rs` | | ✨ | | | |
| `src-tauri/src/summary_formatter.rs` | | ✨ | | | |
| `src/components/PermissionPrompt.tsx` | | | ✨ | | |
| `src/components/PermissionHistory.tsx` | | | ✨ | | |
| `src/lib/types.ts` | | | ✏️ | | |
| `src/hooks/usePermissions.ts` | | | ✨ | | |
| `../hooks/cue-hook` | | | | ✏️ | |
| `../install.sh` | | | | ✏️ | |
| `../README.md` | | | | ✏️ | |
| `.claude/CLAUDE.md` | ✏️ | | | | |
| `src-tauri/src/main.rs` (or lib.rs) | | | | | ✏️ |
| `src-tauri/Cargo.toml` | | | | | ✏️ |
| Session row component (existing) | | | | | ✏️ |
| Settings component (existing) | | | | | ✏️ |

✨ = creates new file, ✏️ = modifies existing file

**Verification:** No file appears in more than one Wave 1 track.

---

## Wave 0: Foundation

**Mode:** Sequential (single agent)
**Goal:** Add data models, Tauri command stubs, and update CLAUDE.md

### Prompt (copy-paste)

```
Read specs/permission_request_ui.spec.md fully.
Read cue-desktop/.claude/CLAUDE.md fully.

Execute the foundation tasks:

1. **Rust data models** — Add to the existing models file (or create if needed):
   - `PermissionRequest` struct: `session_id: String`, `tool_name: String`, `tool_input: serde_json::Value`, `hook_event_name: String`, `received_at: f64`
   - `PermissionDecision` enum: `Allow`, `Deny`
   - `PermissionLogEntry` struct: `timestamp: f64`, `session_id: String`, `tool_name: String`, `tool_input_summary: String`, `decision: String`
   - All structs derive `Serialize, Deserialize, Clone, Debug`

2. **Tauri command stubs** — Add to the existing commands file:
   - `approve_permission(session_id: String, request_id: String)` → stub returning Ok(())
   - `deny_permission(session_id: String, request_id: String)` → stub returning Ok(())
   - `get_permission_history(session_id: String)` → stub returning empty Vec
   - Register commands in Tauri builder

3. **CLAUDE.md hardening** — Edit `.claude/CLAUDE.md`:
   - Amend security rule: "NO outbound network calls. Localhost-only HTTP server (`127.0.0.1`) is permitted for Claude Code hook communication. Never bind to `0.0.0.0`. No HTTP clients in deps."
   - Add under Conventions: "Hook must support macOS (`~/Library/Application Support/`), Linux (`$XDG_DATA_HOME/cue/` or `~/.local/share/cue/`), and Windows (`%LOCALAPPDATA%\Cue\`). No `fcntl` on Windows — use `msvcrt.locking` or the `filelock` package."
   - Add sessions.json schema contract (see spec FR-DOC-003)
   - Add hook event → state mapping table (see spec FR-DOC-004)
   - Add: "See `../specs/` for feature specifications and `../plans/` for architecture decisions (especially `cross_platform_final_plan.md`)."
   - Amend audit rules: "Run `cargo audit` after adding any Rust dependency and `npm audit` after adding any npm dependency. If either finds a vulnerability, do not proceed — flag it to the user before continuing."

Files you will modify: models file, commands file, `.claude/CLAUDE.md`
Files you will create: none
Files you must NOT touch: `../Sources/*`, `permission_server.rs`, `permission_log.rs`, `summary_formatter.rs`, any React components

Verify it compiles: `cargo check`
```

---

## Wave 1: Parallel Build

**Mode:** 3 parallel agents (spawn as teammates)
**Goal:** Build all new modules — each track creates only new files in its own domain

### Prompt (copy-paste)

```
Read specs/permission_request_ui.spec.md fully.
Read cue-desktop/.claude/CLAUDE.md fully.

Spawn teammates:

- "rust-permission-server" → Create the Rust permission server, log writer, and summary formatter
- "react-permission-ui" → Create the React permission components and TypeScript types
- "hook-config" → Update the hook configuration and documentation

Each teammate's instructions follow.

--- TEAMMATE: rust-permission-server ---

Create ONLY these new files in `src-tauri/src/`:

1. **`permission_server.rs`** — Localhost HTTP server using `axum` (or `tiny_http`)
   - Function `start_permission_server(port: u16, app_handle: AppHandle)` → spawns tokio task
   - Bind to `127.0.0.1:{port}` ONLY — reject if bind fails (log warning, don't panic)
   - POST `/permission-request` handler:
     - Parse JSON body into `PermissionRequest` struct
     - Generate unique `request_id` (UUID or timestamp)
     - Emit Tauri event `permission-request` to frontend with full payload
     - Hold the HTTP response open using a tokio oneshot channel
     - When frontend sends decision back (via Tauri command), respond with the correct JSON:
       - Allow: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
       - Deny: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}`
   - GET `/health` → return 200 (for testing)
   - All other routes → 404
   - No CORS headers
   - Store pending requests in `Arc<DashMap<String, oneshot::Sender<PermissionDecision>>>`

2. **`permission_log.rs`** — JSONL audit log writer
   - Function `append_permission_log(entry: PermissionLogEntry, status_dir: &Path)` → Result
   - Write to `{status_dir}/permission-log.jsonl`
   - Use `security.rs::atomic_write()` pattern (temp file → fsync → rename) — but for append, open with O_APPEND + write + fsync
   - Set file permissions 0600 on Unix
   - Function `read_permission_log(session_id: &str, status_dir: &Path)` → Vec<PermissionLogEntry>
   - Filter entries by session_id, return sorted by timestamp

3. **`summary_formatter.rs`** — Human-readable tool summaries
   - Function `format_tool_summary(tool_name: &str, tool_input: &serde_json::Value)` → String
   - Rules:
     - `Bash` → "Run: `{command}`" (truncate command to 80 chars with "...")
     - `Read` → "Read: `{file_path}`"
     - `Edit` → "Edit: `{file_path}`"
     - `Write` → "Write: `{file_path}`"
     - `Glob` → "Search: `{pattern}`"
     - `Grep` → "Search for: `{pattern}`"
     - Other → "`{tool_name}`: {first key}={first value}" (truncate value to 60 chars)

4. **Unit tests** for all three modules:
   - `permission_server`: payload parsing, health endpoint
   - `permission_log`: write + read round-trip, file permissions check
   - `summary_formatter`: one test per tool type, truncation test, unknown tool test

Files you will create: `permission_server.rs`, `permission_log.rs`, `summary_formatter.rs`
Files you must NOT touch: `main.rs`, `lib.rs`, `models.rs`, `commands.rs`, `Cargo.toml`, any React files
Do NOT add dependencies to Cargo.toml — that happens in Wave 2.

Verify: `cargo check` (may fail on missing deps — that's OK, Wave 2 adds them)

--- TEAMMATE: react-permission-ui ---

Create ONLY these new files in `src/`:

1. **`src/lib/types.ts`** — Add permission types (append, don't replace existing types):
   - `PermissionRequest`: `{ requestId: string; sessionId: string; toolName: string; toolInput: Record<string, unknown>; summary: string; hookEventName: string; receivedAt: number; }`
   - `PermissionDecision`: `'allow' | 'deny'`
   - `PermissionLogEntry`: `{ timestamp: number; sessionId: string; toolName: string; toolInputSummary: string; decision: string; }`

2. **`src/components/PermissionPrompt.tsx`** — Inline permission prompt
   - Props: `{ request: PermissionRequest; onApprove: () => void; onDeny: () => void; }`
   - Layout: yellow accent left border, summary text, expand/collapse chevron, Approve (green) + Deny (red) buttons
   - Expanded state shows full `toolInput` as formatted JSON in a `<pre>` block
   - Collapsed by default

3. **`src/components/PermissionHistory.tsx`** — Decision history list
   - Props: `{ entries: PermissionLogEntry[]; }`
   - Each entry: timestamp (relative, e.g., "2m ago"), tool summary, green "Approved" or red "Denied" badge
   - Scrollable, max-height container
   - Empty state: "No permission history"

4. **`src/hooks/usePermissions.ts`** — Custom hook for permission state
   - Listen for Tauri `permission-request` events → add to pending map (keyed by sessionId)
   - `approvePermission(sessionId, requestId)` → invoke Tauri command, remove from pending
   - `denyPermission(sessionId, requestId)` → invoke Tauri command, remove from pending
   - `getPermissionHistory(sessionId)` → invoke Tauri command, return entries
   - Export: `{ pendingBySession, approvePermission, denyPermission, permissionHistory }`

Files you will create: `PermissionPrompt.tsx`, `PermissionHistory.tsx`, `usePermissions.ts`
Files you will modify: `src/lib/types.ts` (append only)
Files you must NOT touch: any Rust files, existing React components, `install.sh`

--- TEAMMATE: hook-config ---

Update hook configuration and documentation:

1. **`../install.sh`** — Add HTTP hook entry for `PermissionRequest`:
   - In the Python hook config section, add a SECOND hook entry for `PermissionRequest` with type `http`:
     ```json
     {"type": "http", "url": "http://localhost:{PORT}/permission-request", "timeout": 600000}
     ```
   - Keep the existing command hook (cue-hook waiting) — both should fire
   - Use port 3002 (next available per port registry: 3000=agent-zero, 3001=mcp-servers)
   - Add a comment explaining the dual-hook setup

2. **`../README.md`** — Add a "Permission Approval" section:
   - Explain the HTTP hook integration
   - Show the hook config snippet
   - Note that the desktop app must be running for permission approval to work
   - If the app isn't running, Claude Code falls back to its normal terminal/VSCode permission flow

3. **`../hooks/cue-hook`** — No changes needed (the existing command hook still sets status to "waiting")

Files you will modify: `../install.sh`, `../README.md`
Files you will create: none
Files you must NOT touch: `../Sources/*`, any Rust files, any React files

Wait for ALL teammates to complete before proceeding.
```

---

## Wave 2: Integration

**Mode:** Sequential (single agent)
**Goal:** Wire everything together — add dependencies, connect server to app startup, embed components in session rows

### Prompt (copy-paste)

```
Read specs/permission_request_ui.spec.md fully.
Read cue-desktop/.claude/CLAUDE.md fully.

Wire the permission request feature into the existing app:

1. **`src-tauri/Cargo.toml`** — Add dependencies:
   - `axum` (or `tiny_http`) for HTTP server
   - `dashmap` for concurrent pending request storage
   - `uuid` for request IDs (if not already present)
   - Run `cargo audit` after adding. If vulnerabilities found, STOP and report.

2. **`src-tauri/src/main.rs`** (or `lib.rs`) — App startup:
   - Import `permission_server::start_permission_server`
   - Call `start_permission_server(port, app_handle)` during Tauri setup
   - Read port from settings (default 3002)
   - Register the real Tauri commands: `approve_permission`, `deny_permission`, `get_permission_history`
   - Replace the stubs from Wave 0 with real implementations that:
     - `approve_permission`: send `Allow` through the oneshot channel, append to permission log
     - `deny_permission`: send `Deny` through the oneshot channel, append to permission log
     - `get_permission_history`: read from permission log file
   - Add `mod permission_server; mod permission_log; mod summary_formatter;`

3. **Session row component** (existing) — Embed permission UI:
   - Import `PermissionPrompt` and `PermissionHistory` components
   - Import `usePermissions` hook
   - For each session row, check if `pendingBySession[session.id]` has entries
   - If yes: render `<PermissionPrompt>` inline below the session info, with yellow left border accent
   - Add an expandable "Permission History" section using `<PermissionHistory>`
   - Keep all existing session row content unchanged

4. **Settings component** (existing) — Add port config:
   - Add a "Permission Server Port" number input field (default: 3002)
   - Save to tauri-plugin-store settings

5. **`tauri.conf.json`** — No changes needed (localhost server runs in Rust, not from frontend)

Files you will modify: `Cargo.toml`, `main.rs`/`lib.rs`, session row component, settings component, commands file
Files you will create: none
Files you must NOT touch: `../Sources/*`, `permission_server.rs`, `permission_log.rs`, `summary_formatter.rs`, `PermissionPrompt.tsx`, `PermissionHistory.tsx`

Verify: `npm run tauri dev` launches with no errors and the permission server responds to `curl http://localhost:3002/health`

Run `cargo audit && npm audit` — if either finds vulnerabilities, report them.
```

---

## Execution Plan

### Prerequisites
- V1 Tauri app is built (phases 0-6 from `plans/`)
- `npm install` and `cargo build` succeed

### Wave 0: Foundation
Paste Wave 0 prompt into a Claude Code session.
Verify: `cargo check`
Commit: `feat(permission-ui): add data models, command stubs, and harden CLAUDE.md`

### Wave 1: Parallel Build
Paste Wave 1 prompt — team lead spawns 3 teammates.
Verify: `cargo check` (may warn about unused modules — OK), `npx tsc --noEmit`
Commit: `feat(permission-ui): implement server, components, and hook config`

### Wave 2: Integration
Paste Wave 2 prompt.
Verify: `npm run tauri dev` + `curl http://localhost:3002/health`
Commit: `feat(permission-ui): wire server and components into app`

### After execution
Run `/review-gauntlet` for five review passes.

---

## Open Questions (resolve before Wave 2)

1. **Port number**: Plan uses 3002. Confirm this doesn't conflict with anything.
2. **Permission log rotation**: Not in V1 scope — add if log file exceeds reasonable size.
3. **Dual hook coexistence**: The command hook (status → waiting) and HTTP hook (permission UI) both fire on `PermissionRequest`. This is intentional — command hook updates the tray color, HTTP hook shows the approval UI.
