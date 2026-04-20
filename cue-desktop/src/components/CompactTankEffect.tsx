/**
 * CompactTankEffect — three horizontal liquid-glass wave layers rising from
 * the bottom of the card as compaction progresses. Matches the Cue logo's
 * compacting row: a faint back wave (visible behind), a glassy mid wave, and
 * a solid periwinkle front wave.
 *
 *   back  (dark, faint, highest surface)   ← visible behind the others
 *   mid   (glassy translucent)              ← middle-height surface
 *   front (solid bright periwinkle)         ← lowest, brightest, nearest viewer
 *
 * A single <canvas> paints all three layers in painter's order so the stacking
 * creates the logo's parallax depth at the overlap regions.
 *
 * The parent (SessionCard) owns `fillRef` so the drain timer and the pulsing
 * bar stay in sync without React re-renders per frame.
 */
import { useEffect, useMemo, useRef } from "react";

interface CompactTankEffectProps {
  /** Fill fraction in [0, 1] — read every frame. Owned by the parent. */
  fillRef: React.RefObject<number>;
  /** Overall alpha multiplier applied to every layer. */
  alpha?: number;
  /** Ignored; retained for API compatibility with the previous signature. */
  color?: string;
}

// Palette mirrors the logo's compacting row: the back sits in the shadow,
// the mid adds a glass tint, the front carries the bright periwinkle.
//   topRGB / botRGB  — gradient anchors from the surface (top) to the card
//                       bottom. Front uses a highlight→base shift for the
//                       "bright crest, richer body" look; back/mid hold a
//                       single hue and vary only in opacity.
//   topAlpha / botAlpha  — per-layer opacity at surface and bottom.
//   baseHeight    – resting water height at fill=0 as a fraction of card
//                    height. Back starts lowest (tiny sliver at rest), front
//                    starts tallest. As fill→1 every surface rises together.
//   fillResponse – how aggressively this layer climbs with fill.
//   phaseRate    – wave time scale; differing rates desynchronize neighbors.
//   phaseSeed    – constant offset so layers don't crest at the same x.
//   ampScale     – amplitude multiplier on the layered-sine surface.
const LAYERS = [
  {
    topRGB: [88, 112, 168],  botRGB: [88, 112, 168],
    topAlpha: 0.35, botAlpha: 0.60,
    baseHeight: 0.18, fillResponse: 0.92, phaseRate: 0.65, phaseSeed: 0.0, ampScale: 0.55,
  },
  {
    topRGB: [116, 135, 198], botRGB: [116, 135, 198],
    topAlpha: 0.50, botAlpha: 0.78,
    baseHeight: 0.25, fillResponse: 0.96, phaseRate: 0.85, phaseSeed: 1.7, ampScale: 0.78,
  },
  {
    topRGB: [168, 184, 232], botRGB: [139, 159, 212],
    topAlpha: 0.72, botAlpha: 0.95,
    baseHeight: 0.32, fillResponse: 1.0,  phaseRate: 1.05, phaseSeed: 3.4, ampScale: 1.0,
  },
] as const;

export function CompactTankEffect({
  fillRef,
  alpha = 1.0,
}: CompactTankEffectProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const alphaRef = useRef(alpha);
  alphaRef.current = alpha;

  // Precompute rgba strings once per layer — avoids template-literal work on
  // every frame × layer × gradient-stop.
  const layerStyle = useMemo(
    () =>
      LAYERS.map((l) => ({
        topRGB: l.topRGB,
        botRGB: l.botRGB,
        topAlpha: l.topAlpha,
        botAlpha: l.botAlpha,
      })),
    [],
  );

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

    // Calm, logo-matching swell. Amplitudes measured as fractions of card
    // height so the motion scales with the card.
    const AMP1 = 0.020;  // primary — 2% of card height
    const AMP2 = 0.008;  // micro-ripple
    const AMP3 = 0.012;  // long swell
    const WAVE_K1 = (Math.PI * 2 * 1.3);
    const WAVE_K2 = (Math.PI * 2 * 2.8);
    const WAVE_K3 = (Math.PI * 2 * 0.55);
    const BOB_AMP = 0.004;
    const BOB_FREQ = 0.5;
    const STEP_X = 6;

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
      const A = alphaRef.current;

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, cssW, cssH);

      const sampleCount = Math.ceil(cssW / STEP_X) + 1;
      const xs = new Float32Array(sampleCount);
      const ys = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) xs[i] = Math.min(cssW, i * STEP_X);

      for (let li = 0; li < LAYERS.length; li++) {
        const layer = LAYERS[li];
        const style = layerStyle[li];
        const phase = reduced ? layer.phaseSeed : t * layer.phaseRate + layer.phaseSeed;
        const bob = reduced ? 0 : Math.sin(t * BOB_FREQ + layer.phaseSeed) * BOB_AMP * cssH;

        // seaY = height of the surface above the bottom. As fill rises, each
        // layer's surface climbs toward the top edge; relative offsets stay
        // constant, preserving the parallax stack.
        const seaY =
          cssH - (layer.baseHeight + layer.fillResponse * fill * (1 - layer.baseHeight)) * cssH
          + bob;

        const ampX1 = AMP1 * layer.ampScale * cssH;
        const ampX2 = AMP2 * layer.ampScale * cssH;
        const ampX3 = AMP3 * layer.ampScale * cssH;
        const invW = cssW > 0 ? 1 / cssW : 0;

        for (let i = 0; i < sampleCount; i++) {
          const x = xs[i];
          const u = x * invW;
          const w1 = Math.sin(u * WAVE_K1 + phase) * ampX1;
          const w2 = Math.sin(u * WAVE_K2 - phase * 1.4 + 1.7) * ampX2;
          const w3 = Math.sin(u * WAVE_K3 + phase * 0.55 + 3.1) * ampX3;
          ys[i] = seaY + w1 + w2 + w3;
        }

        // Two-stop vertical gradient: faint at the surface, richer toward the
        // card's bottom — this is what separates "solid" from "glassy" at a
        // glance. Front uses a hue shift (highlight → base) so the crest
        // glimmers without needing a stroke.
        const [tr, tg, tb] = style.topRGB;
        const [br, bg, bb] = style.botRGB;
        const topA = (style.topAlpha * A).toFixed(3);
        const botA = (style.botAlpha * A).toFixed(3);
        const grad = ctx.createLinearGradient(0, seaY, 0, cssH);
        grad.addColorStop(0, `rgba(${tr}, ${tg}, ${tb}, ${topA})`);
        grad.addColorStop(1, `rgba(${br}, ${bg}, ${bb}, ${botA})`);

        ctx.beginPath();
        ctx.moveTo(0, ys[0]);
        for (let i = 1; i < sampleCount - 1; i++) {
          const mx = (xs[i] + xs[i + 1]) * 0.5;
          const my = (ys[i] + ys[i + 1]) * 0.5;
          ctx.quadraticCurveTo(xs[i], ys[i], mx, my);
        }
        ctx.lineTo(cssW, ys[sampleCount - 1]);
        ctx.lineTo(cssW, cssH);
        ctx.lineTo(0, cssH);
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
  }, [fillRef, layerStyle]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 1, width: "100%", height: "100%", borderRadius: "inherit" }}
      aria-hidden
    />
  );
}
