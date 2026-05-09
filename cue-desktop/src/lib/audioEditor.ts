/**
 * PCM editing pipeline applied before band extraction.
 * All operations are pure (return a new Float32Array). Pipeline order is fixed:
 *   crop → smooth → fade → gain → clip → normalize
 * Skipping a step is just passing identity params (defaults below).
 */

export interface EditParams {
  /** Crop start in seconds (>= 0). */
  cropInSecs: number;
  /** Crop end in seconds (<= total duration). */
  cropOutSecs: number;
  /**
   * One-pole low-pass cutoff in Hz. 0 disables.
   * Lower values = more smoothing (rolls off treble before extraction).
   */
  smoothCutoffHz: number;
  /** Linear fade in length in seconds (0 disables). */
  fadeInSecs: number;
  /** Linear fade out length in seconds (0 disables). */
  fadeOutSecs: number;
  /** Linear gain factor applied to all samples. 1.0 = identity. */
  gain: number;
  /** Hard clip ceiling (0..1). 1.0 disables; values < 1 cap |sample|. */
  clipCeiling: number;
  /** Peak-normalize the final buffer to 1.0. */
  normalize: boolean;
}

export const DEFAULT_EDIT_PARAMS: EditParams = {
  cropInSecs: 0,
  cropOutSecs: 0, // 0 means "use full duration"; the editor sets this from PCM length on load
  smoothCutoffHz: 0,
  fadeInSecs: 0,
  fadeOutSecs: 0,
  gain: 1.0,
  clipCeiling: 1.0,
  normalize: false,
};

/** Apply the full pipeline. Returns a new Float32Array. */
export function processPcm(
  mono: Float32Array,
  sampleRate: number,
  params: EditParams,
): Float32Array {
  let out = crop(mono, sampleRate, params.cropInSecs, params.cropOutSecs);
  if (params.smoothCutoffHz > 0) out = smooth(out, sampleRate, params.smoothCutoffHz);
  if (params.fadeInSecs > 0 || params.fadeOutSecs > 0) {
    out = fade(out, sampleRate, params.fadeInSecs, params.fadeOutSecs);
  }
  if (params.gain !== 1.0) out = applyGain(out, params.gain);
  if (params.clipCeiling < 1.0) out = clip(out, params.clipCeiling);
  if (params.normalize) out = normalizePeak(out);
  return out;
}

function crop(mono: Float32Array, sr: number, inSecs: number, outSecs: number): Float32Array {
  const totalDuration = mono.length / sr;
  const startSec = Math.max(0, Math.min(inSecs, totalDuration));
  // outSecs of 0 (or anything <= startSec) means "to the end"
  const endSec = outSecs > startSec ? Math.min(outSecs, totalDuration) : totalDuration;
  const startIdx = Math.floor(startSec * sr);
  const endIdx = Math.floor(endSec * sr);
  if (startIdx === 0 && endIdx === mono.length) {
    return new Float32Array(mono); // copy so downstream can mutate
  }
  return mono.slice(startIdx, endIdx);
}

/** One-pole low-pass at cutoffHz. Single-pass forward filter. */
function smooth(mono: Float32Array, sr: number, cutoffHz: number): Float32Array {
  const alpha = 1 - Math.exp(-2 * Math.PI * cutoffHz / sr);
  const out = new Float32Array(mono.length);
  let state = 0;
  for (let i = 0; i < mono.length; i++) {
    state += alpha * (mono[i] - state);
    out[i] = state;
  }
  return out;
}

function fade(mono: Float32Array, sr: number, inSecs: number, outSecs: number): Float32Array {
  const out = new Float32Array(mono);
  const inSamples = Math.min(Math.floor(inSecs * sr), out.length);
  const outSamples = Math.min(Math.floor(outSecs * sr), out.length);
  for (let i = 0; i < inSamples; i++) {
    out[i] *= i / inSamples;
  }
  for (let i = 0; i < outSamples; i++) {
    const idx = out.length - 1 - i;
    out[idx] *= i / outSamples;
  }
  return out;
}

function applyGain(mono: Float32Array, gain: number): Float32Array {
  const out = new Float32Array(mono.length);
  for (let i = 0; i < mono.length; i++) out[i] = mono[i] * gain;
  return out;
}

function clip(mono: Float32Array, ceiling: number): Float32Array {
  const out = new Float32Array(mono.length);
  for (let i = 0; i < mono.length; i++) {
    const s = mono[i];
    out[i] = s > ceiling ? ceiling : s < -ceiling ? -ceiling : s;
  }
  return out;
}

function normalizePeak(mono: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < mono.length; i++) {
    const a = Math.abs(mono[i]);
    if (a > peak) peak = a;
  }
  if (peak === 0 || peak === 1) return new Float32Array(mono);
  const scale = 1 / peak;
  const out = new Float32Array(mono.length);
  for (let i = 0; i < mono.length; i++) out[i] = mono[i] * scale;
  return out;
}
