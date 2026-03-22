import { useRef, useEffect } from "react";
import { getFrequencyData, isPlaying } from "@/lib/presetEngine";

/**
 * Signal String — animated separator with two modes:
 * 1. Simulated: title letter "strikes" send damped traveling wave pulses
 * 2. Preset: extracted frequency envelope data drives displacement
 * Uses tanh activation to smoothly bound the result.
 */

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
}

export function SignalString({ state, frequency = 1.0, revived = false, pulses, signalMode = "simulated", signalAlpha = 0.25, signalAmplitude = 0.25, signalEcho = 1.0, signalBass = true, signalMids = true, signalTreble = true }: SignalStringProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);

  const isActive = state === "working" || state === "subagent" || state === "error";
  const isAudio = signalMode === "preset" || signalMode === "audio";
  // Track energy level for smooth decay when session stops
  const energyRef = useRef(0);
  // Track when session became inactive for decay timing
  const deactivatedAtRef = useRef<number | null>(null);
  // Driven oscillator state: position + velocity per mode per band (max 3 bands × 6 modes)
  const modeStateRef = useRef<{ pos: Float64Array; vel: Float64Array } | null>(null);
  const lastFrameRef = useRef<number>(0);

  useEffect(() => {
    if (isActive) {
      deactivatedAtRef.current = null;
    }
  }, [isActive]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isDark = document.documentElement.getAttribute("data-theme") !== "light";

    const a = signalAlpha;
    const strokeColor = revived
      ? `rgba(239, 68, 68, ${0.4 * a})`
      : isDark ? `rgba(255, 255, 255, ${0.4 * a})` : `rgba(0, 0, 0, ${0.35 * a})`;
    const flatColor = revived
      ? `rgba(239, 68, 68, ${0.5 * a})`
      : isDark ? `rgba(255, 255, 255, ${0.35 * a})` : `rgba(0, 0, 0, ${0.3 * a})`;

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

    const drawFlatLine = (w: number, midY: number) => {
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(w, midY);
      ctx.strokeStyle = flatColor;
      ctx.lineWidth = 1;
      ctx.stroke();
    };

    const draw = (now: number) => {
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const midY = h / 2;
      const halfH = h / 2 - 1;

      ctx.clearRect(0, 0, w, h);

      // Flat line for revived or reduced motion — no animation
      if (revived || prefersReducedMotion) {
        drawFlatLine(w, midY);
        return;
      }

      // ── Audio mode: 3 strings (bass / mids / highs) with time accumulation ──
      if (isAudio) {
        // Audio not loaded/playing yet — show flat line and keep polling
        if (!isPlaying()) {
          drawFlatLine(w, midY);
          animRef.current = requestAnimationFrame(draw);
          return;
        }
        const freqData = getFrequencyData();
        const numBins = freqData.length;
        const t = now / 1000;

        // Decay envelope: when session stops, smoothly fade out over ~2 seconds
        let decayEnvelope = 1.0;
        if (!isActive) {
          if (deactivatedAtRef.current === null) {
            deactivatedAtRef.current = now;
          }
          const elapsed = (now - deactivatedAtRef.current) / 1000;
          decayEnvelope = Math.exp(-elapsed * 2.0); // ~2s decay
          if (decayEnvelope < 0.005) {
            drawFlatLine(w, midY);
            energyRef.current = 0;
            animRef.current = requestAnimationFrame(draw);
            return;
          }
        }

        // Three strings with DIFFERENT spatial modes so they visually separate:
        // Bass: harmonics 1-3 (wide lobes) + leftward travel
        // Mids: harmonics 2-5 (medium)     + standing
        // Treble: harmonics 4-9 (tight)    + rightward travel
        const amp = signalAmplitude;
        const allBands = [
          { enabled: signalBass, binStart: 0, binEnd: Math.floor(numBins * 0.25), startMode: 1, numModes: 3, speed: 0.7, travel: -0.3, phaseOff: 0, gain: 2.2 * amp, lw: 1.5, opacity: 0.3 },
          { enabled: signalMids, binStart: Math.floor(numBins * 0.25), binEnd: Math.floor(numBins * 0.6), startMode: 2, numModes: 4, speed: 1.4, travel: 0, phaseOff: 2.1, gain: 1.8 * amp, lw: 1.0, opacity: 0.25 },
          { enabled: signalTreble, binStart: Math.floor(numBins * 0.6), binEnd: numBins, startMode: 4, numModes: 6, speed: 2.8, travel: 0.4, phaseOff: 4.5, gain: 1.5 * amp, lw: 0.75, opacity: 0.2 },
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

        // Oscillator constants — stiffness controls response speed, damping prevents ringing
        const STIFFNESS = 120;
        const DAMPING = 10;

        const numTrails = Math.max(1, Math.round(32 * signalEcho));
        const trailSpacing = 0.018;

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
            const target = Math.sqrt(raw);

            // Driven oscillator: position tracks target with inertia
            const idx = bi * 6 + m;
            const force = (target - ms.pos[idx]) * STIFFNESS - ms.vel[idx] * DAMPING;
            ms.vel[idx] += force * dt;
            ms.pos[idx] += ms.vel[idx] * dt;
            // Clamp to prevent overshoot beyond reasonable bounds
            ms.pos[idx] = Math.max(0, Math.min(1.5, ms.pos[idx]));
            modeAmps.push(ms.pos[idx]);
          }

          for (let trail = 0; trail < numTrails; trail++) {
            const tOff = t - trail * trailSpacing;
            const alpha = 1.0 - (trail / numTrails);
            // Trail 0 is the main line (always full opacity), trails 1+ are echoes
            const echoFade = trail === 0 ? 1.0 : signalEcho;
            const op = alpha * alpha * band.opacity * signalAlpha * echoFade;

            ctx.beginPath();
            for (let x = 0; x <= w; x += 2) {
              let sum = 0;
              const xNorm = x / w;

              for (let m = 0; m < band.numModes; m++) {
                const n = band.startMode + m;
                const amp = modeAmps[m];
                // Standing wave + traveling component
                const standing = Math.sin(n * Math.PI * xNorm);
                const traveling = Math.sin(n * Math.PI * xNorm - band.travel * tOff * n);
                const spatial = standing * 0.6 + traveling * 0.4;
                const temporal = Math.cos(tOff * (band.speed + m * 0.35) + band.phaseOff + m * 1.9);
                sum += amp * spatial * temporal;
              }

              const y = Math.tanh(sum * band.gain) * halfH * decayEnvelope;
              if (x === 0) ctx.moveTo(x, midY + y);
              else ctx.lineTo(x, midY + y);
            }

            const c = isDark ? `rgba(255,255,255,${op})` : `rgba(0,0,0,${op * 0.8})`;
            ctx.strokeStyle = c;
            ctx.lineWidth = trail === 0 ? band.lw : band.lw * 0.6;
            ctx.stroke();
          }
        }

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

      // Inactive with no pulses to drain — flat line, stop animation
      if (!isActive && !hasPulses) {
        drawFlatLine(w, midY);
        return;
      }

      // Physics parameters scaled by frequency
      const f = frequency;
      const speed = f * 600;
      const omega = f * 20;
      const physDecay = 1.2 + f * 0.4;

      ctx.beginPath();

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

        if (x === 0) {
          ctx.moveTo(x, midY + y);
        } else {
          ctx.lineTo(x, midY + y);
        }
      }

      ctx.strokeStyle = hasPulses ? strokeColor : flatColor;
      ctx.lineWidth = 1;
      ctx.stroke();

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animRef.current);
      observer.disconnect();
    };
  }, [state, isActive, frequency, revived, pulses, isAudio, signalAlpha, signalAmplitude, signalEcho, signalBass, signalMids, signalTreble]);

  if (isAudio) {
    // Audio mode: full-card background canvas
    return (
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        aria-hidden="true"
      />
    );
  }

  // Simulated mode: separator with overflow
  return (
    <div className="relative w-full" style={{ height: "12px" }}>
      <canvas
        ref={canvasRef}
        className="absolute left-0 w-full pointer-events-none"
        style={{ height: "60px", top: "-24px" }}
        aria-hidden="true"
      />
    </div>
  );
}
