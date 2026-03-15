# Claude Cue

A native macOS menu bar app that shows real-time status of your Claude Code sessions — at a glance, know if Claude is working, waiting for permission, hit an error, or finished.

![Swift](https://img.shields.io/badge/Swift-5.9-F05138?logo=swift&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS_14+-000000?logo=apple&logoColor=white)
![SwiftUI](https://img.shields.io/badge/UI-SwiftUI-0071e3?logo=swift&logoColor=white)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-None-brightgreen)
![License](https://img.shields.io/badge/License-MIT-blue)

## Status Indicators

Each Claude Code session appears as a colored dot in your menu bar:

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

- **Real-time status** — polls every second, so the indicator updates instantly
- **Multi-session support** — tracks up to 8 concurrent sessions as a dot grid
- **Token metrics** — parses JSONL conversation logs for input/output/cache token counts
- **Session dashboard** — detailed view with workspace, duration, model, git branch, tool usage
- **Automatic cleanup** — stale sessions expire and get pruned
- **File locking** — concurrent hooks don't clobber each other's updates
- **Menu bar only** — optional dock icon, configurable via Settings

## How It Works

Claude Cue uses [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) to track session state. A Python hook script writes session status to `~/Library/Application Support/Claude Cue/sessions.json` on every lifecycle event:

```
SessionStart    → idle
PreToolUse      → working
PostToolUse     → working
UserPromptSubmit → working
PermissionRequest → waiting
PostToolUseFailure → error
SubagentStart   → subagent (cyan)
SubagentStop    → working
Stop            → done
TaskCompleted   → done
Notification    → done
SessionEnd      → remove
```

The Swift app reads `sessions.json` every second and renders the dot grid in the menu bar. Metrics are parsed from Claude's `.jsonl` conversation logs every 5 seconds.

## Install

```bash
git clone https://github.com/avonbereghy/claude-cue.git
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
Sources/
├── main.swift           # App entry point, AppDelegate, menu bar rendering, dot grid
├── SessionMonitor.swift # Polls sessions.json, parses JSONL for token metrics
├── DashboardView.swift  # SwiftUI dashboard with session details
└── Models.swift         # SessionInfo, SessionMetrics, EnrichedSession

hooks/
└── cue-hook             # Python hook script (called by Claude Code on every event)
```

**4 Swift files, zero external dependencies.** Pure SwiftUI + AppKit with `@Observable` state and atomic file writes.

## avonbereghy

Claude Cue is part of [avonbereghy](https://github.com/avonbereghy), a collection of tools for Claude Code:

| Project | What It Does |
|---------|-------------|
| **[Claude Symphony](https://github.com/avonbereghy/claude-symphony)** | Workflow methodology + slash commands for project generation |
| **[Claude Conductor](https://github.com/avonbereghy/claude-conductor)** | Native macOS app for managing Claude Code configuration |
| **[Claude Cue](https://github.com/avonbereghy/claude-cue)** | Status line indicator for Claude Code sessions |

## License

MIT
