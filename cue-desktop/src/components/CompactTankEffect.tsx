/**
 * CompactTankEffect — a vertical liquid-glass surface that sweeps right-to-left
 * behind the session card while it is compacting. Everything west of the
 * surface is filled (periwinkle gradient with a bright specular crest on the
 * leading edge); everything east is transparent, so the "glass" visibly drains
 * toward the left edge as `fillRef` drops 1 → 0.
 *
 * Three SVG layers are updated each frame via setAttribute:
 *   1. Body — closed gradient-filled shape (light top, denser bottom = depth)
 *   2. Crest — open stroke along just the leading edge = specular highlight
 *
 * The surface uses three layered sines (slow swell + main wave + micro-ripple)
 * plus a slow horizontal bob, smoothed via midpoint-quadratic Béziers. This
 * produces organic motion without importing a noise library.
 *
 * Percent-based viewBox (`0 0 100 100`) + `preserveAspectRatio="none"` lets
 * the shape stretch to the card's actual dimensions automatically.
 *
 * The parent (SessionCard) owns `fillRef` so the drain timer and the
 * pulsing bar stay in sync without React re-renders per frame.
 */
import { useEffect, useId, useRef } from "react";

interface CompactTankEffectProps {
  /** Fill fraction in [0, 1] — read every frame. Owned by the parent. */
  fillRef: React.RefObject<number>;
  /** Fill color (hex). Defaults to periwinkle that matches the compacting theme. */
  color?: string;
  /** Fill alpha. Gradient stops + crest opacity derive from this. */
  alpha?: number;
}

export function CompactTankEffect({
  fillRef,
  color = "#8b9fd4",
  alpha = 0.28,
}: CompactTankEffectProps) {
  const bodyRef = useRef<SVGPathElement>(null);
  const crestRef = useRef<SVGPathElement>(null);
  // useId can include `:` which is valid in SVG IDs but trips some
  // tooling — strip them defensively for the gradient url() reference.
  const gradientId = `liquid-${useId().replace(/:/g, "")}`;

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = mql.matches;
    const onChange = () => { reduced = mql.matches; };
    mql.addEventListener("change", onChange);

    const startT = performance.now();
    let rafId = 0;
    let running = true;

    // Multi-octave surface in viewBox units (0..100). Layered sines at
    // different frequencies/phases produce organic-looking motion without
    // a noise table. Amplitudes sum to ~4 units worst-case.
    const AMP1 = 2.0;        // primary wave
    const AMP2 = 0.7;        // micro-ripple (high freq)
    const AMP3 = 1.4;        // slow swell (low freq)
    const WAVE_K1 = (Math.PI * 2 * 0.9) / 100;  // ~0.9 wavelengths top-to-bottom
    const WAVE_K2 = (Math.PI * 2 * 2.3) / 100;  // ~2.3 wavelengths
    const WAVE_K3 = (Math.PI * 2 * 0.4) / 100;  // ~0.4 wavelengths (long swell)
    const BOB_AMP = 0.5;     // horizontal "breathing" of the surface center
    const BOB_FREQ = 0.6;
    const PHASE_RATE = 1.05; // slower than a marching sine — feels fluid
    const STEP_Y = 4;        // dense enough that Bézier smoothing reads as a curve

    const updatePaths = (fill: number, t: number) => {
      const phase = reduced ? 0 : t * PHASE_RATE;
      const bob = reduced ? 0 : Math.sin(t * BOB_FREQ) * BOB_AMP;
      const centerX = fill * 100 + bob;

      // Sample the surface
      const xs: number[] = new Array(Math.floor(100 / STEP_Y) + 1);
      const ys: number[] = new Array(xs.length);
      let idx = 0;
      for (let y = 0; y <= 100; y += STEP_Y) {
        const w1 = Math.sin(y * WAVE_K1 + phase) * AMP1;
        const w2 = Math.sin(y * WAVE_K2 - phase * 1.4 + 1.7) * AMP2;
        const w3 = Math.sin(y * WAVE_K3 + phase * 0.55 + 3.1) * AMP3;
        xs[idx] = centerX + w1 + w2 + w3;
        ys[idx] = y;
        idx++;
      }

      // Build body (closed shape, fills the area west of the surface) and
      // crest (open polyline along just the surface) in one pass via shared
      // midpoint-quadratic Bézier segments. Midpoint smoothing produces a
      // continuous C1 curve through the sample points.
      const x0 = xs[0].toFixed(2);
      const y0 = ys[0];
      let bodyD = `M0 0 L${x0} ${y0}`;
      let crestD = `M${x0} ${y0}`;
      for (let i = 1; i < idx - 1; i++) {
        const x1 = xs[i];
        const y1 = ys[i];
        const x2 = xs[i + 1];
        const y2 = ys[i + 1];
        const mx = ((x1 + x2) / 2).toFixed(2);
        const my = ((y1 + y2) / 2).toFixed(0);
        const seg = ` Q${x1.toFixed(2)} ${y1} ${mx} ${my}`;
        bodyD += seg;
        crestD += seg;
      }
      const xL = xs[idx - 1].toFixed(2);
      const yL = ys[idx - 1];
      bodyD += ` L${xL} ${yL} L0 100 Z`;
      crestD += ` L${xL} ${yL}`;

      bodyRef.current?.setAttribute("d", bodyD);
      crestRef.current?.setAttribute("d", crestD);
    };

    const tick = () => {
      if (!running) return;
      const fill = Math.max(0, Math.min(1, fillRef.current ?? 0));
      const t = (performance.now() - startT) / 1000;
      updatePaths(fill, t);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      running = false;
      cancelAnimationFrame(rafId);
      mql.removeEventListener("change", onChange);
    };
  }, [fillRef]);

  // Gradient depth scales with the prop alpha. Top is more translucent
  // (light penetrates the surface), bottom is denser (deep water reads as
  // less transparent). The crest is a bright meniscus highlight.
  const topAlpha = alpha * 0.55;
  const midAlpha = alpha * 0.95;
  const bottomAlpha = Math.min(1, alpha * 1.5);
  const crestAlpha = Math.min(1, alpha * 1.7);

  return (
    <svg
      className="absolute inset-0 pointer-events-none"
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
      style={{ zIndex: 1, width: "100%", height: "100%" }}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={topAlpha} />
          <stop offset="32%" stopColor={color} stopOpacity={midAlpha} />
          <stop offset="100%" stopColor={color} stopOpacity={bottomAlpha} />
        </linearGradient>
      </defs>
      <path ref={bodyRef} fill={`url(#${gradientId})`} />
      <path
        ref={crestRef}
        fill="none"
        stroke="#ffffff"
        strokeOpacity={crestAlpha}
        strokeWidth={1.2}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
