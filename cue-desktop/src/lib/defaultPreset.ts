import type { SignalPreset } from "./types";
import rawDefaultPreset from "@/assets/defaultPreset.json";

/**
 * Baked-in default audio data. Drives the signal strings out of the box so a
 * fresh install always has motion without the user uploading anything. It is
 * intentionally nameless (`name: ""`) and never appears in the preset list —
 * users can still add their own presets, which take over when active.
 */
export const DEFAULT_PRESET: SignalPreset = rawDefaultPreset as SignalPreset;

/** Sentinel id for the baked-in default preset (never persisted to disk). */
export const DEFAULT_PRESET_ID = "default";
