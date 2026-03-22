/**
 * Preset playback engine for driving Signal Strings from extracted frequency envelopes.
 * No AudioContext needed — just array indexing with interpolation.
 * Loops from start when reaching end. Auto-starts on load.
 */

import type { SignalPreset } from "./types";

let preset: SignalPreset | null = null;
let playing = false;
let startTime = 0;       // performance.now() when playback started
let pauseOffset = 0;     // seconds into the track when paused
let paused = false;
let gateThreshold = 0.05; // noise gate: values below this are zeroed

// Pre-built Uint8Array for getFrequencyData() compatibility
const NUM_BINS = 128;
let frequencyData = new Uint8Array(NUM_BINS);

// Asymmetric attack/release smoothing state per band
// Fast attack (track transients), slow release (smooth decay)
let smoothBass = 0, smoothMids = 0, smoothTreble = 0;
const ATTACK_BASS = 0.35, ATTACK_MIDS = 0.45, ATTACK_TREBLE = 0.55;
const RELEASE_BASS = 0.94, RELEASE_MIDS = 0.92, RELEASE_TREBLE = 0.89;

/** Load a preset and auto-start playback. */
export function loadPreset(p: SignalPreset): void {
  stop();
  preset = p;
  pauseOffset = 0;
  play();
}

/** Start or resume playback. */
export function play(): void {
  if (!preset) return;
  startTime = performance.now();
  playing = true;
  paused = false;
}

/** Pause playback — retains position. */
export function pause(): void {
  if (!playing || paused) return;
  pauseOffset = getCurrentTime();
  playing = false;
  paused = true;
}

/** Resume from paused position. */
export function resume(): void {
  if (!paused || !preset) return;
  startTime = performance.now();
  playing = true;
  paused = false;
}

/** Toggle play/pause. */
export function togglePlayPause(): void {
  if (paused) resume();
  else if (playing) pause();
}

/** Stop playback and release preset. */
export function stop(): void {
  preset = null;
  playing = false;
  paused = false;
  pauseOffset = 0;
  frequencyData = new Uint8Array(NUM_BINS);
  smoothBass = smoothMids = smoothTreble = 0;
}

/** Current playback position in seconds (accounts for looping). */
export function getCurrentTime(): number {
  if (!preset) return 0;
  if (paused) return pauseOffset % (preset.durationSecs || 1);
  if (!playing) return 0;
  const elapsed = pauseOffset + (performance.now() - startTime) / 1000;
  return preset.durationSecs > 0 ? elapsed % preset.durationSecs : 0;
}

/** Total track duration in seconds. */
export function getDuration(): number {
  return preset?.durationSecs ?? 0;
}

/** Whether preset is currently playing. */
export function isPlaying(): boolean {
  return playing;
}

/** Whether a preset is loaded (playing or paused). */
export function isLoaded(): boolean {
  return preset !== null;
}

/** Whether playback is paused. */
export function isPaused(): boolean {
  return paused;
}

/** Set the noise gate threshold (0.0 = no gate, 1.0 = full gate). */
export function setGate(threshold: number): void {
  gateThreshold = Math.max(0, Math.min(1, threshold));
}

/** Get current gate threshold. */
export function getGate(): number {
  return gateThreshold;
}

/** Seek to a specific position in seconds. */
export function seek(time: number): void {
  if (!preset) return;
  pauseOffset = Math.max(0, Math.min(time, preset.durationSecs));
  if (playing) {
    startTime = performance.now();
  }
}

/**
 * Get frequency data as a 128-bin Uint8Array (0-255), matching the old audioEngine API.
 * Reconstructs bins from the 3 stored band values at the current playback position.
 * Uses linear interpolation between samples for smoothness.
 */
export function getFrequencyData(): Uint8Array {
  if (!preset || !playing) return frequencyData;

  const t = getCurrentTime();
  const samplePos = t * preset.sampleRate;
  const totalSamples = preset.bands.bass.length;
  if (totalSamples === 0) return frequencyData;

  // Interpolation indices
  const idx0 = Math.floor(samplePos) % totalSamples;
  const idx1 = (idx0 + 1) % totalSamples;
  const frac = samplePos - Math.floor(samplePos);

  // Interpolate each band, then apply noise gate
  const gate = gateThreshold;
  const scale = gate < 1 ? 1 / (1 - gate) : 0;
  const applyGate = (v: number) => v <= gate ? 0 : (v - gate) * scale;

  const rawBass = applyGate(preset.bands.bass[idx0] * (1 - frac) + preset.bands.bass[idx1] * frac);
  const rawMids = applyGate(preset.bands.mids[idx0] * (1 - frac) + preset.bands.mids[idx1] * frac);
  const rawTreble = applyGate(preset.bands.treble[idx0] * (1 - frac) + preset.bands.treble[idx1] * frac);

  // Asymmetric attack/release smoothing: fast rise, slow fall
  const smooth = (raw: number, prev: number, attack: number, release: number) =>
    raw > prev ? prev + attack * (raw - prev) : prev + (1 - release) * (raw - prev);

  smoothBass = smooth(rawBass, smoothBass, ATTACK_BASS, RELEASE_BASS);
  smoothMids = smooth(rawMids, smoothMids, ATTACK_MIDS, RELEASE_MIDS);
  smoothTreble = smooth(rawTreble, smoothTreble, ATTACK_TREBLE, RELEASE_TREBLE);

  const bass = smoothBass;
  const mids = smoothMids;
  const treble = smoothTreble;

  // Map bands to bins: bass = 0-25%, mids = 25-60%, treble = 60-100%
  const bassBins = Math.floor(NUM_BINS * 0.25);
  const midsBins = Math.floor(NUM_BINS * 0.6);

  for (let i = 0; i < NUM_BINS; i++) {
    let value: number;
    if (i < bassBins) {
      value = bass;
    } else if (i < midsBins) {
      value = mids;
    } else {
      value = treble;
    }
    frequencyData[i] = Math.round(value * 255);
  }

  return frequencyData;
}
