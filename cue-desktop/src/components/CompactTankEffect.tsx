/**
 * CompactTankEffect — three overlapping translucent glass ribbons whose
 * trailing edges recede right→left as compaction drains the tank.
 *
 *   back   (deep ocean blue, most transparent, trails furthest right)
 *   mid    (sky blue)
 *   front  (ice, most opaque, leads — catches the meniscus light)
 *
 * Each layer covers [0 .. trailingEdge]. As `fill` drops from 1→0 the
 * trailing edge sweeps leftward, so the right side of the card empties
 * first and the fluid appears to drain off the right edge. The three
 * layers stagger so the back ribbon trails furthest right at any moment,
 * giving the overlapping-glass look.
 *
 * A thin bright highlight traces each trailing edge for the glass-meniscus
 * sheen; translucent fills let the dark card show through and stack-tint
 * where two or three layers overlap.
 *
 * The parent (SessionCard) owns `fillRef` so the drain timer and any
 * pulsing UI stay in sync without React re-renders per frame.
 */
import { useEffect, useRef } from "react";
import { usePageVisible } from "@/hooks/usePageVisible";
import { useOnScreen } from "@/hooks/useOnScreen";

interface CompactTankEffectProps {
  /** Fill fraction in [0, 1] — read every frame. Owned by the parent. */
  fillRef: React.RefObject<number>;
  /** Overall alpha multiplier applied to every layer. */
  alpha?: number;
  /** Ignored; retained for API compatibility. */
  color?: string;
}

// Each layer is a translucent glass ribbon covering [0 .. trailEdge].
//   rgb           – periwinkle-family tint; alpha carries the glass feel
//   baseAlpha     – per-layer opacity. Kept low so overlap stacks and the
//                    wallpaper still reads through.
//   trailReach    – how much the trailing edge recedes over fill 1→0, as a
//                    fraction of card width.
//   trailBias     – at fill=1, final edge position = trailBias + trailReach.
//                    Kept ≤ 1.0 so the liquid stays trapped inside the right
//                    wall instead of bleeding past it.
//   waveAmpFrac   – primary harmonic amplitude at the trailing edge, as a
//                    fraction of card WIDTH.
//   waveFreq      – primary-harmonic cycles vertically across card height.
//   waveAmp2Frac  – secondary harmonic amplitude (creates non-repeating,
//                    fluid-looking wave shapes instead of pure sine).
//   waveFreq2     – secondary-harmonic cycles (must be non-integer ratio to
//                    waveFreq so crests never align twice).
//   phaseRate     – drift speed of primary harmonic (rad/s).
//   phaseSeed     – constant phase offset so layers don't crest together.
//   highlightAlpha – opacity of the bright glass edge highlight (0 disables).
//
// All three layers share nearly the same trailing position and drain together
// — the back/mid/front separation is ~4% of width, read as stacked meniscus
// bands on one body of fluid rather than three independent walls. Wave
// variety comes from phase and harmonic content, not trail-position spread.
const LAYERS = [
  // back — deep ocean (reads as the body of fluid behind the meniscus)
  {
    rgb: [14, 38, 92],
    baseAlpha: 0.26,
    trailReach: 1.0,
    trailBias: 0.0,          // edge sits flush at right wall at fill=1
    waveAmpFrac: 0.010,
    waveFreq: 0.95,
    waveAmp2Frac: 0.004,
    waveFreq2: 2.3,
    phaseRate: 0.32,
    phaseSeed: 0.0,
    highlightAlpha: 0.0,
  },
  // mid — sky blue (just inside back, creates the first meniscus band)
  {
    rgb: [110, 170, 225],
    baseAlpha: 0.18,
    trailReach: 0.98,
    trailBias: -0.02,        // ~2% inside back edge at fill=1
    waveAmpFrac: 0.011,
    waveFreq: 1.15,
    waveAmp2Frac: 0.005,
    waveFreq2: 2.9,
    phaseRate: 0.48,
    phaseSeed: 1.9,
    highlightAlpha: 0.22,
  },
  // front — ice (brightest meniscus, leads by a hair)
  {
    rgb: [200, 225, 245],
    baseAlpha: 0.14,
    trailReach: 0.96,
    trailBias: -0.04,        // ~4% inside back edge at fill=1
    waveAmpFrac: 0.009,
    waveFreq: 1.45,
    waveAmp2Frac: 0.004,
    waveFreq2: 3.4,
    phaseRate: 0.62,
    phaseSeed: 3.3,
    highlightAlpha: 0.38,
  },
] as const;

export function CompactTankEffect({
  fillRef,
  alpha = 1.0,
}: CompactTankEffectProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const alphaRef = useRef(alpha);
  alphaRef.current = alpha;
  const pageVisible = usePageVisible();
  const onScreen = useOnScreen(canvasRef);
  const renderActive = pageVisible && onScreen;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Skip the entire tick loop when the card is off-screen or the tab is
    // hidden — compaction is a long-running state, so an off-screen card
    // would otherwise burn 60fps of canvas draws for no visible benefit.
    if (!renderActive) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = mql.matches;
    const onChange = () => { reduced = mql.matches; };
    mql.addEventListener("change", onChange);

    const startT = performance.now();
    let rafId = 0;
    let running = true;

    // Sample resolution along Y — cards are short; 4px is plenty smooth.
    const STEP_Y = 4;

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

      const sampleCount = Math.ceil(cssH / STEP_Y) + 1;
      const ys = new Float32Array(sampleCount);
      const xs = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) ys[i] = Math.min(cssH, i * STEP_Y);

      // Paint back → front so front layer reads as the brightest crest.
      for (let li = 0; li < LAYERS.length; li++) {
        const layer = LAYERS[li];
        const phase = reduced ? layer.phaseSeed : t * layer.phaseRate + layer.phaseSeed;

        // Trailing edge (the right boundary of this layer's fill).
        //   extent = fraction of card width this layer currently covers,
        //            clamped to [0, 1] so the liquid is trapped inside the
        //            right wall instead of bleeding past it.
        //   baseX  = centerline of the trailing edge for this frame (px)
        //   ampX   = primary-harmonic amplitude (px)
        //   ampX2  = secondary-harmonic amplitude (px); combined with a
        //            non-integer frequency ratio, this breaks the pure-sine
        //            look and gives a natural fluid meniscus.
        const extent = Math.max(0, Math.min(1, layer.trailBias + fill * layer.trailReach));
        const baseX = extent * cssW;
        const ampX = layer.waveAmpFrac * cssW;
        const ampX2 = layer.waveAmp2Frac * cssW;
        const invH = cssH > 0 ? 1 / cssH : 0;
        const kY = Math.PI * 2 * layer.waveFreq;
        const kY2 = Math.PI * 2 * layer.waveFreq2;
        const phase2 = phase * 1.37 + 0.9;  // drift secondary out of sync

        for (let i = 0; i < sampleCount; i++) {
          const v = ys[i] * invH;
          const w = Math.sin(v * kY + phase) * ampX
                  + Math.sin(v * kY2 + phase2) * ampX2;
          // Clamp to card so crests never poke past the right wall
          const x = baseX + w;
          xs[i] = x < 0 ? 0 : (x > cssW ? cssW : x);
        }

        // Fill the region to the left of the trailing edge.
        // Horizontal gradient: brighter at the trailing edge (right side),
        // fading toward the left — the meniscus catches light, the body
        // reads as translucent glass depth.
        const [r, g, b] = layer.rgb;
        const baseA = layer.baseAlpha * A;
        const edgeA = baseA * 1.75;           // brighter trailing-edge sheen (glass)
        const tailA = baseA * 0.45;           // very thin body so wallpaper reads through

        // Gradient anchored so the bright band travels with the trailing edge.
        const gradLeft = 0;
        const gradRight = Math.min(cssW, baseX + ampX);
        if (gradRight > gradLeft) {
          const grad = ctx.createLinearGradient(gradLeft, 0, gradRight, 0);
          grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${tailA.toFixed(3)})`);
          grad.addColorStop(0.65, `rgba(${r}, ${g}, ${b}, ${baseA.toFixed(3)})`);
          grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, ${edgeA.toFixed(3)})`);
          ctx.fillStyle = grad;
        } else {
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${baseA.toFixed(3)})`;
        }

        // Closed path: top wall, trailing-edge curve down the right, bottom wall, left wall.
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(xs[0], ys[0]);
        for (let i = 1; i < sampleCount - 1; i++) {
          const my = (ys[i] + ys[i + 1]) * 0.5;
          const mx = (xs[i] + xs[i + 1]) * 0.5;
          ctx.quadraticCurveTo(xs[i], ys[i], mx, my);
        }
        ctx.lineTo(xs[sampleCount - 1], ys[sampleCount - 1]);
        ctx.lineTo(0, cssH);
        ctx.closePath();
        ctx.fill();

        // Glass meniscus highlight — thin bright stroke along the trailing edge.
        // Skipped on the back layer (it reads as atmosphere, not a surface).
        if (layer.highlightAlpha > 0 && extent > 0.02 && extent <= 1.0) {
          ctx.beginPath();
          ctx.moveTo(xs[0], ys[0]);
          for (let i = 1; i < sampleCount - 1; i++) {
            const my = (ys[i] + ys[i + 1]) * 0.5;
            const mx = (xs[i] + xs[i + 1]) * 0.5;
            ctx.quadraticCurveTo(xs[i], ys[i], mx, my);
          }
          ctx.lineTo(xs[sampleCount - 1], ys[sampleCount - 1]);
          ctx.strokeStyle = `rgba(245, 250, 255, ${(layer.highlightAlpha * A).toFixed(3)})`;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
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
  }, [fillRef, renderActive]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 1, width: "100%", height: "100%", borderRadius: "inherit" }}
      aria-hidden
    />
  );
}
