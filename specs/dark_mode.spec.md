# Dark Mode & Light Mode Polish — Feature Specification

## Overview

Cue follows macOS system appearance but (a) has no manual override toggle, and (b) the light mode looks washed out with poor contrast. This spec adds a Dark/Light/System theme picker in Settings and polishes light mode to be a first-class experience.

## User Value

- Users who prefer dark mode on a light-mode OS (or vice versa) can override
- Light mode becomes usable — proper contrast, readable text, clean card styling
- Professional appearance in both modes matches macOS native aesthetic

---

## Functional Requirements (EARS)

### Theme Toggle

**FR-1:** Where the Settings view is displayed, the system shall show a Theme section with three options: Dark, Light, and System (default).

**FR-2:** When the user selects a theme option, the system shall immediately apply the theme without page reload by setting `data-theme` on `<html>`.

**FR-3:** When the user selects a theme option, the system shall persist the choice via the Tauri settings store so it survives app restarts.

**FR-4:** Where the theme is set to "System", the system shall follow `prefers-color-scheme` media query changes in real-time.

**FR-5:** When the app launches, the system shall apply the persisted theme before React renders to prevent flash of wrong theme (FOUC).

### Light Mode Styling

**FR-6:** Where light mode is active, the system shall use the following palette:
- Background: `#f0f0f0` (light gray)
- Cards: `#ffffff` (white) with `border: #e0e0e0`
- Primary text: `#1a1a1a` (near black)
- Secondary text: `#6b7280` (gray-500)
- Subtle text: `#9ca3af` (gray-400)

**FR-7:** Where light mode is active, the system shall use darkened semantic state colors:
- Done/Success: `green-600` (instead of green-500)
- Waiting/Warning: `yellow-600` (instead of yellow-400)
- Error: `red-600` (instead of red-500)
- Subagent: `cyan-600` (instead of cyan-400)
- Idle: `gray-500` (unchanged)

**FR-8:** Where light mode is active, the system shall render status dot colors, state badges, stat badge icons, progress bar fills, and permission buttons using the darkened palette from FR-7.

### Dark Mode Styling

**FR-9:** Where dark mode is active, the system shall use `#2d2d2d` as the background color (macOS native dark) instead of the current `#1a1a1a`.

**FR-10:** Where dark mode is active, the system shall keep all existing color values (white-based opacity scale, semantic colors) unchanged except the background.

---

## Non-Functional Requirements

**NFR-1:** Theme switch shall complete within 50ms (CSS variable swap, no re-render).

**NFR-2:** No flash of unstyled/wrong-theme content on app launch.

**NFR-3:** Light mode text shall meet WCAG AA contrast ratio (4.5:1) against card and page backgrounds.

**NFR-4:** The `forced-colors` and `prefers-reduced-motion` media queries already in `globals.css` shall continue to work in both themes.

---

## Acceptance Criteria

### Theme Toggle

```
Given the Settings tab is open,
When the user views the Theme section,
Then they see three options: Dark, Light, System — with System selected by default.

Given the user selects "Dark",
When macOS is in light mode,
Then the app immediately displays dark mode (#2d2d2d background, white text).

Given the user selects "System" and macOS is in light mode,
When the user switches macOS to dark mode via System Preferences,
Then the app switches to dark mode within 1 second.

Given the user selects "Light" and quits the app,
When they relaunch the app,
Then the app loads in light mode without any dark flash.
```

### Light Mode Quality

```
Given the app is in light mode,
When viewing the Sessions tab with active sessions,
Then session cards have white backgrounds with visible gray borders,
And all text is legible against the white/gray backgrounds,
And state colors (green, yellow, red, cyan) use darkened variants.

Given the app is in light mode,
When viewing the Usage tab,
Then progress bars, plan picker, and window sections use appropriate light styling,
And the cost/token text meets WCAG AA contrast.

Given the app is in light mode,
When viewing the Settings tab,
Then input fields, toggle switches, and buttons have visible borders and contrast.

Given the app is in light mode,
When a permission prompt appears,
Then the yellow border, approve (green), and deny (red) buttons are clearly visible.
```

---

## Error Handling

| Scenario | Handling |
|----------|----------|
| Persisted theme value is invalid | Fall back to "system" |
| `prefers-color-scheme` not supported | Default to dark mode |
| Tauri store read fails on launch | Apply "system" theme, log warning |
| Theme applied before CSS loads | Inline critical `background-color` in `index.html` based on stored theme |

---

## Affected Views & Components

| Component | Changes |
|-----------|---------|
| `globals.css` | New CSS variables for light mode palette, update dark bg to #2d2d2d |
| `index.html` | Remove hardcoded dark bg, add theme-aware inline script |
| `main.tsx` | Read theme from Tauri store, apply before mount |
| `SettingsView.tsx` | Add Theme section with 3-way toggle |
| `SessionCard.tsx` | Use theme-aware state color classes |
| `SessionsTab.tsx` | Card/header bg adapt to theme |
| `UsageView.tsx` | Header and empty state colors |
| `WindowSection.tsx` | Card bg, text colors, tool chips |
| `StatBadge.tsx` | Icon and label colors |
| `ProgressBar.tsx` | Container border color in light mode |
| `OnboardingWizard.tsx` | Background, button, and info box colors |
| `PermissionPrompt.tsx` | Border, button, and text colors |
| `PermissionHistory.tsx` | Entry row text and badge colors |
| `lib/types.ts` | Theme-aware state color maps |
| `settings.rs` (Rust) | Add `theme: String` to Settings struct |
| `lib.rs` (Rust) | Add `get_theme` / `set_theme` Tauri commands |

---

## Implementation TODO

### Phase 1: Infrastructure
- [ ] Update `Settings` struct in `models.rs` to add `theme: String` (default: `"system"`)
- [ ] Add `get_theme` and `set_theme` Tauri commands in `lib.rs`
- [ ] Update `globals.css`: change dark bg from `#1a1a1a` to `#2d2d2d`, add comprehensive light mode CSS variables for backgrounds, borders, text
- [ ] Update `index.html`: replace hardcoded bg with theme-aware inline script
- [ ] Update `main.tsx`: read theme from Tauri store on boot, apply `data-theme`

### Phase 2: Light Mode Polish
- [ ] Define light-mode CSS variables: `--bg-page`, `--bg-card`, `--border-card`, `--text-primary`, `--text-secondary`, `--text-subtle`
- [ ] Define light-mode semantic color variants: `--color-success`, `--color-warning`, `--color-error`, `--color-info`
- [ ] Update `lib/types.ts`: make `STATE_COLORS`, `STATE_DOT_COLORS`, `STATE_BADGE_BG` theme-aware (use CSS variables or dual class maps)
- [ ] Update all 11 components to use CSS variables instead of hardcoded `text-white/N` and `bg-white/N` where the current `--color-white` inversion is insufficient

### Phase 3: Settings UI
- [ ] Add Theme section to `SettingsView.tsx` with Dark/Light/System toggle (same button style as plan picker)
- [ ] Wire toggle to `set_theme` Tauri command + `applyTheme()` function
- [ ] Persist and restore on app launch

### Phase 4: Verification
- [ ] Test all 5 views in dark mode: Sessions, Usage, Settings, Onboarding, Permissions
- [ ] Test all 5 views in light mode with same checklist
- [ ] Test System mode follows OS changes
- [ ] Test persistence across app restart
- [ ] Test no FOUC on launch
- [ ] Verify WCAG AA contrast for light mode text
