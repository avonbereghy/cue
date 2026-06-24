# Changelog

All notable changes to Cue are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Being pre-1.0, minor (`0.x`) releases may include breaking changes.

## [Unreleased]

_Nothing yet._

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

[Unreleased]: https://github.com/avonbereghy/cue/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/avonbereghy/cue/releases/tag/v0.5.0
