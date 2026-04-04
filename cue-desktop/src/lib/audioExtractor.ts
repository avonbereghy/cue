/**
 * Extract frequency envelope data from an audio file.
 * Decodes to PCM, then processes raw samples directly — no audio is ever played.
 * Produces a SignalPreset with bass/mids/treble band envelopes at 60 samples/sec.
 */

import type { SignalPreset } from "./types";

const PRESET_SAMPLE_RATE = 60; // envelope samples per second

/**
 * Extract a SignalPreset from an audio file.
 * @param file - The audio file to process
 * @param name - Display name for the preset
 * @returns A complete SignalPreset ready to save
 */
export async function extractPreset(file: File, name: string): Promise<SignalPreset> {
  const arrayBuffer = await file.arrayBuffer();

  // Decode audio to raw PCM — this doesn't play anything
  const audioCtx = new AudioContext();
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    await audioCtx.close();
  }

  const sr = audioBuffer.sampleRate;
  const duration = audioBuffer.duration;
  const totalEnvelopeSamples = Math.ceil(duration * PRESET_SAMPLE_RATE);
  const chunkSize = Math.floor(sr / PRESET_SAMPLE_RATE);

  // Mix to mono
  const mono = mixToMono(audioBuffer);

  // 4-pole cascaded IIR low-pass filters for steep band separation (24dB/oct)
  // Bass: < ~300 Hz, Mids: 300-4000 Hz, Treble: > 4000 Hz
  const POLES = 4;
  const bassAlpha = 1 - Math.exp(-2 * Math.PI * 300 / sr);
  const trebleAlpha = 1 - Math.exp(-2 * Math.PI * 4000 / sr);

  const bass: number[] = [];
  const mids: number[] = [];
  const treble: number[] = [];

  // Each filter stage gets its own state
  const bassLp = new Float64Array(POLES);   // 4-pole cascade at 300 Hz
  const fullLp = new Float64Array(POLES);   // 4-pole cascade at 4000 Hz

  for (let i = 0; i < totalEnvelopeSamples; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, mono.length);
    if (start >= mono.length) break;

    let bassRms = 0, midsRms = 0, trebleRms = 0;
    let count = 0;

    for (let s = start; s < end; s++) {
      const sample = mono[s];

      // Cascade 4 poles at 300 Hz → bass
      let bIn = sample;
      for (let p = 0; p < POLES; p++) {
        bassLp[p] += bassAlpha * (bIn - bassLp[p]);
        bIn = bassLp[p];
      }
      const bassSignal = bIn;

      // Cascade 4 poles at 4000 Hz → bass+mids
      let fIn = sample;
      for (let p = 0; p < POLES; p++) {
        fullLp[p] += trebleAlpha * (fIn - fullLp[p]);
        fIn = fullLp[p];
      }
      const midsSignal = fIn - bassSignal;       // mids = (bass+mids) - bass
      const trebleSignal = sample - fIn;          // treble = original - (bass+mids)

      bassRms += bassSignal * bassSignal;
      midsRms += midsSignal * midsSignal;
      trebleRms += trebleSignal * trebleSignal;
      count++;
    }

    if (count === 0) {
      bass.push(0);
      mids.push(0);
      treble.push(0);
      continue;
    }

    // RMS → normalize to 0-1 range with sqrt curve for perceptual scaling
    // Scale factors tuned so typical music fills the range well
    bass.push(Math.min(1, Math.sqrt(Math.sqrt(bassRms / count) * 8)));
    mids.push(Math.min(1, Math.sqrt(Math.sqrt(midsRms / count) * 12)));
    treble.push(Math.min(1, Math.sqrt(Math.sqrt(trebleRms / count) * 20)));
  }

  return {
    id: crypto.randomUUID(),
    name,
    createdAt: Date.now() / 1000,
    durationSecs: duration,
    sampleRate: PRESET_SAMPLE_RATE,
    bands: { bass, mids, treble },
  };
}

/** Mix an AudioBuffer down to a mono Float32Array. */
function mixToMono(buffer: AudioBuffer): Float32Array {
  const length = buffer.length;
  const channels = buffer.numberOfChannels;

  if (channels === 1) {
    return buffer.getChannelData(0);
  }

  const mono = new Float32Array(length);
  const scale = 1 / channels;
  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += data[i] * scale;
    }
  }
  return mono;
}
