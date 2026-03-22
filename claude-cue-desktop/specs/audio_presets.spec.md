# Audio Presets — Signal String Frequency Envelopes

## Overview

Replace the live-audio-file approach with lightweight **presets** — extracted frequency envelope data (bass/mid/treble bands over time) that power the signal string animations. No audio files are stored in the app. Users upload a song, the app extracts the envelope, saves it as a preset (~50-100KB), and discards the audio. Presets are selectable from a history list and the active preset auto-plays on launch.

## Data Model

### SignalPreset

```typescript
interface SignalPreset {
  id: string;           // UUID
  name: string;         // editable, auto-filled from filename
  createdAt: number;    // unix timestamp
  durationSecs: number; // original track duration
  sampleRate: number;   // samples per second (60)
  bands: {
    bass: number[];     // normalized 0.0-1.0 per sample
    mids: number[];     // normalized 0.0-1.0 per sample
    treble: number[];   // normalized 0.0-1.0 per sample
  };
}
```

- **Sample rate**: 60 samples/second (matches requestAnimationFrame cadence)
- **Storage**: ~43KB per minute of audio (3 bands × 60 samples × 4 bytes × 60 sec)
- **A 4-minute song**: ~170KB as JSON — lightweight enough to store many presets

### Settings Changes

```typescript
interface Settings {
  // ... existing fields ...
  signalMode: string;        // "simulated" | "preset"  (rename "audio" → "preset")
  activePresetId: string;    // UUID of the currently active preset
  // REMOVE: audioFileName — no longer needed
}
```

## Functional Requirements

### REQ-1: Audio Upload & Extraction

**When** the user clicks "Choose File" in audio/preset mode settings,
**the app shall** decode the audio file in the browser using Web Audio API, extract frequency envelopes for bass (0-25% of bins), mids (25-60%), and treble (60-100%) at 60 samples/second using AnalyserNode FFT, normalize each sample to 0.0-1.0 range using sqrt curve, then construct a SignalPreset with auto-filled name from the filename (sans extension).

The audio file is never sent to the Rust backend or persisted to disk.

### REQ-2: Preset Persistence (Rust Backend)

**The backend shall** provide Tauri commands:
- `save_preset(preset: SignalPreset)` — write to `{app_data}/presets/{id}.json`
- `list_presets()` → `PresetSummary[]` — return id, name, createdAt, durationSecs for all saved presets (read from files, no index needed)
- `load_preset(id: string)` → `SignalPreset` — read full preset data
- `delete_preset(id: string)` — remove preset file
- `rename_preset(id: string, name: string)` — update name field in preset file

All file I/O uses `security.rs::atomic_write()`. Preset directory created on first save.

### REQ-3: Preset History / Library (Settings UI)

**The settings page shall** show a "Presets" section when signal mode is "preset":
- List of saved presets: name, duration, created date
- Active preset highlighted
- Click to activate (sets `activePresetId` in settings)
- Delete button per preset (with confirmation or multi-click)
- Rename inline (click name to edit)
- "Upload New" button to add another preset

### REQ-4: Preset Playback Engine

Replace the current `audioEngine.ts` with a `presetEngine.ts` that:
- Holds the active preset's band data in memory
- Tracks playback position (loops from start when reaching end)
- Exposes `getFrequencyData()` returning a Uint8Array (same interface as before) reconstructed from the preset's band values at the current playback position
- Exposes `isPlaying()`, `play()`, `pause()`, `seek()` with same API shape
- Auto-starts on load (no user interaction needed — no AudioContext restrictions since there's no actual audio)

### REQ-5: App Launch Behavior

**On launch**, SessionsTab reads `activePresetId` from settings. If set:
1. Calls `load_preset(id)` to get the full preset data
2. Loads it into the preset engine
3. Engine auto-starts playback (looping)
4. All working session cards display the audio-driven string animation

No race conditions — preset data is a simple JSON load, no AudioContext needed.

### REQ-6: Signal String Compatibility

SignalString's audio rendering path remains unchanged. It calls `getFrequencyData()` and `isPlaying()` — the preset engine provides the same interface. The three-band string visualization (bass/mids/treble with standing waves + travel) works identically whether driven by live FFT or preset data.

### REQ-7: Remove Audio File Storage

Remove from Rust backend:
- `save_audio_file` command
- `load_audio_file` command
- Any stored audio file in app data directory

Remove from Settings model:
- `audio_file_name` field

Rename `signalMode` value `"audio"` → `"preset"` with backward compat (treat "audio" as "preset" on load).

## Implementation Checklist

- [ ] Create `SignalPreset` type in `types.ts` and `models.rs`
- [ ] Create `presetEngine.ts` replacing `audioEngine.ts`
- [ ] Add extraction logic (Web Audio decode + FFT sampling at 60fps)
- [ ] Add Rust commands: save_preset, list_presets, load_preset, delete_preset, rename_preset
- [ ] Update Settings model (both Rust and TS) — remove audioFileName, add activePresetId
- [ ] Remove save_audio_file / load_audio_file commands
- [ ] Update SettingsView — preset library UI, upload flow
- [ ] Update SessionsTab — load active preset on launch
- [ ] Update SignalString — import from presetEngine instead of audioEngine
- [ ] Backward compat: treat signalMode "audio" as "preset"

## Non-Goals

- No audio playback (speakers/headphones) — visualization only
- No waveform preview in settings — just name/duration/date
- No import/export of presets between machines
- No real-time microphone input
