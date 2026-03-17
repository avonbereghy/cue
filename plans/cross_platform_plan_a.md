# Plan A: Top-Down Comprehensive — Cross-Platform Claude Cue

> Making Claude Code session monitoring available on Windows and Linux alongside the existing macOS app.

---

## 1. Product Vision

Claude Cue becomes the universal companion for Claude Code users on every desktop OS. A lightweight system tray app that shows live session status at a glance, tracks token usage against plan limits, and surfaces JSONL-derived metrics — regardless of whether you are on macOS, Windows, or Linux.

**Non-goal:** replacing the native macOS Swift app. The macOS version continues to ship as-is. This plan adds a *second* app target — a cross-platform build — that covers Windows and Linux (and could optionally replace the macOS version later if quality parity is reached).

---

## 2. Recommended Tech Stack

### Decision: **Tauri v2 + TypeScript + React**

| Option | Pros | Cons |
|--------|------|------|
| **Tauri v2** | ~5 MB binary, native system tray API, Rust backend for file I/O, no bundled Chromium, strong Windows/Linux/macOS support | Smaller ecosystem than Electron, WebView rendering differences |
| Electron | Mature, massive ecosystem, Chromium consistency | 150+ MB bundles, high RAM, overkill for a tray app |
| Flutter Desktop | Single codebase, good tray plugins | Dart ecosystem weaker for CLI/file tooling, large binary |
| .NET MAUI / Avalonia | Native-feel on Windows | Weak Linux story, C# diverges from existing Swift codebase |

**Why Tauri wins for Claude Cue:**
- Claude Cue is a *tray-first* app with a small dashboard window — Tauri's tiny footprint is ideal.
- The Rust backend handles all file I/O (JSONL parsing, `sessions.json` polling, settings persistence) with excellent cross-platform filesystem APIs.
- Tauri v2 has first-class system tray support (`tauri-plugin-tray`) on all three platforms.
- The React/TypeScript frontend replicates the SwiftUI dashboard with modern web UI primitives.
- No external runtime required (unlike Electron's bundled Chromium).

### Stack summary

| Layer | Technology |
|-------|-----------|
| Backend / core engine | Rust (Tauri commands) |
| Frontend / UI | React 19 + TypeScript + Tailwind CSS |
| System tray | `tauri-plugin-tray` (wraps native APIs) |
| Build / bundle | Tauri CLI (`tauri build`) |
| Settings store | `tauri-plugin-store` (JSON file) |
| Hook script | Python (adapted for cross-platform) |

---

## 3. Architecture Breakdown

### 3.1 Mono-repo structure

```
claude-cue/
├── Sources/                    # Existing macOS Swift app (unchanged)
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
│   │   │   ├── tray.rs              # System tray icon rendering
│   │   │   └── paths.rs             # OS-specific path resolution
│   │   └── icons/
│   ├── src/                    # React frontend
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── Dashboard.tsx
│   │   │   ├── SessionCard.tsx
│   │   │   ├── UsageView.tsx
│   │   │   ├── SettingsView.tsx
│   │   │   ├── ProgressBar.tsx
│   │   │   └── StatBadge.tsx
│   │   ├── hooks/
│   │   │   ├── useSessionMonitor.ts
│   │   │   └── useUsageMetrics.ts
│   │   ├── lib/
│   │   │   ├── format.ts       # Port of Format enum
│   │   │   └── types.ts        # TypeScript interfaces matching Rust models
│   │   └── styles/
│   ├── index.html
│   ├── package.json
│   └── tsconfig.json
├── plans/
└── build.sh                    # Existing macOS build script
```

### 3.2 Shared vs. platform-specific

| Component | macOS (Swift) | Cross-platform (Tauri) | Shared |
|-----------|--------------|----------------------|--------|
| Session polling | `SessionMonitor.swift` | `session_monitor.rs` | Logic is ported, not shared at binary level |
| JSONL parsing | `SessionMonitor.parseJSONL` | `jsonl_parser.rs` | Same algorithm, different language |
| Usage aggregation | `UsageAggregator.swift` | `usage_aggregator.rs` | Same algorithm |
| Data models | `Models.swift` | `models.rs` + `types.ts` | Schema contract shared |
| Hook script | `hooks/cue-hook` | `hooks/cue-hook` | **Literally the same file**, with platform adaptations |
| System tray | NSStatusBar | Tauri tray plugin | Completely different |
| Dashboard UI | SwiftUI | React + Tailwind | Visual design shared, code diverges |
| Settings | UserDefaults | `tauri-plugin-store` | Same keys/schema |

**Key insight:** the core engine logic (JSONL parsing, session state management, usage aggregation) ports cleanly to Rust because it is pure data transformation — no UI coupling in the Swift code. The `SessionMonitor` and `UsageAggregator` classes are already well-separated.

---

## 4. V1 Feature Set

### Must-have (V1 MVP)
- System tray icon with colored dots matching macOS behavior (working=white blink, waiting=yellow, error=red, subagent=cyan blink, idle=dim)
- Tray menu showing active sessions with state, duration, token count
- Dashboard window with Sessions tab (session cards with all current metrics)
- Dashboard window with Usage tab (5hr/daily/weekly progress bars, plan picker)
- Settings: plan preset picker, token limits
- Hook script working on Windows and Linux
- Windows installer (MSI) and Linux package (AppImage)

### Deferred to V2
- "Start at login" toggle (platform-specific autostart mechanisms)
- "Show in dock/taskbar" toggle
- Demo mode (`--demo` flag)
- Auto-update mechanism
- Desktop notifications for rate limit warnings
- Custom title display from JSONL `custom-title` events

### Rationale
V1 focuses on functional parity for the core monitoring loop. Login-item registration and dock visibility are OS-specific and can follow once the foundation is solid.

---

## 5. Core Engine Design (Rust Backend)

### 5.1 `session_monitor.rs`

Direct port of `SessionMonitor.swift`. Responsibilities:
- Poll `sessions.json` every 1s via a Tokio interval timer
- Parse JSONL conversation logs every 5s (with file modification date caching to skip unchanged files)
- Resolve JSONL paths using the same workspace-encoding + parent-walk + fallback-search strategy
- Maintain `enriched_sessions: Vec<EnrichedSession>` and `usage_metrics: HashMap<UsageWindow, WindowMetrics>`
- Emit updates to the frontend via Tauri events (`session-update`, `usage-update`)

```rust
// Pseudocode sketch
pub struct SessionMonitor {
    status_file_path: PathBuf,
    claude_projects_path: PathBuf,
    metrics_cache: HashMap<String, SessionMetrics>,
    file_mod_dates: HashMap<String, SystemTime>,
    resolved_paths: HashMap<String, PathBuf>,
    usage_aggregator: UsageAggregator,
}

impl SessionMonitor {
    pub fn poll_status(&mut self) -> Vec<EnrichedSession> { ... }
    pub fn refresh_metrics(&mut self) { ... }
    fn jsonl_path(&mut self, session: &SessionInfo) -> PathBuf { ... }
    fn parse_jsonl(&self, path: &Path) -> Option<SessionMetrics> { ... }
}
```

### 5.2 `usage_aggregator.rs`

Direct port of `UsageAggregator.swift`:
- Discover all `.jsonl` files under the Claude projects directory
- Skip files with modification dates older than the oldest window start
- Parse each JSONL line, extract timestamps (Unix float or ISO 8601), bucket into windows
- Return `HashMap<UsageWindow, WindowMetrics>`

### 5.3 `jsonl_parser.rs`

Shared JSONL parsing extracted as a module:
- Line-by-line parsing with `serde_json::Value` (no strict schema — mirrors the `JSONSerialization` approach in Swift)
- Extract `type`, `timestamp`/`isoTimestamp`, `message.usage.*`, `message.content[].tool_use`, `message.model`, `customTitle`, `gitBranch`
- Return typed `ParsedEntry` structs

### 5.4 `paths.rs` — OS-specific path resolution

```rust
pub fn sessions_json_path() -> PathBuf {
    match std::env::consts::OS {
        "macos" => home().join("Library/Application Support/Claude Cue/sessions.json"),
        "windows" => appdata_local().join("Claude Cue/sessions.json"),
        _ => home().join(".config/claude-cue/sessions.json"),  // Linux / XDG
    }
}

pub fn claude_projects_path() -> PathBuf {
    home().join(".claude/projects")  // Same on all platforms
}
```

### 5.5 Tauri command interface

The Rust backend exposes Tauri commands that the React frontend calls:

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

Additionally, the backend pushes updates via Tauri events so the frontend can subscribe:

```rust
app_handle.emit("sessions-updated", &enriched_sessions)?;
app_handle.emit("usage-updated", &usage_metrics)?;
```

---

## 6. Data Model Translation

### Rust models (`models.rs`)

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
    // Computed fields serialized for frontend convenience:
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
    pub model_tokens: HashMap<String, (i64, i64)>,  // (input, output)
}
```

### TypeScript interfaces (`types.ts`)

Mirror the Rust structs exactly using `camelCase` (Tauri's serde serialization handles the mapping):

```typescript
interface SessionInfo {
  id: string;
  workspace: string;
  state: "working" | "waiting" | "error" | "subagent" | "idle" | "done";
  lastActivity: number;
  startedAt: number;
}

interface SessionMetrics {
  messageCount: number;
  userMessageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  model: string;
  lastInputTokens: number;
  customTitle: string | null;
  gitBranch: string | null;
  toolCounts: Record<string, number>;
}

interface EnrichedSession {
  info: SessionInfo;
  metrics: SessionMetrics;
  workspaceName: string;
  displayTitle: string;
  stateIcon: string;
  stateDisplayName: string;
  durationSecs: number;
  contextLimit: number;
  contextUsagePercent: number;
  modelDisplayName: string;
}

interface WindowMetrics {
  inputTokens: number;
  outputTokens: number;
  sessionCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCounts: Record<string, number>;
  modelTokens: Record<string, [number, number]>;
}
```

### `sessions.json` contract

The JSON schema for `sessions.json` is the shared contract between the Python hook and both app targets. It remains unchanged:

```json
{
  "sessions": {
    "<session-id>": {
      "id": "...",
      "workspace": "/path/to/project",
      "state": "working",
      "lastActivity": 1710000000.0,
      "startedAt": 1710000000.0
    }
  }
}
```

---

## 7. System Tray Integration

### 7.1 Tauri tray plugin

Tauri v2's `tauri-plugin-tray` provides a unified API:

```rust
use tauri::tray::{TrayIconBuilder, TrayIcon};

let tray = TrayIconBuilder::new()
    .icon(render_dot_grid_icon(&sessions))
    .menu(&build_tray_menu(&sessions))
    .on_menu_event(|app, event| { ... })
    .build(app)?;
```

### 7.2 Dot grid icon rendering

Port the `renderDotGrid()` logic from `main.swift` to Rust using the `image` crate:

- Create an RGBA `ImageBuffer` at the computed dimensions
- Draw filled circles for each session using the same color mapping
- Handle the blink state toggle (0.5s timer in the Rust backend)
- Convert to platform-appropriate icon format via Tauri's `Icon::Rgba`

Color mapping (preserved from Swift):

| State | Color | Blink |
|-------|-------|-------|
| working | white | yes (alpha 1.0 <-> 0.15) |
| waiting | yellow | no |
| error | red | no |
| subagent | cyan | yes (alpha 1.0 <-> 0.15) |
| idle | white @ 35% alpha | no |
| done/default | green | no |

No-session state: hollow white ring (same as macOS).

### 7.3 Platform-specific tray behaviors

| Behavior | Windows | Linux | macOS (Tauri) |
|----------|---------|-------|---------------|
| Tray location | System tray (notification area) | StatusNotifierItem (modern) or AppIndicator (legacy) | NSStatusBar (via Tauri) |
| Left-click | Open dashboard | Open dashboard | Open menu (macOS convention) |
| Right-click | Open menu | Open menu | N/A (left-click opens menu) |
| Icon format | ICO (auto-converted by Tauri) | PNG | PNG |
| Tooltip | "Claude Cue -- N sessions" | Same | Same |

### 7.4 Tray menu

Dynamically rebuilt on each open (same as the `NSMenuDelegate` pattern):

```
Claude Code Sessions
--------------------
⟳  WebApp — 38m 02s · 48.2K tokens
⏸  MLPipeline — 25m 20s · 31.6K tokens
--------------------
Dashboard...        Ctrl+D
Settings...         Ctrl+,
Quit                Ctrl+Q
```

---

## 8. Dashboard UI

### 8.1 Framework: React + Tailwind CSS

The dashboard replicates the SwiftUI views. Component mapping:

| SwiftUI View | React Component | Notes |
|-------------|-----------------|-------|
| `DashboardView` | `<Dashboard />` | Tab bar with Sessions/Usage |
| `SessionsTabView` | `<SessionsTab />` | Stat badges + session card list |
| `SessionCardView` | `<SessionCard />` | 4-row card with state dot, metrics, tools, context bar |
| `StatBadge` | `<StatBadge />` | Icon + label + value |
| `UsageView` | `<UsageView />` | Plan picker + window sections |
| `WindowSectionView` | `<WindowSection />` | Header + progress bar + stats + tool chips |
| `ContextBar` | `<ProgressBar />` | Reusable progress bar |
| `CueSettingsView` | `<SettingsView />` | Plan presets + token limit fields |

### 8.2 Styling approach

- **Dark theme by default** (matches the macOS app's dark appearance and developer preference)
- Tailwind CSS with a custom color palette matching the SwiftUI `.quaternary`, `.tertiary`, `.secondary` opacity levels
- `backdrop-blur` for the `.ultraThinMaterial` effects
- Monospaced digits via `font-variant-numeric: tabular-nums`
- Capsule-shaped tool chips using `rounded-full` + small padding

### 8.3 Data flow

```
Rust backend (Tokio timers)
  |-- poll_status() every 1s
  |-- refresh_metrics() every 5s
  \-- emit Tauri events --> React frontend
                              |-- useSessionMonitor() hook
                              |-- useUsageMetrics() hook
                              \-- Re-render components
```

The frontend subscribes to Tauri events using `@tauri-apps/api/event`:

```typescript
import { listen } from "@tauri-apps/api/event";

function useSessionMonitor() {
  const [sessions, setSessions] = useState<EnrichedSession[]>([]);

  useEffect(() => {
    const unlisten = listen<EnrichedSession[]>("sessions-updated", (event) => {
      setSessions(event.payload);
    });
    // Also fetch initial state via command
    invoke<EnrichedSession[]>("get_sessions").then(setSessions);
    return () => { unlisten.then(f => f()); };
  }, []);

  return sessions;
}
```

### 8.4 Window management

- Dashboard opens as the main Tauri window (created on tray menu click or app launch)
- Settings opens as a secondary window via `tauri::WebviewWindowBuilder`
- Window position/size persisted via `tauri-plugin-window-state`

---

## 9. Hook Adaptation

The Python hook script (`hooks/cue-hook`) needs two changes for cross-platform support:

### 9.1 File locking — replace `fcntl.flock`

`fcntl` is Unix-only. Replace with `msvcrt` on Windows or use a cross-platform approach:

```python
import sys
import os

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

### 9.2 Status directory — OS-appropriate paths

```python
def get_status_dir():
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~\\AppData\\Local"))
        return os.path.join(base, "Claude Cue")
    elif sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/Claude Cue")
    else:
        # Linux: XDG_DATA_HOME or ~/.local/share
        base = os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share"))
        return os.path.join(base, "claude-cue")
```

### 9.3 Atomic write on Windows

`os.rename()` fails on Windows if the target exists. Use `os.replace()` instead (available since Python 3.3, atomic on both platforms):

```python
os.replace(tmp, STATUS_FILE)  # Works on Windows, Linux, and macOS
```

### 9.4 Shebang line

The current `#!/usr/bin/env python3` works on macOS/Linux. On Windows, Claude Code invokes hooks differently (via `python` or `python3` on PATH), so the shebang is irrelevant there. No change needed.

### 9.5 Updated hook script (full diff summary)

| Change | Before | After |
|--------|--------|-------|
| Import | `import fcntl` | Platform-conditional lock functions |
| `STATUS_DIR` | Hardcoded `~/Library/...` | `get_status_dir()` function |
| Atomic write | `os.rename(tmp, STATUS_FILE)` | `os.replace(tmp, STATUS_FILE)` |
| Lock mechanism | `fcntl.flock(lock, fcntl.LOCK_EX)` | `lock_file(lock)` / `unlock_file(lock)` |

---

## 10. Installer / Packaging

### 10.1 Windows — MSI + optional NSIS

Tauri's built-in bundler produces both MSI and NSIS installers:

```json
// tauri.conf.json
{
  "bundle": {
    "targets": ["msi", "nsis"],
    "windows": {
      "certificateThumbprint": null,
      "digestAlgorithm": "sha256",
      "timestampUrl": ""
    }
  }
}
```

- MSI for enterprise/IT deployment
- NSIS for user-friendly "Next, Next, Finish" installation
- Install location: `C:\Program Files\Claude Cue\`
- Start Menu shortcut + optional Desktop shortcut
- Bundle the `cue-hook` Python script in the installation directory

### 10.2 Linux — AppImage + deb

Tauri produces AppImage and `.deb` bundles natively:

```json
{
  "bundle": {
    "targets": ["appimage", "deb"],
    "linux": {
      "desktop": {
        "Name": "Claude Cue",
        "Comment": "Monitor Claude Code sessions",
        "Categories": "Development;Utility;",
        "StartupWMClass": "claude-cue"
      }
    }
  }
}
```

- AppImage: single-file, runs anywhere, no installation needed
- `.deb`: for Debian/Ubuntu users who prefer system package management
- Optional future: RPM for Fedora/RHEL, Flatpak for sandboxed distros
- Install `cue-hook` to `~/.local/bin/` or bundle alongside the app

### 10.3 Hook installation

The installer (or first-run setup) should:
1. Copy `cue-hook` to a known location
2. Ensure the location is on `PATH` (or instruct the user to configure Claude Code's hook path)
3. On Windows: optionally create a `cue-hook.cmd` wrapper that invokes `python3 cue-hook`

---

## 11. Settings Persistence

### Replace UserDefaults with `tauri-plugin-store`

The plugin stores settings in a JSON file at the OS-appropriate config directory:

| Platform | Settings file location |
|----------|----------------------|
| macOS | `~/Library/Application Support/com.claude-cue.app/settings.json` |
| Windows | `%LOCALAPPDATA%\Claude Cue\settings.json` |
| Linux | `~/.config/claude-cue/settings.json` |

### Settings schema

```json
{
  "showInDock": true,
  "startAtLogin": false,
  "fiveHourTokenLimit": 2000000,
  "dailyTokenLimit": 8000000,
  "weeklyTokenLimit": 40000000,
  "selectedDashboardTab": "sessions"
}
```

Same keys as the macOS UserDefaults, enabling potential migration if a user switches from the Swift app to the Tauri app on macOS.

### Rust settings API

```rust
use tauri_plugin_store::StoreExt;

fn get_token_limit(app: &AppHandle, window: &UsageWindow) -> i64 {
    let store = app.store("settings.json").unwrap();
    store.get(window.settings_key())
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
}
```

---

## 12. MVP Build Order (Phased)

### Phase 1: Rust Core Engine (Week 1-2)

1. Scaffold Tauri v2 project in `claude-cue-desktop/`
2. Implement `models.rs` — all data structs with Serde derive
3. Implement `paths.rs` — OS-specific path resolution
4. Implement `jsonl_parser.rs` — line-by-line JSONL parsing
5. Implement `session_monitor.rs` — `poll_status()` + `refresh_metrics()`
6. Implement `usage_aggregator.rs` — full port of time-window aggregation
7. Implement `settings.rs` — `tauri-plugin-store` wrapper
8. Wire up Tauri commands and event emission
9. Unit tests for parsing, path resolution, and aggregation

**Exit criteria:** `cargo test` passes, Tauri commands return correct data from real `~/.claude/projects/` JSONL files.

### Phase 2: System Tray (Week 2-3)

1. Implement `tray.rs` — dot grid icon rendering using the `image` crate
2. Wire up 0.5s blink timer and 1s poll timer
3. Build dynamic tray menu with session info
4. Handle tray click to open dashboard window
5. Test on Windows and Linux (via CI or VM)

**Exit criteria:** Tray icon shows colored dots, menu lists sessions, click opens an empty dashboard window.

### Phase 3: Dashboard Frontend (Week 3-4)

1. Set up React + TypeScript + Tailwind in `claude-cue-desktop/src/`
2. Implement `useSessionMonitor` and `useUsageMetrics` hooks
3. Build `<Dashboard />` with tab bar
4. Build `<SessionsTab />` with stat badges and session cards
5. Build `<SessionCard />` — all 4 rows (status, metrics, tools, context bar)
6. Build `<UsageView />` with plan picker and window sections
7. Build `<ProgressBar />` component (used for context bar and usage bars)
8. Style to match the macOS app's dark theme

**Exit criteria:** Dashboard visually matches the macOS SwiftUI version, data flows from Rust backend to React frontend in real time.

### Phase 4: Settings + Hook Adaptation (Week 4-5)

1. Build `<SettingsView />` with plan presets and token limit fields
2. Implement settings window (secondary Tauri window)
3. Adapt `cue-hook` for cross-platform (locking, paths, atomic write)
4. Test hook on Windows with Python 3
5. Test hook on Linux

**Exit criteria:** Settings persist across restarts, hook works on all three platforms.

### Phase 5: Packaging + Release (Week 5-6)

1. Configure Tauri bundler for MSI, NSIS, AppImage, deb
2. Set up GitHub Actions CI for cross-platform builds
3. Test installers on clean Windows and Linux VMs
4. Write installation instructions
5. First release (GitHub Releases with platform-specific assets)

**Exit criteria:** Users can download and install Claude Cue on Windows or Linux and have it working within 5 minutes.

---

## 13. V2 Features

| Feature | Priority | Notes |
|---------|----------|-------|
| Auto-update | High | Tauri's built-in updater plugin with GitHub Releases backend |
| Start at login | High | Windows: Registry `Run` key; Linux: XDG autostart `.desktop` file |
| Desktop notifications | Medium | Notify when approaching rate limits (80%+ usage) |
| Demo mode | Medium | `--demo` flag with hardcoded seed data (port from Swift) |
| Custom title display | Medium | Already parsed from JSONL, just needs frontend rendering |
| Dock/taskbar visibility toggle | Low | Platform-specific; less meaningful on Windows/Linux |
| Keyboard shortcuts | Low | Global hotkey to open dashboard |
| Multiple theme support | Low | Light theme option |
| macOS Tauri target | Low | Optional replacement for the Swift app if quality parity is reached |
| RPM / Flatpak packages | Low | Expand Linux distribution coverage |
| Portable mode (Windows) | Low | Run from USB without installation, settings in app directory |

---

## 14. Engineering Principles

1. **Preserve the macOS app.** The Swift codebase is untouched. The Tauri app is additive. Both share only the hook script and `sessions.json` contract.

2. **Port logic, not code.** Rust reimplements the Swift algorithms for JSONL parsing, session monitoring, and usage aggregation. No FFI, no shared libraries. Each codebase is independently maintainable.

3. **Backend does the work.** All file I/O, parsing, and timer logic lives in Rust. The React frontend is a pure rendering layer that receives data via events and commands. This keeps the frontend simple and testable.

4. **Same data, same display.** The TypeScript interfaces mirror the Rust structs exactly. The React components reproduce the SwiftUI layout faithfully. A user switching platforms should see an identical dashboard.

5. **OS conventions matter.** Paths follow XDG on Linux, `%LOCALAPPDATA%` on Windows, `~/Library/` on macOS. Tray behavior respects platform norms (left-click = menu on macOS, left-click = dashboard on Windows/Linux).

6. **Zero external runtime.** No bundled Python, no bundled Node. The Tauri app is a single native binary. Only the hook script requires Python (which Claude Code already depends on).

7. **Test the core, not the UI.** Unit tests cover JSONL parsing, path resolution, time-window bucketing, and format utilities. UI testing is manual for V1 — automated via Playwright or similar in V2.

8. **Ship incrementally.** Each phase produces a working artifact. Phase 2 alone (tray only) is useful. Phase 3 (tray + dashboard) is the real MVP. Phase 5 is polish.

---

## 15. Product Risks and Advantages

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **WebView rendering inconsistency** across Linux distros (WebKitGTK versions vary) | Medium | Pin minimum WebKitGTK version, test on Ubuntu LTS + Fedora |
| **Python not installed** on some Windows machines | Medium | Document Python 3 as a prerequisite (Claude Code already requires it); optionally bundle a Python-to-Rust rewrite of the hook in V2 |
| **System tray support fragile on Linux** (some DEs hide tray icons, Wayland issues) | Medium | Test on GNOME, KDE, XFCE; provide fallback "open dashboard" desktop shortcut |
| **Two codebases to maintain** (Swift + Rust/React) | Medium | The Swift app is stable and small (~1700 LOC). Rust port is a one-time effort. Shared schema tests can catch drift. |
| **Tauri v2 maturity** — newer than Electron, fewer battle-tested examples | Low | Tauri v2 is GA since 2024, actively maintained, and well-documented. Community is large. |
| **JSONL format changes** in future Claude Code versions | Low | Parsing is lenient (ignores unknown fields). Both apps parse the same way. |

### Advantages

| Advantage | Impact |
|-----------|--------|
| **Unlocks 60%+ of potential users** who are on Windows/Linux | High — Claude Code is a CLI tool with many Linux/WSL users |
| **Tiny binary** (~5-8 MB) vs Electron (~150 MB) | Users appreciate lightweight tools, especially developers |
| **Rust backend** provides memory safety and excellent performance for file I/O | No GC pauses, no memory leaks from long-running tray app |
| **Same hook script** (with minor adaptations) reduces maintenance | One hook to test and document |
| **Future macOS consolidation** possible — could eventually ship one Tauri app for all three platforms | Long-term simplification if desired |
| **React frontend** has massive talent pool and component ecosystem | Faster iteration on dashboard features than SwiftUI |
| **GitHub Actions** can build all three platforms in one CI workflow | Single release process for all targets |

---

## Appendix: Key Dependencies

### Rust (Cargo.toml)

| Crate | Purpose |
|-------|---------|
| `tauri` v2 | App framework |
| `tauri-plugin-tray` | System tray |
| `tauri-plugin-store` | Settings persistence |
| `tauri-plugin-window-state` | Window position persistence |
| `serde` + `serde_json` | Serialization |
| `tokio` | Async runtime (bundled with Tauri) |
| `image` | Icon rendering (dot grid) |
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
