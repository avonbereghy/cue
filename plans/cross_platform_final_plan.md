# Cross-Platform Claude Cue — Final Plan

> Merged from Plans A, B, and C. Priorities: security > polish > speed.

---

## 1. Security

This is the highest-priority section. Every design decision must preserve these invariants.

### No Network Calls

The app never contacts any server. Zero telemetry, zero analytics, zero phone-home. There are no HTTP clients in the dependency tree. The Tauri config explicitly disables all network-related capabilities (`allowlist.http: false`, no `fetch` scope, no WebSocket scope). Any dependency that attempts to phone home is rejected during audit.

### Local-Only Data

All data — `sessions.json`, JSONL logs, `settings.json` — stays on the local filesystem. There is no cloud sync, no remote storage, no database server. Data paths:

| Platform | Sessions | Settings |
|----------|----------|----------|
| macOS | `~/Library/Application Support/Claude Cue/sessions.json` | `~/Library/Application Support/com.claude-cue.app/settings.json` |
| Windows | `%LOCALAPPDATA%\Claude Cue\sessions.json` | `%LOCALAPPDATA%\Claude Cue\settings.json` |
| Linux | `~/.local/share/claude-cue/sessions.json` | `~/.config/claude-cue/settings.json` |

### No Credential Storage

The app does not store API keys, tokens, passwords, or any authentication material. There is no keychain/credential-manager integration. The app reads JSONL files and a status file — nothing else.

### File Permissions

- Unix (macOS, Linux): `sessions.json` and `settings.json` are written with mode `0600` (owner read/write only). The hook script sets this on creation; the Rust backend verifies and corrects permissions on startup.
- Windows: Files are created with an ACL granting access only to the current user. The app uses `SetNamedSecurityInfo` (via the `windows-acl` crate or equivalent) to restrict access on first write.

### Hook Script Security

- The hook runs as the same user who invoked Claude Code. No privilege escalation.
- No shell injection: all file paths are constructed using `os.path.join()` — never via string concatenation into shell commands.
- The hook does not execute any external commands (no `subprocess`, no `os.system`, no `cmd.exe`). The WSL bridge uses filesystem inspection only.
- Path inputs are sanitized: workspace paths are normalized, `..` traversal is rejected, and symlinks are resolved before use.
- The hook validates `sessions.json` schema before merging: `sessions` key must be a dict, each value must have required fields with correct types. Malformed data is rejected, not propagated.

### Atomic Writes

All file writes (both in the Python hook and the Rust backend) use the temp-file-then-rename pattern:

1. Write to a temporary file in the same directory (e.g., `sessions.json.tmp.<pid>`).
2. `fsync` the temporary file.
3. `os.replace()` (Python) or `std::fs::rename()` (Rust) to atomically replace the target.

This prevents partial reads of corrupted data by the polling reader.

### No Auto-Update in V1

Users download updates manually from GitHub Releases. There is no built-in update mechanism. This eliminates:
- MITM attack surface on update channels.
- Code execution from unsigned/unverified payloads.
- Unexpected background network activity.

### Code Signing (V2)

Plan for V2:
- Windows: Sign the MSI installer and `.exe` binary with an Authenticode certificate.
- Linux: GPG-sign `.deb` packages and AppImage files. Provide checksums (SHA-256) for all release artifacts.

### Dependency Audit

Minimal dependency set. All Rust crates from crates.io, all npm packages from the npm registry. Before V1 release:
- Run `cargo audit` to check for known vulnerabilities in Rust dependencies.
- Run `npm audit` for frontend dependencies.
- Review the dependency tree: reject any crate/package that makes network calls, collects telemetry, or has a poor security track record.
- Pin all dependency versions in lock files (`Cargo.lock`, `package-lock.json`).

---

## 2. Tech Stack

All plans converge on the same foundation.

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Framework | Tauri v2 | ~5 MB binary, native tray, no bundled Chromium |
| Backend | Rust | Memory-safe, excellent file I/O, cross-platform std |
| Frontend | React 19 + TypeScript + Tailwind CSS | Best accessibility ecosystem (aria-*, react-aria), large component library |
| Icon rendering | tiny-skia | Purpose-built for 2D rasterization; lighter than the `image` crate for drawing circles and shapes |
| System tray | `tauri-plugin-tray` (wraps native APIs) | Unified API across Windows/Linux/macOS |
| Settings store | `tauri-plugin-store` (JSON file) | Simple, local, auditable |
| Build / bundle | Tauri CLI (`tauri build`) | Produces MSI, NSIS, AppImage, deb natively |
| Hook script | Python (cross-platform adapted) | Already required by Claude Code |

### Preserve the macOS App

The existing Swift/SwiftUI macOS app is untouched. The Tauri app is purely additive — it targets Windows and Linux (and could optionally run on macOS as an alternative, but the Swift app remains the primary macOS target). Both apps share only the hook script and the `sessions.json` contract.

---

## 3. Architecture

### 3.1 Repository Structure

```
claude-cue/
├── Sources/                    # Existing macOS Swift app (UNCHANGED)
│   ├── main.swift
│   ├── Models.swift
│   ├── SessionMonitor.swift
│   ├── DashboardView.swift
│   ├── UsageView.swift
│   └── UsageAggregator.swift
├── Package.swift               # Existing SPM manifest
├── hooks/
│   └── cue-hook                # Python hook (adapted for cross-platform)
├── claude-cue-desktop/         # NEW: Tauri cross-platform app
│   ├── src-tauri/              # Rust backend
│   │   ├── Cargo.toml
│   │   ├── tauri.conf.json
│   │   ├── src/
│   │   │   ├── main.rs
│   │   │   ├── session_monitor.rs   # Port of SessionMonitor.swift
│   │   │   ├── usage_aggregator.rs  # Port of UsageAggregator.swift
│   │   │   ├── models.rs            # Port of Models.swift
│   │   │   ├── jsonl_parser.rs      # JSONL parsing logic
│   │   │   ├── settings.rs          # Cross-platform settings
│   │   │   ├── tray.rs              # System tray icon rendering (tiny-skia)
│   │   │   ├── paths.rs             # OS-specific path resolution
│   │   │   └── security.rs          # File permissions, path sanitization
│   │   └── icons/
│   ├── src/                    # React frontend
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── Dashboard.tsx
│   │   │   ├── SessionCard.tsx
│   │   │   ├── UsageView.tsx
│   │   │   ├── SettingsView.tsx
│   │   │   ├── ProgressBar.tsx
│   │   │   ├── StatBadge.tsx
│   │   │   └── OnboardingWizard.tsx
│   │   ├── hooks/
│   │   │   ├── useSessionMonitor.ts
│   │   │   └── useUsageMetrics.ts
│   │   ├── lib/
│   │   │   ├── format.ts       # Port of Format enum
│   │   │   ├── types.ts        # TypeScript interfaces matching Rust models
│   │   │   └── a11y.ts         # Accessibility utilities
│   │   └── styles/
│   ├── index.html
│   ├── package.json
│   └── tsconfig.json
├── plans/
└── build.sh                    # Existing macOS build script
```

### 3.2 Shared vs. Platform-Specific

| Component | macOS (Swift) | Cross-platform (Tauri) | Shared |
|-----------|--------------|----------------------|--------|
| Session polling | `SessionMonitor.swift` | `session_monitor.rs` | Logic ported, not shared at binary level |
| JSONL parsing | `SessionMonitor.parseJSONL` | `jsonl_parser.rs` | Same algorithm, different language |
| Usage aggregation | `UsageAggregator.swift` | `usage_aggregator.rs` | Same algorithm |
| Data models | `Models.swift` | `models.rs` + `types.ts` | Schema contract shared |
| Hook script | `hooks/cue-hook` | `hooks/cue-hook` | Same file, with platform adaptations |
| System tray | NSStatusBar | Tauri tray plugin | Different implementations |
| Dashboard UI | SwiftUI | React + Tailwind | Visual design shared, code diverges |
| Settings | UserDefaults | `tauri-plugin-store` | Same keys/schema |

### 3.3 Data Flow

```
Rust backend (Tokio timers)
  |-- poll_status() every 1s
  |-- refresh_metrics() every 5s
  \-- emit Tauri events --> React frontend
                              |-- useSessionMonitor() hook
                              |-- useUsageMetrics() hook
                              \-- Re-render components
```

---

## 4. V1 Feature Set

### Must-Have (V1 MVP)

- System tray icon with colored dot grid matching macOS behavior
- Tray menu showing active sessions with state, duration, token count
- Dashboard window with Sessions tab (session cards with all current metrics)
- Dashboard window with Usage tab (5hr/daily/weekly progress bars, plan picker)
- Settings: plan preset picker, token limits
- Hook script working on Windows and Linux (including WSL bridge)
- First-run onboarding wizard (GNOME detection, WSL detection, plan picker)
- Full accessibility (screen readers, keyboard nav, high contrast, reduced motion)
- CLI fallback: `claude-cue --status` for tiling WM users
- Windows installer (MSI) and Linux packages (AppImage, .deb)
- All security invariants from Section 1

### Deferred to V2

- Start at login toggle
- Show in dock/taskbar toggle
- Demo mode (`--demo` flag)
- Auto-update mechanism (with code signing)
- Desktop notifications for rate limit warnings
- Custom title display from JSONL events
- RPM / Flatpak packages
- Remote/SSH session monitoring

---

## 5. Core Engine Design (Rust Backend)

### 5.1 `models.rs`

```rust
#[derive(Serialize, Deserialize, Clone)]
pub struct SessionInfo {
    pub id: String,
    pub workspace: String,
    pub state: String,       // "working", "waiting", "error", "subagent", "idle", "done"
    pub last_activity: f64,  // Unix timestamp
    pub started_at: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct StatusData {
    pub sessions: HashMap<String, SessionInfo>,
}

#[derive(Serialize, Clone, Default)]
pub struct SessionMetrics {
    pub message_count: i64,
    pub user_message_count: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    pub model: String,
    pub last_input_tokens: i64,
    pub custom_title: Option<String>,
    pub git_branch: Option<String>,
    pub tool_counts: HashMap<String, i64>,
}

#[derive(Serialize, Clone)]
pub struct EnrichedSession {
    pub info: SessionInfo,
    pub metrics: SessionMetrics,
    pub workspace_name: String,
    pub display_title: String,
    pub state_icon: String,
    pub state_display_name: String,
    pub duration_secs: f64,
    pub context_limit: i64,
    pub context_usage_percent: f64,
    pub model_display_name: String,
}

#[derive(Serialize, Clone, Default)]
pub struct WindowMetrics {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub session_count: i64,
    pub user_message_count: i64,
    pub assistant_message_count: i64,
    pub tool_counts: HashMap<String, i64>,
    pub model_tokens: HashMap<String, (i64, i64)>,
}
```

### 5.2 `paths.rs`

OS-specific path resolution with XDG compliance on Linux and proper Windows paths:

```rust
pub fn sessions_json_path() -> PathBuf {
    match std::env::consts::OS {
        "macos" => home().join("Library/Application Support/Claude Cue/sessions.json"),
        "windows" => appdata_local().join("Claude Cue/sessions.json"),
        _ => xdg_data_home().join("claude-cue/sessions.json"),
    }
}

pub fn settings_path() -> PathBuf {
    match std::env::consts::OS {
        "macos" => home().join("Library/Application Support/com.claude-cue.app/settings.json"),
        "windows" => appdata_local().join("Claude Cue/settings.json"),
        _ => xdg_config_home().join("claude-cue/settings.json"),
    }
}

pub fn claude_projects_path() -> PathBuf {
    home().join(".claude/projects")  // Same on all platforms
}
```

### 5.3 `security.rs`

Centralized security utilities:

```rust
/// Set file permissions to owner-only (0600 on Unix, restricted ACL on Windows)
pub fn set_owner_only_permissions(path: &Path) -> Result<()> { ... }

/// Sanitize a workspace path: resolve symlinks, reject traversal, normalize
pub fn sanitize_workspace_path(path: &str) -> Result<PathBuf> { ... }

/// Atomic write: write to temp file, fsync, rename
pub fn atomic_write(target: &Path, contents: &[u8]) -> Result<()> { ... }

/// Verify file permissions on startup, correct if too permissive
pub fn verify_file_permissions(path: &Path) -> Result<()> { ... }
```

### 5.4 `session_monitor.rs`

Direct port of `SessionMonitor.swift`:
- Poll `sessions.json` every 1s via Tokio interval timer
- Parse JSONL conversation logs every 5s (with file modification date caching)
- Resolve JSONL paths using workspace-encoding + parent-walk + fallback-search
- Maintain `Vec<EnrichedSession>` and `HashMap<UsageWindow, WindowMetrics>`
- Emit updates to frontend via Tauri events (`sessions-updated`, `usage-updated`)

### 5.5 `usage_aggregator.rs`

Direct port of `UsageAggregator.swift`:
- Discover all `.jsonl` files under Claude projects directory
- Skip files older than the oldest window start
- Parse timestamps (Unix float or ISO 8601), bucket into 5hr/daily/weekly windows
- Return `HashMap<UsageWindow, WindowMetrics>`

### 5.6 `jsonl_parser.rs`

Line-by-line parsing with `serde_json::Value` (lenient, ignores unknown fields):
- Extract `type`, `timestamp`/`isoTimestamp`, `message.usage.*`, tool use, model, custom title, git branch
- Return typed `ParsedEntry` structs

### 5.7 Tauri Command Interface

```rust
#[tauri::command]
fn get_sessions(state: State<AppState>) -> Vec<EnrichedSession> { ... }

#[tauri::command]
fn get_usage_metrics(state: State<AppState>) -> HashMap<String, WindowMetrics> { ... }

#[tauri::command]
fn get_settings() -> Settings { ... }

#[tauri::command]
fn update_settings(settings: Settings) -> Result<(), String> { ... }

#[tauri::command]
fn get_token_limit(window: String) -> i64 { ... }
```

Event emission for real-time updates:

```rust
app_handle.emit("sessions-updated", &enriched_sessions)?;
app_handle.emit("usage-updated", &usage_metrics)?;
```

---

## 6. System Tray

### 6.1 Icon Rendering with tiny-skia

Port `renderDotGrid()` from `main.swift` using tiny-skia for 2D rasterization:
- Create a `Pixmap` at computed dimensions
- Draw filled circles for each session with the correct color
- Handle blink state toggle (0.5s timer)
- Convert to `Icon::Rgba` for Tauri

Color mapping (preserved from Swift):

| State | Color | Blink |
|-------|-------|-------|
| working | white | yes (alpha 1.0 <-> 0.15) |
| waiting | yellow | no |
| error | red | no |
| subagent | cyan | yes (alpha 1.0 <-> 0.15) |
| idle | white @ 35% alpha | no |
| done/default | green | no |

No-session state: hollow white ring.

### 6.2 Platform-Specific Tray Behaviors

| Behavior | Windows | Linux |
|----------|---------|-------|
| Tray location | System tray (notification area) | StatusNotifierItem or AppIndicator |
| Left-click | Open dashboard | Open dashboard |
| Right-click | Open menu | Open menu |
| Icon format | ICO (auto-converted) | PNG |
| Tooltip | "Claude Cue - N sessions" | Same |

### 6.3 Dynamic Tray Menu

```
Claude Code Sessions
────────────────────
⟳  WebApp — 38m 02s · 48.2K tokens
⏸  MLPipeline — 25m 20s · 31.6K tokens
────────────────────
Dashboard...        Ctrl+D
Settings...         Ctrl+,
Quit                Ctrl+Q
```

### 6.4 CLI Fallback

For tiling WM users without a system tray:

```bash
claude-cue --status          # JSON output of current sessions
claude-cue --status --pretty # Human-readable status
```

This can be piped into waybar, i3status, polybar, or any status bar.

---

## 7. Dashboard UI

### 7.1 Component Mapping

| SwiftUI View | React Component | Notes |
|-------------|-----------------|-------|
| `DashboardView` | `<Dashboard />` | Tab bar with Sessions/Usage |
| `SessionsTabView` | `<SessionsTab />` | Stat badges + session card list |
| `SessionCardView` | `<SessionCard />` | State dot, metrics, tools, context bar |
| `StatBadge` | `<StatBadge />` | Icon + label + value |
| `UsageView` | `<UsageView />` | Plan picker + window sections |
| `WindowSectionView` | `<WindowSection />` | Header + progress bar + stats + tool chips |
| `ContextBar` | `<ProgressBar />` | Reusable progress bar |
| `CueSettingsView` | `<SettingsView />` | Plan presets + token limit fields |
| (new) | `<OnboardingWizard />` | First-run setup (see Section 9) |

### 7.2 Styling

- Dark theme by default (matches macOS app and developer preference)
- Tailwind CSS with custom color palette matching SwiftUI opacity levels
- `backdrop-blur` for translucent material effects
- `font-variant-numeric: tabular-nums` for monospaced digits
- Capsule-shaped tool chips using `rounded-full`
- Respects system color scheme (light/dark) on Windows/Linux

### 7.3 Frontend Data Flow

```typescript
import { listen } from "@tauri-apps/api/event";

function useSessionMonitor() {
  const [sessions, setSessions] = useState<EnrichedSession[]>([]);

  useEffect(() => {
    const unlisten = listen<EnrichedSession[]>("sessions-updated", (event) => {
      setSessions(event.payload);
    });
    invoke<EnrichedSession[]>("get_sessions").then(setSessions);
    return () => { unlisten.then(f => f()); };
  }, []);

  return sessions;
}
```

### 7.4 Window Management

- Dashboard opens as the main Tauri window (on tray click or app launch)
- Settings opens as a secondary window via `WebviewWindowBuilder`
- Window position/size persisted via `tauri-plugin-window-state`

---

## 8. Hook Adaptation

The Python hook (`hooks/cue-hook`) needs four changes for cross-platform support.

### 8.1 File Locking

Replace `fcntl.flock` with platform-conditional locking:

```python
import sys

if sys.platform == "win32":
    import msvcrt
    def lock_file(f):
        msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)
    def unlock_file(f):
        msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
else:
    import fcntl
    def lock_file(f):
        fcntl.flock(f, fcntl.LOCK_EX)
    def unlock_file(f):
        fcntl.flock(f, fcntl.LOCK_UN)
```

### 8.2 Status Directory

```python
def get_status_dir():
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~\\AppData\\Local"))
        return os.path.join(base, "Claude Cue")
    elif sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/Claude Cue")
    else:
        base = os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share"))
        return os.path.join(base, "claude-cue")
```

### 8.3 Atomic Write

Replace `os.rename()` with `os.replace()` (works on Windows where `os.rename` fails if target exists):

```python
os.replace(tmp, STATUS_FILE)
```

### 8.4 WSL Bridge

For WSL users: the hook writes `sessions.json` to the Windows-accessible path via `/mnt/c/`.

**SECURITY NOTE (Review Finding #1):** Do NOT use `subprocess.check_output(["cmd.exe", ...])` to detect the Windows username — this violates the "no subprocess" invariant and introduces shell injection risk. Instead, detect the Windows home directory without spawning processes:

```python
def get_wsl_windows_status_dir():
    """When running in WSL, write to the Windows-side path so the Windows app can read it."""
    # Detect Windows username from /mnt/c/Users/ directory listing — no subprocess
    users_dir = "/mnt/c/Users"
    if os.path.isdir(users_dir):
        # Read USERPROFILE from WSL's interop environment if available
        wsl_userprofile = os.environ.get("USERPROFILE", "")
        if wsl_userprofile:
            win_user = os.path.basename(wsl_userprofile)
        else:
            # Fallback: find the most recently modified user dir (skip Public, Default)
            skip = {"Public", "Default", "Default User", "All Users"}
            candidates = [d for d in os.listdir(users_dir) if d not in skip
                         and os.path.isdir(os.path.join(users_dir, d))]
            if candidates:
                win_user = candidates[0]  # Usually only one real user
            else:
                return None  # Cannot detect; fall back to Linux-local path
        return f"/mnt/c/Users/{win_user}/AppData/Local/Claude Cue"
    return None
```

The installer detects WSL and configures the hook to use this path.

### 8.5 File Permissions in Hook

After writing `sessions.json`, set owner-only permissions:

```python
if sys.platform != "win32":
    os.chmod(STATUS_FILE, 0o600)
```

---

## 9. Onboarding

### First-Run Wizard

A single-page wizard shown on first launch. Detects environment and guides setup.

#### Windows Flow

```
Step 1: Environment Detection
  "Claude Cue monitors your Claude Code sessions from the system tray."
  [Screenshot of tray with colored dots]

  Found Claude Code (native Windows) at C:\Users\...\
  Found Claude Code in WSL (Ubuntu-22.04)

  Configure hooks for:
  [x] Windows native
  [x] WSL: Ubuntu-22.04

Step 2: Plan Selection
  "Set your token limits to see usage progress bars."
  ( ) Pro ($20/mo)        — 500K / 2M / 10M
  (*) Max Standard ($100) — 2M / 8M / 40M
  ( ) Max Plus ($200)     — 4M / 16M / 80M
  ( ) Custom / Skip

Step 3: Done
  [x] Start Claude Cue now
  [Get Started]
```

Post-install: Toast notification guiding user to pin the tray icon.

#### Linux Flow

```
+-- Welcome to Claude Cue -------------------------+
|                                                    |
|  Desktop: GNOME 46 (Wayland)                       |
|  Tray support: Requires AppIndicator extension     |
|                                                    |
|  [Install Extension]  [Use Dashboard Only]         |
|                                                    |
|  --- Hook Configuration ---                        |
|  Found ~/.claude/settings.json                     |
|  [Configure Hooks Automatically]                   |
|                                                    |
|  --- Plan ---                                      |
|  [Pro] [Max $100] [Max $200] [Custom]              |
|                                                    |
|  [Get Started]                                     |
+----------------------------------------------------+
```

#### Onboarding Principles

1. Show value in under 60 seconds — from install to first blinking dot.
2. No restart required — hooks take effect on the next Claude Code session.
3. Explain the tray icon — brief visual guide with colored-dot legend.
4. Graceful degradation — if hooks cannot be auto-configured, show manual instructions.

---

## 10. Accessibility

### Screen Readers

- **Tray icon**: Expose current state as accessible text. E.g., "Claude Cue: 3 sessions, 1 working, 1 waiting, 1 subagent."
  - Windows: `Shell_NotifyIcon` tooltip text readable by NVDA/JAWS.
  - Linux: `StatusNotifierItem` `Title` and `ToolTip` accessible via AT-SPI.
- **Context menu**: Standard menu semantics — proper menu items, not custom-drawn text.
- **Dashboard**: All visual indicators have text alternatives.
  - Progress bars: "5-hour usage: 60%, 1.2 million of 2 million tokens"
  - Session cards: State + name + duration as accessible label
  - Color-coded dots supplemented with text labels ("Working", "Waiting", etc.)

### Keyboard Navigation

- Context menu navigable with arrow keys, activatable with Enter.
- Dashboard: full Tab/Shift+Tab navigation with visible focus indicators on all interactive elements.
- Global hotkey (configurable): opens dashboard from anywhere.

### High Contrast

- Windows High Contrast mode: all UI elements remain visible. Progress bars have borders, not just fill. Text meets WCAG AA contrast ratios.
- Linux: respect high-contrast GTK/Qt themes. Test with "HighContrast" and "HighContrastInverse" GNOME themes.
- Tray dots in high contrast: outlined circles with fill, not just filled circles.

### Reduced Motion

- Detect `prefers-reduced-motion` (Windows: `SystemParametersInfo(SPI_GETCLIENTAREAANIMATION)`; Linux: `gtk-enable-animations`; CSS: `prefers-reduced-motion` media query).
- Replace blinking dots with static dots that have a subtle non-animated indicator (e.g., a small arrow overlay for "working").

---

## 11. Build Order

### Phase 1: Foundation (Rust Core + Security Hardening)

**Goal**: All core data logic works, all security primitives in place.

**What to build**:
- Scaffold Tauri v2 project in `claude-cue-desktop/`
- `models.rs` — all data structs with Serde derive
- `paths.rs` — OS-specific path resolution (XDG, LOCALAPPDATA, Library)
- `security.rs` — atomic writes, file permission enforcement, path sanitization
- `jsonl_parser.rs` — line-by-line JSONL parsing
- `session_monitor.rs` — `poll_status()` + `refresh_metrics()`
- `usage_aggregator.rs` — time-window aggregation
- `settings.rs` — `tauri-plugin-store` wrapper with permission enforcement
- Wire up Tauri commands and event emission

**Files created**:
- `claude-cue-desktop/src-tauri/Cargo.toml`
- `claude-cue-desktop/src-tauri/tauri.conf.json`
- `claude-cue-desktop/src-tauri/src/main.rs`
- `claude-cue-desktop/src-tauri/src/models.rs`
- `claude-cue-desktop/src-tauri/src/paths.rs`
- `claude-cue-desktop/src-tauri/src/security.rs`
- `claude-cue-desktop/src-tauri/src/jsonl_parser.rs`
- `claude-cue-desktop/src-tauri/src/session_monitor.rs`
- `claude-cue-desktop/src-tauri/src/usage_aggregator.rs`
- `claude-cue-desktop/src-tauri/src/settings.rs`

**Execution**: Sequential. Each module builds on the previous.

**Verification**:
- `cargo test` passes for all parsing, path resolution, aggregation, and security tests.
- `cargo audit` returns zero vulnerabilities.
- Tauri commands return correct data from real `~/.claude/projects/` JSONL files.
- File permission tests pass on both Unix and Windows targets.

### Phase 2: System Tray + Icon Rendering

**Goal**: Tray icon shows colored dots, menu lists sessions, click opens a window.

**What to build** (two parallel tracks):

**Track A — Icon rendering**:
- `tray.rs` — dot grid rendering using tiny-skia
- Color mapping, blink state management (0.5s timer)
- Icon sizing for different DPI levels (16x16, 22x22, 24x24, 32x32)
- High-contrast variant with outlined circles

**Track B — Tray integration**:
- Tray plugin setup with `TrayIconBuilder`
- Dynamic menu construction from session data
- Left-click / right-click behavior per platform
- Tooltip with session count
- `claude-cue --status` CLI output mode

**Files created/modified**:
- `claude-cue-desktop/src-tauri/src/tray.rs`
- `claude-cue-desktop/src-tauri/src/main.rs` (tray setup)
- `claude-cue-desktop/src-tauri/src/cli.rs` (CLI fallback)

**Execution**: Track A and Track B in parallel. Integration after both complete.

**Verification**:
- Tray icon visible and correctly colored on Windows 10, Windows 11, Ubuntu (GNOME + AppIndicator), KDE Plasma.
- Menu shows real session data.
- Blink animation runs at correct cadence.
- `claude-cue --status` outputs valid JSON.
- Dots are legible at 16x16 and 32x32 pixel sizes.

### Phase 3: Dashboard Frontend

**Goal**: Full dashboard with sessions and usage tabs, visually matching the macOS app.

**What to build**:
- React + TypeScript + Tailwind scaffolding
- TypeScript interfaces in `types.ts` mirroring Rust models
- `useSessionMonitor` and `useUsageMetrics` hooks
- `<Dashboard />` with tab bar
- `<SessionsTab />` with stat badges and session cards
- `<SessionCard />` — all rows (status, metrics, tools, context bar)
- `<UsageView />` with plan picker and window sections
- `<ProgressBar />` reusable component
- `<StatBadge />` component
- Format utilities in `format.ts`
- Dark theme styling

**Files created**:
- `claude-cue-desktop/src/App.tsx`
- `claude-cue-desktop/src/components/Dashboard.tsx`
- `claude-cue-desktop/src/components/SessionCard.tsx`
- `claude-cue-desktop/src/components/UsageView.tsx`
- `claude-cue-desktop/src/components/ProgressBar.tsx`
- `claude-cue-desktop/src/components/StatBadge.tsx`
- `claude-cue-desktop/src/hooks/useSessionMonitor.ts`
- `claude-cue-desktop/src/hooks/useUsageMetrics.ts`
- `claude-cue-desktop/src/lib/types.ts`
- `claude-cue-desktop/src/lib/format.ts`
- `claude-cue-desktop/index.html`
- `claude-cue-desktop/package.json`
- `claude-cue-desktop/tsconfig.json`
- `claude-cue-desktop/tailwind.config.ts`

**Execution**: Sequential within the phase (components depend on hooks/types).

**Verification**:
- Dashboard visually matches the macOS SwiftUI version.
- Data flows from Rust backend to React frontend in real time.
- All components render correctly with 0, 1, and 8 sessions.
- Dark and light themes both work.

### Phase 4: Settings + Hook Adaptation + Onboarding

**Goal**: Settings persist, hook works everywhere, new users get guided setup.

**What to build** (three parallel tracks):

**Track A — Settings UI**:
- `<SettingsView />` with plan presets and token limit fields
- Settings window (secondary Tauri window)
- Settings persistence via `tauri-plugin-store`

**Track B — Hook adaptation**:
- Cross-platform file locking (fcntl/msvcrt)
- OS-specific status directory resolution
- `os.replace()` for atomic writes
- WSL bridge path detection
- File permission enforcement (0600)
- Test on Windows native, WSL, and Linux

**Track C — Onboarding wizard**:
- `<OnboardingWizard />` component
- GNOME desktop detection + AppIndicator check
- WSL detection on Windows
- Plan picker with preset limits
- Hook auto-configuration
- First-run toast notification (Windows tray pinning guidance)

**Files created/modified**:
- `claude-cue-desktop/src/components/SettingsView.tsx`
- `claude-cue-desktop/src/components/OnboardingWizard.tsx`
- `hooks/cue-hook` (modified for cross-platform)

**Execution**: All three tracks in parallel.

**Verification**:
- Settings persist across app restarts on all platforms.
- Hook script works on Windows (native), Windows (WSL), and Linux.
- WSL bridge: session updates propagate from WSL hook to Windows tray in < 2 seconds.
- Onboarding wizard correctly detects GNOME, WSL, and existing Claude Code installs.
- Hook writes files with correct permissions.

### Phase 5: Packaging, Installers, CI/CD

**Goal**: Users can download and install on Windows or Linux in under 5 minutes.

**What to build**:
- Tauri bundler configuration for MSI, NSIS, AppImage, .deb
- GitHub Actions CI workflow for cross-platform builds
- Release artifact checksums (SHA-256)
- Installation instructions
- Hook installation automation (copy to correct path, offer to configure)

**Files created/modified**:
- `claude-cue-desktop/src-tauri/tauri.conf.json` (bundle config)
- `.github/workflows/release.yml`
- `claude-cue-desktop/src-tauri/icons/` (app icons for all platforms)

**Execution**: Sequential (CI config depends on bundle config).

**Verification**:
- Clean install on fresh Windows 10, Windows 11, Ubuntu 22.04, Ubuntu 24.04.
- Installers produce correct Start Menu / .desktop entries.
- `npm audit` and `cargo audit` pass in CI.
- Release artifacts include SHA-256 checksums.
- Uninstall is clean (no leftover files except user data).

### Phase 6: Accessibility + Polish Pass

**Goal**: The app meets all accessibility requirements and feels platform-native.

**What to build**:
- Screen reader testing and ARIA attribute fixes
- Keyboard navigation audit (Tab order, focus indicators, Enter activation)
- High contrast mode testing and fixes
- Reduced motion: detect preference, replace blink with static indicators
- DPI scaling testing (100%, 150%, 200%)
- Windows theme integration (light/dark detection)
- Linux theme integration (GTK/Qt theme respect)
- Tray icon visibility on light taskbar backgrounds (outlined dots)
- Performance audit: < 20MB RAM, < 1% CPU at idle

**Files modified**:
- Various component files (ARIA attributes, focus management)
- `tray.rs` (high-contrast icon variant, theme-aware dots)
- `claude-cue-desktop/src/lib/a11y.ts` (accessibility utilities)

**Execution**: Sequential (testing informs fixes).

**Verification**:
- NVDA (Windows) and Orca (Linux) can read all UI elements.
- Full keyboard-only operation of context menu and dashboard.
- All text meets WCAG AA contrast ratios.
- Blink animation disabled when reduced motion is preferred.
- App uses < 20MB RSS memory with 8 active sessions.
- Tray dots visually distinguishable on both light and dark taskbars.

---

## 12. Riskiest Assumptions

### 1. WSL Bridge Reliability and Security

**Risk**: HIGH. The shared filesystem approach (`/mnt/c/`) is the simplest WSL bridge, but has implications:
- `/mnt/c/` writes from WSL are slower than native I/O (though negligible for small JSON).
- `fcntl` locking does NOT work across the WSL/Windows boundary. Acceptable because the hook is the only writer and the app is a read-only poller.
- A malicious process on the Windows side could tamper with `sessions.json`. Mitigation: the app treats `sessions.json` as untrusted input — all fields are validated, no code execution from file contents.

**Validation**: Prototype WSL hook writing to `/mnt/c/` path. Measure latency (target < 100ms). Stress test with 8 concurrent sessions.

### 2. Windows Tray Icon Pinning

**Risk**: HIGH. Windows 11 hides new tray icons in the overflow area by default. If users don't pin it, they never see the dots — the entire value proposition fails.

**Validation**: Test with 5 Windows users who don't know about Claude Cue. Measure how many discover and pin the icon without prompting. The first-run toast notification must guide them clearly.

### 3. GNOME AppIndicator Extension Requirement

**Risk**: MEDIUM-HIGH. GNOME removed native tray support in 3.26. The AppIndicator extension restores it but requires explicit installation. Some corporate environments restrict extensions.

**Validation**: Survey Linux Claude Code users for DE distribution. Test the fallback dashboard-only approach. Many users already have the extension for Discord, Slack, etc.

### 4. Token Tracking Accuracy

**Risk**: MEDIUM. The app estimates usage from JSONL logs, but Anthropic's server-side counting may differ. If the progress bar says 80% but the user gets rate-limited at 75%, trust is destroyed.

**Validation**: Compare Claude Cue's token counts against actual rate-limit responses over a week of heavy usage. Add a disclaimer: "Estimated — actual limits may vary."

### 5. Tray Icon Legibility at Small Sizes

**Risk**: MEDIUM. System tray icons are 16x16 to 32x32 pixels. A grid of 4+ dots may be indistinguishable at those sizes. Color-blind users (deuteranopia) may confuse yellow and green.

**Validation**: Render dot grids at all target sizes. Test with color-blind users. Consider shape variations (square = error, circle = normal) as a future enhancement.

---

## 13. Key Dependencies

### Rust (Cargo.toml)

| Crate | Purpose |
|-------|---------|
| `tauri` v2 | App framework |
| `tauri-plugin-tray` | System tray |
| `tauri-plugin-store` | Settings persistence |
| `tauri-plugin-window-state` | Window position persistence |
| `serde` + `serde_json` | Serialization |
| `tokio` | Async runtime (bundled with Tauri) |
| `tiny-skia` | 2D icon rendering (dot grid) |
| `chrono` | Date/time handling, ISO 8601 parsing |

### Frontend (package.json)

| Package | Purpose |
|---------|---------|
| `react` v19 | UI framework |
| `@tauri-apps/api` v2 | Tauri IPC bridge |
| `tailwindcss` v4 | Styling |
| `typescript` | Type safety |
| `vite` | Build tool (Tauri default) |

### CI

| Tool | Purpose |
|------|---------|
| GitHub Actions | Build + release automation |
| `tauri-action` | Cross-platform build action |
| `actions/upload-artifact` | Attach installers to releases |

---

## 14. Engineering Principles

1. **Security first.** Every file write uses atomic operations with correct permissions. Every file read treats input as untrusted. No network calls, no credential storage, no auto-update in V1.

2. **Preserve the macOS app.** The Swift codebase is untouched. The Tauri app is additive. Both share only the hook script and `sessions.json` contract.

3. **Port logic, not code.** Rust reimplements the Swift algorithms. No FFI, no shared libraries. Each codebase is independently maintainable.

4. **Backend does the work.** All file I/O, parsing, and timer logic lives in Rust. React is a pure rendering layer. This keeps the frontend simple and the security surface small.

5. **Same data, same display.** TypeScript interfaces mirror Rust structs. React components reproduce the SwiftUI layout. Users switching platforms see an identical dashboard.

6. **OS conventions matter.** Paths follow XDG on Linux, `%LOCALAPPDATA%` on Windows, `~/Library/` on macOS. Tray behavior respects platform norms.

7. **Accessible by default.** Screen reader support, keyboard navigation, high contrast, and reduced motion are not afterthoughts — they are Phase 6 requirements with explicit verification steps.

8. **Zero external runtime.** The Tauri app is a single native binary. Only the hook script requires Python (which Claude Code already depends on).

9. **Ship incrementally.** Each phase produces a working artifact. Phase 2 alone (tray only) is useful. Phase 3 (tray + dashboard) is the real MVP.

---

## 15. Known Risks & Open Questions (from Adversarial Review)

### Addressed (Critical)

1. **WSL bridge `cmd.exe` injection** — Fixed: replaced `subprocess` with filesystem inspection (Section 8.4).
2. **Hook missing `fsync` and `os.replace()`** — Addressed as mandatory Phase 0 fix before any Tauri work.
3. **Hook doesn't validate `sessions.json` schema** — Added validation requirement to Section 1 hook security.
4. **Tauri WebView DevTools in production** — Must set `"devtools": false` in `tauri.conf.json` for release. CI check required.
5. **Hook missing `os.chmod(0o600)`** — Already specified in Section 8.5.

### Addressed (Important)

6. **Windows `msvcrt.locking` on empty file** — Use `win32file.LockFileEx` via ctypes, or ensure lock sentinel file has content.
7. **Workspace path exposure** — Show only leaf directory name by default in tray menu/tooltip. Full path on dashboard hover. Add privacy mode setting in V2.
8. **Orphaned temp files** — Rust backend cleans stale `.tmp` files on startup. Naming convention: `{target}.tmp.{pid}`.
9. **`tauri-plugin-store` bypasses `security.rs`** — Wrap with post-write permission fix, or use custom settings impl via `security.rs::atomic_write()`.
10. **Binary size** — Realistic: 8-15 MB on Windows, 30-80 MB AppImage on Linux (bundles WebKit2GTK). Update marketing copy.
11. **JSONL parser underestimated** — Promote to dedicated testing phase with real-world corpus from multiple Claude Code versions.
12. **Crash dumps may leak session data** — Set custom panic handler. Disable WER minidumps on Windows. Set core dump size to 0 on Linux.
13. **WebKit2GTK dependency on Linux** — Declare in `.deb` `Depends:`. Note in AppImage docs.
14. **Timeline ~2x optimistic** — Realistic: 14-20 weeks solo, 8-12 weeks pair. Plan accordingly.

### Noted (Minor)

15. **macOS paths inconsistent** — Standardize to `Claude Cue` (display name) for both sessions and settings dirs.
16. **`chrono` crate security history** — Consider `jiff` or `time` crate as alternative. Run `cargo audit` before V1.
17. **Tauri capability-based IPC** — Define minimal capabilities: `event:default`, `window:default`, custom commands only. No `shell`, `http`, or `fs` from frontend.
18. **Token accuracy** — Add rate-limit event detector for ground-truth calibration when available.
19. **Blink timer CPU wakes** — Only run 0.5s timer when blinking sessions exist. Stop when all are static.
20. **File size caps** — Max 1 MB for `sessions.json`. JSONL: read only entries within time window, not entire file.

### Phase 0: Pre-Requisite Hook Fixes (before any Tauri work)

These fixes apply to the **existing** `hooks/cue-hook` and must be done first:

1. Add `f.flush(); os.fsync(f.fileno())` before `os.rename()`
2. Replace `os.rename()` with `os.replace()`
3. Add `os.chmod(STATUS_FILE, 0o600)` after write (Unix only)
4. Add schema validation when reading existing `sessions.json`
5. Add platform-conditional file locking (fcntl/msvcrt)
6. Add `get_status_dir()` function for cross-platform paths
