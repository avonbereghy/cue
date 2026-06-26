# Changelog

All notable changes to Cue are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Being pre-1.0, minor (`0.x`) releases may include breaking changes.

## [Unreleased]

_Nothing yet._

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

[Unreleased]: https://github.com/avonbereghy/cue/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/avonbereghy/cue/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/avonbereghy/cue/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/avonbereghy/cue/releases/tag/v0.5.0
