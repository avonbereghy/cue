/**
 * CompactTankEffect — a vertical sine boundary that sweeps right-to-left
 * behind the session card while it is compacting. Everything west of the
 * boundary is filled (periwinkle); everything east is transparent, so the
 * "water" visibly drains toward the left edge as `fillRef` drops 1 → 0.
 *
 * Implemented as a single SVG path that's updated each frame via
 * setAttribute("d", ...) — no canvas, no DPR math, no buffer sizing.
 * Percent-based viewBox (`0 0 100 100`) + `preserveAspectRatio="none"`
 * lets the shape stretch to the card's actual dimensions automatically.
 *
 * The parent (SessionCard) owns `fillRef` so the drain timer and the
 * pulsing bar stay in sync without React re-renders per frame.
 */
import { useEffect, useRef } from "react";

interface CompactTankEffectProps {
  /** Fill fraction in [0, 1] — read every frame. Owned by the parent. */
  fillRef: React.RefObject<number>;
  /** Fill color (hex). Defaults to periwinkle that matches the compacting theme. */
  color?: string;
  /** Fill alpha. Stroke opacity derives from this. */
  alpha?: number;
}

export function CompactTankEffect({
  fillRef,
  color = "#8b9fd4",
  alpha = 0.28,
}: CompactTankEffectProps) {
  const pathRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = mql.matches;
    const onChange = () => { reduced = mql.matches; };
    mql.addEventListener("change", onChange);

    const startT = performance.now();
    let rafId = 0;
    let running = true;

    // Sine boundary in viewBox coordinates (0..100 in x and y).
    // - centerX sweeps from 100 (fill=1) to 0 (fill=0).
    // - Wave amplitude and wavelength are in the same units so they scale
    //   automatically with the card; visual amplitude in pixels depends on
    //   the card's actual width.
    const AMP = 2.8;
    const WAVE_K = (Math.PI * 2 * 0.9) / 100; // ~0.9 wavelengths top-to-bottom
    const STEP_Y = 8;

    const buildPath = (fill: number, t: number): string => {
      const centerX = fill * 100;
      const phase = reduced ? 0 : t * 1.35;
      let d = `M0 0 L${(centerX + Math.sin(phase) * AMP).toFixed(2)} 0`;
      for (let y = STEP_Y; y < 100; y += STEP_Y) {
        const x = centerX + Math.sin(y * WAVE_K + phase) * AMP;
        d += ` L${x.toFixed(2)} ${y}`;
      }
      const xBottom = centerX + Math.sin(100 * WAVE_K + phase) * AMP;
      d += ` L${xBottom.toFixed(2)} 100 L0 100 Z`;
      return d;
    };

    const tick = () => {
      if (!running) return;
      const fill = Math.max(0, Math.min(1, fillRef.current ?? 0));
      const t = (performance.now() - startT) / 1000;
      const path = pathRef.current;
      if (path) path.setAttribute("d", buildPath(fill, t));
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      running = false;
      cancelAnimationFrame(rafId);
      mql.removeEventListener("change", onChange);
    };
  }, [fillRef]);

  return (
    <svg
      className="absolute inset-0 pointer-events-none"
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
      style={{ zIndex: 1, width: "100%", height: "100%" }}
      aria-hidden
    >
      <path
        ref={pathRef}
        fill={color}
        fillOpacity={alpha}
        stroke={color}
        strokeOpacity={Math.min(1, alpha * 2.6)}
        strokeWidth={0.4}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
