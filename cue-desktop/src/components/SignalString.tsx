import { useRef, useEffect, useState } from "react";
import { usePageVisible } from "@/hooks/usePageVisible";
import { useOnScreen } from "@/hooks/useOnScreen";
import { getFrequencyData, getFrequencyDataAtTime, getCurrentTime, getDuration, isPlaying, getOnsets } from "@/lib/presetEngine";
import { setDisturbances, clearDisturbances, type FluxDisturbance } from "@/lib/fluxDisturbance";

/**
 * Signal String — animated separator with two modes:
 * 1. Simulated: title letter "strikes" send damped traveling wave pulses
 * 2. Preset: extracted frequency envelope data drives displacement
 * Uses tanh activation to smoothly bound the result.
 */

/** Parse hex color string to RGB components */
export function hexToRgb(hex: string) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.substring(0, 2), 16) || 0,
    g: parseInt(h.substring(2, 4), 16) || 0,
    b: parseInt(h.substring(4, 6), 16) || 0,
  };
}

export interface StrikePulse {
  originX: number;   // 0..1 normalized position on the string
  startTime: number; // performance.now() timestamp
  amplitude: number; // initial strength (typically 1.0)
}

/**
 * A thin white tracer that streaks left→right across one of the three string
 * lanes. Emitted by the parent (SessionCard) once per tool call so the signal
 * strings visibly "fire" as Claude runs tools.
 */
export interface CometPulse {
  /** performance.now() when this comet was spawned. */
  startTime: number;
  /**
   * Vertical position as a fraction of card height (0 = top, 1 = bottom).
   * Producers pick a random value in [0.25, 0.75] so comets land inside the
   * card's visual safe zone rather than clipping through row content.
   */
  yFrac: number;
}

/** Total flight time of a comet (ms). Short — reads as a tracer, not a car. */
const COMET_LIFE_MS = 550;

/**
 * Draw and prune comet tracers. Mutates `buf` (filters expired entries).
 * Uses "lighter" composite for the glass/tracer sheen and falls through when
 * the buffer is empty so it's cheap to call unconditionally.
 */
function renderComets(
  ctx: CanvasRenderingContext2D,
  buf: CometPulse[],
  now: number,
  w: number,
  h: number,
) {
  if (buf.length === 0) return;
  const tailLen = Math.max(24, w * 0.22);

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";

  // Iterate in reverse so in-place splice is safe.
  for (let i = buf.length - 1; i >= 0; i--) {
    const c = buf[i];
    const age = now - c.startTime;
    if (age < 0) continue;                // scheduled slightly in the future (stagger)
    if (age >= COMET_LIFE_MS) { buf.splice(i, 1); continue; }

    const t = age / COMET_LIFE_MS;        // 0..1 travel progress
    const headX = t * w;
    const tailX = Math.max(0, headX - tailLen);
    const y = c.yFrac * h;

    // Sin envelope: fades in on entry, fades out as it exits the right edge.
    const env = Math.sin(t * Math.PI);
    // Faint tracer — 20% peak so the comet reads as a subtle background
    // spark beneath the strings rather than competing with them.
    const headAlpha = 0.20 * env;

    // Tracer trail — transparent at tail, bright at the head.
    const grad = ctx.createLinearGradient(tailX, y, headX, y);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.75, `rgba(255,255,255,${(headAlpha * 0.28).toFixed(3)})`);
    grad.addColorStop(1, `rgba(255,255,255,${headAlpha.toFixed(3)})`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(tailX, y);
    ctx.lineTo(headX, y);
    ctx.stroke();

    // Bullet head — small bright dot at the leading point.
    ctx.beginPath();
    ctx.fillStyle = `rgba(255,255,255,${headAlpha.toFixed(3)})`;
    ctx.arc(headX, y, 1.1, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

interface SignalStringProps {
  state: string;
  /** Frequency multiplier (0.3 = slow, 1.0 = normal, 3.0 = fast) */
  frequency?: number;
  /** Whether this is a revived (ended) session */
  revived?: boolean;
  /** Shared pulse buffer from SessionCard's strike detector */
  pulses?: React.RefObject<StrikePulse[]>;
  /** Shared comet buffer — one entry per tool call, drawn as a thin white tracer. */
  comets?: React.RefObject<CometPulse[]>;
  /** "simulated" (piano strikes) or "audio" (uploaded audio FFT) */
  signalMode?: string;
  /** Global alpha multiplier (0.0 = invisible, 1.0 = full) */
  signalAlpha?: number;
  /** Amplitude/gain multiplier (0.1 = subtle, 1.0 = normal, 3.0 = intense) */
  signalAmplitude?: number;
  /** Echo/trail intensity (0.0 = no trails, 1.0 = full trails) */
  signalEcho?: number;
  /** Which frequency bands are enabled */
  signalBass?: boolean;
  signalMids?: boolean;
  signalTreble?: boolean;
  /** Custom string color for dark mode (hex) */
  signalColorDark?: string;
  /** Custom string color for light mode (hex) */
  signalColorLight?: string;
  /** Audio offset randomness (0 = all sessions synced, 1 = full random offset) */
  signalOffset?: number;
  /** Visual effect mode: "string" (waveform lines) or "sand" (blown grains) */
  signalEffect?: string;
  /** Whether sand effect is enabled */
  sandEnabled?: boolean;
  /** Sand intensity multiplier */
  sandIntensity?: number;
  /** Sand wind direction in degrees */
  sandDirection?: number;
  /** Sand grain spawn density multiplier */
  sandDensity?: number;
  /** Sand grain travel speed multiplier */
  sandSpeed?: number;
  /** Sand grain size multiplier */
  sandGrainSize?: number;
  /** Sand turbulence / scatter intensity */
  sandTurbulence?: number;
  /** Sand grain opacity */
  sandAlpha?: number;
  /** Delay before cord retracts after stopping (seconds) */
  cordRetractDelay?: number;
  /** Deploy force multiplier (how fast strings launch out) */
  cordDeployForce?: number;
  /** Retract force multiplier (how hard the vacuum pulls) */
  cordRetractForce?: number;
  /** Session ID used as seed for per-session random offset */
  sessionId?: string;
  /** Ref to content wrapper — used to clip sand/strings behind content rows */
  contentRef?: React.RefObject<HTMLDivElement | null>;
  /** Key release animation duration (seconds) — strings stay active until key finishes rising */
  keyReleaseSpeed?: number;
  /** Vertical spread between the three strings (0 = all at center, 0.5 = fully spread) */
  stringSpread?: number;
  /** Deploy angle in degrees — tilt of the working strings around card center */
  stringDeployAngle?: number;
  /**
   * Fires once per thinking→working deploy cycle when all three string bands
   * have reached full clipFraction (≥0.98). Used by the parent to commit the
   * visual working-state swap after strings physically connect, not before.
   */
  onStringsConnected?: () => void;
  /**
   * Additional dynamically-created bands (e.g. one per active subagent).
   * Each is rendered along its own axis (start → end in fractional card
   * coordinates) and uses the audio physics of the referenced band kind.
   * Order is significant: latest items are the "newest" for LIFO retract.
   */
  extraBands?: ExtraBandSpec[];
  /**
   * When true, force-retract the 3 base bands and stop drawing them. Used by
   * the parent for subagent-state entries that did NOT come from working —
   * in those cases only the subagent lines should be visible.
   */
  suppressBaseBands?: boolean;
  /**
   * How many of the 3 base bands the parent currently wants deployed (1..3).
   * Bands at index >= target stay at clipFraction=0. Growing the target mid-
   * turn schedules a deploy for the newly-enabled band; shrinking retracts.
   * Defaults to 3 so callers that don't pass this see the legacy behavior.
   */
  baseBandsTarget?: number;
  /**
   * Per-base-band amplitude multiplier, indexed by bandIdx (0=bass, 1=mids,
   * 2=treble). Applied post-tanh so the string's visible vertical span
   * scales by the multiplier without clipping at saturation. Used to give
   * each successive progressive working string (strings 1..5 from SessionCard)
   * a slightly louder amplitude than the one before. Defaults to [1,1,1].
   */
  baseBandsAmpMuls?: [number, number, number];
}

export interface ExtraBandSpec {
  id: string;
  bandKind: "bass" | "mids" | "treble";
  /** Start of the axis, fractional card coords (0..1 in x and y). */
  axisStart: { xFrac: number; yFrac: number };
  /** End of the axis, fractional card coords (0..1 in x and y). */
  axisEnd: { xFrac: number; yFrac: number };
  /** Stroke color (0-255). Subagents: cyan. */
  color: { r: number; g: number; b: number };
  /**
   * Optional radians-valued phase offset added to the band's temporal term,
   * so multiple extras of the same bandKind don't all crest at the same
   * moment. Stable per id (seeded by the caller).
   */
  phaseJitter?: number;
  /**
   * Per-band amplitude multiplier applied post-tanh. Used to give strings 4/5
   * (progressive working strings) their compounded 5% amplitude bumps.
   * Defaults to 1.
   */
  amplitudeMul?: number;
}

export function SignalString({ state, frequency = 1.0, revived = false, pulses, comets, signalMode = "simulated", signalAlpha = 0.25, signalAmplitude = 0.25, signalEcho = 1.0, signalBass = true, signalMids = true, signalTreble = true, signalColorDark = "#ffffff", signalColorLight = "#000000", signalOffset = 0, signalEffect = "string", sandEnabled = false, sandIntensity = 1.0, sandDirection = 0, sandDensity = 1.0, sandSpeed = 1.0, sandGrainSize = 1.0, sandTurbulence = 0.5, sandAlpha = 0.7, cordRetractDelay = 0.5, cordDeployForce = 1.0, cordRetractForce = 1.0, stringSpread = 0.15, stringDeployAngle = -16, sessionId = "", contentRef, keyReleaseSpeed: _keyReleaseSpeed = 0.4, onStringsConnected, extraBands, suppressBaseBands = false, baseBandsTarget = 3, baseBandsAmpMuls = [1, 1, 1] }: SignalStringProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const pageVisible = usePageVisible();
  const onScreen = useOnScreen(canvasRef);
  // Drive the draw loop only when the canvas is actually on-screen AND the
  // app is in foreground. Off-screen cards used to keep running physics +
  // canvas draws at 60fps; this gate collapses them to zero cost.
  const renderActive = pageVisible && onScreen;
  // Mirror into a ref so the RAF callback can self-terminate within one frame
  // when the gate flips, without waiting for React to schedule the effect
  // cleanup. Without this, an in-flight `draw()` queued before the gate
  // change still ran one extra frame against a hidden/off-screen canvas.
  const renderActiveRef = useRef(renderActive);
  renderActiveRef.current = renderActive;

  // Smoothly interpolated string color (r,g,b) — transitions between states
  const currentColorRef = useRef<{ r: number; g: number; b: number } | null>(null);
  // Track current state in a ref so the draw loop can determine effect type (sand vs string)
  const stateRef = useRef(state);
  stateRef.current = state;
  // Smooth blend between string (0) and sand (1) effects — crossfades during state transitions
  const sandBlendRef = useRef(state === "idle" ? 1.0 : 0.0);

  // Base strings deploy during working and subagent only. Thinking does not
  // deploy strings on its own — but if a turn already deployed them (working
  // → thinking), they stay deployed via the stringsStayDeployed branch below.
  // The thinking→working handoff sweeps in any not-yet-deployed bands.
  const stateIsActive = state === "working" || state === "subagent";
  // Strings should stay deployed (no retract) mid-turn. Thinking is part of
  // an ongoing turn (working↔thinking cycles); error/waiting are transient
  // pauses. Only idle/done/compacting/clearing/ended end the turn and retract.
  const stringsStayDeployed =
    state === "error" || state === "waiting" || state === "thinking";
  // Track whether we deactivated from thinking (sand-only) — strings should not retract
  const deactivatedFromThinkingRef = useRef(false);
  // Delayed deactivation: keep strings active while the audio fades out,
  // then cut input and begin the retract sequence. Activation is instant.
  const [isActive, setIsActive] = useState(stateIsActive);
  // Mirror isActive into a ref so the draw loop reads the latest value
  // without requiring isActive in the animation effect's dependency array.
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  // Track when state left working for gradual FFT drive fade
  const fadingRef = useRef(false);
  const fadeStartRef = useRef<number>(0);
  const FADE_DURATION = 0.5; // seconds to fade FFT drive to zero
  useEffect(() => {
    if (stateIsActive) {
      setIsActive(true);
      fadingRef.current = false;
      deactivatedFromThinkingRef.current = false;
      return;
    }
    // Working → error/waiting: keep strings deployed, just fade the drive
    if (stringsStayDeployed) {
      fadingRef.current = true;
      fadeStartRef.current = performance.now();
      const timer = setTimeout(() => {
        fadingRef.current = false;
      }, FADE_DURATION * 1000);
      return () => clearTimeout(timer);
    }
    // "Deactivated from thinking" means the strings were never actually
    // deployed — skip the retract animation and just snap to zero. The
    // previous check (`state === "idle"`) was too broad: a working→idle
    // transition also passes it, which instant-snapped visible strings
    // instead of retracting them. Base the decision on whether any clip
    // fraction is up, with sand coverage as a separate short-circuit.
    const anyBandDeployed =
      clipFractionsRef.current[0] > 0.05 ||
      clipFractionsRef.current[1] > 0.05 ||
      clipFractionsRef.current[2] > 0.05;
    deactivatedFromThinkingRef.current = !anyBandDeployed || sandBlendRef.current > 0.5;
    // State left working/subagent — begin fade, then deactivate after fade completes
    fadingRef.current = true;
    fadeStartRef.current = performance.now();
    const timer = setTimeout(() => {
      setIsActive(false);
      fadingRef.current = false;
    }, FADE_DURATION * 1000);
    return () => clearTimeout(timer);
  }, [stateIsActive, stringsStayDeployed]);

  const isAudio = signalMode === "preset" || signalMode === "audio";
  // Track when session became inactive for decay timing
  const deactivatedAtRef = useRef<number | null>(null);
  // Driven oscillator state: position + velocity per mode per band (max 3 bands × 6 modes)
  const modeStateRef = useRef<{ pos: Float64Array; vel: Float64Array } | null>(null);
  const lastFrameRef = useRef<number>(0);
  // Cached canvas bounding rect — updated by ResizeObserver, not every frame
  const rectCacheRef = useRef<DOMRect | null>(null);
  // Onset impulse accumulators per band (decays each frame)
  const onsetRef = useRef<Float64Array>(new Float64Array(3));
  // Sand grains: blown across the card, driven by audio energy
  const sandGrainsRef = useRef<{ x: number; y: number; vx: number; vy: number; size: number; band: number; birth: number; life: number }[]>([]);
  // Tracks when the session went inactive — drives wind ramp-down and gravity transition
  const sandDeactivatedAtRef = useRef<number | null>(null);
  // Deploy priority for progressive working strings.
  // Index 0 is the FIRST band that deploys (mids = visually central). As
  // `baseBandsTarget` grows 1→3 we enable one more band in this order.
  //   priority[0] = mids  (central, where a single string belongs)
  //   priority[1] = bass  (above center)
  //   priority[2] = treble (below center)
  const BAND_PRIORITY = [1, 0, 2] as const;
  const bandEnabled = (bandIdx: number, target: number) =>
    BAND_PRIORITY.indexOf(bandIdx as 0 | 1 | 2) < target;
  const baseBandsTargetRef = useRef(baseBandsTarget);
  baseBandsTargetRef.current = baseBandsTarget;

  // Vacuum cord retract/deploy per band: 0 = fully retracted (left), 1 = fully deployed (right)
  // [bass, mids, treble] — each travels at a slightly different rate. Always
  // start at zero so mounting into an already-active turn still plays the
  // deploy animation — the isActive useEffect below runs on mount and schedules
  // the staggered deploy for whichever bands baseBandsTarget currently enables.
  const clipFractionsRef = useRef(new Float64Array(3));
  const clipVelsRef = useRef(new Float64Array(3));
  // Per-band ready flags and timers — staggered: band 0 first, band 1 after 400ms, band 2 after 520ms
  const bandStaggerMs = [0, 400, 520];
  const retractTimersRef = useRef<(number | null)[]>([null, null, null]);
  const retractReadyRef = useRef<boolean[]>([true, true, true]);
  const deployTimersRef = useRef<(number | null)[]>([null, null, null]);
  const deployReadyRef = useRef<boolean[]>([false, false, false]);

  // Store tuning props in a ref so the draw loop reads them live
  // without tearing down the animation pipeline on every slider change
  const configRef = useRef({
    signalAlpha, signalAmplitude, signalEcho, frequency,
    signalBass, signalMids, signalTreble,
    signalColorDark, signalColorLight, signalOffset,
    signalEffect, sandEnabled, sandIntensity, sandDirection, sandDensity, sandSpeed, sandGrainSize, sandTurbulence, sandAlpha,
    cordRetractDelay, cordDeployForce, cordRetractForce, stringSpread, stringDeployAngle, signalMode,
  });
  configRef.current = {
    signalAlpha, signalAmplitude, signalEcho, frequency,
    signalBass, signalMids, signalTreble,
    signalColorDark, signalColorLight, signalOffset,
    signalEffect, sandEnabled, sandIntensity, sandDirection, sandDensity, sandSpeed, sandGrainSize, sandTurbulence, sandAlpha,
    cordRetractDelay, cordDeployForce, cordRetractForce, stringSpread, stringDeployAngle, signalMode,
  };

  // Latest onStringsConnected callback — stashed in a ref so the draw loop
  // calls the current function even though the animation effect doesn't
  // re-create on callback identity changes.
  const onStringsConnectedRef = useRef(onStringsConnected);
  onStringsConnectedRef.current = onStringsConnected;
  // One-shot latch: prevents the callback from firing every frame once all
  // three bands have landed. Reset on each thinking→working redeploy so the
  // next cycle can fire again.
  const stringsConnectedFiredRef = useRef(false);

  // Reverse handoff (working/subagent → thinking): while true, strings retract
  // visibly while state === "thinking", and their leading edges continue to
  // publish flux disturbances so the retract pushes the growing needles the
  // same way the forward deploy does. Cleared once all three bands reach 0 or
  // when state leaves thinking.
  const reverseRetractingRef = useRef(false);

  // ─── Extra bands (subagents) ────────────────────────────────────────────
  // One entry per live subagent id. Kept around after removal while the
  // retract animation plays out; dropped when clipFraction hits 0.
  type ExtraBandState = {
    spec: ExtraBandSpec;
    clipFraction: number;
    clipVel: number;
    modePos: Float64Array;   // length 6 (matches max band.numModes)
    modeVel: Float64Array;
    deployReady: boolean;
    retractReady: boolean;
    deployTimer: number | null;
    retractTimer: number | null;
    whip: { active: boolean; t0: number; amp: number; dir: number };
    insertionIdx: number;
    removing: boolean;
  };
  const extraBandsStateRef = useRef<Map<string, ExtraBandState>>(new Map());
  const extraInsertionCounterRef = useRef(0);
  // Base-band suppression latch: once tripped, the 3 base strings retract and
  // stay hidden until the consumer clears suppressBaseBands.
  const baseSuppressedRef = useRef(suppressBaseBands);
  // Track whether base bands were force-retracted due to suppression — so we
  // can redeploy them when suppression releases while state is still active.
  const baseSuppressRetractedRef = useRef(false);

  // Whip pulses — triggered when each band starts retracting
  // Each pulse: a Gaussian kink at the cord tip that travels left and decays
  const whipPulsesRef = useRef([
    { active: false, t0: 0, amp: 0, dir: 1 },
    { active: false, t0: 0, amp: 0, dir: -1 },
    { active: false, t0: 0, amp: 0, dir: 1 },
  ]);

  useEffect(() => {
    const clearAllTimers = () => {
      for (let i = 0; i < 3; i++) {
        if (retractTimersRef.current[i] !== null) {
          clearTimeout(retractTimersRef.current[i]!);
          retractTimersRef.current[i] = null;
        }
        if (deployTimersRef.current[i] !== null) {
          clearTimeout(deployTimersRef.current[i]!);
          deployTimersRef.current[i] = null;
        }
      }
    };

    if (isActive) {
      deactivatedAtRef.current = null;
      // Cancel any pending retract
      retractReadyRef.current = [false, false, false];
      clearAllTimers();
      // Staggered deploy: only for bands the parent currently wants (per
      // baseBandsTarget). Disabled bands stay at clipFraction=0 and will be
      // deployed later by the progressive-deploy effect if the target grows.
      deployReadyRef.current = [false, false, false];
      const bandNudge = [0.35, 0.15, 0.15]; // first band gets a stronger initial push
      for (let i = 0; i < 3; i++) {
        if (!bandEnabled(i, baseBandsTargetRef.current)) continue;
        const delay = 850 + bandStaggerMs[i];
        deployTimersRef.current[i] = window.setTimeout(() => {
          deployReadyRef.current[i] = true;
          // Initial nudge — first band gets a stronger push to come out faster.
          // Read force from configRef so slider changes mid-deploy apply.
          clipVelsRef.current[i] = Math.max(
            clipVelsRef.current[i],
            bandNudge[i] * configRef.current.cordDeployForce,
          );
          deployTimersRef.current[i] = null;
        }, delay);
      }
    } else {
      // Cancel any pending deploy
      deployReadyRef.current = [false, false, false];
      clearAllTimers();
      if (deactivatedFromThinkingRef.current) {
        // Deactivated from thinking — strings were never deployed, keep them retracted
        clipFractionsRef.current.fill(0);
        clipVelsRef.current.fill(0);
        retractReadyRef.current = [false, false, false];
      } else {
        // Staggered retract: band 0 first, band 1 after 500ms, band 2 after 600ms
        retractReadyRef.current = [false, false, false];
        const whipAmps = [2.2, 1.6, 1.1];
        for (let i = 0; i < 3; i++) {
          const delay = cordRetractDelay * 1000 + bandStaggerMs[i];
          retractTimersRef.current[i] = window.setTimeout(() => {
            retractReadyRef.current[i] = true;
            retractTimersRef.current[i] = null;
            // Fire whip pulse at the cord tip
            whipPulsesRef.current[i] = { active: true, t0: performance.now(), amp: whipAmps[i], dir: i % 2 === 0 ? 1 : -1 };
          }, delay);
        }
      }
    }
    return clearAllTimers;
  }, [isActive, cordRetractDelay, cordDeployForce]);

  // Clear this card's flux disturbances on unmount so the registry doesn't
  // accumulate entries for destroyed sessions.
  useEffect(() => {
    return () => {
      if (sessionId) clearDisturbances(sessionId);
    };
  }, [sessionId]);

  // Thinking → working (or subagent) is the transition we want to make smooth:
  // during thinking the strings were hidden (flux overlay covered the card),
  // so clipFractions stayed at [1,1,1]. Without this reset they'd pop into
  // view fully-deployed the instant state flips, which reads as jumpy.
  //
  // The reset retracts strings to 0 and redeploys them from the left edge
  // after a short anticipation. That sweep is what lets the leading edges
  // physically "push" flux lines aside (see fluxDisturbance registry writes
  // in the draw loop below). Flux fades out a bit later, after the sweep is
  // largely complete — see SessionCard's fluxActive linger.
  const prevStateRef = useRef(state);
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = state;

    if (prev === "thinking" && (state === "working" || state === "subagent")) {
      // Skip the reset-and-redeploy only if the CURRENTLY-enabled bands are
      // already deployed AND the disabled bands are already retracted. This
      // matters across turn boundaries: the previous turn may have left all
      // three bands deployed, but the new turn starts with baseBandsTarget=1
      // — without force-retracting the now-disabled bands, users see a stale
      // "instant 3 lines" the moment the next turn enters working.
      const t = baseBandsTargetRef.current;
      let matchesTarget = true;
      for (let i = 0; i < 3; i++) {
        const enabled = bandEnabled(i, t);
        const frac = clipFractionsRef.current[i];
        if (enabled ? frac < 0.9 : frac > 0.05) { matchesTarget = false; break; }
      }
      if (matchesTarget) {
        reverseRetractingRef.current = false;
        return;
      }
      // Fall through to the reset + gated re-deploy below. `fill(0)` zeros
      // every band's clip fraction; the deploy loop only re-deploys the ones
      // enabled by the current baseBandsTarget, so disabled bands are
      // automatically retracted.
      reverseRetractingRef.current = false;
      clipFractionsRef.current.fill(0);
      clipVelsRef.current.fill(0);
      retractReadyRef.current = [false, false, false];
      deployReadyRef.current = [false, false, false];
      // Arm the latch so onStringsConnected fires after this redeploy lands.
      stringsConnectedFiredRef.current = false;
      for (let i = 0; i < 3; i++) {
        if (deployTimersRef.current[i] !== null) {
          clearTimeout(deployTimersRef.current[i]!);
          deployTimersRef.current[i] = null;
        }
        if (retractTimersRef.current[i] !== null) {
          clearTimeout(retractTimersRef.current[i]!);
          retractTimersRef.current[i] = null;
        }
      }
      const bandNudge = [0.35, 0.15, 0.15];
      for (let i = 0; i < 3; i++) {
        // Respect progressive deploy: only kick off bands the parent currently
        // wants (baseBandsTarget). The remainder stay at clipFraction=0 until
        // the target grows and the baseBandsTarget effect below deploys them.
        if (!bandEnabled(i, baseBandsTargetRef.current)) continue;
        // 150 ms anticipation is enough to register the "pullback" without
        // feeling slow. Bass leads slightly so the ear-ish ordering matches
        // the existing bandStaggerMs spread.
        const delay = 150 + bandStaggerMs[i];
        deployTimersRef.current[i] = window.setTimeout(() => {
          deployReadyRef.current[i] = true;
          clipVelsRef.current[i] = Math.max(clipVelsRef.current[i], bandNudge[i] * cordDeployForce);
          deployTimersRef.current[i] = null;
        }, delay);
      }
    }

    // Reverse retract (working/subagent → thinking) removed: strings now stay
    // deployed through the entire turn, including working↔thinking cycles.
    // They only retract on turn end — any active state → idle/done/compacting/
    // clearing/ended. That retract runs via `stateIsActive` flipping false in
    // the deactivation effect above.
  }, [state, cordDeployForce]);

  // ─── Progressive base-band deploy ──────────────────────────────────────
  // Keep the base bands in sync with the parent's baseBandsTarget.
  //   • Enabled-but-not-yet-deployed bands get a staggered deploy scheduled.
  //   • Disabled bands that are still hanging on (from a previous turn that
  //     ended before they could fully retract) are snapped back to zero —
  //     without this, a fresh turn that starts with baseBandsTarget=1 would
  //     render all three bands that the prior turn left deployed.
  useEffect(() => {
    if (!stateIsActive) return;
    const target = baseBandsTarget;
    const bandNudge = [0.35, 0.15, 0.15];
    for (let i = 0; i < 3; i++) {
      const enabled = bandEnabled(i, target);
      if (enabled) {
        // Cancel any lingering retract from a prior turn — we want to keep
        // (or bring back) this band, not pull it down.
        if (retractTimersRef.current[i] !== null) {
          clearTimeout(retractTimersRef.current[i]!);
          retractTimersRef.current[i] = null;
        }
        retractReadyRef.current[i] = false;
        if (clipFractionsRef.current[i] > 0.02 || deployReadyRef.current[i]) continue;
        if (deployTimersRef.current[i] !== null) continue;
        const delay = 150 + bandStaggerMs[i];
        stringsConnectedFiredRef.current = false;
        deployTimersRef.current[i] = window.setTimeout(() => {
          deployReadyRef.current[i] = true;
          clipVelsRef.current[i] = Math.max(clipVelsRef.current[i], bandNudge[i] * cordDeployForce);
          deployTimersRef.current[i] = null;
        }, delay);
      } else {
        // Disabled — cancel any pending deploy/retract and snap to 0.
        if (deployTimersRef.current[i] !== null) {
          clearTimeout(deployTimersRef.current[i]!);
          deployTimersRef.current[i] = null;
        }
        if (retractTimersRef.current[i] !== null) {
          clearTimeout(retractTimersRef.current[i]!);
          retractTimersRef.current[i] = null;
        }
        deployReadyRef.current[i] = false;
        retractReadyRef.current[i] = false;
        if (clipFractionsRef.current[i] > 0.001 || clipVelsRef.current[i] !== 0) {
          clipFractionsRef.current[i] = 0;
          clipVelsRef.current[i] = 0;
        }
      }
    }
  }, [baseBandsTarget, stateIsActive, cordDeployForce]);

  // ─── Extra-bands lifecycle ──────────────────────────────────────────────
  // Diff the caller's extraBands list against our live map each render. New
  // ids get init state + staggered deploy. Ids no longer present are marked
  // `removing` and scheduled to retract. Retract stagger is LIFO by insertion
  // index (newest first), with the same 0/400/520/640…ms spacing as the
  // base-band stagger so a wholesale state exit feels like the main strings.
  useEffect(() => {
    const map = extraBandsStateRef.current;
    const incoming = extraBands ?? [];
    const incomingIds = new Set(incoming.map(b => b.id));

    // Added or updated ids
    incoming.forEach((spec, orderIdx) => {
      const existing = map.get(spec.id);
      if (existing) {
        // Refresh cached spec (colour / axis may jitter across renders; we
        // keep a single authoritative copy rather than re-reading on hot
        // paths). Don't touch physics state.
        existing.spec = spec;
        // If it was previously marked for removal but came back, revive it.
        if (existing.removing) {
          existing.removing = false;
          existing.retractReady = false;
          if (existing.retractTimer !== null) {
            window.clearTimeout(existing.retractTimer);
            existing.retractTimer = null;
          }
          // Re-schedule a gentle deploy pulse so a reappearing band doesn't
          // snap back instantly.
          if (!existing.deployReady) {
            existing.deployTimer = window.setTimeout(() => {
              existing.deployReady = true;
              existing.clipVel = Math.max(existing.clipVel, 0.25 * cordDeployForce);
              existing.deployTimer = null;
            }, 60);
          }
        }
        return;
      }
      // Fresh entry. Stagger small deploy delay by insertion order so rapid
      // multi-add reads as a cascade rather than a single pop.
      const insertionIdx = extraInsertionCounterRef.current++;
      const stBand: ExtraBandState = {
        spec,
        clipFraction: 0,
        clipVel: 0,
        modePos: new Float64Array(6),
        modeVel: new Float64Array(6),
        deployReady: false,
        retractReady: false,
        deployTimer: null,
        retractTimer: null,
        whip: { active: false, t0: 0, amp: 0, dir: 1 },
        insertionIdx,
        removing: false,
      };
      const delay = 120 + orderIdx * 140;
      stBand.deployTimer = window.setTimeout(() => {
        stBand.deployReady = true;
        stBand.clipVel = Math.max(stBand.clipVel, 0.30 * cordDeployForce);
        stBand.deployTimer = null;
      }, delay);
      map.set(spec.id, stBand);
    });

    // Removed ids — gather then stagger LIFO.
    const removing: ExtraBandState[] = [];
    map.forEach((st, id) => {
      if (!incomingIds.has(id) && !st.removing) {
        st.removing = true;
        removing.push(st);
      }
    });
    // Newest (highest insertionIdx) first.
    removing.sort((a, b) => b.insertionIdx - a.insertionIdx);
    const retractStagger = [0, 400, 520, 640, 760, 880, 1000];
    const whipAmps = [2.2, 1.6, 1.1, 0.9, 0.75, 0.6];
    removing.forEach((st, rIdx) => {
      if (st.retractTimer !== null) window.clearTimeout(st.retractTimer);
      if (st.deployTimer !== null) {
        window.clearTimeout(st.deployTimer);
        st.deployTimer = null;
      }
      st.deployReady = false;
      const delay = retractStagger[Math.min(rIdx, retractStagger.length - 1)] + rIdx * 120 / Math.max(1, retractStagger.length);
      const amp = whipAmps[Math.min(rIdx, whipAmps.length - 1)];
      st.retractTimer = window.setTimeout(() => {
        st.retractReady = true;
        st.retractTimer = null;
        st.whip = { active: true, t0: performance.now(), amp, dir: rIdx % 2 === 0 ? 1 : -1 };
      }, delay);
    });
  }, [extraBands, cordDeployForce]);

  // Flush extra-band timers on unmount so nothing fires after disposal.
  useEffect(() => {
    return () => {
      const map = extraBandsStateRef.current;
      map.forEach(st => {
        if (st.deployTimer !== null) window.clearTimeout(st.deployTimer);
        if (st.retractTimer !== null) window.clearTimeout(st.retractTimer);
      });
      map.clear();
    };
  }, []);

  // ─── Base-band suppression latch ─────────────────────────────────────────
  // When suppressBaseBands flips true while strings are deployed, we treat
  // them as if the session went inactive for the purpose of retract physics:
  // retractReady goes true (staggered) so they pull back like a normal exit.
  // When suppression releases and the state is still active, redeploy.
  useEffect(() => {
    baseSuppressedRef.current = suppressBaseBands;
    if (suppressBaseBands) {
      // Schedule staggered retract for base bands — mirror the isActive=false
      // path timing so the motion reads as familiar.
      deployReadyRef.current = [false, false, false];
      for (let i = 0; i < 3; i++) {
        if (deployTimersRef.current[i] !== null) {
          window.clearTimeout(deployTimersRef.current[i]!);
          deployTimersRef.current[i] = null;
        }
        if (retractTimersRef.current[i] !== null) {
          window.clearTimeout(retractTimersRef.current[i]!);
          retractTimersRef.current[i] = null;
        }
      }
      retractReadyRef.current = [false, false, false];
      const whipAmps = [2.2, 1.6, 1.1];
      for (let i = 0; i < 3; i++) {
        const delay = 100 + bandStaggerMs[i];
        retractTimersRef.current[i] = window.setTimeout(() => {
          retractReadyRef.current[i] = true;
          retractTimersRef.current[i] = null;
          whipPulsesRef.current[i] = { active: true, t0: performance.now(), amp: whipAmps[i], dir: i % 2 === 0 ? 1 : -1 };
        }, delay);
      }
      baseSuppressRetractedRef.current = true;
    } else if (baseSuppressRetractedRef.current) {
      // Suppression released — if the session is still in an active state,
      // redeploy the base bands from zero. Otherwise let the regular isActive
      // flow take over.
      if (stateRef.current === "working" || stateRef.current === "subagent") {
        clipFractionsRef.current.fill(0);
        clipVelsRef.current.fill(0);
        retractReadyRef.current = [false, false, false];
        deployReadyRef.current = [false, false, false];
        for (let i = 0; i < 3; i++) {
          if (deployTimersRef.current[i] !== null) {
            window.clearTimeout(deployTimersRef.current[i]!);
            deployTimersRef.current[i] = null;
          }
        }
        const bandNudge = [0.35, 0.15, 0.15];
        for (let i = 0; i < 3; i++) {
          const delay = 150 + bandStaggerMs[i];
          deployTimersRef.current[i] = window.setTimeout(() => {
            deployReadyRef.current[i] = true;
            clipVelsRef.current[i] = Math.max(clipVelsRef.current[i], bandNudge[i] * cordDeployForce);
            deployTimersRef.current[i] = null;
          }, delay);
        }
      }
      baseSuppressRetractedRef.current = false;
    }
  }, [suppressBaseBands, cordDeployForce]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Pause all rendering when page is hidden OR the canvas isn't on screen.
    if (!renderActive) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      rectCacheRef.current = rect;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    // Cached erase-rect geometry. Previously rebuilt every frame by calling
    // getBoundingClientRect on every content row + child — an N-read forced
    // layout per card per frame. Now invalidated by a ResizeObserver on the
    // content wrapper (catches layout-box changes at the moment they happen)
    // and a slow polling fallback for sub-pixel reflows the observer misses.
    let cachedEraseRects: { x: number; y: number; w: number; h: number }[] = [];
    let eraseRectsDirty = true;
    let eraseRectsNextRebuildAt = 0;
    const ERASE_RECTS_REBUILD_MS = 500;
    let contentObserver: ResizeObserver | null = null;
    let contentMutationObserver: MutationObserver | null = null;
    if (contentRef?.current && typeof ResizeObserver !== "undefined") {
      contentObserver = new ResizeObserver(() => {
        eraseRectsDirty = true;
      });
      contentObserver.observe(contentRef.current);
      // Also observe direct children so we catch row-level reflows (e.g. a
      // toolpill row widening when a tool starts) without relying on the
      // polling fallback.
      for (const child of Array.from(contentRef.current.children)) {
        contentObserver.observe(child);
      }
      // Catch rows that mount AFTER this effect set up — a state transition
      // (thinking → working) inserts new content rows the original snapshot
      // didn't see, and without this the polling fallback would be the only
      // path to refresh the erase mask.
      if (typeof MutationObserver !== "undefined") {
        contentMutationObserver = new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const node of Array.from(m.addedNodes)) {
              if (node instanceof Element) {
                contentObserver?.observe(node);
              }
            }
          }
          eraseRectsDirty = true;
        });
        contentMutationObserver.observe(contentRef.current, { childList: true });
      }
    }

    const draw = (now: number) => {
      // Self-terminate when the visibility gate has flipped to false. The
      // useEffect cleanup also cancels animRef, but a frame already queued
      // before the cleanup runs would otherwise execute one final pass on a
      // hidden/off-screen canvas. Bail before any work and skip rescheduling.
      if (!renderActiveRef.current) {
        animRef.current = 0;
        return;
      }
      const cfg = configRef.current;
      const { signalAlpha, signalAmplitude, signalEcho, frequency,
        signalBass, signalMids, signalTreble,
        signalColorDark, signalColorLight, signalOffset,
        signalEffect: _cfgEffect, sandEnabled: _cfgSandEnabled, sandIntensity: cfgSandIntensity,
        sandDirection: cfgSandDirection, sandDensity: cfgSandDensity, sandSpeed: cfgSandSpeed,
        sandGrainSize: cfgSandGrainSize, sandTurbulence: cfgSandTurbulence, sandAlpha: cfgSandAlpha,
        stringSpread: cfgStringSpread } = cfg;
      // Smooth crossfade between string and sand effects. Sand is now the
      // idle-state effect (was thinking-state previously). Hold sand at 0
      // while any base band is still extended so the retract animation plays
      // visibly — otherwise sand ramps to ~0.99 during the 500ms fade +
      // cordRetractDelay window and masks the strings completely before they
      // get a chance to pull back.
      const anyBaseBandUp =
        clipFractionsRef.current[0] > 0.01 ||
        clipFractionsRef.current[1] > 0.01 ||
        clipFractionsRef.current[2] > 0.01;
      const sandTarget =
        stateRef.current === "idle" && !anyBaseBandUp ? 1.0 : 0.0;
      if (isActiveRef.current && stateRef.current !== "idle") {
        // An active state that isn't idle — snap sand off immediately.
        sandBlendRef.current = 0;
        sandGrainsRef.current.length = 0;
      } else {
        sandBlendRef.current += (sandTarget - sandBlendRef.current) * 0.045;
        if (Math.abs(sandBlendRef.current - sandTarget) < 0.003) sandBlendRef.current = sandTarget;
      }
      const sandBlend = sandBlendRef.current;
      // Draw strings whenever they're deployed and sand isn't covering them.
      // Strings stay visible through working↔thinking so the card retains a
      // sense of continuity during re-thinking; flux coexists above.
      const drawStrings =
        sandBlend < 0.99 &&
        !deactivatedFromThinkingRef.current &&
        // While suppressed, base bands shouldn't draw — but only fully gate
        // off once they've fully retracted, otherwise they'd pop out of view
        // mid-retract.
        (!baseSuppressedRef.current || clipFractionsRef.current[0] > 0.005 || clipFractionsRef.current[1] > 0.005 || clipFractionsRef.current[2] > 0.005);
      const drawSand = sandBlend > 0.01 || sandGrainsRef.current.length > 0;
      const isGlass = document.documentElement.hasAttribute("data-glass");
      const isDark = isGlass || document.documentElement.getAttribute("data-theme") !== "light";
      const defaultColor = isDark ? hexToRgb(signalColorDark) : hexToRgb(signalColorLight);
      const a = signalAlpha;

      // Skip all computation when nothing to draw
      if (a <= 0 && !drawSand) {
        animRef.current = requestAnimationFrame(draw);
        return;
      }

      // State-aware target color. A base/subagent string is constrained to
      // exactly four colours:
      //   error    → red
      //   waiting  → yellow
      //   subagent → blue (matches the subagent badge & the diagonal extras)
      //   anything else → configured default (white)
      // Idle and thinking get no special colour — they fall through to the
      // default, so transitioning into idle/thinking from working stays white,
      // and transitioning into idle from waiting/error/subagent visibly lerps
      // back to white. Priority: error > waiting > subagent > default.
      const targetColor = state === "error"
        ? (isDark ? { r: 239, g: 68, b: 68 } : { r: 185, g: 28, b: 28 })     // red
        : state === "waiting"
        ? (isDark ? { r: 234, g: 179, b: 8 } : { r: 161, g: 98, b: 7 })       // yellow
        : state === "subagent"
        ? (isDark ? { r: 124, g: 197, b: 255 } : { r: 42, g: 139, b: 217 })   // blue (#7CC5FF / #2A8BD9)
        : defaultColor;

      // Initialize on first frame
      if (!currentColorRef.current) {
        currentColorRef.current = { ...targetColor };
      }
      // Smooth lerp toward target color (~8 frames to converge)
      const cc = currentColorRef.current;
      const lerpSpeed = 0.12;
      cc.r += (targetColor.r - cc.r) * lerpSpeed;
      cc.g += (targetColor.g - cc.g) * lerpSpeed;
      cc.b += (targetColor.b - cc.b) * lerpSpeed;

      const sc = cc;
      // Pre-compute rounded integers once per frame — reused in all inner loops
      const scR = Math.round(sc.r);
      const scG = Math.round(sc.g);
      const scB = Math.round(sc.b);
      const strokeColor = revived
        ? `rgba(239, 68, 68, ${0.4 * a})`
        : `rgba(${scR}, ${scG}, ${scB}, ${0.4 * a})`;

      const rect = rectCacheRef.current ?? canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const midY = h / 2;
      const halfH = h / 2 - 1;

      ctx.clearRect(0, 0, w, h);

      // Tool-call comets — rendered FIRST so strings and sand paint on top of
      // them. Reads as background tracers sliding underneath the waveform.
      if (comets?.current) renderComets(ctx, comets.current, now, w, h);

      // Reduced motion — flat line, no animation
      if (prefersReducedMotion) {
        return;
      }

      // ── Vacuum cord deploy/retract animation (per-band) ──
      // Skip for revived mode (lightning bolts don't retract)
      // Each of the 3 strings (bass/mids/treble) travels at a slightly different rate
      // bandForceMult: bass=slowest, treble=fastest (staggered arrival)
      const bandForceMult = [0.85, 0.75, 0.70];
      if (!revived) {
        const { cordDeployForce: deployF, cordRetractForce: retractF } = cfg;
        const clipDt = 1 / 60; // approximate frame dt
        const fracs = clipFractionsRef.current;
        const vels = clipVelsRef.current;

        const baseEffectivelyActive = isActiveRef.current && !baseSuppressedRef.current;
        for (let i = 0; i < 3; i++) {
          const clip = fracs[i];
          const fm = bandForceMult[i];

          if (baseEffectivelyActive && deployReadyRef.current[i]) {
            // Deploy: magnetic acceleration — very slow buildup, explosive finish
            // Cubic ramp: near-zero force at start, steep ramp past ~60%
            const pullStrength = (0.4 + clip * clip * clip * 8) * deployF * fm;
            vels[i] += pullStrength * clipDt;
          } else if (retractReadyRef.current[i]) {
            // Retract: accelerating pull toward left (vacuum cord feel)
            const pullStrength = (1.5 + (1 - clip) * 6) * retractF * fm;
            vels[i] -= pullStrength * clipDt;
          }

          fracs[i] = Math.max(0, Math.min(1, clip + vels[i] * clipDt));
          if (fracs[i] <= 0) { fracs[i] = 0; vels[i] = 0; }
          if (fracs[i] >= 1) vels[i] = Math.max(0, vels[i] * 0.9);
        }

        // ── Strings-connected latch ─────────────────────────────────────
        // When all three bands land (≥0.98) during a working/subagent state,
        // fire the parent callback exactly once so it can commit the visual
        // working-state swap 200ms later. Re-armed on each thinking→working
        // redeploy (see useEffect above).
        if (
          !stringsConnectedFiredRef.current &&
          (stateRef.current === "working" || stateRef.current === "subagent")
        ) {
          // Only require the currently-enabled subset of base bands to have
          // landed. At baseBandsTarget=1 just band 1 (mids) needs to be up.
          const t = baseBandsTargetRef.current;
          let allLanded = true;
          for (let i = 0; i < 3; i++) {
            if (!bandEnabled(i, t)) continue;
            if (fracs[i] < 0.98) { allLanded = false; break; }
          }
          if (allLanded) {
            stringsConnectedFiredRef.current = true;
            onStringsConnectedRef.current?.();
          }
        }

        // ── Publish disturbances for the Flux field ─────────────────────
        // While strings are actively sweeping across the card (clipFraction
        // in the open interval), emit one disturbance per band at the
        // leading edge. FluxEffect reads these by session id and pushes
        // nearby line targets radially outward — so strings physically
        // displace the flux as they arrive, instead of popping on top of it.
        //
        // Skip while state === "thinking" — strings are deployed but we don't
        // want them pushing flux needles around; flux should flow freely
        // during pure thinking. Disturbances only fire during the deploy sweep
        // (thinking → working) so the sweep visibly pushes flux aside.
        const publishDisturbances =
          sessionId && stateRef.current !== "thinking";
        if (publishDisturbances) {
          const list: FluxDisturbance[] = [];
          // Three bands stacked vertically; exact y doesn't matter much
          // given the generous push radius, just needs to cover the card.
          const bandYs = [midY - h * 0.25, midY, midY + h * 0.25];
          for (let i = 0; i < 3; i++) {
            const f = fracs[i];
            // Parabolic sweep strength: 0 at ends, 1 at midpoint. Keeps the
            // displacement from popping on entry or lingering after settle.
            const sweep = 4 * f * (1 - f);
            if (sweep > 0.02) {
              list.push({
                x: f * w,
                y: bandYs[i],
                radius: 64,
                force: 36,
                strength: sweep,
              });
            }
          }
          if (list.length > 0) {
            setDisturbances(sessionId, list);
          } else {
            clearDisturbances(sessionId);
          }
        } else if (sessionId && stateRef.current === "thinking") {
          // During thinking, keep the disturbance registry clean so lingering
          // entries from the prior state don't keep pushing flux lines around.
          clearDisturbances(sessionId);
        }

        // Fully retracted — nothing to draw, just keep the loop alive
        // Don't exit early while grains are still falling or blending
        const maxClip = Math.max(fracs[0], fracs[1], fracs[2]);
        // Keep the loop alive during idle even with no grains yet, so sand
        // can spawn on entry. Otherwise a freshly-idle card with 0 grains
        // would early-exit and never fire the spawn path below.
        if (
          maxClip < 0.001 &&
          !isActiveRef.current &&
          sandGrainsRef.current.length === 0 &&
          stateRef.current !== "idle"
        ) {
          animRef.current = requestAnimationFrame(draw);
          return;
        }

        // Apply global clip at the widest band — only for string rendering
        if (drawStrings) {
          const clipX = maxClip * w;
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, clipX, h);
          ctx.clip();
        }
      }

      // clipped tracks whether ctx.save() was called (for ctx.restore() at end)
      let clipped = !revived && drawStrings;

      // ── Revived mode: randomized lightning strikes ──
      if (revived && !prefersReducedMotion) {
        const t = now / 1000;
        const a = signalAlpha;
        const hash = (v: number) => ((v * 2654435761) >>> 0);
        const hashF = (v: number) => (hash(v) >>> 0) / 0xFFFFFFFF; // 0..1

        // Variable cycle duration: 3–6s, derived from cycle index
        // We iterate to find current cycle since durations vary
        let elapsed = 0;
        let cycle = 0;
        while (true) {
          const dur = 3.0 + hashF(cycle * 31337) * 3.0;
          if (elapsed + dur > t) {
            // We're in this cycle
            const phase = (t - elapsed) / dur;
            const cycleSeed = hash(cycle * 2654435761);

            // Per-cycle randomization
            const goRight = (cycleSeed & 1) === 0;  // bolt direction
            const mainYOff = (hashF(cycleSeed + 999) - 0.5) * halfH * 0.4; // vertical wander
            const jitterScale = 0.7 + hashF(cycleSeed + 777) * 0.6; // zigzag intensity 0.7–1.3
            const numBranches = 2 + (cycleSeed >> 4 & 3); // 2–5 branches
            const crawlSpeed = 0.4 + hashF(cycleSeed + 555) * 0.2; // crawl takes 40–60% of cycle

            const crawlEnd = crawlSpeed;
            const holdEnd = crawlEnd + 0.2;

            let tipProgress: number;
            let brightness: number;

            if (phase < crawlEnd) {
              tipProgress = phase / crawlEnd;
              // Stutter: occasional micro-pauses during crawl
              const stutterSeed = hashF(cycleSeed + Math.floor(phase * 8) * 1009);
              if (stutterSeed > 0.7) tipProgress *= 0.92 + stutterSeed * 0.08;
              brightness = 0.7 + hashF(cycleSeed + 111) * 0.2;
            } else if (phase < holdEnd) {
              tipProgress = 1.0;
              const holdPhase = (phase - crawlEnd) / (holdEnd - crawlEnd);
              brightness = 0.8 + 0.3 * Math.exp(-holdPhase * 3);
            } else {
              tipProgress = 1.0;
              const fadePhase = (phase - holdEnd) / (1.0 - holdEnd);
              brightness = 0.8 * (1.0 - fadePhase);
            }

            // Flicker: random brightness wobble
            const flicker = 1.0 + (hashF(cycleSeed + Math.floor(now / 50)) - 0.5) * 0.15;
            brightness *= flicker;

            const tipX = goRight ? tipProgress * w : (1 - tipProgress) * w;

            const drawBolt = (yBase: number, seedOff: number, opacity: number, lineWidth: number, isBranch: boolean) => {
              const steps = isBranch ? 6 + (hash(seedOff) & 7) : 16 + (hash(seedOff + 3) & 7);
              const segLen = w / steps;

              ctx.beginPath();
              let bx = goRight ? 0 : w;
              let by = yBase;
              ctx.moveTo(bx, by);

              for (let i = 0; i < steps; i++) {
                const s = hash(cycleSeed + seedOff + i * 7919);
                const zigDir = (i % 2 === 0) ? 1 : -1;
                const jY = zigDir * ((s & 0xFFFF) / 0xFFFF) * halfH * jitterScale * (isBranch ? 0.5 : 1.0);
                const jX = ((s >> 16) & 0xFF) / 255 * segLen * 0.3;
                bx += (goRight ? 1 : -1) * (segLen + jX);
                by = yBase + jY;

                const pastTip = goRight ? bx > tipX : bx < tipX;
                if (pastTip) {
                  const prevBx = bx - (goRight ? 1 : -1) * (segLen + jX);
                  const frac = Math.abs(tipX - prevBx) / Math.abs(bx - prevBx);
                  ctx.lineTo(prevBx + frac * (bx - prevBx), yBase + frac * jY);
                  break;
                }
                ctx.lineTo(bx, by);
              }

              const op = opacity * brightness * a;
              ctx.strokeStyle = `rgba(255, 69, 58, ${op})`;
              ctx.lineWidth = lineWidth;
              ctx.stroke();
              ctx.strokeStyle = `rgba(255, 120, 100, ${op * 0.3})`;
              ctx.lineWidth = lineWidth * 4;
              ctx.stroke();
            };

            // Main bolt
            drawBolt(midY + mainYOff, 0, 0.9, 2.0, false);

            // Random branches
            for (let b = 0; b < numBranches; b++) {
              const bs = hash(cycleSeed + (b + 1) * 104729);
              const branchStart = hashF(bs) * 0.6 + 0.15;
              if (tipProgress > branchStart) {
                const yOff = midY + mainYOff + (hashF(bs + 7) - 0.5) * halfH * 0.8;
                const branchOpacity = 0.25 + hashF(bs + 13) * 0.3;
                const branchWidth = 0.7 + hashF(bs + 19) * 0.8;
                drawBolt(yOff, (b + 1) * 50000, branchOpacity, branchWidth, true);
              }
            }

            // Tip glow
            if (phase < crawlEnd && brightness > 0.3) {
              const tipY = midY + mainYOff;
              const glowR = 8 + hashF(cycleSeed + 888) * 10;
              const grad = ctx.createRadialGradient(tipX, tipY, 0, tipX, tipY, glowR);
              grad.addColorStop(0, `rgba(255, 200, 180, ${0.4 * a * brightness})`);
              grad.addColorStop(1, `rgba(255, 69, 58, 0)`);
              ctx.fillStyle = grad;
              ctx.fillRect(tipX - glowR, tipY - glowR, glowR * 2, glowR * 2);
            }

            break;
          }
          elapsed += 3.0 + hashF(cycle * 31337) * 3.0;
          cycle++;
          if (cycle > 10000) break; // safety
        }

        animRef.current = requestAnimationFrame(draw);
        return;
      }

      // ── Audio mode: 3 strings (bass / mids / highs) with time accumulation ──
      if (isAudio) {
        // Audio not loaded/playing yet — show breathing idle animation
        if (!isPlaying()) {
          const t = now / 1000;
          const amp = signalAmplitude;
          const a = signalAlpha;
          ctx.beginPath();
          for (let x = 0; x <= w; x += 2) {
            const xNorm = x / w;
            const breath = amp * 0.4 * (
              Math.sin(xNorm * 4.17 + t * 0.71) * 0.5 +
              Math.sin(xNorm * 6.83 - t * 1.13) * 0.3 +
              Math.sin(xNorm * 11.3 + t * 0.37) * 0.15 +
              Math.sin(xNorm * 17.1 - t * 1.71) * 0.05
            );
            const y = midY + breath * halfH;
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = isDark ? `rgba(${scR},${scG},${scB},${0.2 * a})` : `rgba(${scR},${scG},${scB},${0.15 * a})`;
          ctx.lineWidth = 1;
          ctx.stroke();
          if (clipped) ctx.restore();
          animRef.current = requestAnimationFrame(draw);
          return;
        }

        // Per-session offset: derive random position + speed from session ID
        let freqData: Uint8Array;
        let t: number;
        if (signalOffset > 0 && sessionId) {
          // Hash session ID to get deterministic random values
          let hash = 0;
          for (let i = 0; i < sessionId.length; i++) {
            hash = ((hash << 5) - hash + sessionId.charCodeAt(i)) | 0;
          }
          const h1 = ((hash * 2654435761) >>> 0) / 0xFFFFFFFF; // 0..1 for position
          const h2 = (((hash * 40503) >>> 0) & 0xFFFF) / 0xFFFF; // 0..1 for speed

          const duration = getDuration() || 1;
          const posOffset = h1 * duration * signalOffset;
          const speedMult = 1 + (h2 - 0.5) * 0.08 * signalOffset; // +-4% max

          const offsetTime = getCurrentTime() * speedMult + posOffset;
          freqData = getFrequencyDataAtTime(offsetTime);
          // Apply posOffset to the drawing phase too, otherwise every session
          // shares the same wave temporal phase and the motion looks identical
          // even though they're sampling different preset frames.
          t = now / 1000 * speedMult + posOffset;
        } else {
          freqData = getFrequencyData();
          t = now / 1000;
        }
        const numBins = freqData.length;

        // Decay envelope: only applies AFTER all bands are fully retracted.
        // During retraction the physics (audio + straightening force) handles amplitude.
        let decayEnvelope = 1.0;
        if (!isActiveRef.current) {
          const maxClipFrac = Math.max(
            clipFractionsRef.current[0],
            clipFractionsRef.current[1],
            clipFractionsRef.current[2],
          );
          if (maxClipFrac > 0.001) {
            // Still retracting — physics handles amplitude via straightening force
            decayEnvelope = 1.0;
            deactivatedAtRef.current = null; // reset so post-retract decay starts fresh
          } else {
            if (deactivatedAtRef.current === null) {
              deactivatedAtRef.current = now;
            }
            const elapsed = (now - deactivatedAtRef.current) / 1000;
            decayEnvelope = Math.exp(-elapsed * 1.2);
            if (decayEnvelope < 0.005) decayEnvelope = 0;
          }
        }

        // Three strings with DIFFERENT spatial modes so they visually separate:
        // Bass: harmonics 1-3 (wide lobes) + leftward travel
        // Mids: harmonics 2-5 (medium)     + standing
        // Treble: harmonics 4-9 (tight)    + rightward travel
        const amp = signalAmplitude;
        const INHARMONICITY = 0.0005; // slight detuning for organic phase drift
        const allBands = [
          { enabled: signalBass, bandIdx: 0, binStart: 0, binEnd: Math.floor(numBins * 0.25), startMode: 1, numModes: 3, speed: 0.7, travel: -0.3, phaseOff: 0, gain: 2.2 * amp, lw: 1.5, opacity: 0.3, baseDamping: 4 },
          // mids travel was 0 → traveling wave collapsed to standing, producing
          // bright pinch-point "dots" at x=1/3, 2/3 where modes 3 etc. share nodes.
          { enabled: signalMids, bandIdx: 1, binStart: Math.floor(numBins * 0.25), binEnd: Math.floor(numBins * 0.6), startMode: 2, numModes: 4, speed: 1.4, travel: 0.55, phaseOff: 2.1, gain: 1.8 * amp, lw: 1.0, opacity: 0.25, baseDamping: 5 },
          { enabled: signalTreble, bandIdx: 2, binStart: Math.floor(numBins * 0.6), binEnd: numBins, startMode: 4, numModes: 6, speed: 2.8, travel: 0.4, phaseOff: 4.5, gain: 1.5 * amp, lw: 0.75, opacity: 0.2, baseDamping: 6 },
        ];
        const bands = allBands.filter(b => b.enabled);

        // Initialize oscillator state if needed (max 3 bands × 6 modes = 18 slots)
        const totalModes = 18;
        if (!modeStateRef.current) {
          modeStateRef.current = { pos: new Float64Array(totalModes), vel: new Float64Array(totalModes) };
        }
        const ms = modeStateRef.current;
        const dt = lastFrameRef.current > 0 ? Math.min((now - lastFrameRef.current) / 1000, 0.05) : 1 / 60;
        lastFrameRef.current = now;

        // Oscillator constants
        const STIFFNESS = 200;

        // Onset detection — inject impulses on beat hits
        const onsets = getOnsets();
        const onsetArr = onsetRef.current;
        const onsetValues = [onsets.bass, onsets.mids, onsets.treble];
        for (let i = 0; i < 3; i++) {
          if (onsetValues[i] > 0) onsetArr[i] = Math.min(onsetArr[i] + onsetValues[i] * 12, 4.0);
          else onsetArr[i] *= 0.8; // decay impulse
        }

        // Cap trails to avoid quadratic cost at high echo values.
        // Spread them over the same time span so the echo depth is preserved.
        const maxTrails = 16;
        const rawTrails = Math.round(32 * signalEcho);
        const numTrails = Math.max(1, Math.min(rawTrails, maxTrails));
        const trailSpacing = rawTrails > maxTrails ? (0.018 * rawTrails) / numTrails : 0.018;

        // Collect all band mode amplitudes for sympathetic resonance
        const allModeAmps: number[][] = [];

        for (let bi = 0; bi < bands.length; bi++) {
          const band = bands[bi];
          const bandBins = band.binEnd - band.binStart;

          // Get target energy for this band's FFT range per mode
          const modeAmps: number[] = [];
          for (let m = 0; m < band.numModes; m++) {
            const mStart = band.binStart + Math.floor((m / band.numModes) * bandBins);
            const mEnd = band.binStart + Math.floor(((m + 1) / band.numModes) * bandBins);
            let energy = 0;
            for (let i = mStart; i < mEnd; i++) energy += freqData[i];
            const raw = energy / ((mEnd - mStart) * 255);
            let target = Math.sqrt(raw);

            // Add onset impulse — a burst that excites the mode
            target += onsetArr[band.bandIdx] * 0.35;

            // Frequency-dependent damping: higher modes decay faster
            const modeDamping = band.baseDamping * (1 + m * 0.3);

            // Driven oscillator: position tracks target with inertia
            const idx = bi * 6 + m;
            const bandClip = clipFractionsRef.current[band.bandIdx];
            if (isActiveRef.current || fadingRef.current) {
              // Active/fading: drive oscillator toward FFT target at full strength.
              // No fade reduction — strings keep receiving audio until retraction handles it.
              const force = (target - ms.pos[idx]) * STIFFNESS - ms.vel[idx] * modeDamping;
              ms.vel[idx] += force * dt;
            } else if (bandClip > 0.001) {
              // Retracting: audio input continues as additive excitation,
              // competing with a straightening force that pulls the string flat.
              // The competition creates organic retract — the string fights between
              // audio response and the retracting tension that tries to straighten it.
              const retractProgress = 1 - bandClip; // 0 = deployed, 1 = retracted
              // Audio drive tapers as string retracts (100% → 40%)
              const audioStrength = 1 - retractProgress * 0.6;
              // Straightening force ramps up quadratically — pulls mode toward rest (flat)
              const straightenStrength = retractProgress * retractProgress * STIFFNESS * 1.5;
              const audioForce = (target * audioStrength - ms.pos[idx]) * STIFFNESS;
              const straightenForce = -ms.pos[idx] * straightenStrength;
              // Extra damping during retraction to prevent wild oscillation
              const dampForce = -ms.vel[idx] * (modeDamping + retractProgress * 8);
              ms.vel[idx] += (audioForce + straightenForce + dampForce) * dt;
            } else {
              // Fully retracted: gently damp residual motion
              ms.vel[idx] *= 0.92;
            }
            ms.pos[idx] += ms.vel[idx] * dt;
            ms.pos[idx] = Math.max(0, Math.min(1.5, ms.pos[idx]));
            modeAmps.push(ms.pos[idx]);
          }
          allModeAmps.push(modeAmps);
        }

        // Sympathetic resonance: energy leaks between bands at harmonic ratios
        if (allModeAmps.length > 1) {
          for (let a = 0; a < allModeAmps.length; a++) {
            for (let b = a + 1; b < allModeAmps.length; b++) {
              const modesA = allModeAmps[a];
              const modesB = allModeAmps[b];
              // Couple strongest mode of each band into the other
              const maxA = Math.max(...modesA);
              const maxB = Math.max(...modesB);
              if (maxA > 0.3) {
                // Band A excites band B's first mode slightly
                modesB[0] = Math.min(1.5, modesB[0] + maxA * 0.03);
              }
              if (maxB > 0.3) {
                modesA[0] = Math.min(1.5, modesA[0] + maxB * 0.03);
              }
            }
          }
        }

        // Pseudo-noise breathing: subtle displacement during quiet passages
        // Sum of irrational-ratio sines approximates Perlin noise cheaply
        const breathe = (xNorm: number, t: number, level: number) => {
          const quietness = Math.max(0, 1 - level * 4); // fades out as signal rises
          if (quietness < 0.01) return 0;
          return quietness * 0.08 * (
            Math.sin(xNorm * 4.17 + t * 0.71) * 0.5 +
            Math.sin(xNorm * 6.83 - t * 1.13) * 0.3 +
            Math.sin(xNorm * 11.3 + t * 0.37) * 0.15 +
            Math.sin(xNorm * 17.1 - t * 1.71) * 0.05
          );
        };

        // Collect element rects for soft-erase after drawing. Skip empty
        // spacer divs (no text/visible content) to avoid erasing the
        // waveform behind invisible layout elements in slim mode. Cache is
        // refreshed at ERASE_RECTS_REBUILD_MS cadence — see note above the
        // draw closure for why per-frame rebuilds were removed.
        if (contentRef?.current && canvas && (eraseRectsDirty || now >= eraseRectsNextRebuildAt)) {
          eraseRectsDirty = false;
          eraseRectsNextRebuildAt = now + ERASE_RECTS_REBUILD_MS;
          const fresh: { x: number; y: number; w: number; h: number }[] = [];
          const canvasRect = rectCacheRef.current ?? canvas.getBoundingClientRect();
          const rows = contentRef.current.children;
          for (let ri = 0; ri < rows.length; ri++) {
            const row = rows[ri] as HTMLElement;
            if (row.children.length === 0 && !row.textContent?.trim()) continue;
            const items = row.children;
            if (items.length > 0) {
              for (let ci = 0; ci < items.length; ci++) {
                const el = items[ci] as HTMLElement;
                const er = el.getBoundingClientRect();
                if (er.width < 1 || er.height < 1) continue;
                fresh.push({
                  x: er.left - canvasRect.left,
                  y: er.top - canvasRect.top,
                  w: er.width,
                  h: er.height,
                });
              }
            } else {
              const rr = row.getBoundingClientRect();
              if (rr.width < 1 || rr.height < 1) continue;
              fresh.push({
                x: rr.left - canvasRect.left,
                y: rr.top - canvasRect.top,
                w: rr.width,
                h: rr.height,
              });
            }
          }
          cachedEraseRects = fresh;
        }
        const eraseRects = cachedEraseRects;

        // Store trail-0 points per band for particle rendering
        const bandPaths: number[][] = [];

        // Per-band Y offsets: bass above center (-), mids at center, treble below (+)
        // Indexed by bandIdx (0=bass, 1=mids, 2=treble)
        const bandYOffsets = [-cfgStringSpread * halfH, 0, cfgStringSpread * halfH];

        // Working-state tilt. The sweep math below stays horizontal — we apply
        // a ctx rotation around the card center just for the draw calls, so
        // bandPaths, sand spawning, erase rects, and everything downstream
        // continue to read horizontal y values (unchanged from before). The
        // clip rect is set INSIDE the rotation so deployment progresses along
        // the tilted axis instead of along the card's horizontal. Negative
        // angle = clockwise in canvas y-down space, which lifts the right end
        // and drops the left end → bottom-left → top-right diagonal.
        const BASE_TILT = (configRef.current.stringDeployAngle ?? -16) * Math.PI / 180;

        for (let bi = 0; bi < bands.length; bi++) {
          const band = bands[bi];
          const modeAmps = allModeAmps[bi];
          const avgAmp = modeAmps.reduce((s, v) => s + v, 0) / modeAmps.length;
          const yOffset = bandYOffsets[band.bandIdx] ?? 0;

          // Save + rotate (always, so we can restore) + optionally clip.
          ctx.save();
          ctx.translate(w / 2, h / 2);
          ctx.rotate(BASE_TILT);
          ctx.translate(-w / 2, -h / 2);

          // Per-band clip region (each string deploys/retracts at its own
          // speed). Set INSIDE the rotation so the clip rect is axis-aligned
          // to the tilted frame — deployment reads as the tip advancing along
          // the tilted string, which is what clipFraction has always meant
          // geometrically; only the visible orientation changes.
          if (!revived) {
            const bandClipX = clipFractionsRef.current[band.bandIdx] * w;
            ctx.beginPath();
            ctx.rect(0, 0, bandClipX, h);
            ctx.clip();
          }

          // Precompute per-mode constants (avoids sqrt per point per trail)
          const modeConsts = new Array(band.numModes);
          for (let m = 0; m < band.numModes; m++) {
            const n = band.startMode + m;
            modeConsts[m] = {
              n,
              nEff: n * Math.sqrt(1 + INHARMONICITY * n * n),
              mAmp: modeAmps[m],
            };
          }

          for (let trail = 0; trail < numTrails; trail++) {
            const tOff = t - trail * trailSpacing;
            const alpha = 1.0 - (trail / numTrails);
            const echoFade = trail === 0 ? 1.0 : signalEcho;
            const op = alpha * alpha * band.opacity * signalAlpha * echoFade;

            // Skip invisible trails
            if (op < 0.005) continue;

            // Build path once, draw twice (glow + core) for trail 0
            const points: number[] = [];
            for (let x = 0; x <= w; x += 2) {
              let sum = 0;
              const xNorm = x / w;
              // Edge-softened per-mode spatial phase. Without this, every mode's
              // standing wave is sin(nπx) → modes 3, 6, 9 all have nodes at x=1/3
              // and 2/3, so all trails collapse to the center axis at those two
              // x values and stack into visible bright "dots". Multiplying by
              // sin(πx) keeps the phase offset zero at x=0 and x=1 (so strings
              // still land on their anchors) while scrambling the node
              // positions in the middle.
              const midMod = Math.sin(Math.PI * xNorm);

              for (let m = 0; m < band.numModes; m++) {
                const mc = modeConsts[m];
                const spatialPhase = m * 0.55 * midMod;
                const standing = Math.sin(mc.nEff * Math.PI * xNorm + spatialPhase);
                const traveling = Math.sin(mc.nEff * Math.PI * xNorm + spatialPhase - band.travel * tOff * mc.n);
                const spatial = standing * 0.6 + traveling * 0.4;
                const temporal = Math.cos(tOff * (band.speed + m * 0.35) + band.phaseOff + m * 1.9);
                sum += mc.mAmp * spatial * temporal;
              }

              // Add breathing noise — persists even when inactive (not scaled by decayEnvelope)
              const breath = breathe(xNorm, tOff, decayEnvelope > 0.01 ? avgAmp : 0);

              // Whip pulse: Gaussian kink that fires at the cord tip on retract,
              // travels leftward and decays — only on trail 0 for crispness
              let whipContrib = 0;
              if (trail === 0) {
                const wp = whipPulsesRef.current[band.bandIdx];
                if (wp.active) {
                  const elapsed = (now - wp.t0) / 1000;
                  const decay = Math.exp(-elapsed * 5.5);
                  if (decay < 0.01) {
                    wp.active = false;
                  } else {
                    const clipFrac = clipFractionsRef.current[band.bandIdx];
                    // Kink center starts at cord tip and travels left with the retract
                    const kinkCenter = Math.max(0, clipFrac - elapsed * 0.35);
                    const sigma = 0.07;
                    const gaussian = Math.exp(-((xNorm - kinkCenter) ** 2) / (2 * sigma * sigma));
                    whipContrib = wp.dir * wp.amp * decay * gaussian;
                  }
                }
              }

              const ampMul = baseBandsAmpMuls[band.bandIdx] ?? 1;
              const y = Math.tanh((sum * decayEnvelope + breath + whipContrib) * band.gain) * halfH * ampMul;
              points.push(midY + yOffset + y);
            }

            // Save trail-0 path for particles
            if (trail === 0) bandPaths.push(points);

            // Draw glow + core lines — blend alpha fades strings during crossfade to sand
            if (drawStrings) {
              ctx.globalAlpha = 1 - sandBlend;
              if (trail === 0) {
                ctx.beginPath();
                for (let i = 0; i < points.length; i++) {
                  const x = i * 2;
                  if (i === 0) ctx.moveTo(x, points[i]);
                  else ctx.lineTo(x, points[i]);
                }
                const glowOp = op * 0.25;
                ctx.strokeStyle = `rgba(${scR},${scG},${scB},${glowOp})`;
                ctx.lineWidth = band.lw * 4;
                ctx.stroke();
              }

              ctx.beginPath();
              for (let i = 0; i < points.length; i++) {
                const x = i * 2;
                if (i === 0) ctx.moveTo(x, points[i]);
                else ctx.lineTo(x, points[i]);
              }
              const c = `rgba(${scR},${scG},${scB},${op})`;
              ctx.strokeStyle = c;
              ctx.lineWidth = trail === 0 ? band.lw : band.lw * 0.6;
              ctx.stroke();
            }
          }
              ctx.globalAlpha = 1;

          // Restore rotation (and clip, if applied). Paired with the ctx.save
          // up top that wraps rotate + conditional clip.
          ctx.restore();

          // ── Spear-tip ornament at the leading edge ── (disabled for now)
          // Visible only while the cord is in motion (deploying or retracting):
          // opacity is driven by |clipVel|, which decays to 0 once the string
          // lands or fully retracts, so the tip naturally disappears at rest.
          // Direction follows the sign of clipVel — points right while
          // deploying, points left while retracting — and tilts to the local
          // wave tangent so it reads as attached to the cord.
          // if (drawStrings && bandPaths[bi] && bandPaths[bi].length >= 2) {
          //   const tipPts = bandPaths[bi];
          //   const bandClip = clipFractionsRef.current[band.bandIdx];
          //   const vel = clipVelsRef.current[band.bandIdx];
          //   const speed = Math.abs(vel);
          //   const tipAlpha = Math.min(1, speed * 1.2) * signalAlpha * (1 - sandBlend);
          //   if (tipAlpha > 0.01 && bandClip > 0.005) {
          //     const bandClipX = bandClip * w;
          //     const idx = Math.max(1, Math.min(tipPts.length - 1, Math.floor(bandClipX / 2)));
          //     const dx = 2;
          //     const dy = tipPts[idx] - tipPts[idx - 1];
          //     const len = Math.hypot(dx, dy) || 1;
          //     const sign = vel >= 0 ? 1 : -1;
          //     const tx = (dx / len) * sign;
          //     const ty = (dy / len) * sign;
          //     const tipSize = 11 + band.lw * 3;
          //     drawSpearTip(
          //       ctx,
          //       bandClipX,
          //       tipPts[idx],
          //       tx,
          //       ty,
          //       tipSize,
          //       scR,
          //       scG,
          //       scB,
          //       tipAlpha,
          //       tipAlpha * 0.35,
          //     );
          //   }
          // }
        }

        // ── Extra bands (subagents) — diagonal axis renderer ──
        // Each entry has its own clip physics + 6-mode oscillator state. Audio
        // characteristics are inherited from the referenced band kind so they
        // visibly resemble the white lines but in their own colour.
        const extraMap = extraBandsStateRef.current;
        if (!revived && extraMap.size > 0) {
          const extraDt = 1 / 60;
          const { cordDeployForce: deployFE, cordRetractForce: retractFE } = cfg;
          // Snapshot ids so we can prune retired entries after iteration.
          const idsToDrop: string[] = [];
          extraMap.forEach((st, id) => {
            const kindIdx = st.spec.bandKind === "bass" ? 0 : st.spec.bandKind === "mids" ? 1 : 2;
            const cfgBand = allBands[kindIdx];
            if (!cfgBand.enabled) {
              // Disabled band — gently retract and clean up
              st.clipFraction = Math.max(0, st.clipFraction - extraDt);
              if (st.clipFraction <= 0 && st.removing) idsToDrop.push(id);
              return;
            }

            // Clip physics — same shape as base bands.
            const clip = st.clipFraction;
            const fm = 0.78; // fixed mid-ish force multiplier
            if (st.deployReady && !st.removing) {
              const pull = (0.4 + clip * clip * clip * 8) * deployFE * fm;
              st.clipVel += pull * extraDt;
            } else if (st.retractReady) {
              const pull = (1.5 + (1 - clip) * 6) * retractFE * fm;
              st.clipVel -= pull * extraDt;
            }
            st.clipFraction = Math.max(0, Math.min(1, clip + st.clipVel * extraDt));
            if (st.clipFraction <= 0) { st.clipFraction = 0; st.clipVel = 0; }
            if (st.clipFraction >= 1) st.clipVel = Math.max(0, st.clipVel * 0.9);

            // Mode oscillator integration — per-band-kind FFT bins, per-id state.
            const bandBins = cfgBand.binEnd - cfgBand.binStart;
            const modeAmps: number[] = [];
            for (let m = 0; m < cfgBand.numModes; m++) {
              const mStart = cfgBand.binStart + Math.floor((m / cfgBand.numModes) * bandBins);
              const mEnd = cfgBand.binStart + Math.floor(((m + 1) / cfgBand.numModes) * bandBins);
              let energy = 0;
              for (let i = mStart; i < mEnd; i++) energy += freqData[i];
              const raw = energy / Math.max(1, (mEnd - mStart) * 255);
              let target = Math.sqrt(raw);
              target += onsetArr[kindIdx] * 0.35;
              const modeDamping = cfgBand.baseDamping * (1 + m * 0.3);

              if (!st.removing) {
                const force = (target - st.modePos[m]) * STIFFNESS - st.modeVel[m] * modeDamping;
                st.modeVel[m] += force * extraDt;
              } else if (st.clipFraction > 0.001) {
                const retractProgress = 1 - st.clipFraction;
                const audioStrength = 1 - retractProgress * 0.6;
                const straightenStrength = retractProgress * retractProgress * STIFFNESS * 1.5;
                const audioForce = (target * audioStrength - st.modePos[m]) * STIFFNESS;
                const straightenForce = -st.modePos[m] * straightenStrength;
                const dampForce = -st.modeVel[m] * (modeDamping + retractProgress * 8);
                st.modeVel[m] += (audioForce + straightenForce + dampForce) * extraDt;
              } else {
                st.modeVel[m] *= 0.92;
              }
              st.modePos[m] += st.modeVel[m] * extraDt;
              st.modePos[m] = Math.max(0, Math.min(1.5, st.modePos[m]));
              modeAmps.push(st.modePos[m]);
            }

            // Drop fully-retracted removed entries.
            if (st.removing && st.clipFraction <= 0) {
              idsToDrop.push(id);
              return;
            }

            // Skip drawing if invisible. Extra bands (subagents, working
            // strings 4-5) have an independent lifecycle from the base bands,
            // so the base-band suppression branch of `drawStrings` doesn't
            // apply — when a session enters `subagent` directly from idle,
            // base bands stay suppressed, but the subagent line should still
            // render. Gate on the conditions that genuinely apply to extras:
            // sand not covering the card, and the band has clip to draw.
            const sandCoveringExtras = sandBlendRef.current >= 0.99;
            if (sandCoveringExtras || st.clipFraction <= 0.001) return;

            // Resolve axis in pixel space.
            const sx = st.spec.axisStart.xFrac * w;
            const sy = st.spec.axisStart.yFrac * h;
            const ex = st.spec.axisEnd.xFrac * w;
            const ey = st.spec.axisEnd.yFrac * h;
            const dx = ex - sx;
            const dy = ey - sy;
            const axisLen = Math.hypot(dx, dy);
            if (axisLen < 1) return;
            const tanX = dx / axisLen;
            const tanY = dy / axisLen;
            const nrmX = -tanY;
            const nrmY = tanX;

            // Precompute per-mode constants.
            const modeConsts: { n: number; nEff: number; mAmp: number }[] = new Array(cfgBand.numModes);
            for (let m = 0; m < cfgBand.numModes; m++) {
              const n = cfgBand.startMode + m;
              modeConsts[m] = { n, nEff: n * Math.sqrt(1 + INHARMONICITY * n * n), mAmp: modeAmps[m] };
            }
            const avgAmp = modeAmps.reduce((s, v) => s + v, 0) / Math.max(1, modeAmps.length);
            // Perpendicular displacement scale — use a fixed half-extent
            // similar to halfH so the wave amplitude reads consistently
            // regardless of axis orientation.
            const halfDisp = Math.min(halfH, axisLen * 0.18);
            // Sample density along the axis — match base-band ~2px stride.
            const sampleStep = 2;
            const nPts = Math.max(2, Math.floor(axisLen / sampleStep));

            const r = st.spec.color.r;
            const g = st.spec.color.g;
            const b = st.spec.color.b;

            // Capture the leading-edge position of the trail-0 path so we can
            // hang a spear-tip ornament there once the loop finishes drawing.
            // (disabled — re-enable alongside the drawSpearTip call below)
            // let tipPx = 0;
            // let tipPy = 0;
            // let tipReady = false;

            for (let trail = 0; trail < numTrails; trail++) {
              const tOff = t - trail * trailSpacing;
              const alphaT = 1.0 - (trail / numTrails);
              const echoFade = trail === 0 ? 1.0 : signalEcho;
              const op = alphaT * alphaT * cfgBand.opacity * signalAlpha * echoFade;
              if (op < 0.005) continue;

              ctx.beginPath();
              for (let i = 0; i <= nPts; i++) {
                const tParam = i / nPts;        // 0..1 along axis
                const u = tParam * axisLen;     // axis distance
                if (tParam > st.clipFraction) break; // clip tip

                let sum = 0;
                // Edge-softened per-mode spatial phase — see note in base-band
                // render loop. Prevents trail stacking at x=1/3, 2/3.
                const midMod = Math.sin(Math.PI * tParam);
                for (let m = 0; m < cfgBand.numModes; m++) {
                  const mc = modeConsts[m];
                  const spatialPhase = m * 0.55 * midMod;
                  const standing = Math.sin(mc.nEff * Math.PI * tParam + spatialPhase);
                  const traveling = Math.sin(mc.nEff * Math.PI * tParam + spatialPhase - cfgBand.travel * tOff * mc.n);
                  const spatial = standing * 0.6 + traveling * 0.4;
                  const temporal = Math.cos(tOff * (cfgBand.speed + m * 0.35) + cfgBand.phaseOff + (st.spec.phaseJitter ?? 0) + m * 1.9);
                  sum += mc.mAmp * spatial * temporal;
                }
                const breath = breathe(tParam, tOff, decayEnvelope > 0.01 ? avgAmp : 0);

                let whipContrib = 0;
                if (trail === 0 && st.whip.active) {
                  const elapsed = (now - st.whip.t0) / 1000;
                  const decay = Math.exp(-elapsed * 5.5);
                  if (decay < 0.01) {
                    st.whip.active = false;
                  } else {
                    const kinkCenter = Math.max(0, st.clipFraction - elapsed * 0.35);
                    const sigma = 0.07;
                    const gaussian = Math.exp(-((tParam - kinkCenter) ** 2) / (2 * sigma * sigma));
                    whipContrib = st.whip.dir * st.whip.amp * decay * gaussian;
                  }
                }

                const ampMulX = st.spec.amplitudeMul ?? 1;
                const v = Math.tanh((sum * decayEnvelope + breath + whipContrib) * cfgBand.gain) * halfDisp * ampMulX;
                const px = sx + u * tanX + v * nrmX;
                const py = sy + u * tanY + v * nrmY;
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                // if (trail === 0) { tipPx = px; tipPy = py; tipReady = true; }
              }
              if (trail === 0) {
                // glow pass
                const glowOp = op * 0.25;
                ctx.strokeStyle = `rgba(${r},${g},${b},${glowOp})`;
                ctx.lineWidth = cfgBand.lw * 4;
                ctx.globalAlpha = 1 - sandBlend;
                ctx.stroke();
              }
              ctx.strokeStyle = `rgba(${r},${g},${b},${op})`;
              ctx.lineWidth = trail === 0 ? cfgBand.lw : cfgBand.lw * 0.6;
              ctx.globalAlpha = 1 - sandBlend;
              ctx.stroke();
            }
            ctx.globalAlpha = 1;

            // ── Spear-tip on the subagent string ── (disabled for now)
            // Only visible during deploy/retract motion (|clipVel|-driven
            // opacity). Direction follows the axis tangent — flipped when
            // retracting — so the tip always points where the cord is heading.
            // if (tipReady) {
            //   const speed = Math.abs(st.clipVel);
            //   const tipAlpha = Math.min(1, speed * 1.2) * signalAlpha * (1 - sandBlend);
            //   if (tipAlpha > 0.01) {
            //     const sign = st.clipVel >= 0 ? 1 : -1;
            //     const tipSize = 11 + cfgBand.lw * 3;
            //     drawSpearTip(
            //       ctx,
            //       tipPx,
            //       tipPy,
            //       tanX * sign,
            //       tanY * sign,
            //       tipSize,
            //       r,
            //       g,
            //       b,
            //       tipAlpha,
            //       tipAlpha * 0.35,
            //     );
            //   }
            // }
          });
          for (const id of idsToDrop) extraMap.delete(id);
        }

        // ── Sand effect: 3 layers (bass/mids/treble) driven independently ──
        // Grains continue falling under gravity after the session stops.
        // Sand is now the idle-state effect, so treat "idle" as sand-active
        // for entry + wind-ramp even though idle is not in stateIsActive.
        const sandActive = isActiveRef.current || stateRef.current === "idle";
        if (drawSand && (sandActive || sandGrainsRef.current.length > 0)) {
          const grains = sandGrainsRef.current;
          const dirRad = ((cfgSandDirection + 180) * Math.PI) / 180;
          const windX = Math.cos(dirRad) * 120 * cfgSandSpeed;
          const windY = Math.sin(dirRad) * 120 * cfgSandSpeed;

          // Track deactivation for wind ramp-down
          if (sandActive) {
            sandDeactivatedAtRef.current = null;
          } else if (sandDeactivatedAtRef.current === null) {
            sandDeactivatedAtRef.current = now;
          }
          const deactSecs = sandDeactivatedAtRef.current !== null
            ? (now - sandDeactivatedAtRef.current) / 1000 : 0;
          const windRamp = sandActive ? 1.0 : Math.max(0, Math.exp(-deactSecs * 2.2));
          const GRAVITY = 90; // px/s²

          const layerSizeScale  = [1.6,  1.0,  0.55];
          const layerSpeedScale = [0.65, 1.0,  1.45];
          const layerTurbScale  = [0.6,  1.0,  1.5 ];
          const layerMaxGrains  = [100,  120,  130 ];

          const bandCounts = [0, 0, 0];
          for (let gi = 0; gi < grains.length; gi++) {
            const b = grains[gi].band;
            if (b >= 0 && b < 3) bandCounts[b]++;
          }

          const activeBands = Math.min(bands.length, 3);
          for (let bi = 0; bi < 3; bi++) {
            const path = bi < activeBands ? bandPaths[bi] : null;
            let bandEnergy = 0;
            if (path && path.length > 0) {
              let sum = 0;
              for (let pi = 0; pi < path.length; pi += 8) sum += Math.abs(path[pi] - midY);
              bandEnergy = sum / (path.length / 8) / h;
            }
            const spd = layerSpeedScale[bi];
            const bwX = windX * spd * windRamp;
            const bwY = windY * spd * windRamp;
            const energyMod = (0.5 + bandEnergy * cfgSandIntensity * 15) * windRamp;

            // Spawn only while idle — idle is not in stateIsActive, so we
            // check state directly rather than isActiveRef.
            if (bi < activeBands && stateRef.current === "idle") {
              const rawEnergy = 0.5 + bandEnergy * cfgSandIntensity * 15;
              const spawnRate = 0.06 * cfgSandDensity * rawEnergy * spd;
              if (Math.random() < spawnRate && bandCounts[bi] < layerMaxGrains[bi]) {
                const baseSize = (0.4 + Math.random() * 1.2) * cfgSandGrainSize * layerSizeScale[bi];
                const life = 4.0 + Math.random() * 5.0;
                let sx: number, sy: number;
                if (Math.abs(Math.cos(dirRad)) > Math.abs(Math.sin(dirRad))) {
                  sx = windX > 0 ? -5 : w + 5;
                  sy = Math.random() * h;
                } else {
                  sx = Math.random() * w;
                  sy = windY > 0 ? -5 : h + 5;
                }
                grains.push({
                  x: sx, y: sy,
                  vx: windX * spd * (0.6 + Math.random() * 0.8),
                  vy: windY * spd * (0.6 + Math.random() * 0.8),
                  size: baseSize, band: bi, birth: now, life,
                });
                bandCounts[bi]++;
              }
            }

            // Update and render — always runs while grains exist
            const turb = cfgSandTurbulence * energyMod * layerTurbScale[bi];
            for (let i = grains.length - 1; i >= 0; i--) {
              const g = grains[i];
              if (g.band !== bi) continue;
              const age = (now - g.birth) / 1000;
              // Bottom exit is primary when falling; other edges also cull
              if (g.y > h + 5 || g.x < -20 || g.x > w + 20 || g.y < -20) {
                grains.splice(i, 1); continue;
              }
              if (isActiveRef.current && age > g.life) {
                grains.splice(i, 1); continue;
              }
              // Gravity ramps in as wind dies
              g.vy += GRAVITY * (1 - windRamp) * dt;
              const phase = g.birth * 0.001 + age * 3;
              const tx = Math.sin(phase * 1.7 + bi * 2.1) * turb * 40;
              const ty = Math.cos(phase * 2.3 + bi * 1.4) * turb * 40;
              g.vx += (bwX - g.vx) * 0.02 + tx * dt;
              g.vy += (bwY - g.vy) * 0.02 + ty * dt;
              g.x += g.vx * dt;
              g.y += g.vy * dt;
              let alpha: number;
              if (isActiveRef.current) {
                const fadeIn = Math.min(age / 0.15, 1);
                const fadeOut = Math.max(1 - (age - (g.life - 0.3)) / 0.3, 0);
                alpha = fadeIn * (age > g.life - 0.3 ? fadeOut : 1) * cfgSandAlpha;
              } else {
                alpha = Math.min(age / 0.15, 1) * cfgSandAlpha * Math.max(0.15, windRamp);
              }
              if (alpha <= 0) continue;
              const r = g.size * (0.8 + 0.2 * Math.sin(age * 5 + g.birth));
              ctx.beginPath();
              ctx.arc(g.x, g.y, r, 0, Math.PI * 2);
              ctx.fillStyle = `rgba(${scR},${scG},${scB},${alpha * 0.8})`;
              ctx.fill();
              if (r > 0.6) {
                ctx.beginPath();
                ctx.arc(g.x, g.y, r * 0.35, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(255,255,255,${alpha * 0.3})`;
                ctx.fill();
              }
            }
          }
          if (grains.length > 350) grains.splice(0, grains.length - 350);
        }

        // Soft-erase: two-pass rounded-rect erase behind each content element
        // 1) Soft outer halo (feathered edge)  2) Hard inner core matching pill shape
        if (eraseRects.length > 0) {
          ctx.save();
          ctx.globalCompositeOperation = "destination-out";
          for (const r of eraseRects) {
            // Outer feather: slightly larger, semi-transparent
            const fo = 3; // feather outset
            ctx.beginPath();
            ctx.roundRect(r.x - fo, r.y - fo, r.w + fo * 2, r.h + fo * 2, r.h / 2 + fo);
            ctx.fillStyle = "rgba(0,0,0,0.5)";
            ctx.fill();

            // Inner core: exact pill shape, fully opaque
            ctx.beginPath();
            ctx.roundRect(r.x, r.y, r.w, r.h, r.h / 2);
            ctx.fillStyle = "rgba(0,0,0,1)";
            ctx.fill();
          }
          ctx.restore();
        }

        if (clipped) ctx.restore();
        animRef.current = requestAnimationFrame(draw);
        return;
      }

      // ── Simulated mode (piano strikes) ──

      // Read and prune pulse buffer
      const activePulses = pulses?.current ?? [];
      if (pulses?.current && pulses.current.length > 0) {
        pulses.current = pulses.current.filter(p => now - p.startTime < 4000);
      }
      const hasPulses = activePulses.length > 0;

      // Inactive with no pulses to drain — draw resting string and keep animating
      // (no abrupt snap — the cord retract handles the visual fade-out)
      if (!isActiveRef.current && !hasPulses) {
        // Only draw the resting line if the cord is still visible and strings are active
        const maxClipSim = Math.max(clipFractionsRef.current[0], clipFractionsRef.current[1], clipFractionsRef.current[2]);
        if (drawStrings && maxClipSim > 0.001) {
          ctx.globalAlpha = 1 - sandBlend;
          ctx.beginPath();
          ctx.moveTo(0, midY);
          ctx.lineTo(w, midY);
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        // Fall through when grains still exist so they continue to fall
        if (sandGrainsRef.current.length === 0) {
          if (clipped) ctx.restore();
          animRef.current = requestAnimationFrame(draw);
          return;
        }
      }

      // Physics parameters scaled by frequency
      const f = frequency;
      const speed = f * 600;
      const omega = f * 20;
      const physDecay = 1.2 + f * 0.4;

      if (drawStrings) ctx.beginPath();

      const simPoints: number[] = [];
      for (let x = 0; x <= w; x += 2) {
        let sum = 0;

        for (let pi = 0; pi < activePulses.length; pi++) {
          const p = activePulses[pi];
          const originPx = p.originX * w;
          const dist = Math.abs(x - originPx);
          const travelDelay = dist / speed;
          const localAge = (now - p.startTime) / 1000 - travelDelay;

          if (localAge <= 0) continue;

          sum += p.amplitude * Math.sin(omega * localAge) * Math.exp(-physDecay * localAge);
        }

        const y = Math.tanh(sum * 0.2) * halfH;
        simPoints.push(midY + y);

        if (drawStrings) {
          if (x === 0) {
            ctx.moveTo(x, midY + y);
          } else {
            ctx.lineTo(x, midY + y);
          }
        }
      }

      if (drawStrings) {
        ctx.globalAlpha = 1 - sandBlend;
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // ── Sand effect for simulated mode: 3 layers (bass/mids/treble) ──
      // Grains continue falling under gravity after the session stops.
      // "sandActive" folds in idle state so sand flows even though
      // isActiveRef is false (idle is not in stateIsActive).
      const sandActiveSim = isActiveRef.current || stateRef.current === "idle";
      if (drawSand && (sandActiveSim || sandGrainsRef.current.length > 0)) {
        const grains = sandGrainsRef.current;
        const dirRad = (cfgSandDirection * Math.PI) / 180;
        const windX = Math.cos(dirRad) * 120 * cfgSandSpeed;
        const windY = Math.sin(dirRad) * 120 * cfgSandSpeed;

        // Track deactivation for wind ramp-down
        if (sandActiveSim) {
          sandDeactivatedAtRef.current = null;
        } else if (sandDeactivatedAtRef.current === null) {
          sandDeactivatedAtRef.current = now;
        }
        const deactSecs = sandDeactivatedAtRef.current !== null
          ? (now - sandDeactivatedAtRef.current) / 1000 : 0;
        const windRamp = sandActiveSim ? 1.0 : Math.max(0, Math.exp(-deactSecs * 2.2));
        const GRAVITY = 90;
        const simDt = 1 / 60;

        // Energy from waveform — zero when no pulses (pure gravity fall)
        let simEnergy = 0;
        if (simPoints.length > 0) {
          for (let pi = 0; pi < simPoints.length; pi += 8) simEnergy += Math.abs(simPoints[pi] - midY);
          simEnergy = simEnergy / (simPoints.length / 8) / h;
        }

        const layerSizeScale  = [1.6,  1.0,  0.55];
        const layerSpeedScale = [0.65, 1.0,  1.45];
        const layerTurbScale  = [0.6,  1.0,  1.5 ];
        const layerMaxGrains  = [65,   80,   85  ];
        const layerEnergyBias = [1.2,  1.0,  0.85];

        const bandCounts = [0, 0, 0];
        for (let gi = 0; gi < grains.length; gi++) {
          const b = grains[gi].band;
          if (b >= 0 && b < 3) bandCounts[b]++;
        }

        for (let bi = 0; bi < 3; bi++) {
          const spd = layerSpeedScale[bi];
          const bwX = windX * spd * windRamp;
          const bwY = windY * spd * windRamp;
          const energyMod = (0.5 + simEnergy * cfgSandIntensity * 15 * layerEnergyBias[bi]) * windRamp;

          // Spawn only while idle (sand state). isActiveRef is false for
          // idle, so gate on state directly.
          if (hasPulses && stateRef.current === "idle") {
            const rawEnergy = 0.5 + simEnergy * cfgSandIntensity * 15 * layerEnergyBias[bi];
            const spawnRate = 0.04 * cfgSandDensity * rawEnergy * spd;
            if (Math.random() < spawnRate && bandCounts[bi] < layerMaxGrains[bi]) {
              const baseSize = (0.3 + Math.random() * 1.0) * cfgSandGrainSize * layerSizeScale[bi];
              const life = 4.0 + Math.random() * 4.5;
              let sx: number, sy: number;
              if (Math.abs(Math.cos(dirRad)) > Math.abs(Math.sin(dirRad))) {
                sx = windX > 0 ? -5 : w + 5;
                sy = Math.random() * h;
              } else {
                sx = Math.random() * w;
                sy = windY > 0 ? -5 : h + 5;
              }
              grains.push({
                x: sx, y: sy,
                vx: windX * spd * (0.6 + Math.random() * 0.8),
                vy: windY * spd * (0.6 + Math.random() * 0.8),
                size: baseSize, band: bi, birth: now, life,
              });
              bandCounts[bi]++;
            }
          }

          const turb = cfgSandTurbulence * energyMod * layerTurbScale[bi];
          for (let i = grains.length - 1; i >= 0; i--) {
            const g = grains[i];
            if (g.band !== bi) continue;
            const age = (now - g.birth) / 1000;
            if (g.y > h + 5 || g.x < -20 || g.x > w + 20 || g.y < -20) {
              grains.splice(i, 1); continue;
            }
            if (isActiveRef.current && age > g.life) {
              grains.splice(i, 1); continue;
            }
            g.vy += GRAVITY * (1 - windRamp) * simDt;
            const phase = g.birth * 0.001 + age * 3;
            const tx = Math.sin(phase * 1.7 + bi * 2.1) * turb * 40;
            const ty = Math.cos(phase * 2.3 + bi * 1.4) * turb * 40;
            g.vx += (bwX - g.vx) * 0.02 + tx * simDt;
            g.vy += (bwY - g.vy) * 0.02 + ty * simDt;
            g.x += g.vx * simDt;
            g.y += g.vy * simDt;
            let alpha: number;
            if (isActiveRef.current) {
              const fadeIn = Math.min(age / 0.15, 1);
              const fadeOut = Math.max(1 - (age - (g.life - 0.3)) / 0.3, 0);
              alpha = fadeIn * (age > g.life - 0.3 ? fadeOut : 1) * cfgSandAlpha;
            } else {
              alpha = Math.min(age / 0.15, 1) * cfgSandAlpha * Math.max(0.15, windRamp);
            }
            if (alpha <= 0) continue;
            const r = g.size * (0.8 + 0.2 * Math.sin(age * 5 + g.birth));
            ctx.beginPath();
            ctx.arc(g.x, g.y, r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${scR},${scG},${scB},${alpha * 0.8})`;
            ctx.fill();
            if (r > 0.6) {
              ctx.beginPath();
              ctx.arc(g.x, g.y, r * 0.35, 0, Math.PI * 2);
              ctx.fillStyle = `rgba(255,255,255,${alpha * 0.3})`;
              ctx.fill();
            }
          }
        }
        if (grains.length > 230) grains.splice(0, grains.length - 230);
      }

      if (clipped) ctx.restore();
      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animRef.current);
      observer.disconnect();
      contentObserver?.disconnect();
      contentMutationObserver?.disconnect();
    };
  // Only re-create the animation pipeline for structural changes.
  // Tuning props (alpha, amplitude, colors, etc.) are read from configRef each frame.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, revived, isAudio, sessionId, renderActive]);

  // Full-card background canvas — z-0 ensures content (z-10) renders above
  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full pointer-events-none"
      style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 0 }}
      aria-hidden="true"
    />
  );
}
