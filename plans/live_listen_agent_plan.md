# Live Listen — Agent Plan

## Wave Structure

**Single-session sequential** — each layer depends on the previous.

### Wave 0: Swift Sidecar
- Create `cue-desktop/src-tauri/sidecar/cue-audio-tap.swift`
- Add build script to compile it during `tauri build`

### Wave 1: Rust Backend
- Create `cue-desktop/src-tauri/src/live_audio.rs`
- Wire into `main.rs` — register commands and module
- FFT via `rustfft` crate

### Wave 2: Frontend Integration
- Add `"live"` to signal mode selector in SettingsView
- Add live audio event listener in SignalString
- Wire through SessionsTab state
- Add to types.ts if needed

### Wave 3: Build Config
- Info.plist: `NSAudioCaptureUsageDescription`
- Entitlements if needed
- Bundle sidecar as Tauri resource

## Build verification after each wave
