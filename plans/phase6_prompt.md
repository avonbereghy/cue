# Phase 6: Accessibility + Polish Pass

Read plans/cross_platform_final_plan.md for full context.

## Tasks

### Screen Reader Support
1. `src/components/SessionCard.tsx`: Add `aria-label` combining state + workspace name + duration (e.g., "Working: WebApp, running 38 minutes")
2. `src/components/ProgressBar.tsx`: Add `role="progressbar"`, `aria-valuenow`, `aria-valuemin="0"`, `aria-valuemax`, `aria-label` (e.g., "5-hour usage: 60%, 1.2 million of 2 million tokens")
3. `src/components/WindowSection.tsx`: Add `aria-label` to the section container (e.g., "5-hour usage window")
4. `src/components/Dashboard.tsx`: Tab bar uses `role="tablist"`, each tab uses `role="tab"`, `aria-selected`, `aria-controls`
5. `src/components/StatBadge.tsx`: Add `aria-label` combining label + value (e.g., "Sessions: 3")
6. `src/components/UsageView.tsx`: Plan picker has `aria-label="Select plan tier"`
7. `src-tauri/src/tray.rs`: Update tooltip to descriptive text: "Cue: 3 sessions — 1 working, 1 waiting, 1 subagent"
8. Create `src/lib/a11y.ts`: utility for live region announcements (`aria-live="polite"` div for dynamic updates)

### Keyboard Navigation
1. `src/components/Dashboard.tsx`: Arrow keys switch between tabs, Enter/Space activates
2. `src/components/SessionCard.tsx`: Cards are focusable (`tabIndex={0}`), show visible focus ring (`outline-2 outline-offset-2 outline-blue-500`)
3. `src/components/UsageView.tsx`: Plan picker navigable with arrow keys
4. `src/components/SettingsView.tsx`: All form fields have correct tab order, labeled with `<label htmlFor>`
5. `src/components/OnboardingWizard.tsx`: Next/Back buttons focusable, Enter activates, focus trapped within wizard
6. All interactive elements: visible focus indicators on `:focus-visible` (not `:focus` to avoid showing on click)
7. Defer global hotkey to V2 (platform-specific, Wayland restrictions make this non-trivial)

### High Contrast
1. `src/styles/globals.css`: Add `@media (forced-colors: active)` overrides for Windows High Contrast
2. `src/components/ProgressBar.tsx`: Add 1px border so bar is visible when fill color is overridden
3. All text: verify WCAG AA contrast ratios (4.5:1 for normal text, 3:1 for large text) against dark theme background
4. `src-tauri/src/tray.rs`: Add `render_dot_grid_high_contrast()` — detect system theme and use outlined dots on light backgrounds

### Reduced Motion
1. `src/styles/globals.css`: Add `@media (prefers-reduced-motion: reduce)` — disable all CSS transitions/animations
2. `src-tauri/src/tray.rs`: When reduced motion is preferred, replace blinking dots with static dots that have a small arrow overlay icon for "working" state. Detect via Tauri window API or platform-specific check.

### Platform Polish
1. `src-tauri/src/tray.rs`: Detect taskbar theme (light/dark) and choose appropriate icon variant
2. `src/styles/globals.css`: Add `@media (prefers-color-scheme: light)` overrides for system light mode
3. `src-tauri/src/main.rs`: Set window DPI awareness (Tauri handles this by default, but verify at 150% and 200%)

### Privacy Polish
1. `src-tauri/src/tray.rs`: Tray menu shows only leaf directory name (e.g., "WebApp" not "/Users/dev/Projects/WebApp")
2. `src/components/SessionCard.tsx`: Show leaf name as title, full path on hover tooltip only
3. `src-tauri/src/cli.rs`: `--status` masks workspace paths by default (shows leaf name). Add `--show-paths` flag for full paths.

### Performance
1. Verify RSS memory < 20MB with 8 active sessions (use `taskmgr` on Windows, `htop` on Linux)
2. Verify CPU < 1% when all sessions are non-blinking (blink timer should be stopped)
3. Profile JSONL parsing with large files (> 10MB) — ensure it completes in < 1 second

## Files to create
- `cue-desktop/src/lib/a11y.ts`

## Files to modify
- `cue-desktop/src/components/SessionCard.tsx` — ARIA labels, focus ring, leaf name
- `cue-desktop/src/components/ProgressBar.tsx` — ARIA progressbar role, border for high contrast
- `cue-desktop/src/components/WindowSection.tsx` — ARIA label
- `cue-desktop/src/components/Dashboard.tsx` — tablist/tab roles, keyboard nav
- `cue-desktop/src/components/StatBadge.tsx` — ARIA label
- `cue-desktop/src/components/UsageView.tsx` — plan picker ARIA, keyboard nav
- `cue-desktop/src/components/SettingsView.tsx` — label associations, tab order
- `cue-desktop/src/components/OnboardingWizard.tsx` — focus trap, keyboard nav
- `cue-desktop/src/styles/globals.css` — high contrast, reduced motion, light mode
- `cue-desktop/src-tauri/src/tray.rs` — descriptive tooltip, theme detection, reduced motion, privacy (leaf names)
- `cue-desktop/src-tauri/src/cli.rs` — `--show-paths` flag, default path masking

## Files NOT to touch
- Everything in `Sources/`
- `hooks/cue-hook`
- Rust backend data logic (models, jsonl_parser, session_monitor, usage_aggregator, security, paths)

## Verification
- NVDA (Windows): all UI elements announced correctly, no unlabeled interactive controls
- Orca (Linux): same verification as NVDA
- Keyboard-only: navigate all tabs, session cards, settings, onboarding without mouse
- Tab order: logical flow (tab bar → content → cards), no focus traps except onboarding wizard
- Focus indicators: visible on `:focus-visible`, not on mouse click
- Windows High Contrast: all elements visible, progress bars have borders, text meets contrast ratio
- GNOME HighContrast theme: all elements visible
- `prefers-reduced-motion`: zero blinking/animation in both tray icon and dashboard
- `prefers-color-scheme: light`: dashboard adapts colors, tray icon uses high-contrast variant
- DPI: clean rendering at 100%, 150%, 200% on Windows
- Memory: < 20MB RSS with 8 sessions
- CPU: < 1% when all sessions are static (no blinking)
- Tray menu and CLI show leaf directory names only (no full paths)
- `--status --show-paths` reveals full paths
