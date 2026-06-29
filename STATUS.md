# Cue.app Status Document

## Active Project
**Cue.app** — Real-time session monitor for Claude Code with WebGL animations and state tracking. **Production (v0.5.1 released Jun 25, publicly available).**

## Status Checklist

### Core Features
- [x] Session card FLIP reordering (hero card ducking + quiescence sort, ~60-line impl)
- [x] State transitions (thinking→working→idle→done→compacting with physics-based retract)
- [x] Turn-completion detection via `stop_reason == "end_turn"` (commit 8f5bfc6, 10 unit tests)
- [x] Subprocess/subagent branching and grouping (per-agent JSONL tail end_turn)
- [x] Session effort tracking with `/effort` command (color-coded pills, 5 new tests)
- [x] Claude Code mode detection with status indicators (model context up to 1M)
- [x] Branch view with parent→child visualization (fixed visibility issue Jun 9)
- [x] Audio-driven string retract (audio taper 100%→40%, straightening force, damping)
- [x] Menu bar context bar (dot→100% bar, shine animation, gray working state)
- [x] Local model context detection (model_context.rs, ~250 lines, parses Claude binary)
- [ ] Waiting state detection reliability (6+ week regression; permission prompts ~6s blind window) — DEFERRED post-launch

### Infrastructure & Rendering
- [x] WebGL effects (FluxEffect, AuroraEffect, DriftEffect, CompactTankEffect) restored Jun 10
- [x] Canvas-based SignalString physics (~1,277 lines, precomputed band offsets for perf)
- [x] JSONL parser with stop_reason filtering (skip system events, extract `/effort` commands)
- [x] Settings persistence + theme system
- [x] Tauri release build (macOS signed+notarized, Windows codesigned) — ~/Applications/Cue.app

### Motion & Polish
- [x] Motion design audit (50+ state transitions, accessibility)
- [x] Thinking→working flux field (curl-noise, spring physics)
- [x] Done state aurora (domain-warped FBM, glints)
- [x] Compacting state ripple (periwinkle, single vertical sine wave)
- [x] Redesigned CUE logo (04b-stacked-sessions.svg, icon regenerated for all formats)
- [ ] Card header responsive shrink (prompt pill → workspace → timer → title) — DEFERRED

### DevOps & Release
- [x] Release-engineering scaffolding (cargo test 235 passing, macOS signing, Windows codesign)
- [x] Public repository (avonbereghy/cue, all secrets removed from git history)
- [x] README refined (one-line description, setup instructions, feature list)
- [ ] GitHub Actions release secrets re-added (APPLE_CERTIFICATE_PASSWORD, APPLE_PASSWORD, WINDOWS_CERTIFICATE_PASSWORD, TAURI_SIGNING_PRIVATE_KEY) for CI/CD automation

## Recent Timeline
- 2026-06-25: v0.5.1 public release (download links live on GitHub /releases/latest)
- 2026-06-25: Final security sweep completed; personal info/test strings scrubbed from history
- 2026-06-24: UI refinements (compact mode row centering, special effects/strings/aurora toggles, context bar sizing)
- 2026-06-24: Release installation flow verified (build.sh → ~/Applications/Cue.app)
- 2026-06-19: v0.2.0 release build (8.4 MB) deployed to ~/Applications/Cue.app
- 2026-06-10: FluxEffect.tsx restored (WebGL working; prior panic was 16-bit PNG unrelated)

## Current Focus
**Post-launch monitoring:** Observing public release for any critical issues. Re-add GitHub Actions secrets to avonbereghy/cue for CI/CD pipeline automation (optional if not automating releases yet).

## Deferred Items (Non-Blocking)
1. **Waiting state detection** (6+ week regression): Permission prompts seed waiting with ~6s blind window. Root cause: hook notification firing late. Acceptable for v0.5.1 since user can manually refresh if stuck.
2. **Card header responsive shrink** (polish): Header elements (prompt pill → workspace → timer → title) should cascade down as window narrows. Low priority.
3. **Tauri permission narrowing** (T-02, Low): Scope process:default to process:allow-relaunch only (currently grants both relaunch + exit). Requires capabilities/default.json update; deferred pending v0.5.2+ maintenance window.
4. **Frontend localStorage validation** (F9, Low): loadRevivedSessions() lacks schema validation on parsed entries. Local-only threat model; accepted for v0.5.1.
5. **Hook workspace length cap** (H-05, Low): Defense-in-depth; workspace stored in sessions.json without control-char stripping. Rust backend sanitizes on read; deferred pending v0.5.1+ patch.

---
**Deployment:** Production runner at `~/Applications/Cue.app` (standalone, NOT launchd). Users download DMG from GitHub /releases/latest or build from source via `cue-desktop/scripts/build.sh`. Dev-rebuild uses LaunchAgent + `dev-restart.sh` (build-mode Vite + force-sign).
