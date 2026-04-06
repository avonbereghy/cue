# Live Listen — Feature Specification

## Overview

Add a **beta** "Live Listen" signal mode that captures real-time system audio (e.g. Apple Music) via macOS Core Audio Taps and uses it to drive the string/sand visualizations, replacing simulated piano strikes or preset audio files with live now-playing music data.

**Platform:** macOS 14.2+ (Sonoma) only
**Status:** Beta feature (hidden behind beta toggle in settings)

## Architecture

### Swift Sidecar Approach

A small Swift command-line tool (`cue-audio-tap`) captures system audio output via the Core Audio Taps API and streams raw PCM data to stdout. The Rust backend spawns this sidecar, reads the PCM stream, performs FFT to extract bass/mids/treble frequency bands, and emits the same frequency data format the frontend already consumes.

```
┌─────────────┐    PCM stdout    ┌──────────────┐    FFT bands    ┌──────────────┐
│ cue-audio-  │ ───────────────► │ Rust backend │ ──────────────► │ SignalString  │
│ tap (Swift) │                  │ (live_audio) │    (events)     │ (frontend)    │
└─────────────┘                  └──────────────┘                 └──────────────┘
```

### Why a sidecar?

- Core Audio Taps API is Swift/ObjC — no stable Rust bindings exist
- AudioTee project proves the pattern works reliably
- Process isolation: audio capture runs independently, Rust manages lifecycle
- Clean separation: sidecar handles platform API, Rust handles FFT + data plumbing

## Functional Requirements

### FR-1: Swift Sidecar (`cue-audio-tap`)
- Captures system audio output via `CATapDescription` + aggregate device
- Streams mono Float32 PCM at the device sample rate to stdout
- Logs status/errors to stderr (never stdout)
- Exits cleanly on SIGTERM/SIGINT or when stdin closes (parent died)
- Requires `NSAudioCaptureUsageDescription` in the host app's Info.plist
- Single Swift file, compiled as part of the Tauri build, bundled as a resource

### FR-2: Rust Audio Manager (`live_audio.rs`)
- Spawns `cue-audio-tap` sidecar as a child process
- Reads PCM Float32 chunks from the child's stdout
- Performs FFT (1024-sample window, Hann windowed) to extract:
  - Bass: 20-300 Hz
  - Mids: 300-2000 Hz
  - Treble: 2000-20000 Hz
- Normalizes band energies to 0.0-1.0 range
- Emits `live-audio-data` Tauri events with `{ bass: f32, mids: f32, treble: f32 }` at ~30fps
- Provides Tauri commands: `start_live_audio`, `stop_live_audio`, `get_live_audio_status`
- Gracefully kills sidecar on stop or app exit
- Handles sidecar crash/exit with status event to frontend

### FR-3: Frontend Integration
- New signal mode: `"live"` alongside `"simulated"` and `"preset"`
- When `signalMode === "live"`:
  - SignalString subscribes to `live-audio-data` events
  - Frequency band data drives the same rendering pipeline as preset mode
  - No file upload needed — data comes from the live stream
- Settings UI: add "Live" option to the Mode selector (only on macOS)
- Beta badge: show "Beta" label next to the Live option
- Status indicator: show connection state (starting / listening / error / not available)

### FR-4: Entitlements & Permissions
- Add `NSAudioCaptureUsageDescription` to Info.plist
- Add `com.apple.security.device.audio-input` to Entitlements.plist
- Permission prompt appears on first activation (user approves once)

## Non-Functional Requirements

- **NFR-1:** No network calls — all audio capture is local
- **NFR-2:** Sidecar must exit when parent process dies (no orphaned processes)
- **NFR-3:** Must not interfere with audio playback (tap is read-only)
- **NFR-4:** FFT processing must be efficient enough for 30fps updates without UI jank
- **NFR-5:** Feature degrades gracefully on Linux/Windows (mode hidden, not selectable)

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| signalMode | string | "simulated" | Now accepts "live" as a third option |

No new settings are added — Live mode reuses all existing string/sand tuning parameters (opacity, amplitude, echo, etc.)

## Implementation Checklist

### Phase 0: Foundation
- [ ] Create Swift sidecar source (`cue-desktop/src-tauri/sidecar/cue-audio-tap.swift`)
- [ ] Add sidecar build step to Tauri build pipeline
- [ ] Add `live_audio.rs` module to Rust backend with FFT processing
- [ ] Add Tauri commands and events

### Phase 1: Frontend Integration
- [ ] Add "Live" mode to signal mode selector in SettingsView
- [ ] Add live audio event listener in SignalString component
- [ ] Add status indicator for live audio state
- [ ] Hide "Live" option on non-macOS platforms

### Phase 2: Build & Config
- [ ] Add `NSAudioCaptureUsageDescription` to Info.plist
- [ ] Add audio input entitlement to Entitlements.plist
- [ ] Bundle sidecar binary in Tauri resources
- [ ] Test end-to-end with Apple Music playback

## Out of Scope

- Per-app audio capture (tapping only Music.app) — uses system-wide tap for V1
- Now-playing metadata display (track name, artist, album art)
- Audio recording or storage
- Windows/Linux audio capture
