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

// Spectral flux onset detection state
// Tracks rate-of-change per band; positive flux = onset (new energy arriving)
let prevBass = 0, prevMids = 0, prevTreble = 0;
let fluxBass = 0, fluxMids = 0, fluxTreble = 0;
// Smoothed flux for adaptive thresholding
let fluxAvgBass = 0, fluxAvgMids = 0, fluxAvgTreble = 0;
const FLUX_SMOOTH = 0.92; // EMA for running average
const FLUX_THRESHOLD_MULT = 2.5; // onset = flux > avg * this

// ── Once-per-frame gate for getFrequencyData ────────────────────────────────
// getFrequencyData() advances the attack/release smoothing and spectral-flux
// onset state on EVERY call, but it's called once per rAF frame PER consumer
// (each on-screen FluxEffect canvas + the audio-mode SignalString). With N live
// consumers the smoothing constants would apply N× per frame and the flux diff
// between consecutive intra-frame calls would collapse to ~0 — silently killing
// onset detection whenever 2+ effect canvases are on screen. To fix this we
// advance the analyser AT MOST ONCE PER ANIMATION FRAME: a rAF ticker (live only
// while a preset plays) reopens `frameAdvanceAvailable` once per real frame; the
// first consumer to read consumes it and advances the state, and every later
// consumer in the same frame gets the cached buffer. A boolean reset exactly
// once per frame makes this strictly once-per-frame regardless of the order the
// ticker and consumer rAF callbacks happen to run in — and, being driven by rAF
// rather than a wall-clock read, stays refresh-rate-agnostic and free of
// Date.now()/Math.random().
let frameAdvanceAvailable = true;
let frameTickerHandle: number | null = null;

/** Start the once-per-frame ticker (idempotent; no-op without requestAnimationFrame). */
function startFrameTicker(): void {
  if (frameTickerHandle !== null) return;
  if (typeof requestAnimationFrame === "undefined") return;
  const tick = () => {
    frameAdvanceAvailable = true; // reopen the single per-frame advance
    frameTickerHandle = requestAnimationFrame(tick);
  };
  frameTickerHandle = requestAnimationFrame(tick);
}

/** Stop the once-per-frame ticker. */
function stopFrameTicker(): void {
  if (frameTickerHandle !== null && typeof cancelAnimationFrame !== "undefined") {
    cancelAnimationFrame(frameTickerHandle);
  }
  frameTickerHandle = null;
}

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
  frameAdvanceAvailable = true; // let the next frame compute immediately
  startFrameTicker();
}

/** Pause playback — retains position. */
export function pause(): void {
  if (!playing || paused) return;
  pauseOffset = getCurrentTime();
  playing = false;
  paused = true;
  stopFrameTicker();
}

/** Resume from paused position. */
export function resume(): void {
  if (!paused || !preset) return;
  startTime = performance.now();
  playing = true;
  paused = false;
  frameAdvanceAvailable = true; // let the next frame compute immediately
  startFrameTicker();
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
  offsetFreqData = new Uint8Array(NUM_BINS);
  smoothBass = smoothMids = smoothTreble = 0;
  prevBass = prevMids = prevTreble = 0;
  fluxBass = fluxMids = fluxTreble = 0;
  fluxAvgBass = fluxAvgMids = fluxAvgTreble = 0;
  stopFrameTicker();
  frameAdvanceAvailable = true;
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

  // Advance-and-cache once per animation frame. When the rAF ticker is live
  // (normal playback) only the first consumer each frame consumes the advance;
  // any further consumers in the same frame get the cached buffer — so
  // smoothing/flux advance exactly once per frame regardless of consumer count.
  // When the ticker is absent (no requestAnimationFrame, e.g. node tests) the
  // flag never reopens, so we skip the gate and advance on every call (original
  // behavior).
  if (frameTickerHandle !== null) {
    if (!frameAdvanceAvailable) return frequencyData;
    frameAdvanceAvailable = false;
  }

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

  let rawBass = applyGate(preset.bands.bass[idx0] * (1 - frac) + preset.bands.bass[idx1] * frac);
  let rawMids = applyGate(preset.bands.mids[idx0] * (1 - frac) + preset.bands.mids[idx1] * frac);
  let rawTreble = applyGate(preset.bands.treble[idx0] * (1 - frac) + preset.bands.treble[idx1] * frac);

  // Crossfade near loop boundary to avoid a hard jump between end and start
  const XFADE_SECS = 1.5;
  const duration = preset.durationSecs || 1;
  const timeLeft = duration - t;
  if (timeLeft < XFADE_SECS && duration > XFADE_SECS * 2) {
    const blend = timeLeft / XFADE_SECS; // 1 at edge, 0 at loop point
    // Sample the start of the track
    const startPos = (t - duration + XFADE_SECS) * preset.sampleRate; // mirror position from start
    const sIdx0 = Math.floor(startPos) % totalSamples;
    const sIdx1 = (sIdx0 + 1) % totalSamples;
    const sFrac = startPos - Math.floor(startPos);
    const startBass = applyGate(preset.bands.bass[sIdx0] * (1 - sFrac) + preset.bands.bass[sIdx1] * sFrac);
    const startMids = applyGate(preset.bands.mids[sIdx0] * (1 - sFrac) + preset.bands.mids[sIdx1] * sFrac);
    const startTreble = applyGate(preset.bands.treble[sIdx0] * (1 - sFrac) + preset.bands.treble[sIdx1] * sFrac);
    rawBass = rawBass * blend + startBass * (1 - blend);
    rawMids = rawMids * blend + startMids * (1 - blend);
    rawTreble = rawTreble * blend + startTreble * (1 - blend);
  }

  // Asymmetric attack/release smoothing: fast rise, slow fall
  const smooth = (raw: number, prev: number, attack: number, release: number) =>
    raw > prev ? prev + attack * (raw - prev) : prev + (1 - release) * (raw - prev);

  smoothBass = smooth(rawBass, smoothBass, ATTACK_BASS, RELEASE_BASS);
  smoothMids = smooth(rawMids, smoothMids, ATTACK_MIDS, RELEASE_MIDS);
  smoothTreble = smooth(rawTreble, smoothTreble, ATTACK_TREBLE, RELEASE_TREBLE);

  const bass = smoothBass;
  const mids = smoothMids;
  const treble = smoothTreble;

  // Spectral flux: half-wave rectified difference (only increases = onsets)
  fluxBass = Math.max(0, bass - prevBass);
  fluxMids = Math.max(0, mids - prevMids);
  fluxTreble = Math.max(0, treble - prevTreble);
  prevBass = bass; prevMids = mids; prevTreble = treble;

  // Adaptive threshold: running average of flux
  fluxAvgBass = FLUX_SMOOTH * fluxAvgBass + (1 - FLUX_SMOOTH) * fluxBass;
  fluxAvgMids = FLUX_SMOOTH * fluxAvgMids + (1 - FLUX_SMOOTH) * fluxMids;
  fluxAvgTreble = FLUX_SMOOTH * fluxAvgTreble + (1 - FLUX_SMOOTH) * fluxTreble;

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

// Reusable buffer for getFrequencyDataAtTime — avoids allocation per frame
let offsetFreqData = new Uint8Array(NUM_BINS);

/**
 * Get frequency data at an arbitrary time position (no smoothing/onset detection).
 * Used by per-session offset to sample different points in the song.
 * Returns a shared buffer — callers must consume before next call.
 */
export function getFrequencyDataAtTime(timeSecs: number): Uint8Array {
  if (!preset) { offsetFreqData.fill(0); return offsetFreqData; }

  const totalSamples = preset.bands.bass.length;
  if (totalSamples === 0) { offsetFreqData.fill(0); return offsetFreqData; }

  // Wrap time into track duration
  const duration = preset.durationSecs || 1;
  const t = ((timeSecs % duration) + duration) % duration; // handle negatives
  const samplePos = t * preset.sampleRate;

  const idx0 = Math.floor(samplePos) % totalSamples;
  const idx1 = (idx0 + 1) % totalSamples;
  const frac = samplePos - Math.floor(samplePos);

  const gate = gateThreshold;
  const scale = gate < 1 ? 1 / (1 - gate) : 0;
  const applyGate = (v: number) => v <= gate ? 0 : (v - gate) * scale;

  let bass = applyGate(preset.bands.bass[idx0] * (1 - frac) + preset.bands.bass[idx1] * frac);
  let mids = applyGate(preset.bands.mids[idx0] * (1 - frac) + preset.bands.mids[idx1] * frac);
  let treble = applyGate(preset.bands.treble[idx0] * (1 - frac) + preset.bands.treble[idx1] * frac);

  // Crossfade near loop boundary
  const XFADE_SECS = 1.5;
  const dur = preset.durationSecs || 1;
  const timeLeft = dur - t;
  if (timeLeft < XFADE_SECS && dur > XFADE_SECS * 2) {
    const blend = timeLeft / XFADE_SECS;
    const startPos = (t - dur + XFADE_SECS) * preset.sampleRate;
    const sIdx0 = Math.floor(startPos) % totalSamples;
    const sIdx1 = (sIdx0 + 1) % totalSamples;
    const sFrac = startPos - Math.floor(startPos);
    const sBass = applyGate(preset.bands.bass[sIdx0] * (1 - sFrac) + preset.bands.bass[sIdx1] * sFrac);
    const sMids = applyGate(preset.bands.mids[sIdx0] * (1 - sFrac) + preset.bands.mids[sIdx1] * sFrac);
    const sTreble = applyGate(preset.bands.treble[sIdx0] * (1 - sFrac) + preset.bands.treble[sIdx1] * sFrac);
    bass = bass * blend + sBass * (1 - blend);
    mids = mids * blend + sMids * (1 - blend);
    treble = treble * blend + sTreble * (1 - blend);
  }

  const bassBins = Math.floor(NUM_BINS * 0.25);
  const midsBins = Math.floor(NUM_BINS * 0.6);

  for (let i = 0; i < NUM_BINS; i++) {
    offsetFreqData[i] = Math.round((i < bassBins ? bass : i < midsBins ? mids : treble) * 255);
  }

  return offsetFreqData;
}

/**
 * Get per-band onset strength (0 = no onset, positive = onset intensity).
 * Returns flux above the adaptive threshold — only fires on genuine transients.
 */
export function getOnsets(): { bass: number; mids: number; treble: number } {
  return {
    bass: fluxBass > fluxAvgBass * FLUX_THRESHOLD_MULT ? fluxBass : 0,
    mids: fluxMids > fluxAvgMids * FLUX_THRESHOLD_MULT ? fluxMids : 0,
    treble: fluxTreble > fluxAvgTreble * FLUX_THRESHOLD_MULT ? fluxTreble : 0,
  };
}

/**
 * Get raw spectral flux per band (useful for visualization/debugging).
 */
export function getFlux(): { bass: number; mids: number; treble: number } {
  return { bass: fluxBass, mids: fluxMids, treble: fluxTreble };
}
