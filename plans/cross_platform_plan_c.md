# Plan C: Outside-In — User Experience & Validation Plan

## Cross-Platform Claude Cue (Windows + Linux)

---

## 1. Target User Personas

### Persona A: "WSL Power User" (Windows)

- **Profile**: Professional developer on Windows 10/11 who runs Claude Code inside WSL2 (Ubuntu). Uses VS Code with the WSL remote extension. Has 2-3 terminal panes with Claude Code sessions running in WSL while their desktop is Windows-native.
- **Dev environment**: Windows Terminal + WSL2, VS Code, PowerShell for some tasks. Likely has Docker Desktop. Uses Windows taskbar and notification center daily.
- **Key tension**: Claude Code runs *inside* WSL but they want to see session status in the *Windows* system tray — bridging the Unix/Windows boundary is their daily reality.
- **Current workaround**: Alt-tab between terminal windows to check if Claude is still working or waiting for permission. Misses permission requests, wastes time.

### Persona B: "Native Windows Dev" (Windows)

- **Profile**: .NET, Rust, or Node.js developer who uses Claude Code natively on Windows (not WSL). Uses Windows Terminal or the built-in terminal in their IDE. May have 1-2 Claude Code sessions.
- **Dev environment**: PowerShell or cmd, Visual Studio or VS Code, native Windows file paths.
- **Key tension**: Fewer sessions than power users but equally frustrated by the invisible "is it done yet?" problem. Expects Windows-native look and feel — follows system theme, respects DPI scaling, integrates with notification center.

### Persona C: "Linux Terminal Heavy" (Linux)

- **Profile**: Backend/infra/ML engineer on Linux. Uses a tiling WM (i3/sway) or a full DE (GNOME/KDE). Runs 3-8 Claude Code sessions across tmux panes or multiple terminal emulators. Cares deeply about resource efficiency.
- **Dev environment**: Alacritty/kitty/gnome-terminal, tmux, neovim or VS Code, typically Wayland on GNOME/KDE or X11 on older setups. May SSH into remote machines.
- **Key tension**: Wants a lightweight indicator that doesn't break their carefully configured desktop. GNOME users are especially tricky — no native system tray since GNOME 3.26, requires the "AppIndicator" extension. Tiling WM users may not have a tray at all and prefer i3status/waybar integration.

### Persona D: "Remote/SSH Developer" (Cross-platform)

- **Profile**: Developer who SSHes into a Linux server or cloud dev environment (Codespaces, remote EC2) where Claude Code runs. Their local machine (Mac, Windows, or Linux) has a display, but Claude Code is headless on the remote.
- **Key tension**: The hook script runs on the remote machine but the tray app needs to run locally. This is the hardest persona to serve well in V1 and may be deferred, but we must acknowledge it.

---

## 2. Core User Problems

### The "Is It Done Yet?" Tax

Claude Code sessions can run for minutes. Without visibility, developers:
1. **Context-switch anxiety** — Afraid to focus on something else because they might miss a permission prompt, stalling the session for 5-10 minutes.
2. **Blind polling** — Alt-tab to check the terminal every 30-60 seconds, destroying deep work flow.
3. **Missed errors** — A tool failure or error state goes unnoticed, wasting the remaining context window on a doomed session.
4. **Rate limit surprise** — Hit a 5-hour or daily token cap unexpectedly, losing momentum at the worst moment.

### Why Current Workarounds Fail

- **Terminal title bars** don't update with Claude Code state.
- **Desktop notifications** from Claude Code are coarse-grained (only on completion) — no ongoing "heartbeat" visibility.
- **Multiple monitors** make it worse: Claude Code is on monitor 2, your IDE is on monitor 1. Without a persistent tray indicator, you have no peripheral awareness.

### What Users Actually Want

- A **persistent ambient signal** — like a build light — that they can check with a flick of the eye.
- A **detailed drill-down** when they want to know *which* session needs attention.
- A **usage dashboard** so they can pace their work across rate-limit windows.

---

## 3. End-to-End User Journeys

### Journey 1: Installing and Seeing the First Tray Icon

#### Windows

1. User downloads the installer (MSI or standalone `.exe`) from GitHub Releases.
2. Runs the installer. It:
   - Copies the binary to `%LOCALAPPDATA%\Claude Cue\`
   - Creates Start Menu shortcut
   - Detects WSL distributions and native Claude Code installs
   - Offers to configure hooks (explains what hooks are in plain language)
   - Asks: "Where does Claude Code run? (a) Windows native, (b) WSL, (c) Both"
3. If WSL: installs the hook script inside the WSL filesystem via `wsl.exe -d <distro> -- bash -c "..."`, writes hook config to `~/.claude/settings.json` inside WSL.
4. If native Windows: installs the hook script to `%USERPROFILE%\.claude\` and configures hooks.
5. Claude Cue launches. A hollow ring appears in the system tray (overflow area by default on Windows 11).
6. **Critical first-run moment**: A toast notification says "Claude Cue is running. Pin it to your taskbar tray for quick access." with a link/instructions to pin.
7. User starts a Claude Code session. Within 1 second, the hollow ring becomes a blinking white dot.
8. **Aha moment**: "I can see it working without leaving my IDE."

**Risk**: On Windows 11, new tray icons are hidden in the overflow by default. If the user doesn't pin it, they'll never see the dots. The first-run notification MUST guide them to pin it.

#### Linux

1. User downloads an AppImage (universal) or installs via distro package (`.deb` for Ubuntu/Debian, AUR for Arch).
2. AppImage: `chmod +x ClaudeCue.AppImage && ./ClaudeCue.AppImage`
3. First launch:
   - Detects desktop environment (GNOME, KDE, XFCE, i3, sway, etc.)
   - If GNOME without AppIndicator extension: shows a dialog — "GNOME doesn't support tray icons natively. Install the AppIndicator extension?" with a one-click install link or `gnome-extensions install` command.
   - If tiling WM without tray: offers alternative — "No system tray detected. Would you like to use (a) a standalone floating window, (b) a D-Bus interface for waybar/i3status integration, (c) just the dashboard window?"
   - Configures hooks in `~/.claude/settings.json`
4. Tray icon appears (or alternative indicator for tiling WMs).
5. User starts Claude Code, sees the dot animate.
6. **Aha moment**: Same as Windows — "peripheral awareness without context switching."

### Journey 2: Monitoring Multiple Concurrent Sessions During a Work Day

**Scenario**: User has 3 Claude Code sessions — a large refactor (working), an API bugfix (waiting for permission), and a test generation task (subagent running).

1. Glance at tray: see a 2x2 dot grid. One blinking white, one yellow, one blinking cyan.
2. Yellow dot catches attention — that's the permission-waiting session.
3. Right-click tray icon (Windows) or click (Linux) — context menu shows:
   ```
   Claude Code Sessions
   ─────────────────────
   ⟳  WebApp — 38m 12s · 35.8K tokens
   ⏸  APIServer — 10m 45s · 12.2K tokens
   ⤴  InfraConfig — 15m 20s · 18.9K tokens
   ─────────────────────
   Dashboard...    (D)
   Settings...     (,)
   Quit            (Q)
   ```
4. User clicks "Dashboard..." — dashboard window opens showing all three sessions as cards with full metrics (context %, tool breakdown, model, branch).
5. User sees APIServer is at "Waiting" — switches to that terminal, grants permission, comes back to IDE.
6. Throughout the day, the dot grid grows and shrinks as sessions start and complete. The tray icon is the **ambient heartbeat** of their Claude Code usage.

**Platform-specific behaviors**:
- **Windows**: Dashboard is a standard Win32/WPF window. Respects dark/light theme. DPI-aware on high-res monitors. Can be snapped to screen edges via Windows Snap. Keyboard shortcut (configurable global hotkey, e.g., `Ctrl+Shift+C`) opens dashboard.
- **Linux**: Dashboard is a GTK or Qt window (matching DE toolkit). Respects system theme. On Wayland, uses xdg-decoration for server-side decorations. On tiling WMs, the window can be assigned to a specific workspace.

### Journey 3: Checking Usage Limits to Avoid Rate Limits

1. User has been coding all morning with Claude Code. Wants to know if they're approaching their 5-hour token limit.
2. Opens Dashboard (tray click or hotkey) -> Usage tab.
3. Sees three time-window sections:
   - **Session (5hr)**: 1.2M / 2.0M tokens — 60% — yellow progress bar. "Resets in 2h."
   - **Today**: 3.1M / 8.0M tokens — 39% — yellow bar. "Resets in 9h."
   - **This Week**: 18.4M / 40.0M tokens — 46% — yellow bar. "Resets in 3d."
4. User sees they're at 60% on the 5-hour window. Decides to batch their remaining questions carefully.
5. Each section shows cost estimate, model breakdown, tool usage — helps the user understand *where* their tokens went.

**Key design decision**: The usage tab must work identically across platforms because it reads from the same JSONL files. The only platform variance is the settings storage location (UserDefaults on macOS, a JSON config file on Windows, XDG config on Linux).

---

## 4. Key Retention Moments

What makes someone keep Claude Cue running vs. closing it after day one:

1. **First saved context switch** — The moment they notice a yellow dot (permission waiting) from the corner of their eye while writing code in another window. They didn't have to Alt-tab. This is the "I need this" moment.

2. **First rate limit save** — Seeing the 5-hour window at 85% and choosing to wait 20 minutes instead of burning through their limit on a low-priority task.

3. **Multi-session juggling** — Running 3+ sessions and using the tray dots as a "dashboard" without opening anything. The dot grid becomes muscle memory.

4. **End-of-day review** — Opening the usage tab to see how much they accomplished: sessions, tokens, tools used, cost. This creates a sense of productivity and informs work patterns.

5. **Start-at-login becomes default** — After a week, they enable auto-start and forget Claude Cue exists as a separate app — it's just part of their development environment, like a clock in the taskbar.

---

## 5. Onboarding Flow

### Windows Installer (MSI)

```
Step 1: Welcome
  "Claude Cue monitors your Claude Code sessions from the system tray."
  [Screenshot of tray with colored dots]

Step 2: Claude Code Detection
  Found Claude Code (native Windows) at C:\Users\...\
  Found Claude Code in WSL (Ubuntu-22.04)

  Configure hooks for:
  [x] Windows native
  [x] WSL: Ubuntu-22.04

Step 3: Plan Selection
  "Set your token limits to see usage progress bars."
  ( ) Pro ($20/mo)        — 500K / 2M / 10M
  (*) Max Standard ($100) — 2M / 8M / 40M
  ( ) Max Plus ($200)     — 4M / 16M / 80M
  ( ) Custom / Skip

Step 4: Install
  Installing... done.

  [x] Start Claude Cue now
  [x] Start automatically at login

  [Finish]
```

Post-install: Toast notification with instructions to pin the tray icon.

### Linux First Launch

No separate installer wizard — the app handles it on first run:

```
+-- Welcome to Claude Cue ---------------------+
|                                               |
|  Desktop: GNOME 46 (Wayland)                  |
|  Tray support: Requires AppIndicator extension|
|                                               |
|  [Install Extension]  [Use Dashboard Only]    |
|                                               |
|  --- Hook Configuration ---                   |
|                                               |
|  Found ~/.claude/settings.json                |
|  [Configure Hooks Automatically]              |
|                                               |
|  --- Plan ---                                 |
|  [Pro] [Max $100] [Max $200] [Custom]         |
|                                               |
|  [x] Autostart (XDG autostart)                |
|  [Get Started]                                |
+-----------------------------------------------+
```

### Critical Onboarding Principles

1. **Show value in under 60 seconds** — From install to seeing the first dot blink, less than a minute.
2. **Don't require restart** — Hooks take effect on the next Claude Code session, not requiring a restart of existing sessions.
3. **Explain the tray icon** — Many developers haven't used tray icons in years. A brief visual guide (like the macOS installer's colored-dot legend) is essential.
4. **Graceful degradation** — If hooks can't be auto-configured (permissions, non-standard setup), show manual instructions rather than failing.

---

## 6. Information Architecture

### What the User Sees (Ordered by Frequency of Use)

```
Frequency: Constant (peripheral vision)
+--------------------------------------+
|  SYSTEM TRAY ICON                    |
|  Dot grid — color/blink = state      |
|  Hollow ring = app running, no       |
|  sessions                            |
+--------------------------------------+
     |
     | Click / Right-click
     v
Frequency: Several times per hour
+--------------------------------------+
|  CONTEXT MENU                        |
|  Session list with icons, elapsed    |
|  time, token count                   |
|  ----------                          |
|  Dashboard... / Settings... / Quit   |
+--------------------------------------+
     |
     | "Dashboard..."
     v
Frequency: A few times per day
+--------------------------------------+
|  DASHBOARD WINDOW                    |
|                                      |
|  [Sessions]  [Usage]                 |
|                                      |
|  Sessions Tab:                       |
|  +- Session Card -----------------+  |
|  | * Title — State — Duration     |  |
|  | Messages / Tokens / Tools      |  |
|  | Tool chips: Bash 24  Edit 15.. |  |
|  | Context ========---- 59%       |  |
|  +--------------------------------+  |
|                                      |
|  Usage Tab:                          |
|  +- 5-Hour Window ----------------+  |
|  | ==========------ 60%   $2.34   |  |
|  | Resets in 2h                    |  |
|  | Tokens / Sessions / Tools      |  |
|  +--------------------------------+  |
|  +- Daily Window -----------------+  |
|  | ...                             |  |
|  +--------------------------------+  |
+--------------------------------------+
     |
     | Accessed once, then rarely
     v
Frequency: Once at setup, occasionally after
+--------------------------------------+
|  SETTINGS                            |
|  - Start at login                    |
|  - Plan preset / custom limits       |
|  - (Windows) Global hotkey           |
|  - (Linux) Tray mode selection       |
+--------------------------------------+
```

### Design Principle: Escalating Detail

- **Tray icon**: 0 bits of text, pure color/shape. Answers: "How many sessions? What state?"
- **Context menu**: One line per session. Answers: "Which project? How long? How many tokens?"
- **Dashboard**: Full detail. Answers: "What model? What tools? How full is the context window? Am I near rate limits?"

This hierarchy must be preserved across all platforms. The tray icon is the most important surface — if we get that wrong, the rest doesn't matter.

---

## 7. Platform-Specific UX Considerations

### Windows

#### System Tray Overflow
- Windows 11 hides new tray icons in the overflow area by default. Users must manually pin them.
- **Mitigation**: First-run toast notification with visual instructions. Settings page should detect if the icon is in overflow and show a reminder.
- Consider using a balloon notification on first launch (Win32 `Shell_NotifyIcon` with `NIF_INFO`).

#### Notification Center
- Windows 10/11 has Action Center / Notification Center.
- Use Windows toast notifications for high-priority state changes: permission requests (yellow) and errors (red).
- Group notifications by session — don't spam.
- Include action buttons in notifications: "Open Terminal" to switch to the waiting session.

#### Dark/Light Theme
- Windows 10/11 supports system-wide light/dark mode.
- Tray icon dots must be visible on both light and dark taskbars. The current macOS "white" dots will be invisible on a light Windows taskbar.
- **Solution**: Use high-contrast colors that work on both backgrounds, or detect taskbar theme and adjust. Consider using outlined dots on light backgrounds.

#### DPI Scaling
- Windows supports per-monitor DPI scaling (100%, 125%, 150%, 200%, etc.).
- Tray icons are typically 16x16 or 32x32 pixels but must be rendered at the correct DPI.
- Dashboard UI must be DPI-aware — all text, progress bars, and cards must scale cleanly.
- Test at 100%, 150%, and 200% as minimum.

#### Taskbar Behaviors
- On Windows 11, the taskbar is always at the bottom and cannot be moved. Tray icon position is fixed.
- On Windows 10, the taskbar can be on any edge. Context menu positioning must adapt.
- "Focus Assist" / "Do Not Disturb" mode suppresses notifications — the tray icon remains the only signal.

### Linux

#### GNOME (No Native Tray)
- GNOME removed `StatusNotifierItem` / system tray support in 3.26.
- The "AppIndicator and KStatusNotifierItem Support" GNOME extension (`gnome-shell-extension-appindicator`) restores it and is widely used (25M+ downloads on extensions.gnome.org).
- **Strategy**: Detect GNOME at launch. If the extension is missing, show a one-time dialog explaining the situation with an install link. Do NOT silently fail.
- **Fallback**: If user declines the extension, offer a persistent small floating window (always-on-top, sticky to all workspaces, no window decorations) that shows the dot grid.

#### KDE Plasma (Native Tray)
- Full `StatusNotifierItem` support. Tray icons work out of the box.
- KDE uses Qt — if the app uses GTK, the tray icon may look slightly off. Consider using `libappindicator3` or the D-Bus `StatusNotifierItem` protocol directly.

#### XFCE / MATE / Cinnamon
- All support the XEmbed-based system tray (traditional X11 tray protocol) and/or `StatusNotifierItem`.
- Generally "just works" with `libappindicator3`.

#### Tiling WM Users (i3, sway, Hyprland)
- May or may not have a tray. i3bar and swaybar support tray icons. Waybar does too (with tray module).
- Users with no tray configured need an alternative:
  - **Option 1**: D-Bus API that tiling WM status bar modules can query (e.g., a custom waybar module that reads Claude Cue state).
  - **Option 2**: A tiny floating window.
  - **Option 3**: CLI tool (`claude-cue status`) that outputs JSON — users can pipe it into their bar.
- For V1, supporting standard tray + a CLI fallback is reasonable.

#### Wayland vs X11
- X11: Traditional `XEmbed` tray protocol, widely supported.
- Wayland: No universal tray protocol. Must use D-Bus `StatusNotifierItem` protocol (which GNOME supports only via extension, KDE natively).
- Wayland also restricts global hotkeys and window positioning. Dashboard window placement is compositor-dependent.
- **Test matrix**: GNOME on Wayland, KDE on Wayland, sway, GNOME on X11, KDE on X11.

#### Theming
- Linux desktops have wildly diverse themes. Avoid assumptions about background colors.
- Tray icon should use theme-aware colors or render with outlines to ensure visibility.
- Dashboard should use system toolkit colors (GTK theme or Qt theme) — avoid hardcoded colors.

---

## 8. Feedback Loops and Habit-Forming

### Why Users Keep Checking the Tray Icon

1. **Variable-interval reinforcement** — The tray state changes unpredictably. Sometimes Claude works for 10 seconds, sometimes 10 minutes. This mirrors the "pull to refresh" pattern — the user glances at the tray because the state *might* have changed.

2. **Cost of missing a yellow dot** — If Claude is waiting for permission and the user doesn't notice for 5 minutes, that's 5 minutes of dead time. The "loss aversion" of wasted time creates a natural habit of checking.

3. **Progress visualization** — Watching the dot blink while Claude works provides a sense of progress, similar to watching a build run. Even though the user can't speed it up, knowing work is happening reduces anxiety.

### Habit-Building Design Choices

| Design Choice | Psychological Effect |
|---|---|
| Dots blink while working | Creates a "heartbeat" — the tool feels alive |
| Yellow is attention-grabbing | Permission requests are urgent — color creates urgency |
| Context menu shows elapsed time | Creates awareness of how long tasks take |
| Usage % in dashboard | Creates scarcity awareness — "I should be strategic" |
| Dot grid grows with sessions | Visual reward for running multiple sessions |

### Notification Strategy (Cross-Platform)

Notifications should be **opt-in and conservative** to avoid fatigue:
- **Always notify**: Permission request waiting (yellow state) after 30 seconds — the user has probably context-switched.
- **Optional notify**: Session completed (green/done), error state.
- **Never notify**: Working state changes, subagent start/stop, token milestones (too noisy).

Platform-specific notification APIs:
- Windows: Toast notifications via Windows.UI.Notifications
- Linux: `libnotify` / `notify-send` / D-Bus `org.freedesktop.Notifications`

---

## 9. Accessibility

### Screen Readers

- **Tray icon**: Must expose current state as accessible text. E.g., "Claude Cue: 3 sessions — 1 working, 1 waiting, 1 subagent."
  - Windows: `Shell_NotifyIcon` supports tooltip text, which screen readers (NVDA, JAWS) can read.
  - Linux: `StatusNotifierItem` supports `Title` and `ToolTip` properties accessible via AT-SPI.
- **Context menu**: Standard menu semantics. Each item should be a proper menu item, not custom-drawn text.
- **Dashboard**: All visual indicators must have text alternatives.
  - Progress bars: "5-hour usage: 60%, 1.2 million of 2 million tokens"
  - Session cards: State + name + duration as accessible label
  - Color-coded dots in session cards: supplement with text labels ("Working", "Waiting", etc.) — already present in the macOS design.

### Keyboard Navigation

- **Context menu**: Must be navigable with arrow keys and activatable with Enter.
- **Dashboard**: Full Tab/Shift+Tab navigation. Focus indicators on all interactive elements.
- **Global hotkey**: Configurable keyboard shortcut to open dashboard (Windows: `Ctrl+Shift+C` default; Linux: depends on DE — may need to use DE-specific hotkey registration).

### High Contrast

- Windows High Contrast mode: All UI elements must remain visible. Progress bars need borders, not just fill color. Text must meet WCAG AA contrast ratios.
- Linux: Respect high-contrast GTK/Qt themes. Test with "HighContrast" and "HighContrastInverse" GNOME themes.
- Tray icon dots: In high-contrast mode, use outlined circles with fill, not just filled circles. The blink animation should be replaced with a pulsing border (for users who have reduced-motion preferences).

### Reduced Motion

- Detect `prefers-reduced-motion` (Windows: `SystemParametersInfo(SPI_GETCLIENTAREAANIMATION)`; Linux: `gtk-enable-animations` setting).
- Replace blinking dots with static dots that have a subtle indicator (e.g., a small rotation arrow overlay for "working", no blink).

---

## 10. Edge Cases

### WSL Users (Claude Code in WSL, Cue on Windows)

This is the **highest-priority edge case** because a large portion of Windows Claude Code users likely use WSL.

**The bridge problem**: The hook script runs inside WSL (Linux filesystem). Claude Cue runs on Windows (Win32). How does the hook communicate session state to the app?

**Options (ranked by user simplicity)**:
1. **Shared filesystem**: WSL2 mounts the Windows filesystem at `/mnt/c/`. The hook writes `sessions.json` to a Windows-accessible path (e.g., `/mnt/c/Users/<user>/AppData/Local/Claude Cue/sessions.json`). The Windows app reads it normally. **Simplest and most reliable.**
2. **Named pipe / TCP socket**: Hook script sends state over a localhost socket to the Windows app. More complex, but avoids filesystem polling.
3. **WSL interop**: Hook script calls `cmd.exe /c` to invoke a Windows-side script. Heavy and fragile.

**Recommended for V1**: Option 1 (shared filesystem via `/mnt/c/`). The installer detects WSL and configures the hook to write to the Windows-side path.

**Caveat**: `/mnt/c/` writes from WSL are slower than native Linux I/O, but for a small JSON file updated a few times per second, this is negligible.

### SSH / Remote Sessions

Claude Code runs on a remote server; the user's local machine has the display.

**V1 approach**: Explicitly out of scope. Document this limitation clearly. The hook script requires local filesystem access to communicate with the tray app.

**Future approach (V2+)**: The hook script could POST session state to a lightweight HTTP endpoint that the local Claude Cue instance listens on. This would require:
- A "remote mode" config in Claude Cue to listen on a port.
- SSH port forwarding or a secure tunnel.
- Authentication to prevent unauthorized state injection.

### Multiple Monitors

- **Dashboard window positioning**: On first open, center on the primary monitor. Remember position per monitor configuration.
- **Tray icon**: Always on the primary taskbar (Windows) or whichever panel has the tray (Linux).
- **DPI mismatch**: On Windows, different monitors may have different DPI. Dashboard must re-render at correct DPI when dragged between monitors.

### Headless Servers

- No display server = no tray icon or dashboard.
- The hook script still works (it just writes JSON). A future CLI companion (`claude-cue status --json`) could read the state file.
- For V1: if no display is detected at launch, print a helpful error: "Claude Cue requires a desktop environment. For headless monitoring, see [future docs link]."

### Multiple User Accounts

- On shared Linux machines, each user has their own `~/.claude/` directory. No conflict.
- On Windows with multiple user profiles: each user gets their own `%LOCALAPPDATA%\Claude Cue\`.

### File Locking (Cross-Platform)

The current hook uses `fcntl.flock()` — Unix-only.
- **Windows native**: Replace with `msvcrt.locking()` or `win32file.LockFileEx()`.
- **WSL**: `fcntl.flock()` works inside WSL. If writing to `/mnt/c/`, `fcntl` locking does NOT work across the WSL/Windows boundary — but since only the WSL-side hook writes and only the Windows-side app reads, this is acceptable (reader never writes, no lock needed on the reader side).
- **Portable solution**: Use `os.name` check to select `fcntl` (Unix) or `msvcrt` (Windows) locking. Or use atomic temp-file-then-rename (already implemented) which avoids locking entirely on the reader side.

### System Sleep / Hibernate

- When the machine sleeps and wakes, timers may fire incorrectly. All sessions older than `STALE_THRESHOLD` (currently 10 minutes) get pruned on the next poll — this handles sleep gracefully.
- On resume, refresh all metrics immediately rather than waiting for the next timer tick.

### Locale and Time Formatting

- Duration display ("38m 12s") is locale-independent — keep it.
- Cost display ("$2.34") assumes USD — add a note that costs are estimates in USD.
- Date/time formatting in "Resets in" should use the system locale for daily/weekly boundaries.

---

## 11. What Must Be True for Users to Recommend This

Users will recommend Claude Cue to colleagues if **all** of these are true:

1. **"It just works"** — Install takes under 2 minutes. No manual hook configuration. No obscure dependencies. The tray icon appears and sessions show up automatically.

2. **"It's invisible when I don't need it"** — Low resource usage (< 20MB RAM, < 1% CPU). No notification spam. No unexpected windows. It sits in the tray and does its job.

3. **"It saved me real time"** — At least one instance of catching a permission-waiting session within 10 seconds instead of 5 minutes. This is the word-of-mouth story: "I had this thing running in the background and it caught my attention right when Claude needed me."

4. **"It looks native"** — On Windows, it feels like a Windows app. On Linux KDE, it follows the Breeze theme. On Linux GNOME, it follows Adwaita. No Electron shell, no web-tech jank, no foreign-looking UI.

5. **"It respects my setup"** — Doesn't fight with my tiling WM. Doesn't break my carefully configured GNOME extensions. Doesn't add startup services I didn't ask for. Uninstall is clean.

6. **"The usage tracking is genuinely useful"** — The 5-hour/daily/weekly windows with progress bars prevent rate-limit surprises. Cost estimates help API users budget.

---

## 12. Riskiest Assumptions and Validation

### Assumption 1: Users Will Pin the Tray Icon (Windows)

**Risk**: HIGH. Windows 11 hides tray icons by default. If users don't pin it, the entire value proposition fails — they'll never see the dots.

**Validation**:
- Prototype the Windows tray icon behavior. Test with 5 Windows users who don't know about Claude Cue. How many discover the icon without prompting? How many successfully pin it?
- Consider whether a persistent notification or floating widget (like the Windows clock) would be a better primary surface than the tray.

### Assumption 2: GNOME Users Will Install the AppIndicator Extension

**Risk**: MEDIUM-HIGH. Extension installation is friction. Some corporate environments restrict GNOME extensions.

**Validation**:
- Survey Linux Claude Code users: what DE do they use? Do they already have AppIndicator installed? (Many do, for Discord, Slack, etc.)
- Test the fallback floating-window approach. Is it acceptable to GNOME users?
- Consider whether a GNOME extension that integrates Claude Cue into the top bar (like the battery indicator) would be more native-feeling.

### Assumption 3: The Hook-to-JSON-File Architecture Works Cross-Platform

**Risk**: MEDIUM. The current architecture (Python hook writes JSON, app polls JSON) is simple but has platform-specific file path and locking concerns.

**Validation**:
- Prototype the hook script on Windows (native Python, not WSL) writing to `%LOCALAPPDATA%`. Verify performance and reliability.
- Prototype WSL hook writing to `/mnt/c/` path. Measure latency (should be < 100ms).
- Stress test: 8 concurrent sessions firing hooks simultaneously. Does the atomic-write approach hold up?

### Assumption 4: Developers Want a Tray App (Not a Terminal-Based Tool)

**Risk**: MEDIUM. Linux developers in particular may prefer a CLI tool or tmux integration over a GUI tray app.

**Validation**:
- Include a CLI mode (`claude-cue --status`) that outputs JSON to stdout. Observe whether users prefer it.
- Track which surface (tray, context menu, dashboard, CLI) users interact with most.

### Assumption 5: Token Usage Tracking Is Accurate Enough to Be Useful

**Risk**: LOW-MEDIUM. The app estimates usage from JSONL logs, but Anthropic's server-side counting may differ. If the progress bar says 80% but the user gets rate-limited at 75%, trust is destroyed.

**Validation**:
- Compare Claude Cue's token counts against actual rate-limit responses from the API over a week of heavy usage.
- Add a disclaimer: "Estimated — actual limits may vary."

### Assumption 6: The Dot Grid Is Legible at Small Sizes

**Risk**: LOW-MEDIUM. System tray icons are 16x16 to 32x32 pixels. A grid of 4+ dots at that size may be indistinguishable.

**Validation**:
- Render the dot grid at Windows and Linux tray icon sizes (16x16, 22x22, 24x24, 32x32). Can users distinguish 1 dot from 4? Can they see color differences?
- Test with color-blind users (deuteranopia: red-green confusion). Yellow and green may be indistinguishable — consider adding shape variations (e.g., square = error, circle = normal).

---

## 13. Suggested Usability Tests

### Test 1: Cold Install (Week 1)

**Participants**: 3 Windows + 3 Linux developers who use Claude Code daily.
**Task**: "Here's a download link. Install Claude Cue and start using it with your normal workflow."
**Observe**:
- Time from download to first tray icon visible
- Whether they successfully pin the tray icon (Windows)
- Whether they discover the context menu and dashboard
- Any confusion about what the dots mean
- Whether hook configuration succeeds automatically

**Success criteria**: 5/6 users have a working tray icon within 3 minutes without asking for help.

### Test 2: Color and Shape Recognition (Week 1)

**Participants**: 6 developers, including at least 1 with color vision deficiency.
**Task**: Show screenshots of the tray icon in various states (1 dot working, 3 dots mixed states, 8 dots). Ask: "How many sessions? What state are they in?"
**Observe**:
- Accuracy of state identification
- Confusion between similar colors (green vs. yellow, cyan vs. white)
- Whether the dot grid is legible at actual tray icon sizes (16px, 24px, 32px)

**Success criteria**: 5/6 users correctly identify session count and dominant state within 3 seconds.

### Test 3: The "Permission Waiting" Catch (Week 2)

**Participants**: 4 developers, normal work day.
**Setup**: Configure Claude Code to request permission on a tool use. Start a Claude Code session and switch to a different app.
**Observe**:
- How quickly they notice the yellow dot or notification
- Whether they take action within 30 seconds
- Compare with a control day (no Claude Cue) — how long did permission requests go unnoticed?

**Success criteria**: Median time to notice permission request < 30 seconds (vs. estimated 3-5 minutes without Cue).

### Test 4: Usage Dashboard Comprehension (Week 2)

**Participants**: 6 developers.
**Task**: "You want to know if you can run another large session without hitting your rate limit. Use Claude Cue to decide."
**Observe**:
- Do they find the Usage tab?
- Can they interpret the progress bars and "resets in" text?
- Do they understand the 5-hour rolling window vs. daily vs. weekly?
- Do they make a reasonable decision based on the data?

**Success criteria**: 5/6 users navigate to the correct information and make a correct go/no-go decision within 60 seconds.

### Test 5: WSL Bridge Reliability (Week 1, Windows-Only)

**Participants**: 3 WSL users.
**Setup**: Claude Code running in WSL, Claude Cue on Windows host.
**Task**: Normal Claude Code usage for 2 hours.
**Observe**:
- Any dropped state updates (sessions that don't appear in the tray)
- Latency from hook fire to tray icon update
- Any file-locking issues or corrupted `sessions.json`
- Behavior across WSL restart

**Success criteria**: Zero dropped sessions. Latency < 2 seconds from state change to tray icon update.

### Test 6: One-Week Retention (Week 3)

**Participants**: All 6 from Test 1.
**Task**: Use Claude Cue for a full work week with no intervention.
**Measure at end of week**:
- Is Claude Cue still running?
- Did they enable start-at-login?
- Can they describe a specific moment where Claude Cue was useful?
- Would they recommend it to a colleague?

**Success criteria**: 4/6 still running at end of week. 3/6 enabled start-at-login. 4/6 can cite a specific useful moment.

---

## Appendix: Platform Decision Summary

| Concern | Windows | Linux |
|---|---|---|
| Tray API | `Shell_NotifyIcon` (Win32) or `NotifyIcon` (.NET) | `StatusNotifierItem` (D-Bus) via `libappindicator3` |
| Tray icon hidden by default? | Yes (Win 11 overflow) | Depends on DE config |
| Notifications | Windows Toast (WinRT) | `org.freedesktop.Notifications` (D-Bus) |
| Settings storage | `%LOCALAPPDATA%\Claude Cue\settings.json` | `~/.config/claude-cue/settings.json` (XDG) |
| Session data path | `%LOCALAPPDATA%\Claude Cue\sessions.json` | `~/.local/share/claude-cue/sessions.json` (XDG) |
| Hook data path (JSONL) | `%USERPROFILE%\.claude\projects\` | `~/.claude/projects/` (same as macOS) |
| Autostart | Registry `HKCU\...\Run` or Task Scheduler | `~/.config/autostart/claude-cue.desktop` (XDG) |
| File locking (hook) | `msvcrt.locking()` | `fcntl.flock()` (same as macOS) |
| DPI scaling | Per-monitor DPI awareness API | Wayland: compositor-handled; X11: `Xft.dpi` |
| Color scheme | `UISettings.GetColorValue()` | `org.freedesktop.portal.Settings` / `gtk-theme-name` |
| Global hotkey | `RegisterHotKey` (Win32) | DE-specific or XDG portal (limited on Wayland) |
| Installer format | MSI + WiX or MSIX | AppImage (universal) + `.deb` + AUR PKGBUILD |
| WSL bridge | Hook writes to `/mnt/c/.../sessions.json` | N/A |
