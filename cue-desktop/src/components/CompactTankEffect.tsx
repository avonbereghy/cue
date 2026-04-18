/**
 * CompactTankEffect — three stacked liquid-glass wave layers that sweep
 * right-to-left behind the session card while it is compacting. Each layer
 * has its own phase rate, amplitude, color shade, and fill-response factor,
 * which produces a parallax illusion: the rear layers move noticeably slower
 * than the front during the drain, the way distant ridges read against
 * foreground waves.
 *
 * Per layer, three SVG <path>s are updated each frame via setAttribute:
 *   • a closed body filled with a vertical depth gradient
 *   • plus a single open crest stroke on the front layer (specular highlight)
 *
 * The leading-edge surface is built from three layered sines (slow swell +
 * main wave + micro-ripple) plus a slow horizontal bob, smoothed via
 * midpoint-quadratic Béziers. No noise library required.
 *
 * Percent-based viewBox (`0 0 100 100`) + `preserveAspectRatio="none"` lets
 * the shape stretch to the card's actual dimensions automatically.
 *
 * The parent (SessionCard) owns `fillRef` so the drain timer and the
 * pulsing bar stay in sync without React re-renders per frame.
 */
import { useEffect, useId, useMemo, useRef } from "react";

interface CompactTankEffectProps {
  /** Fill fraction in [0, 1] — read every frame. Owned by the parent. */
  fillRef: React.RefObject<number>;
  /** Front-layer fill color (hex). Back layers derive darker variants. */
  color?: string;
  /** Front-layer fill alpha. Back layers scale this down. */
  alpha?: number;
}

// Each layer is a parallax slice of the liquid. Back layers (index 0) sit
// further left, oscillate slower and lower amplitude, render dimmer/cooler.
// Front layer (last) carries the bright crest highlight.
//   offset       – static x shift in viewBox units (negative = behind)
//   fillResponse – how much the layer tracks fill changes (back lags front)
//   phaseRate    – wave time scale; differing rates desynchronize neighbors
//   phaseSeed    – constant offset so layers don't crest at the same y
//   ampScale     – amplitude multiplier on the layered-sine surface
//   alphaScale   – multiplier applied to the gradient stop opacities
//   brightness   – channel multiplier on `color` for the layer's fill
//   hasCrest     – render the white specular crest stroke (front only)
const LAYERS = [
  { offset: -7,   fillResponse: 0.92, phaseRate: 0.65, phaseSeed: 0.0, ampScale: 0.55, alphaScale: 0.45, brightness: 0.65, hasCrest: false },
  { offset: -3.5, fillResponse: 0.96, phaseRate: 0.85, phaseSeed: 1.7, ampScale: 0.78, alphaScale: 0.72, brightness: 0.82, hasCrest: false },
  { offset: 0,    fillResponse: 1.0,  phaseRate: 1.05, phaseSeed: 3.4, ampScale: 1.0,  alphaScale: 1.0,  brightness: 1.0,  hasCrest: true  },
] as const;

function shadeHex(hex: string, factor: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const r = Math.max(0, Math.min(255, Math.round(((v >> 16) & 255) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(((v >> 8) & 255) * factor)));
  const b = Math.max(0, Math.min(255, Math.round((v & 255) * factor)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

export function CompactTankEffect({
  fillRef,
  color = "#8b9fd4",
  alpha = 0.28,
}: CompactTankEffectProps) {
  const bodyRefs = useRef<(SVGPathElement | null)[]>([]);
  const crestRef = useRef<SVGPathElement>(null);
  // useId can include `:` which is valid in SVG IDs but trips some
  // tooling — strip them defensively for the gradient url() reference.
  const idBase = `liquid-${useId().replace(/:/g, "")}`;
  const gradientIds = useMemo(
    () => LAYERS.map((_, i) => `${idBase}-${i}`),
    [idBase],
  );
  const layerColors = useMemo(
    () => LAYERS.map((l) => shadeHex(color, l.brightness)),
    [color],
  );

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
    // a noise table. Amplitudes sum to ~4 units worst-case (front layer).
    const AMP1 = 2.0;        // primary wave
    const AMP2 = 0.7;        // micro-ripple (high freq)
    const AMP3 = 1.4;        // slow swell (low freq)
    const WAVE_K1 = (Math.PI * 2 * 0.9) / 100;  // ~0.9 wavelengths top-to-bottom
    const WAVE_K2 = (Math.PI * 2 * 2.3) / 100;  // ~2.3 wavelengths
    const WAVE_K3 = (Math.PI * 2 * 0.4) / 100;  // ~0.4 wavelengths (long swell)
    const BOB_AMP = 0.5;     // horizontal "breathing" of the surface center
    const BOB_FREQ = 0.6;
    const STEP_Y = 4;        // dense enough that Bézier smoothing reads as a curve

    const sampleCount = Math.floor(100 / STEP_Y) + 1;
    const xs = new Float32Array(sampleCount);
    const ys = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) ys[i] = Math.min(100, i * STEP_Y);

    const updateLayer = (layerIndex: number, fill: number, t: number) => {
      const layer = LAYERS[layerIndex];
      const phase = reduced ? layer.phaseSeed : t * layer.phaseRate + layer.phaseSeed;
      const bob = reduced ? 0 : Math.sin(t * BOB_FREQ + layer.phaseSeed) * BOB_AMP;
      const centerX = fill * 100 * layer.fillResponse + layer.offset + bob;

      for (let i = 0; i < sampleCount; i++) {
        const y = ys[i];
        const w1 = Math.sin(y * WAVE_K1 + phase) * AMP1 * layer.ampScale;
        const w2 = Math.sin(y * WAVE_K2 - phase * 1.4 + 1.7) * AMP2 * layer.ampScale;
        const w3 = Math.sin(y * WAVE_K3 + phase * 0.55 + 3.1) * AMP3 * layer.ampScale;
        xs[i] = centerX + w1 + w2 + w3;
      }

      // Build body (closed shape, fills the area west of the surface) and,
      // on the front layer only, the open crest polyline. Midpoint-quadratic
      // Béziers produce a continuous C1 curve through the sample points.
      const x0 = xs[0].toFixed(2);
      const y0 = ys[0];
      let bodyD = `M0 0 L${x0} ${y0}`;
      let crestD = layer.hasCrest ? `M${x0} ${y0}` : "";
      for (let i = 1; i < sampleCount - 1; i++) {
        const x1 = xs[i];
        const y1 = ys[i];
        const x2 = xs[i + 1];
        const y2 = ys[i + 1];
        const mx = ((x1 + x2) / 2).toFixed(2);
        const my = ((y1 + y2) / 2).toFixed(0);
        const seg = ` Q${x1.toFixed(2)} ${y1} ${mx} ${my}`;
        bodyD += seg;
        if (layer.hasCrest) crestD += seg;
      }
      const xL = xs[sampleCount - 1].toFixed(2);
      const yL = ys[sampleCount - 1];
      bodyD += ` L${xL} ${yL} L0 100 Z`;

      bodyRefs.current[layerIndex]?.setAttribute("d", bodyD);
      if (layer.hasCrest) {
        crestD += ` L${xL} ${yL}`;
        crestRef.current?.setAttribute("d", crestD);
      }
    };

    const tick = () => {
      if (!running) return;
      const fill = Math.max(0, Math.min(1, fillRef.current ?? 0));
      const t = (performance.now() - startT) / 1000;
      for (let i = 0; i < LAYERS.length; i++) updateLayer(i, fill, t);
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
  // (light penetrates the surface), bottom is denser. The crest is a bright
  // meniscus highlight on the front layer only.
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
        {LAYERS.map((layer, i) => (
          <linearGradient key={gradientIds[i]} id={gradientIds[i]} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={layerColors[i]} stopOpacity={topAlpha * layer.alphaScale} />
            <stop offset="32%" stopColor={layerColors[i]} stopOpacity={midAlpha * layer.alphaScale} />
            <stop offset="100%" stopColor={layerColors[i]} stopOpacity={Math.min(1, bottomAlpha * layer.alphaScale)} />
          </linearGradient>
        ))}
      </defs>
      {LAYERS.map((_, i) => (
        <path
          key={gradientIds[i]}
          ref={(el) => { bodyRefs.current[i] = el; }}
          fill={`url(#${gradientIds[i]})`}
        />
      ))}
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
