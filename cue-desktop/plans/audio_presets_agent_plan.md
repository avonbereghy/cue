# Audio Presets — Agent Plan

## Wave Structure

This is a **2-wave** implementation (foundation → integration). No parallel tracks needed — changes are sequential with tight coupling between the preset engine and the UI.

### Wave 0: Foundation — Models, Engine, Backend

**Goal**: Create the preset data model, preset engine, Rust backend commands, and remove old audio file storage.

**Tasks**:

1. **Types** (`src/lib/types.ts`)
   - Add `SignalPreset` and `PresetSummary` interfaces
   - Update `Settings`: remove `audioFileName`, add `activePresetId: string`
   - Rename signal mode value "audio" → "preset" in comments/docs

2. **Preset Engine** (`src/lib/presetEngine.ts`) — NEW file replacing `audioEngine.ts`
   - Holds active preset band data in memory
   - Tracks playback position with `requestAnimationFrame` timing
   - Loops from start when reaching end
   - Exposes same API: `getFrequencyData(): Uint8Array`, `isPlaying(): boolean`, `play()`, `pause()`, `getCurrentTime()`, `getDuration()`
   - `getFrequencyData()` reconstructs a 128-bin Uint8Array from the 3 band values at current position (interpolated between samples)
   - `loadPreset(preset: SignalPreset)` replaces `loadFromBytes()`
   - Auto-starts on load

3. **Audio Extraction** (`src/lib/audioExtractor.ts`) — NEW file
   - `extractPreset(file: File, name: string): Promise<SignalPreset>`
   - Uses OfflineAudioContext to decode and process entire file at once (not real-time)
   - Creates AnalyserNode, processes in chunks at 60fps equivalent
   - Extracts bass/mids/treble bands, normalizes with sqrt curve
   - Returns complete SignalPreset with UUID, name, duration, bands

4. **Rust Models** (`src-tauri/src/models.rs`)
   - Add `SignalPreset` struct (id, name, created_at, duration_secs, sample_rate, bands with bass/mids/treble Vec<f64>)
   - Add `PresetSummary` struct (id, name, created_at, duration_secs)
   - Update `Settings`: remove `audio_file_name`, add `active_preset_id: String`
   - Keep backward compat: `#[serde(alias = "audioFileName")]` or just ignore unknown fields (serde default)

5. **Rust Paths** (`src-tauri/src/paths.rs`)
   - Add `presets_dir() -> PathBuf` (e.g., `~/Library/Application Support/com.cueapp/presets/`)
   - Remove `audio_file_path()`

6. **Rust Commands** (`src-tauri/src/lib.rs`)
   - Add: `save_preset(preset: SignalPreset)`, `list_presets() -> Vec<PresetSummary>`, `load_preset(id: String) -> SignalPreset`, `delete_preset(id: String)`, `rename_preset(id: String, name: String)`
   - Remove: `save_audio_file`, `load_audio_file`
   - Update command registration

7. **Delete** `src/lib/audioEngine.ts`

**Verify**: `cargo check` + `npx tsc --noEmit`

### Wave 1: Integration — UI & Wiring

**Goal**: Wire the preset engine into the settings UI and session cards.

**Tasks**:

1. **SettingsView** (`src/components/SettingsView.tsx`)
   - Replace audio file upload flow with: upload → extract → save preset → activate
   - Add preset library list (name, duration, date, active indicator)
   - Click preset to activate, delete button, inline rename
   - Remove audio playback controls (no audio to play)
   - Update signal mode options: "Simulated" / "Preset"
   - Import from `presetEngine` and `audioExtractor` instead of `audioEngine`

2. **SessionsTab** (`src/components/SessionsTab.tsx`)
   - On launch: read `activePresetId` from settings → `load_preset(id)` → `presetEngine.loadPreset(data)`
   - Remove `audioEngine` imports
   - Rename `signalMode` value handling: "audio" → "preset"

3. **SignalString** (`src/components/SignalString.tsx`)
   - Update imports: `presetEngine` instead of `audioEngine`
   - `signalMode === "preset"` instead of `=== "audio"`
   - Rest of rendering logic unchanged

4. **SessionCard** (`src/components/SessionCard.tsx`)
   - Update `signalMode === "audio"` checks to `=== "preset"`

**Verify**: `cargo check` + `npx tsc --noEmit` + build

## File Ownership Matrix

| File | Wave | Action |
|------|------|--------|
| `src/lib/types.ts` | 0 | Modify |
| `src/lib/presetEngine.ts` | 0 | Create |
| `src/lib/audioExtractor.ts` | 0 | Create |
| `src/lib/audioEngine.ts` | 0 | Delete |
| `src-tauri/src/models.rs` | 0 | Modify |
| `src-tauri/src/paths.rs` | 0 | Modify |
| `src-tauri/src/lib.rs` | 0 | Modify |
| `src/components/SettingsView.tsx` | 1 | Modify |
| `src/components/SessionsTab.tsx` | 1 | Modify |
| `src/components/SignalString.tsx` | 1 | Modify |
| `src/components/SessionCard.tsx` | 1 | Modify |
