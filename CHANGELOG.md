# Changelog

All notable changes to Cue are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Being pre-1.0, minor (`0.x`) releases may include breaking changes.

## [Unreleased]

_Nothing yet._

## [0.6.0] - 2026-07-21

The "tell me what needs me" release. Cue now pushes native notifications when a
session is blocked on you, and clicking a card jumps straight to the terminal
tab that session is running in. The dashboard grew a responsive grid,
project grouping, selectable Looks, and account-level usage meters.

### Added

**Notifications & getting your attention**
- Native notifications when a session needs permission or finishes, suppressed
  while the window is already focused.
- Notification text says the point — the actual question for "needs you", the
  outcome for "done" — instead of a generic ping.
- The blocked-on action is pinned to the top of every card.
- Error cards show *why* a session failed, not just "Error", and clear the
  reason once it recovers.

**Click to get there**
- Click a session card (or a tray row) to open its project.
- On macOS, Cue focuses the exact terminal tab the session is running in
  (iTerm2 and Terminal).

**Dashboard**
- Responsive grid — cards flow side-by-side when the window is wide.
- Group-by-project layout option.
- Auto-fit window height to the session count, with an "Auto-fit window" toggle.
- Auto-hide idle sessions ("Resting").
- Active session count in the header; card column snaps to the screen edge.
- Warm, selectable **Looks** (themes), readable in both light and dark.

**Usage & subagents**
- Account-level 5-hour and weekly limit meters in the header.
- Click a child agent to see a quick report of what it's doing.
- Each subagent's model is shown on its card.

**Menus & windows**
- Native macOS app menu (Cmd-Q / Cmd-, / Cmd-W / Cmd-M) and a native View menu.
- One identical "⋯" menu on both the popover and the dashboard, each with a
  Settings gear and a manual "Check for Updates…".
- Redesigned top toolbar with SF Symbols-native icons.

**Sessions & permissions**
- Claude desktop-app sessions are detected and kept alive.
- Transcripts resolve correctly for every user, not just the primary account.
- Idle sessions whose window has been closed are auto-retired.
- Permission prompts have an honest timeout and keyboard approve/deny.

**Install & accessibility**
- Homebrew tap automation with a cask renderer and download stats.
- Session transitions and permission prompts are announced to screen readers;
  theme-aware focus rings, reduce-transparency support, and tab a11y.

### Changed
- Settings reorganized with section headings and a unified Appearance group;
  auto-save is now debounced.
- Menu-bar pills get a white outline, with a 0–100 border-level slider.
- The dashboard is always Detailed — Compact and Standard densities were retired.
- Focus Mode (frameless window) was removed; per-card 5h/weekly rate-limit bars
  were replaced by the header meters.

### Fixed
- A session no longer drops out of "waiting" while an `AskUserQuestion` is still
  open, or on a bare file-mtime advance.
- The git branch is read live from `HEAD` instead of the stale transcript.
- Background subagent detection, per-session `/effort` display, and the 1M
  model-context floor all report correctly.
- WebGL contexts are released on effect cleanup (fixes a leak).
- The Python hook never surfaces a traceback into a live session, and preserves
  a corrupt `sessions.json` rather than clobbering it.
- Numerous window sizing fixes: compact mode no longer clips cards, a minimized
  dashboard always restores, and auto-fit can shrink to a single session.

### Security
- Bumped `quick-xml` to 0.41, clearing RUSTSEC-2026-0194 and RUSTSEC-2026-0195.
- Bumped Tauri 2.10.3 → 2.11.4 and `tar`, clearing 3 of 4 Dependabot alerts.
- Backend hardening pass over state transitions and detection; replaced unsafe
  non-null assertions in the frontend with real null guards.
- Hardened the release pipeline's merge gate and build scripts.

## [0.5.3] - 2026-06-26

### Fixed
- Menu-bar icon no longer goes blank when every session has idled out (or at
  startup with no sessions). The bars and clock styles now fall back to the
  same hollow-ring "no active sessions" placeholder the dot grid already used,
  so the tray never shows empty tool space.

## [0.5.2] - 2026-06-26

### Changed
- Menu-bar icon stays focused on active work: a session drops off the icon
  (bars/dots/clock) once it has sat **idle with no activity for 2 minutes**.
  Only `idle` times out — active, waiting/error, and done states stay. Longer
  idles still appear in the tray tooltip, the native menu, the popover, and the
  dashboard; they just leave the menu bar up top.

## [0.5.1] - 2026-06-25

Pre-public UI polish: a calmer default look and a properly sized window.

### Changed
- Main window opens at 800×900, centered, and is clamped (640–960 × 560–1100)
  instead of launching maximized to full-screen width.
- Default look is now minimal: **Special Effects off**, context bar in
  **compact** mode, and menu-bar style **Bar Chart**. All remain toggleable in
  Settings.
- Strings and Aurora effects default off (labeled _beta_ / _under construction_)
  and are gated behind the Special Effects master switch, so turning it off
  means no effects render.
- Font scale rebased so the `1.0` default renders at the former `1.15` size.
- Signal strings scale up to five lines on long-running sessions (was three).
- Defaults are now consistent across the Rust and TypeScript layers, so a fresh
  install reflects them.

### Fixed
- Compact-density rows vertically center their content.
- Detail-mode cards no longer overlap the prompt subtitle with the metrics row.
- macOS: clicking the Dock icon reopens the dashboard window.

### Security
- Pre-public security review (no Critical/High findings). Hardened the items found:
  - `cue --status` (CLI) now validates the session id before using it as a path
    component, matching the GUI poll path — closes a local path-traversal vector
    via a hostile `sessions.json` id.
  - Token aggregates use saturating arithmetic, so a crafted oversized JSONL can
    no longer overflow the total.
  - Replaced raw mutex `lock().unwrap()` sites with the poison-safe `lock_safe()`
    wrapper to prevent a panic cascade.
  - The hook creates its data directory owner-only (`0700`).
  - The release workflow passes the git ref name via `env` rather than inlining
    it into a shell step.

### Added
- `cue-desktop/build.sh` — builds the release bundle and deploys it to
  `~/Applications` (tolerating the benign local updater-signing error).

## [0.5.0] - 2026-06-24

First public open-source release.

### Added
- Real-time multi-session monitoring (up to 8 sessions) as a menu-bar / system-tray dot grid.
- State machine: working / thinking / waiting / subagent / compacting / error / done / idle.
- Session dashboard: workspace, duration, model, git branch, tool usage, context-usage bar.
- Incremental JSONL token metrics (input / output / cache), aggregated across subagents.
- Permission approval from the dashboard via a localhost hook server, with an audit log.
- WebGL / canvas signal-string animations, effect presets, and motion-design polish.
- CLI (`--status --pretty --compact`) for SSH and tiling-WM use.
- Cross-platform onboarding wizard that installs and registers the hook.
- Security policy (`SECURITY.md`) and support guide (`SUPPORT.md`).
- Supply-chain CI: `cargo audit` + `npm audit` (`security-audit` workflow), plus
  OpenSSF Scorecard, CodeQL (TypeScript/JS), and Dependency Review workflows that
  activate when the repository is public.
- Build provenance attestations (SLSA Build L2 via Sigstore) and a `SHA256SUMS`
  file on releases, so unsigned binaries can still be verified
  (`gh attestation verify`).
- Structured (YAML) bug-report issue form capturing OS, Cue, and Claude Code versions.
- `scripts/go-public.sh` to enable public-only repository protections in one step.

### Changed
- Hardened GitHub Actions: workflows default to a read-only `GITHUB_TOKEN`,
  elevating permissions only where required.
- Funding: added GitHub Sponsors alongside Buy Me A Coffee.

### Security
- Bounded the remaining unbounded file reads; capped cached JSONL entry text and
  saturated token sums; bounded git subprocesses with a wall-clock timeout;
  poison-safe lock handling.

### Fixed
- Git status now counts both porcelain columns for combined statuses (e.g. `MM`).

[Unreleased]: https://github.com/avonbereghy/cue/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/avonbereghy/cue/compare/v0.5.3...v0.6.0
[0.5.3]: https://github.com/avonbereghy/cue/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/avonbereghy/cue/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/avonbereghy/cue/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/avonbereghy/cue/releases/tag/v0.5.0
