import { useRef, useEffect, useState } from "react";
import { usePageVisible } from "@/hooks/usePageVisible";
import { getFrequencyData, getFrequencyDataAtTime, getCurrentTime, getDuration, isPlaying, getOnsets } from "@/lib/presetEngine";
import { listen } from "@tauri-apps/api/event";

/**
 * Signal String — animated separator with two modes:
 * 1. Simulated: title letter "strikes" send damped traveling wave pulses
 * 2. Preset: extracted frequency envelope data drives displacement
 * Uses tanh activation to smoothly bound the result.
 */

/** Parse hex color string to RGB components */
function hexToRgb(hex: string) {
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

interface SignalStringProps {
  state: string;
  /** Frequency multiplier (0.3 = slow, 1.0 = normal, 3.0 = fast) */
  frequency?: number;
  /** Whether this is a revived (ended) session */
  revived?: boolean;
  /** Shared pulse buffer from SessionCard's strike detector */
  pulses?: React.RefObject<StrikePulse[]>;
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
}

export function SignalString({ state, frequency = 1.0, revived = false, pulses, signalMode = "simulated", signalAlpha = 0.25, signalAmplitude = 0.25, signalEcho = 1.0, signalBass = true, signalMids = true, signalTreble = true, signalColorDark = "#ffffff", signalColorLight = "#000000", signalOffset = 0, signalEffect = "string", sandEnabled = false, sandIntensity = 1.0, sandDirection = 0, sandDensity = 1.0, sandSpeed = 1.0, sandGrainSize = 1.0, sandTurbulence = 0.5, sandAlpha = 0.7, cordRetractDelay = 0.5, cordDeployForce = 1.0, cordRetractForce = 1.0, stringSpread = 0.15, sessionId = "", contentRef, keyReleaseSpeed: _keyReleaseSpeed = 0.4 }: SignalStringProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const pageVisible = usePageVisible();

  // Smoothly interpolated string color (r,g,b) — transitions between states
  const currentColorRef = useRef<{ r: number; g: number; b: number } | null>(null);
  // Track current state in a ref so the draw loop can determine effect type (sand vs string)
  const stateRef = useRef(state);
  stateRef.current = state;
  // Smooth blend between string (0) and sand (1) effects — crossfades during state transitions
  const sandBlendRef = useRef(state === "thinking" ? 1.0 : 0.0);

  const stateIsActive = state === "working" || state === "subagent" || state === "thinking";
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
    // Track whether we're deactivating from thinking — strings should stay hidden
    deactivatedFromThinkingRef.current = stateRef.current === "thinking" || sandBlendRef.current > 0.5;
    // State left working/subagent — begin fade, then deactivate after fade completes
    fadingRef.current = true;
    fadeStartRef.current = performance.now();
    const timer = setTimeout(() => {
      setIsActive(false);
      fadingRef.current = false;
    }, FADE_DURATION * 1000);
    return () => clearTimeout(timer);
  }, [stateIsActive]);

  const isAudio = signalMode === "preset" || signalMode === "audio" || signalMode === "live";
  // Track when session became inactive for decay timing
  const deactivatedAtRef = useRef<number | null>(null);
  // Driven oscillator state: position + velocity per mode per band (max 3 bands × 6 modes)
  const modeStateRef = useRef<{ pos: Float64Array; vel: Float64Array } | null>(null);
  const lastFrameRef = useRef<number>(0);
  // Onset impulse accumulators per band (decays each frame)
  const onsetRef = useRef<Float64Array>(new Float64Array(3));
  // Sand grains: blown across the card, driven by audio energy
  const sandGrainsRef = useRef<{ x: number; y: number; vx: number; vy: number; size: number; band: number; birth: number; life: number }[]>([]);
  // Tracks when the session went inactive — drives wind ramp-down and gravity transition
  const sandDeactivatedAtRef = useRef<number | null>(null);
  // Vacuum cord retract/deploy per band: 0 = fully retracted (left), 1 = fully deployed (right)
  // [bass, mids, treble] — each travels at a slightly different rate
  const clipFractionsRef = useRef(isActive ? new Float64Array([1, 1, 1]) : new Float64Array(3));
  const clipVelsRef = useRef(new Float64Array(3));
  // Per-band ready flags and timers — staggered: band 0 first, band 1 after 400ms, band 2 after 520ms
  const bandStaggerMs = [0, 400, 520];
  const retractTimersRef = useRef<(number | null)[]>([null, null, null]);
  const retractReadyRef = useRef(isActive ? [false, false, false] : [true, true, true]);
  const deployTimersRef = useRef<(number | null)[]>([null, null, null]);
  const deployReadyRef = useRef(isActive ? [true, true, true] : [false, false, false]);

  // Store tuning props in a ref so the draw loop reads them live
  // without tearing down the animation pipeline on every slider change
  const configRef = useRef({
    signalAlpha, signalAmplitude, signalEcho, frequency,
    signalBass, signalMids, signalTreble,
    signalColorDark, signalColorLight, signalOffset,
    signalEffect, sandEnabled, sandIntensity, sandDirection, sandDensity, sandSpeed, sandGrainSize, sandTurbulence, sandAlpha,
    cordRetractDelay, cordDeployForce, cordRetractForce, stringSpread, signalMode,
  });
  configRef.current = {
    signalAlpha, signalAmplitude, signalEcho, frequency,
    signalBass, signalMids, signalTreble,
    signalColorDark, signalColorLight, signalOffset,
    signalEffect, sandEnabled, sandIntensity, sandDirection, sandDensity, sandSpeed, sandGrainSize, sandTurbulence, sandAlpha,
    cordRetractDelay, cordDeployForce, cordRetractForce, stringSpread, signalMode,
  };

  // Whip pulses — triggered when each band starts retracting
  // Each pulse: a Gaussian kink at the cord tip that travels left and decays
  const whipPulsesRef = useRef([
    { active: false, t0: 0, amp: 0, dir: 1 },
    { active: false, t0: 0, amp: 0, dir: -1 },
    { active: false, t0: 0, amp: 0, dir: 1 },
  ]);

  // Live audio data from system audio capture (Beta)
  const liveDataRef = useRef<{ bass: number; mids: number; treble: number }>({ bass: 0, mids: 0, treble: 0 });
  useEffect(() => {
    if (signalMode !== "live") return;
    let unlisten: (() => void) | null = null;
    listen<{ bass: number; mids: number; treble: number }>("live-audio-data", (event) => {
      liveDataRef.current = event.payload;
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [signalMode]);

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
      // Staggered deploy: band 0 first, band 1 after 800ms, band 2 after 950ms
      deployReadyRef.current = [false, false, false];
      const bandNudge = [0.35, 0.15, 0.15]; // first band gets a stronger initial push
      for (let i = 0; i < 3; i++) {
        const delay = 850 + bandStaggerMs[i];
        deployTimersRef.current[i] = window.setTimeout(() => {
          deployReadyRef.current[i] = true;
          // Initial nudge — first band gets a stronger push to come out faster
          clipVelsRef.current[i] = Math.max(clipVelsRef.current[i], bandNudge[i] * cordDeployForce);
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

  // When transitioning out of thinking (sand → strings), the cord fractions are already
  // at [1,1,1] because isActive never changed. Reset to retracted and trigger a fresh deploy
  // so the startup animation plays as strings emerge from under the fading sand.
  const prevStateRef = useRef(state);
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = state;

    if (prev === "thinking" && (state === "working" || state === "subagent")) {
      clipFractionsRef.current.fill(0);
      clipVelsRef.current.fill(0);
      retractReadyRef.current = [false, false, false];
      deployReadyRef.current = [false, false, false];
      for (let i = 0; i < 3; i++) {
        if (deployTimersRef.current[i] !== null) {
          clearTimeout(deployTimersRef.current[i]!);
          deployTimersRef.current[i] = null;
        }
      }
      const bandNudge = [0.35, 0.15, 0.15];
      for (let i = 0; i < 3; i++) {
        const delay = 850 + bandStaggerMs[i];
        deployTimersRef.current[i] = window.setTimeout(() => {
          deployReadyRef.current[i] = true;
          clipVelsRef.current[i] = Math.max(clipVelsRef.current[i], bandNudge[i] * cordDeployForce);
          deployTimersRef.current[i] = null;
        }, delay);
      }
    }
  }, [state, cordDeployForce]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Pause all rendering when page is hidden
    if (!pageVisible) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const draw = (now: number) => {
      const cfg = configRef.current;
      const { signalAlpha, signalAmplitude, signalEcho, frequency,
        signalBass, signalMids, signalTreble,
        signalColorDark, signalColorLight, signalOffset,
        signalEffect: _cfgEffect, sandEnabled: _cfgSandEnabled, sandIntensity: cfgSandIntensity,
        sandDirection: cfgSandDirection, sandDensity: cfgSandDensity, sandSpeed: cfgSandSpeed,
        sandGrainSize: cfgSandGrainSize, sandTurbulence: cfgSandTurbulence, sandAlpha: cfgSandAlpha,
        stringSpread: cfgStringSpread } = cfg;
      // Smooth crossfade between string and sand effects
      const sandTarget = stateRef.current === "thinking" ? 1.0 : 0.0;
      if (isActiveRef.current && stateRef.current !== "thinking") {
        // Active but not thinking (e.g. thinking→working) — snap sand off immediately
        sandBlendRef.current = 0;
        sandGrainsRef.current.length = 0;
      } else {
        sandBlendRef.current += (sandTarget - sandBlendRef.current) * 0.045;
        if (Math.abs(sandBlendRef.current - sandTarget) < 0.003) sandBlendRef.current = sandTarget;
      }
      const sandBlend = sandBlendRef.current;
      // Don't draw strings if we deactivated from thinking — let sand fade out alone
      const drawStrings = sandBlend < 0.99 && !deactivatedFromThinkingRef.current;
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

      // State-aware target color: thinking=orange, waiting=yellow, error=red, default=configured color
      const targetColor = state === "thinking"
        ? (isDark ? { r: 246, g: 165, b: 96 } : { r: 194, g: 65, b: 12 })  // thinking orange
        : state === "waiting"
        ? { r: 234, g: 179, b: 8 }   // amber/yellow
        : state === "error"
        ? { r: 239, g: 68, b: 68 }    // red
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
      const strokeColor = revived
        ? `rgba(239, 68, 68, ${0.4 * a})`
        : `rgba(${Math.round(sc.r)}, ${Math.round(sc.g)}, ${Math.round(sc.b)}, ${0.4 * a})`;

      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const midY = h / 2;
      const halfH = h / 2 - 1;

      ctx.clearRect(0, 0, w, h);

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

        for (let i = 0; i < 3; i++) {
          const clip = fracs[i];
          const fm = bandForceMult[i];

          if (isActiveRef.current && deployReadyRef.current[i]) {
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

        // Fully retracted — nothing to draw, just keep the loop alive
        // Don't exit early while grains are still falling or blending
        const maxClip = Math.max(fracs[0], fracs[1], fracs[2]);
        if (maxClip < 0.001 && !isActiveRef.current && sandGrainsRef.current.length === 0) {
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
          ctx.strokeStyle = isDark ? `rgba(${sc.r},${sc.g},${sc.b},${0.2 * a})` : `rgba(${sc.r},${sc.g},${sc.b},${0.15 * a})`;
          ctx.lineWidth = 1;
          ctx.stroke();
          if (clipped) ctx.restore();
          animRef.current = requestAnimationFrame(draw);
          return;
        }

        // Per-session offset: derive random position + speed from session ID
        let freqData: Uint8Array;
        let t: number;
        if (cfg.signalMode === "live") {
          // Live mode: synthesize frequency bins from 3-band data
          const ld = liveDataRef.current;
          const bins = new Uint8Array(128);
          // Bass: bins 0-10, Mids: bins 11-40, Treble: bins 41-127
          for (let i = 0; i < 11; i++) bins[i] = Math.min(255, Math.floor(ld.bass * 255));
          for (let i = 11; i < 41; i++) bins[i] = Math.min(255, Math.floor(ld.mids * 255));
          for (let i = 41; i < 128; i++) bins[i] = Math.min(255, Math.floor(ld.treble * 255));
          freqData = bins;
          t = now / 1000;
        } else if (signalOffset > 0 && sessionId) {
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
          t = now / 1000 * speedMult;
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
          { enabled: signalMids, bandIdx: 1, binStart: Math.floor(numBins * 0.25), binEnd: Math.floor(numBins * 0.6), startMode: 2, numModes: 4, speed: 1.4, travel: 0, phaseOff: 2.1, gain: 1.8 * amp, lw: 1.0, opacity: 0.25, baseDamping: 5 },
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

        // Collect element rects for soft-erase after drawing
        // Skip empty spacer divs (no text/visible content) to avoid erasing
        // the waveform behind invisible layout elements in slim mode.
        const eraseRects: { x: number; y: number; w: number; h: number }[] = [];
        if (contentRef?.current && canvas) {
          const canvasRect = canvas.getBoundingClientRect();
          const rows = contentRef.current.children;
          for (let ri = 0; ri < rows.length; ri++) {
            const row = rows[ri] as HTMLElement;
            // Skip empty spacer elements (no children AND no text content)
            if (row.children.length === 0 && !row.textContent?.trim()) continue;
            const items = row.children;
            if (items.length > 0) {
              for (let ci = 0; ci < items.length; ci++) {
                const el = items[ci] as HTMLElement;
                const er = el.getBoundingClientRect();
                if (er.width < 1 || er.height < 1) continue;
                eraseRects.push({
                  x: er.left - canvasRect.left,
                  y: er.top - canvasRect.top,
                  w: er.width,
                  h: er.height,
                });
              }
            } else {
              const rr = row.getBoundingClientRect();
              if (rr.width < 1 || rr.height < 1) continue;
              eraseRects.push({
                x: rr.left - canvasRect.left,
                y: rr.top - canvasRect.top,
                w: rr.width,
                h: rr.height,
              });
            }
          }
        }

        // Store trail-0 points per band for particle rendering
        const bandPaths: number[][] = [];

        // Per-band Y offsets: bass above center (-), mids at center, treble below (+)
        // Indexed by bandIdx (0=bass, 1=mids, 2=treble)
        const bandYOffsets = [-cfgStringSpread * halfH, 0, cfgStringSpread * halfH];

        for (let bi = 0; bi < bands.length; bi++) {
          const band = bands[bi];
          const modeAmps = allModeAmps[bi];
          const avgAmp = modeAmps.reduce((s, v) => s + v, 0) / modeAmps.length;
          const yOffset = bandYOffsets[band.bandIdx] ?? 0;

          // Per-band clip region (each string deploys/retracts at its own speed)
          if (!revived) {
            const bandClipX = clipFractionsRef.current[band.bandIdx] * w;
            ctx.save();
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

              for (let m = 0; m < band.numModes; m++) {
                const mc = modeConsts[m];
                const standing = Math.sin(mc.nEff * Math.PI * xNorm);
                const traveling = Math.sin(mc.nEff * Math.PI * xNorm - band.travel * tOff * mc.n);
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

              const y = Math.tanh((sum * decayEnvelope + breath + whipContrib) * band.gain) * halfH;
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
                ctx.strokeStyle = `rgba(${sc.r},${sc.g},${sc.b},${glowOp})`;
                ctx.lineWidth = band.lw * 4;
                ctx.stroke();
              }

              ctx.beginPath();
              for (let i = 0; i < points.length; i++) {
                const x = i * 2;
                if (i === 0) ctx.moveTo(x, points[i]);
                else ctx.lineTo(x, points[i]);
              }
              const c = `rgba(${sc.r},${sc.g},${sc.b},${op})`;
              ctx.strokeStyle = c;
              ctx.lineWidth = trail === 0 ? band.lw : band.lw * 0.6;
              ctx.stroke();
            }
          }
              ctx.globalAlpha = 1;

          // Restore per-band clip
          if (!revived) ctx.restore();
        }

        // ── Sand effect: 3 layers (bass/mids/treble) driven independently ──
        // Grains continue falling under gravity after the session stops.
        if (drawSand && (isActiveRef.current || sandGrainsRef.current.length > 0)) {
          const grains = sandGrainsRef.current;
          const dirRad = ((cfgSandDirection + 180) * Math.PI) / 180;
          const windX = Math.cos(dirRad) * 120 * cfgSandSpeed;
          const windY = Math.sin(dirRad) * 120 * cfgSandSpeed;

          // Track deactivation for wind ramp-down
          if (isActiveRef.current) {
            sandDeactivatedAtRef.current = null;
          } else if (sandDeactivatedAtRef.current === null) {
            sandDeactivatedAtRef.current = now;
          }
          const deactSecs = sandDeactivatedAtRef.current !== null
            ? (now - sandDeactivatedAtRef.current) / 1000 : 0;
          const windRamp = isActiveRef.current ? 1.0 : Math.max(0, Math.exp(-deactSecs * 2.2));
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

            // Spawn only while in thinking state
            if (isActiveRef.current && bi < activeBands && stateRef.current === "thinking") {
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
              ctx.fillStyle = `rgba(${sc.r},${sc.g},${sc.b},${alpha * 0.8})`;
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
      if (drawSand && (isActiveRef.current || sandGrainsRef.current.length > 0)) {
        const grains = sandGrainsRef.current;
        const dirRad = (cfgSandDirection * Math.PI) / 180;
        const windX = Math.cos(dirRad) * 120 * cfgSandSpeed;
        const windY = Math.sin(dirRad) * 120 * cfgSandSpeed;

        // Track deactivation for wind ramp-down
        if (isActiveRef.current) {
          sandDeactivatedAtRef.current = null;
        } else if (sandDeactivatedAtRef.current === null) {
          sandDeactivatedAtRef.current = now;
        }
        const deactSecs = sandDeactivatedAtRef.current !== null
          ? (now - sandDeactivatedAtRef.current) / 1000 : 0;
        const windRamp = isActiveRef.current ? 1.0 : Math.max(0, Math.exp(-deactSecs * 2.2));
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

          // Spawn only while in thinking state with pulses
          if (isActiveRef.current && hasPulses && stateRef.current === "thinking") {
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
            ctx.fillStyle = `rgba(${sc.r},${sc.g},${sc.b},${alpha * 0.8})`;
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
    };
  // Only re-create the animation pipeline for structural changes.
  // Tuning props (alpha, amplitude, colors, etc.) are read from configRef each frame.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, revived, isAudio, sessionId, pageVisible]);

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
