import { useRef, useEffect, useState } from "react";
import { usePageVisible } from "@/hooks/usePageVisible";
import { getFrequencyData, getFrequencyDataAtTime, getCurrentTime, getDuration, isPlaying, getOnsets } from "@/lib/presetEngine";

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
  /** Whether pulse particles are enabled */
  particleEnabled?: boolean;
  /** Particle speed multiplier */
  particleSpeed?: number;
  /** Particle spawn rate multiplier */
  particleRate?: number;
  /** Number of spark trails per particle */
  particleSparks?: number;
  /** Particle opacity (independent of string opacity) */
  particleAlpha?: number;
  /** Delay before cord retracts after stopping (seconds) */
  cordRetractDelay?: number;
  /** Deploy force multiplier (how fast strings launch out) */
  cordDeployForce?: number;
  /** Retract force multiplier (how hard the vacuum pulls) */
  cordRetractForce?: number;
  /** Session ID used as seed for per-session random offset */
  sessionId?: string;
  /** Ref to content wrapper — used to clip particles behind content rows */
  contentRef?: React.RefObject<HTMLDivElement | null>;
  /** Key release animation duration (seconds) — strings stay active until key finishes rising */
  keyReleaseSpeed?: number;
}

export function SignalString({ state, frequency = 1.0, revived = false, pulses, signalMode = "simulated", signalAlpha = 0.25, signalAmplitude = 0.25, signalEcho = 1.0, signalBass = true, signalMids = true, signalTreble = true, signalColorDark = "#ffffff", signalColorLight = "#000000", signalOffset = 0, particleEnabled = true, particleSpeed = 1.0, particleRate = 1.0, particleSparks = 3, particleAlpha = 1.0, cordRetractDelay = 0.5, cordDeployForce = 1.0, cordRetractForce = 1.0, sessionId = "", contentRef, keyReleaseSpeed: _keyReleaseSpeed = 0.4 }: SignalStringProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const pageVisible = usePageVisible();

  // Smoothly interpolated string color (r,g,b) — transitions between states
  const currentColorRef = useRef<{ r: number; g: number; b: number } | null>(null);

  const stateIsActive = state === "working" || state === "subagent";
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
      return;
    }
    // State left working/subagent — begin fade, then deactivate after fade completes
    fadingRef.current = true;
    fadeStartRef.current = performance.now();
    const timer = setTimeout(() => {
      setIsActive(false);
      fadingRef.current = false;
    }, FADE_DURATION * 1000);
    return () => clearTimeout(timer);
  }, [stateIsActive]);

  const isAudio = signalMode === "preset" || signalMode === "audio";
  // Track when session became inactive for decay timing
  const deactivatedAtRef = useRef<number | null>(null);
  // Driven oscillator state: position + velocity per mode per band (max 3 bands × 6 modes)
  const modeStateRef = useRef<{ pos: Float64Array; vel: Float64Array } | null>(null);
  const lastFrameRef = useRef<number>(0);
  // Onset impulse accumulators per band (decays each frame)
  const onsetRef = useRef<Float64Array>(new Float64Array(3));
  // Pulse particles traveling along strings
  const particlesRef = useRef<{ x: number; speed: number; band: number; birth: number }[]>([]);
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
    particleEnabled, particleSpeed, particleRate, particleSparks, particleAlpha,
    cordRetractDelay, cordDeployForce, cordRetractForce,
  });
  configRef.current = {
    signalAlpha, signalAmplitude, signalEcho, frequency,
    signalBass, signalMids, signalTreble,
    signalColorDark, signalColorLight, signalOffset,
    particleEnabled, particleSpeed, particleRate, particleSparks, particleAlpha,
    cordRetractDelay, cordDeployForce, cordRetractForce,
  };

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
      // Staggered retract: band 0 first, band 1 after 500ms, band 2 after 600ms
      retractReadyRef.current = [false, false, false];
      for (let i = 0; i < 3; i++) {
        const delay = cordRetractDelay * 1000 + bandStaggerMs[i];
        retractTimersRef.current[i] = window.setTimeout(() => {
          retractReadyRef.current[i] = true;
          retractTimersRef.current[i] = null;
        }, delay);
      }
    }
    return clearAllTimers;
  }, [isActive, cordRetractDelay, cordDeployForce]);

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
        particleEnabled, particleSpeed, particleRate, particleSparks } = cfg;
      const isGlass = document.documentElement.hasAttribute("data-glass");
      const isDark = isGlass || document.documentElement.getAttribute("data-theme") !== "light";
      const defaultColor = isDark ? hexToRgb(signalColorDark) : hexToRgb(signalColorLight);
      const a = signalAlpha;

      // Skip all computation when alpha is zero (e.g. glass theme)
      if (a <= 0 && !particleEnabled) {
        animRef.current = requestAnimationFrame(draw);
        return;
      }

      // State-aware target color: waiting=yellow, error=red, default=configured color
      const targetColor = state === "waiting"
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
        const maxClip = Math.max(fracs[0], fracs[1], fracs[2]);
        if (maxClip < 0.001 && !isActiveRef.current) {
          animRef.current = requestAnimationFrame(draw);
          return;
        }

        // Apply global clip at the widest band (particles/erase rects need it)
        const clipX = maxClip * w;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, clipX, h);
        ctx.clip();
      }

      let clipped = !revived;

      // ── Revived mode: randomized lightning strikes ──
      if (revived) {
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
          t = now / 1000 * speedMult;
        } else {
          freqData = getFrequencyData();
          t = now / 1000;
        }
        const numBins = freqData.length;

        // Fade envelope: smoothly reduces FFT drive and string opacity
        // during the fade-out period (while fading) and after (when fully inactive).
        let fadeEnvelope = 1.0;
        let decayEnvelope = 1.0;
        if (fadingRef.current) {
          // Fading: gradually reduce over FADE_DURATION
          const elapsed = (now - fadeStartRef.current) / 1000;
          fadeEnvelope = Math.max(0, 1.0 - elapsed / FADE_DURATION);
          // Ease out for smoother tail
          fadeEnvelope = fadeEnvelope * fadeEnvelope;
        }
        if (!isActiveRef.current) {
          if (deactivatedAtRef.current === null) {
            deactivatedAtRef.current = now;
          }
          const elapsed = (now - deactivatedAtRef.current) / 1000;
          decayEnvelope = Math.exp(-elapsed * 1.2); // post-fade cord retract decay
          if (decayEnvelope < 0.005) decayEnvelope = 0;
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
            // fadeEnvelope gradually reduces drive force during transition
            const idx = bi * 6 + m;
            const drive = fadeEnvelope;
            if (isActiveRef.current || fadingRef.current) {
              // Drive oscillator toward FFT target, scaled by fade envelope
              const scaledTarget = target * drive;
              const force = (scaledTarget - ms.pos[idx]) * STIFFNESS - ms.vel[idx] * modeDamping;
              ms.vel[idx] += force * dt;
              ms.pos[idx] += ms.vel[idx] * dt;
              ms.pos[idx] = Math.max(0, Math.min(1.5, ms.pos[idx]));
            } else {
              // Fully inactive: gently damp residual motion
              ms.vel[idx] *= 0.92;
              ms.pos[idx] += ms.vel[idx] * dt;
              ms.pos[idx] = Math.max(0, Math.min(1.5, ms.pos[idx]));
            }
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

        for (let bi = 0; bi < bands.length; bi++) {
          const band = bands[bi];
          const modeAmps = allModeAmps[bi];
          const avgAmp = modeAmps.reduce((s, v) => s + v, 0) / modeAmps.length;

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

              const y = Math.tanh((sum * decayEnvelope + breath) * band.gain) * halfH;
              points.push(midY + y);
            }

            // Save trail-0 path for particles
            if (trail === 0) bandPaths.push(points);

            // Draw glow layer (wider, semi-transparent) — trail 0 only
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

            // Draw core line
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

          // Restore per-band clip
          if (!revived) ctx.restore();
        }

        // ── Pulse particles: blobs that ride along the strings ──
        if (isActiveRef.current && bands.length > 0 && particleEnabled) {
          const particles = particlesRef.current;
          const baseSpeed = 150 * particleSpeed;
          const speedRange = 200 * particleSpeed;
          const spawnChance = 0.035 * particleRate;
          const sparks = Math.round(particleSparks);

          if (Math.random() < spawnChance * bands.length) {
            const bandIdx = Math.floor(Math.random() * bands.length);
            particles.push({
              x: 0,
              speed: baseSpeed + Math.random() * speedRange,
              band: bandIdx,
              birth: now,
            });
          }

          for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            const age = (now - p.birth) / 1000;
            p.x += p.speed * dt;

            if (p.x > w + 10) { particles.splice(i, 1); continue; }

            const path = bandPaths[p.band];
            if (!path || path.length === 0) continue;
            const pathIdx = p.x / 2;
            const pi0 = Math.floor(pathIdx);
            const pi1 = Math.min(pi0 + 1, path.length - 1);
            const frac = pathIdx - pi0;
            const py = pi0 < path.length ? path[pi0] * (1 - frac) + path[pi1] * frac : midY;

            const fadeIn = Math.min(age / 0.1, 1);
            const alpha = fadeIn * particleAlpha;

            const band = bands[p.band];
            const radius = band.lw * 2;

            // Sparks
            for (let si = 0; si < sparks; si++) {
              const sparkSeed = ((p.birth + si * 7919) * 2654435761) >>> 0;
              const sx = p.x - (si + 1) * (3 + ((sparkSeed & 0xFF) / 255) * 5);
              const sy = py + (((sparkSeed >> 8) & 0xFF) / 255 - 0.5) * 6;
              const sparkAlpha = alpha * (0.5 - si * 0.08);
              if (sx > 0 && sx < w) {
                ctx.beginPath();
                ctx.arc(sx, sy, 0.8, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(${sc.r},${sc.g},${sc.b},${sparkAlpha})`;
                ctx.fill();
              }
            }

            ctx.beginPath();
            ctx.arc(p.x, py, radius, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${sc.r},${sc.g},${sc.b},${alpha})`;
            ctx.fill();

            ctx.beginPath();
            ctx.arc(p.x, py, radius * 0.4, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255,255,255,${alpha * 0.5})`;
            ctx.fill();
          }

          if (particles.length > 40) particles.splice(0, particles.length - 40);
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
        // Only draw the resting line if the cord is still visible
        const maxClipSim = Math.max(clipFractionsRef.current[0], clipFractionsRef.current[1], clipFractionsRef.current[2]);
        if (maxClipSim > 0.001) {
          ctx.beginPath();
          ctx.moveTo(0, midY);
          ctx.lineTo(w, midY);
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        if (clipped) ctx.restore();
        animRef.current = requestAnimationFrame(draw);
        return;
      }

      // Physics parameters scaled by frequency
      const f = frequency;
      const speed = f * 600;
      const omega = f * 20;
      const physDecay = 1.2 + f * 0.4;

      ctx.beginPath();

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

        if (x === 0) {
          ctx.moveTo(x, midY + y);
        } else {
          ctx.lineTo(x, midY + y);
        }
      }

      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 1;
      ctx.stroke();

      // ── Pulse particles for simulated mode ──
      if (isActiveRef.current && hasPulses && particleEnabled) {
        const particles = particlesRef.current;
        const baseSpeed = 150 * particleSpeed;
        const speedRange = 200 * particleSpeed;
        const sparks = Math.round(particleSparks);

        if (Math.random() < 0.04 * particleRate) {
          particles.push({
            x: 0,
            speed: baseSpeed + Math.random() * speedRange,
            band: 0,
            birth: now,
          });
        }

        for (let i = particles.length - 1; i >= 0; i--) {
          const p = particles[i];
          const age = (now - p.birth) / 1000;
          p.x += p.speed * (1 / 60);

          if (p.x > w + 10) { particles.splice(i, 1); continue; }

          const pi0 = Math.floor(p.x / 2);
          const pi1 = Math.min(pi0 + 1, simPoints.length - 1);
          const frac = (p.x / 2) - pi0;
          const py = pi0 < simPoints.length ? simPoints[pi0] * (1 - frac) + simPoints[pi1] * frac : midY;

          const fadeIn = Math.min(age / 0.1, 1);
          const pAlpha = fadeIn * particleAlpha;

          for (let si = 0; si < sparks; si++) {
            const sparkSeed = ((p.birth + si * 7919) * 2654435761) >>> 0;
            const sx = p.x - (si + 1) * (3 + ((sparkSeed & 0xFF) / 255) * 4);
            const sy = py + (((sparkSeed >> 8) & 0xFF) / 255 - 0.5) * 5;
            const sparkAlpha = pAlpha * (0.5 - si * 0.08);
            if (sx > 0 && sx < w) {
              ctx.beginPath();
              ctx.arc(sx, sy, 0.7, 0, Math.PI * 2);
              ctx.fillStyle = `rgba(${sc.r},${sc.g},${sc.b},${sparkAlpha})`;
              ctx.fill();
            }
          }

          ctx.beginPath();
          ctx.arc(p.x, py, 1.8, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${sc.r},${sc.g},${sc.b},${pAlpha})`;
          ctx.fill();

          ctx.beginPath();
          ctx.arc(p.x, py, 0.6, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,255,255,${pAlpha * 0.5})`;
          ctx.fill();
        }

        if (particles.length > 30) particles.splice(0, particles.length - 30);
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
