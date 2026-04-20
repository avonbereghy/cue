/**
 * CompactTankEffect — three vertical liquid-glass wave layers sweeping
 * left→right across the card. As the compaction progresses (fill 0 → 1
 * over ~2 min) the water boundary marches from the left edge toward
 * the right, with a gently wavy vertical surface.
 *
 * Single <canvas> drives all three wave layers so we don't pay the DOM cost
 * of per-frame SVG attribute writes.
 *
 * The parent (SessionCard) owns `fillRef` so the drain timer and the pulsing
 * bar stay in sync without React re-renders per frame.
 */
import { useEffect, useMemo, useRef } from "react";

interface CompactTankEffectProps {
  /** Fill fraction in [0, 1] — read every frame. Owned by the parent. */
  fillRef: React.RefObject<number>;
  /** Front-layer fill color (hex). Back layers derive darker variants. */
  color?: string;
  /** Front-layer fill alpha. Back layers scale this down. */
  alpha?: number;
}

// Parallax layers. Back layer (index 0) sits further left (smaller base
// width — starts as a thinner sliver on the left edge), smaller amplitude,
// dimmer. Front layer (last) is the most prominent.
//   baseWidth    – resting width of the layer's water column as fraction of
//                  card width when fill=0. Front extends furthest right (0.32),
//                  back is a thin strip (0.18).
//   fillResponse – how aggressively the layer marches right with `fill`. Front
//                  tracks most closely; back lags so the parallax reads.
//   phaseRate    – wave time scale; differing rates desynchronize neighbors.
//   phaseSeed    – constant offset so layers don't crest at the same y.
//   ampScale     – amplitude multiplier on the layered-sine surface.
//   alphaScale   – multiplier applied to the gradient stop opacities.
//   brightness   – channel multiplier on `color` for the layer's fill.
const LAYERS = [
  { baseWidth: 0.18, fillResponse: 0.92, phaseRate: 0.65, phaseSeed: 0.0, ampScale: 0.55, alphaScale: 0.45, brightness: 0.65 },
  { baseWidth: 0.25, fillResponse: 0.96, phaseRate: 0.85, phaseSeed: 1.7, ampScale: 0.78, alphaScale: 0.72, brightness: 0.82 },
  { baseWidth: 0.32, fillResponse: 1.0,  phaseRate: 1.05, phaseSeed: 3.4, ampScale: 1.0,  alphaScale: 1.0,  brightness: 1.0 },
] as const;

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace("#", ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function shadeRgb(rgb: [number, number, number], factor: number): [number, number, number] {
  return [
    Math.max(0, Math.min(255, Math.round(rgb[0] * factor))),
    Math.max(0, Math.min(255, Math.round(rgb[1] * factor))),
    Math.max(0, Math.min(255, Math.round(rgb[2] * factor))),
  ];
}

export function CompactTankEffect({
  fillRef,
  color = "#8b9fd4",
  alpha = 0.28,
}: CompactTankEffectProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const layerRgb = useMemo(() => {
    const base = hexToRgb(color);
    return LAYERS.map((l) => shadeRgb(base, l.brightness));
  }, [color]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = mql.matches;
    const onChange = () => { reduced = mql.matches; };
    mql.addEventListener("change", onChange);

    const startT = performance.now();
    let rafId = 0;
    let running = true;

    // Multi-octave surface — amplitudes in pixels on the card's actual width.
    // Kept subtle so the waves read as "gentle tide," not "stormy sea."
    const AMP1 = 0.020;  // primary — 2.0% of card width
    const AMP2 = 0.008;  // micro-ripple
    const AMP3 = 0.012;  // long swell
    const WAVE_K1 = (Math.PI * 2 * 0.9);    // ~0.9 wavelengths down the height
    const WAVE_K2 = (Math.PI * 2 * 2.2);
    const WAVE_K3 = (Math.PI * 2 * 0.4);
    const BOB_AMP = 0.004;  // horizontal "breathing"
    const BOB_FREQ = 0.5;
    const STEP_Y = 4;       // sample spacing in pixels — Bézier smoothing fills the gaps

    const tick = () => {
      if (!running) return;
      const rect = canvas.getBoundingClientRect();
      const cssW = rect.width;
      const cssH = rect.height;
      if (cssW < 1 || cssH < 1) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      const bw = Math.round(cssW * dpr);
      const bh = Math.round(cssH * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }

      const fill = Math.max(0, Math.min(1, fillRef.current ?? 0));
      const t = reduced ? 0 : (performance.now() - startT) / 1000;

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, cssW, cssH);

      const sampleCount = Math.ceil(cssH / STEP_Y) + 1;
      const ys = new Float32Array(sampleCount);
      const xs = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) ys[i] = Math.min(cssH, i * STEP_Y);

      for (let li = 0; li < LAYERS.length; li++) {
        const layer = LAYERS[li];
        const [lr, lg, lb] = layerRgb[li];
        const phase = reduced ? layer.phaseSeed : t * layer.phaseRate + layer.phaseSeed;
        const bob = reduced ? 0 : Math.sin(t * BOB_FREQ + layer.phaseSeed) * BOB_AMP * cssW;

        // Resting water boundary at fill=0 sits at x = cssW * baseWidth —
        // a thin sliver on the left edge. As fill rises to 1, the boundary
        // marches rightward to x=cssW (fully covered).
        const seaX =
          (layer.baseWidth + layer.fillResponse * fill * (1 - layer.baseWidth)) * cssW
          + bob;

        const ampX1 = AMP1 * layer.ampScale * cssW;
        const ampX2 = AMP2 * layer.ampScale * cssW;
        const ampX3 = AMP3 * layer.ampScale * cssW;
        const invH = cssH > 0 ? 1 / cssH : 0;

        for (let i = 0; i < sampleCount; i++) {
          const y = ys[i];
          const u = y * invH;
          const w1 = Math.sin(u * WAVE_K1 + phase) * ampX1;
          const w2 = Math.sin(u * WAVE_K2 - phase * 1.4 + 1.7) * ampX2;
          const w3 = Math.sin(u * WAVE_K3 + phase * 0.55 + 3.1) * ampX3;
          xs[i] = seaX + w1 + w2 + w3;
        }

        // Horizontal gradient: soft near the surface (right edge of water),
        // denser toward the far left edge.
        const topAlpha = alpha * 0.55 * layer.alphaScale;
        const midAlpha = alpha * 0.95 * layer.alphaScale;
        const botAlpha = Math.min(1, alpha * 1.5 * layer.alphaScale);
        const grad = ctx.createLinearGradient(seaX, 0, 0, 0);
        grad.addColorStop(0,    `rgba(${lr}, ${lg}, ${lb}, ${topAlpha.toFixed(3)})`);
        grad.addColorStop(0.32, `rgba(${lr}, ${lg}, ${lb}, ${midAlpha.toFixed(3)})`);
        grad.addColorStop(1,    `rgba(${lr}, ${lg}, ${lb}, ${botAlpha.toFixed(3)})`);

        // Polygon: top-right of water → wavy descent down the surface →
        // bottom-right → bottom-left → top-left → close.
        ctx.beginPath();
        ctx.moveTo(xs[0], 0);
        for (let i = 1; i < sampleCount - 1; i++) {
          const my = (ys[i] + ys[i + 1]) * 0.5;
          const mx = (xs[i] + xs[i + 1]) * 0.5;
          ctx.quadraticCurveTo(xs[i], ys[i], mx, my);
        }
        ctx.lineTo(xs[sampleCount - 1], cssH);
        ctx.lineTo(0, cssH);
        ctx.lineTo(0, 0);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }

      ctx.restore();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      running = false;
      cancelAnimationFrame(rafId);
      mql.removeEventListener("change", onChange);
    };
  }, [fillRef, color, alpha, layerRgb]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 1, width: "100%", height: "100%", borderRadius: "inherit" }}
      aria-hidden
    />
  );
}
