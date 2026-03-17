# Claude Cue

A real-time session monitor for Claude Code — see at a glance if Claude is working, waiting for permission, hit an error, or finished. Available as a native macOS menu bar app and a cross-platform desktop app for Windows and Linux.

![Swift](https://img.shields.io/badge/Swift-5.9-F05138?logo=swift&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-Tauri_v2-000000?logo=rust&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS_|_Windows_|_Linux-blue)
![License](https://img.shields.io/badge/License-MIT-blue)

![Claude Cue Dashboard](assets/dashboard-demo.png)

## Status Indicators

Each Claude Code session appears as a colored dot in your menu bar / system tray:

| Color | Meaning |
|-------|---------|
| Blinking white | Claude is working |
| Blinking cyan | Subagent running |
| Yellow | Waiting for your permission |
| Red | Tool error |
| Green | Done |
| Dim white | Idle |
| Hollow ring | No active sessions |

Multiple sessions show as a grid of dots — see all your sessions at once.

## Features

- **Real-time status** — polls every 2 seconds, blink animation for active sessions
- **Multi-session support** — tracks up to 8 concurrent sessions as a dot grid
- **Token metrics** — incremental JSONL parsing for input/output/cache token counts
- **Usage tracking** — 5-hour, daily, and weekly usage windows with progress bars and cost estimates
- **Plan presets** — Pro, Max Standard, Max Plus token limits with one-click selection
- **Session dashboard** — detailed view with workspace, duration, model, git branch, tool usage
- **CLI fallback** — `--status` flag for tiling WM users without a system tray
- **Privacy-first** — shows only leaf directory names, full paths on hover only
- **Security-first** — no network calls, atomic file writes, 0600 permissions, path sanitization
- **Automatic cleanup** — stale sessions expire and get pruned
- **File locking** — concurrent hooks don't clobber each other's updates
- **Accessibility** — ARIA labels, keyboard navigation, high contrast, reduced motion support

## Platforms

### macOS (Native Swift)

The original app — pure SwiftUI + AppKit, zero external dependencies. Menu bar icon with dashboard window.

```bash
git clone https://github.com/ClaudeStage/claude-cue.git
cd claude-cue
bash install.sh
```

### Windows & Linux (Tauri)

Cross-platform desktop app built with Rust (Tauri v2) + React + TypeScript. System tray icon with dashboard, onboarding wizard, and settings UI.

```bash
cd claude-cue/claude-cue-desktop
npm install
npm run tauri dev    # development
npm run tauri build  # release
```

See [claude-cue-desktop/INSTALL.md](claude-cue-desktop/INSTALL.md) for platform-specific install instructions.

## How It Works

Claude Cue uses [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) to track session state. A Python hook script writes session status to a platform-specific `sessions.json` on every lifecycle event:

```
SessionStart       → idle
PreToolUse         → working
PostToolUse        → working
UserPromptSubmit   → working
PermissionRequest  → waiting
PostToolUseFailure → error
SubagentStart      → subagent
SubagentStop       → working
Stop               → done
TaskCompleted      → done
Notification       → done
SessionEnd         → remove
```

The app reads `sessions.json` and renders the dot grid. Metrics are parsed incrementally from Claude's `.jsonl` conversation logs — only new bytes are read on each cycle, keeping CPU near 0%.

## Install

```bash
git clone https://github.com/ClaudeStage/claude-cue.git
cd claude-cue
bash install.sh
```

The installer:
1. Builds the Swift binary
2. Creates `Claude Cue.app` in `~/Applications/`
3. Generates the app icon
4. Configures all 12 Claude Code hooks in `~/.claude/settings.json`
5. Launches the app

To start on login: **System Settings → General → Login Items → add "Claude Cue"**

## Uninstall

```bash
rm -rf ~/Applications/Claude\ Cue.app
```

Then remove the hook entries from `~/.claude/settings.json` (search for `cue-hook`).

## Architecture

```
Sources/                          # macOS native app (Swift/SwiftUI)
├── main.swift                    # AppDelegate, menu bar, dot grid rendering
├── SessionMonitor.swift          # Polls sessions.json, incremental JSONL parsing
├── UsageAggregator.swift         # Time-windowed usage aggregation
├── DashboardView.swift           # Dashboard with session cards
├── UsageView.swift               # Usage tab with progress bars
└── Models.swift                  # SessionInfo, SessionMetrics, EnrichedSession

claude-cue-desktop/               # Cross-platform app (Tauri v2)
├── src-tauri/src/                # Rust backend
│   ├── lib.rs                    # Tauri commands, timers, tray setup
│   ├── session_monitor.rs        # Session polling + JSONL path resolution
│   ├── usage_aggregator.rs       # Usage aggregation across time windows
│   ├── jsonl_parser.rs           # Line-by-line JSONL parsing
│   ├── tray.rs                   # Dot grid icon rendering (tiny-skia)
│   ├── cli.rs                    # CLI --status output
│   ├── security.rs               # Atomic writes, permissions, path sanitization
│   ├── settings.rs               # Settings load/save
│   ├── env_detect.rs             # Platform detection + hook auto-configuration
│   ├── models.rs                 # Shared data types
│   └── paths.rs                  # OS-specific path resolution
├── src/                          # React frontend
│   ├── components/               # Dashboard, SessionCard, UsageView, Settings, Onboarding
│   ├── hooks/                    # useSessionMonitor, useUsageMetrics
│   └── lib/                      # types, format, a11y utilities
└── src-tauri/tauri.conf.json     # Tauri config (minimal capabilities, no network)

hooks/
└── cue-hook                      # Python hook script (cross-platform)
```

## Security

- **No network calls** — all data stays local, no telemetry, no HTTP clients in dependencies
- **Atomic file writes** — temp file → fsync → rename prevents data corruption
- **File permissions** — 0600 on Unix for all data files
- **Path sanitization** — rejects `..` traversal, validates workspace paths
- **Hook validation** — rejects shell metacharacters in hook paths
- **Minimal capabilities** — Tauri frontend has no shell, HTTP, or filesystem access
- **DevTools disabled** — in release builds
- **Privacy** — workspace paths show leaf directory name only

## Claude Stage

Claude Cue is part of [Claude Stage](https://github.com/ClaudeStage), a collection of tools for Claude Code:

| Project | What It Does |
|---------|-------------|
| **[Claude Symphony](https://github.com/ClaudeStage/claude-symphony)** | Workflow methodology + slash commands for project generation |
| **[Claude Conductor](https://github.com/ClaudeStage/claude-conductor)** | Native macOS app for managing Claude Code configuration |
| **[Claude Cue](https://github.com/ClaudeStage/claude-cue)** | Status line indicator for Claude Code sessions |

## License

MIT
