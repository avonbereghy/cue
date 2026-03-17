# Phase 4: Settings + Onboarding + Environment Detection

Read plans/cross_platform_final_plan.md for full context.

## Background
Phase 0 already made `hooks/cue-hook` cross-platform. This phase adds the Settings UI, onboarding wizard, and Rust-side environment detection commands. No further hook modifications needed.

## Tasks

Spawn teammates:
- "settings-ui" → create `src/components/SettingsView.tsx` ONLY
- "onboarding-ui" → create `src/components/OnboardingWizard.tsx` ONLY
- "env-detection" → create `src-tauri/src/env_detect.rs` ONLY (Rust-side detection logic)

After all teammates complete, the team lead integrates by wiring into `App.tsx` and `main.rs`.

### Track A: Settings UI (`SettingsView.tsx`)
1. Create `src/components/SettingsView.tsx`:
   - Plan preset picker: segmented control (Custom, Pro $20/mo, Max Standard $100/mo, Max Plus $200/mo)
   - Selecting a preset auto-fills the token limit fields
   - Token limit fields: 5-hour, daily, weekly — numeric input with K/M formatted display
   - "Custom" mode: fields are editable. Preset mode: fields are read-only.
   - Save button: calls `invoke("update_settings", { settings })`
   - Load current settings on mount via `invoke("get_settings")`
2. Designed to render both as:
   - A secondary Tauri window (opened from tray menu "Settings...")
   - An inline panel (embedded in onboarding wizard step 2)
3. Export: `<SettingsView inline?: boolean />` — when `inline`, omits window chrome/padding

### Track B: Onboarding Wizard (`OnboardingWizard.tsx`)
1. Create `src/components/OnboardingWizard.tsx`:
   - Step 1: Welcome + environment detection results
     - Show detected Claude Code installs, WSL distros (from `invoke("detect_environment")`)
     - On Linux/GNOME without AppIndicator: show warning + link to install extension, or "Use Dashboard Only" button
     - On Windows: note about pinning tray icon
   - Step 2: Plan selection (embed `<SettingsView inline />`)
   - Step 3: Hook configuration
     - "Configure Hooks Automatically" button → calls `invoke("configure_hooks")`
     - Or "Show Manual Instructions" expandable section
   - Step 4: Done — "Get Started" button
2. Multi-step wizard with back/next navigation, progress dots
3. On completion: calls `invoke("update_settings", { onboarding_complete: true })`
4. Export: `<OnboardingWizard onComplete: () => void />`

### Track C: Environment Detection (`env_detect.rs`)
1. Create `src-tauri/src/env_detect.rs`:
   - `pub fn detect_environment() -> EnvironmentInfo` returning:
     - `platform`: "windows" | "linux" | "macos"
     - `desktop_env`: Option<String> (e.g., "GNOME", "KDE", "XFCE", None)
     - `wayland`: bool
     - `has_appindicator`: bool (check for `gnome-shell-extension-appindicator` via `gnome-extensions list` output or dbus)
     - `wsl_distros`: Vec<String> (on Windows: list WSL distros; on Linux: detect if running in WSL)
     - `claude_code_found`: bool (check for `~/.claude/` directory)
     - `claude_settings_exists`: bool (check for `~/.claude/settings.json`)
   - `pub fn configure_hooks(hook_path: &str) -> Result<(), String>`:
     - Read `~/.claude/settings.json`
     - Add/update hook entries for all 12 Claude Code events
     - Backup original settings before modification
     - Use `security.rs::atomic_write()` for the write
   - Expose as Tauri commands: `detect_environment`, `configure_hooks`
2. `EnvironmentInfo` struct with Serialize derive
3. Desktop environment detection:
   - Linux: read `$XDG_CURRENT_DESKTOP`, `$DESKTOP_SESSION`
   - Wayland: check `$WAYLAND_DISPLAY`
   - Windows WSL: check for `wsl.exe` in PATH, list distros via reading registry or filesystem
4. Unit tests for detection logic with mocked env vars

### Integration (team lead, after all tracks complete)
1. Add to `main.rs`:
   - `mod env_detect;`
   - Register Tauri commands: `detect_environment`, `configure_hooks`
   - Settings window creation: 400×350, non-resizable, titled "Settings"
   - Menu item "Settings..." opens settings window
2. Update `src/App.tsx`:
   - On mount: `invoke("get_settings")` → check `onboarding_complete`
   - If false: render `<OnboardingWizard onComplete={...} />`
   - If true: render `<Dashboard />`
   - After onboarding completes: transition to Dashboard

## Files to create (teammates)
- `claude-cue-desktop/src/components/SettingsView.tsx` (Track A)
- `claude-cue-desktop/src/components/OnboardingWizard.tsx` (Track B)
- `claude-cue-desktop/src-tauri/src/env_detect.rs` (Track C)

## Files to modify (integration only, after tracks complete)
- `claude-cue-desktop/src/App.tsx` — onboarding routing
- `claude-cue-desktop/src-tauri/src/main.rs` — `mod env_detect;`, Tauri commands, settings window

## Files NOT to touch
- Everything in `Sources/`
- `hooks/cue-hook` (already cross-platform from Phase 0)
- Phase 3 component files (Dashboard, SessionCard, etc.)

## Verification
- Settings persist across app restarts on all platforms
- Plan presets correctly populate token limit fields
- Switching presets updates all three limit fields immediately
- Custom mode allows manual entry
- Onboarding wizard shows on first launch (clean settings)
- Onboarding wizard does NOT show after completion (settings has `onboarding_complete: true`)
- Environment detection correctly identifies: GNOME vs KDE, Wayland vs X11, WSL distros, Claude Code install
- Hook auto-configuration writes correct entries to `~/.claude/settings.json`
- Hook auto-configuration backs up original settings first
- Settings window opens from tray menu "Settings..."
