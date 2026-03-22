# Audio-Driven Signal String — Spec

## Overview

Add a second mode for the Signal String separator: **Audio mode**. Instead of simulated piano-strike pulses from title letter animation, the string displacement is driven by real-time frequency analysis of a user-uploaded audio file (.wav/.mp3). The audio loops continuously. All active signal strings react to the same global audio source.

## Scope

**In scope:**
- Settings toggle: "Simulated" (current piano strikes) vs "Audio" mode
- File upload button in Settings (appears when Audio mode selected)
- Web Audio API: AudioContext + AnalyserNode for real-time FFT
- AudioBufferSourceNode with `loop = true` for continuous playback
- Frequency bin → string position mapping (bass left, treble right)
- Amplitude at each frequency drives string displacement
- Global audio state shared across all SignalString instances
- Audio starts on upload, loops until mode change or app close

**Out of scope:**
- Playback controls (play/pause/skip/volume)
- Persistence across app restarts (re-upload needed)
- Per-session audio sources
- Rust backend changes (Web Audio API is entirely frontend)
- Playlist / multiple files

## Architecture

### Data Flow

```
Settings: user uploads .wav/.mp3
  → FileReader.readAsArrayBuffer()
    → AudioContext.decodeAudioData()
      → AudioBufferSourceNode (loop=true) → AnalyserNode
        → getByteFrequencyData() every frame
          → SharedRef<Uint8Array> (global)
            → Each SignalString reads frequency data in draw()
              → Maps bins to x-positions, amplitude to y-displacement
                → tanh() bounding → canvas render
```

### Global Audio State

A shared module (`src/lib/audioEngine.ts`) manages the singleton AudioContext:

```ts
interface AudioEngine {
  load(file: File): Promise<void>;   // decode + start looping
  stop(): void;                       // stop playback, release resources
  getFrequencyData(): Uint8Array;     // current FFT frame (128 bins)
  isPlaying(): boolean;
}
```

SignalString accesses the engine via a ref or direct import. No React context needed — the engine is stateless from React's perspective (just a data source polled each frame).

### Frequency → String Mapping

The AnalyserNode produces 128 frequency bins (0 Hz to Nyquist).
Map each bin to a position along the string:

```
for each pixel x on canvas:
  binIndex = floor((x / canvasWidth) * numBins)
  amplitude = frequencyData[binIndex] / 255  // normalize 0..1
  y = amplitude * halfH * intensityScale
```

Apply `tanh(y * gain)` for smooth bounding, same as simulated mode.

### Settings Changes

Add to Settings interface:
- `signalMode: "simulated" | "audio"` (default: "simulated")

Add to Rust Settings struct:
- `signal_mode: String` (default: "simulated")

### UI Changes (SettingsView)

When Signal String is enabled, show mode selector:
```
Signal String Mode: [Simulated] [Audio]
```

When Audio mode selected, show:
```
Upload Audio: [Choose File] filename.mp3 ✓
```

The frequency slider is hidden in audio mode (not applicable — the audio drives everything).

### SignalString Changes

The `draw()` function checks mode:
- **Simulated**: current pulse-driven behavior (unchanged)
- **Audio**: read frequency data from audioEngine, map to displacement

Both modes share the same canvas, tanh bounding, flat line for inactive states, and reduced motion handling.

New prop: `signalMode?: "simulated" | "audio"` (default: "simulated")

## Files Modified

1. `src/lib/audioEngine.ts` — **NEW** — singleton audio engine
2. `src/lib/types.ts` — add `signalMode` to Settings
3. `src/components/SignalString.tsx` — add audio-driven draw path
4. `src/components/SettingsView.tsx` — add mode toggle + file upload
5. `src/components/SessionsTab.tsx` — pass signalMode to SessionCard
6. `src/components/SessionCard.tsx` — pass signalMode to SignalString
7. `src-tauri/src/models.rs` — add `signal_mode` to Settings struct

## Functional Requirements

1. FR-UPLOAD: User can upload a .wav or .mp3 file via Settings when Audio mode is selected
2. FR-DECODE: Audio file is decoded via Web Audio API and begins looping immediately
3. FR-FFT: AnalyserNode produces real-time frequency data (128 bins, updated every frame)
4. FR-MAP: Frequency bins map to horizontal string positions; amplitude maps to vertical displacement
5. FR-GLOBAL: All SignalString instances on all session cards read from the same audio source
6. FR-LOOP: Audio loops continuously without user interaction
7. FR-SWITCH: Toggling back to Simulated mode stops audio and returns to piano-strike behavior
8. FR-INACTIVE: Idle/done sessions still show flat line regardless of mode
9. FR-COMPAT: Reduced motion, revived states, and theme-aware colors work identically in both modes
