/**
 * SpoolContextBar — the context-usage bar rendered as a horizontal side-on
 * spool of blue silk. Filled region = tokens in context; diagonal wrap-lines
 * sell the "wound thread" metaphor.
 *
 * At rest: static wound spool. Fill smoothly eases when contextUsagePercent
 * changes.
 *
 * During compacting: every BURST_INTERVAL_MS a tight burst unwinds a small
 * chunk of silk — the trailing edge kicks out a short bezier strand that
 * sways, then dissolves into dust motes (emit → gravity + drag → fade).
 * The unwind target drains in lockstep with `compactFillRef` (the
 * parent-owned 0..1 value that sweeps 1→0 over a 2-minute compaction).
 *
 * UX principles: Value Change (animated fill reflects token count),
 * Transformation (silk → strand → dust), Offset & Delay (tick-paced bursts),
 * Easing (spring-like ease-out for each burst).
 */
import { useEffect, useRef } from "react";
import { usePageVisible } from "@/hooks/usePageVisible";
import { useOnScreen } from "@/hooks/useOnScreen";

interface SpoolContextBarProps {
  /** 0..1 context usage (rest fill level). */
  fillPercent: number;
  /** True while session.state === "compacting" — drives the burst loop. */
  isCompacting: boolean;
  /**
   * Parent-owned 1→0 value tracking compaction progress across the assumed
   * 2-minute window. Read each frame to compute each burst's target fill.
   * Optional — without it, compacting still unwinds visually toward 0.
   */
  compactFillRef?: React.RefObject<number | null>;
  /** Visible bar thickness in px (canvas is slightly taller for dust). */
  barHeight?: number;
  /** Dark-theme flag governs the well + striation alpha. */
  isDark?: boolean;
  /**
   * Rest-state silk color as [r, g, b]. Used only when !isCompacting — the
   * burst animation overrides with blue to keep the "compacting" state
   * visually distinct.
   */
  restColor?: [number, number, number];
}

/**
 * Dust particles emitted per second at the trailing edge while compacting.
 * Higher rate + upward-biased velocities produce the "evaporating to dust"
 * feel rather than a string unwind.
 */
const DUST_EMIT_PER_SECOND = 24;
/** Duration of the "context grew" glow pulse at the silk's trailing edge. */
const GROWTH_GLOW_MS = 650;

type Dust = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  life0: number;
  size: number;
};

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** Mix r,g,b toward white by t (0..1). */
function lighten(c: [number, number, number], t: number): [number, number, number] {
  return [
    Math.round(c[0] + (255 - c[0]) * t),
    Math.round(c[1] + (255 - c[1]) * t),
    Math.round(c[2] + (255 - c[2]) * t),
  ];
}
/** Mix r,g,b toward black by t (0..1). */
function darken(c: [number, number, number], t: number): [number, number, number] {
  return [
    Math.round(c[0] * (1 - t)),
    Math.round(c[1] * (1 - t)),
    Math.round(c[2] * (1 - t)),
  ];
}
/**
 * Pull a color toward its perceived luminance by `t` (0..1). t=0 leaves the
 * color untouched; t=1 fully desaturates to gray. Used to knock the chroma
 * out of the green/yellow/red ramp so the silk reads muted rather than
 * highlighter-bright.
 */
function desaturate(c: [number, number, number], t: number): [number, number, number] {
  const L = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  return [
    Math.round(c[0] + (L - c[0]) * t),
    Math.round(c[1] + (L - c[1]) * t),
    Math.round(c[2] + (L - c[2]) * t),
  ];
}
/** Chroma reduction applied to every silk palette before shading. */
const REST_DESAT = 0.55;
const COMPACT_DESAT = 0.30;
const rgb = ([r, g, b]: [number, number, number]) => `rgb(${r},${g},${b})`;

// Compacting-silk blue anchor (shaded into top/mid/bottom at draw time).
const COMPACT_BLUE_MID: [number, number, number] = [61, 107, 174];

export function SpoolContextBar({
  fillPercent,
  isCompacting,
  compactFillRef,
  barHeight = 12,
  isDark = true,
  restColor = [120, 150, 200],
}: SpoolContextBarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageVisible = usePageVisible();
  const onScreen = useOnScreen(canvasRef);
  const pageVisibleRef = useRef(pageVisible);
  pageVisibleRef.current = pageVisible;
  const onScreenRef = useRef(onScreen);
  onScreenRef.current = onScreen;
  // Latest props mirrored into refs so the raf loop never re-subscribes.
  const fillPctRef = useRef(fillPercent);
  const compactingRef = useRef(isCompacting);
  compactingRef.current = isCompacting;
  const isDarkRef = useRef(isDark);
  isDarkRef.current = isDark;
  const restColorRef = useRef(restColor);
  restColorRef.current = restColor;

  // Growth-pulse: when fillPercent ticks upward (new tokens consumed), stamp
  // the current time. The raf loop reads this to render a brief radial glow
  // at the silk's trailing edge that fades over GROWTH_GLOW_MS. Skipped
  // while compacting — the burst/strand already owns that edge visually.
  //
  // Stamped inside a post-commit effect rather than during render so React 18
  // StrictMode's double-invoke / speculative renders don't spuriously trigger
  // the pulse.
  const growthPulseAtRef = useRef<number>(0);
  const prevFillPctRef = useRef<number>(fillPercent);
  useEffect(() => {
    if (fillPercent > prevFillPctRef.current + 0.0005 && !isCompacting) {
      growthPulseAtRef.current = performance.now();
    }
    prevFillPctRef.current = fillPercent;
    fillPctRef.current = fillPercent;
  }, [fillPercent, isCompacting]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = mql.matches;
    const onPrefChange = () => {
      reduced = mql.matches;
    };
    mql.addEventListener("change", onPrefChange);

    // Displayed fill (what the canvas actually draws). During compacting this
    // tracks the parent-owned `compactFillRef` (which drains 1→0 linearly over
    // 2 minutes) directly — no bursts, constant motion.
    let displayFill = fillPctRef.current;
    // Continuous dust-emission carry (accrues fractional particles between frames).
    let dustAccum = 0;

    const dust: Dust[] = [];

    let raf = 0;
    let running = true;
    let lastT = performance.now();

    const tick = () => {
      if (!running) return;
      // Off-screen or tab-hidden: skip work but keep the loop alive so we
      // resume instantly when visibility returns.
      if (!pageVisibleRef.current || !onScreenRef.current) {
        lastT = performance.now();
        raf = requestAnimationFrame(tick);
        return;
      }
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;

      const rect = canvas.getBoundingClientRect();
      const cssW = rect.width;
      const cssH = rect.height;
      if (cssW < 2 || cssH < 2) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      const bw = Math.round(cssW * dpr);
      const bh = Math.round(cssH * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }

      const compacting = compactingRef.current;
      const targetPct = Math.max(0, Math.min(1, fillPctRef.current));

      if (compacting && !reduced) {
        // Linear drain — `compactFillRef` is itself a linear 1→0 sweep across
        // the 2-min window, so the trailing edge recedes at a constant rate.
        const drain = compactFillRef?.current ?? 1;
        displayFill = targetPct * Math.max(0, Math.min(1, drain));

        // Continuous dust emission — evaporation/disintegration at the
        // trailing edge. Particles scatter in all directions with upward bias
        // so the bar reads as dissolving rather than unwinding a thread.
        dustAccum += DUST_EMIT_PER_SECOND * dt;
        const emit = Math.floor(dustAccum);
        dustAccum -= emit;
        if (emit > 0) {
          const edgePx = displayFill * cssW;
          for (let i = 0; i < emit; i++) {
            // Spawn zone: ±half-barHeight around the trailing edge, full bar height
            const x = edgePx + (Math.random() - 0.6) * barHeight;
            const spawnBarY = (cssH - Math.min(barHeight, cssH - 2)) / 2;
            const y = spawnBarY + Math.random() * Math.min(barHeight, cssH - 2);
            // Velocity: upward-biased scatter — evaporation rises, some drift sideways
            const upSpeed = 6 + Math.random() * 18;
            const sideSpeed = (Math.random() - 0.5) * 12;
            const life = 0.35 + Math.random() * 0.60;
            dust.push({
              x, y,
              vx: sideSpeed,
              vy: -upSpeed,
              life,
              life0: life,
              size: 0.4 + Math.random() * 1.0,
            });
          }
        }
      } else {
        // Rest / reduced-motion: smooth approach toward target.
        const k = reduced ? 1 : 0.15;
        displayFill += (targetPct - displayFill) * k;
        dustAccum = 0;
      }
      displayFill = Math.max(0, Math.min(1, displayFill));

      // Integrate dust regardless of compacting flag so particles from the
      // final burst still finish their arc after state transitions out.
      for (let i = dust.length - 1; i >= 0; i--) {
        const p = dust[i];
        p.vy += 22 * dt; // light gravity — motes float, not arc
        const drag = Math.pow(0.91, dt * 60);
        p.vx *= drag;
        p.vy *= drag;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= dt;
        if (p.life <= 0) dust.splice(i, 1);
      }

      // ─── Paint ───
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, cssW, cssH);

      const barH = Math.min(barHeight, cssH - 2);
      const barY = (cssH - barH) / 2;
      const radius = barH / 2;

      // Well — fully opaque track so the bar reads as a solid element
      // rather than a tinted wash over whatever sits behind the card.
      const dark = isDarkRef.current;
      roundedRectPath(ctx, 0, barY, cssW, barH, radius);
      ctx.fillStyle = dark ? "rgb(28,30,36)" : "rgb(228,230,234)";
      ctx.fill();
      // Subtle inner shadow at the top of the well — gives it depth
      ctx.save();
      roundedRectPath(ctx, 0, barY, cssW, barH, radius);
      ctx.clip();
      const wellGrad = ctx.createLinearGradient(0, barY, 0, barY + barH);
      wellGrad.addColorStop(0, "rgba(0,0,0,0.22)");
      wellGrad.addColorStop(0.5, "rgba(0,0,0,0)");
      ctx.fillStyle = wellGrad;
      ctx.fillRect(0, barY, cssW, barH);
      ctx.restore();

      // Wound silk fill
      const fillPx = Math.max(0, Math.min(cssW, displayFill * cssW));
      if (fillPx > 0.5) {
        ctx.save();
        roundedRectPath(ctx, 0, barY, cssW, barH, radius);
        ctx.clip();

        // Pick the silk palette: blue while actively compacting, otherwise
        // the caller-provided rest color (threshold-ramped green→yellow→red).
        let topRgb: [number, number, number];
        let midRgb: [number, number, number];
        let lowRgb: [number, number, number];
        if (compacting) {
          const base = desaturate(COMPACT_BLUE_MID, COMPACT_DESAT);
          topRgb = lighten(base, 0.28);
          midRgb = base;
          lowRgb = darken(base, 0.55);
        } else {
          const base = desaturate(restColorRef.current, REST_DESAT);
          topRgb = lighten(base, 0.28);
          midRgb = base;
          lowRgb = darken(base, 0.55);
        }

        // Cylindrical shading — brighter top, darker bottom
        const silkGrad = ctx.createLinearGradient(0, barY, 0, barY + barH);
        silkGrad.addColorStop(0, rgb(topRgb));
        silkGrad.addColorStop(0.45, rgb(midRgb));
        silkGrad.addColorStop(1, rgb(lowRgb));
        ctx.fillStyle = silkGrad;
        ctx.fillRect(0, barY, fillPx, barH);

        // Vertical wrap-lines — 1px, slightly brighter blue, 4px spacing.
        // Confined to the filled region by an additional clip. Upright (not
        // angled) so each line reads as a single loop of thread seen edge-on.
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, barY, fillPx, barH);
        ctx.clip();
        const stripeRgb = lighten(topRgb, 0.45);
        ctx.strokeStyle = `rgba(${stripeRgb[0]},${stripeRgb[1]},${stripeRgb[2]},0.32)`;
        ctx.lineWidth = 1;
        const spacing = 4;
        for (let x = spacing; x < fillPx; x += spacing) {
          ctx.beginPath();
          ctx.moveTo(x + 0.5, barY);
          ctx.lineTo(x + 0.5, barY + barH);
          ctx.stroke();
        }
        ctx.restore();

        // Meniscus highlight at the trailing edge of the silk.
        if (fillPx > 3 && fillPx < cssW - 0.5) {
          const menRgb = lighten(topRgb, 0.35);
          const edgeGrad = ctx.createLinearGradient(fillPx - 5, 0, fillPx, 0);
          edgeGrad.addColorStop(0, `rgba(${menRgb[0]},${menRgb[1]},${menRgb[2]},0)`);
          edgeGrad.addColorStop(1, `rgba(${menRgb[0]},${menRgb[1]},${menRgb[2]},0.55)`);
          ctx.fillStyle = edgeGrad;
          ctx.fillRect(fillPx - 5, barY, 5, barH);
        }

        ctx.restore();
      }

      // Growth pulse — soft radial glow at the trailing edge when the fill
      // level just increased. Rides on top of the silk so the tip feels like
      // it flared when new tokens landed; fades over GROWTH_GLOW_MS.
      const pulseAt = growthPulseAtRef.current;
      if (pulseAt > 0 && !compacting && !reduced) {
        const u = (now - pulseAt) / GROWTH_GLOW_MS;
        if (u < 1) {
          // ease-out cubic so brightness peaks at the start and tapers off
          const a = Math.pow(1 - u, 2.2);
          const edgePx = Math.max(0, Math.min(cssW, displayFill * cssW));
          const cy = barY + barH / 2;
          const radius = barH * (1.4 + u * 1.6); // grows outward as it fades
          const grad = ctx.createRadialGradient(edgePx, cy, 0, edgePx, cy, radius);
          grad.addColorStop(0,   `rgba(255,245,220,${(0.85 * a).toFixed(3)})`);
          grad.addColorStop(0.35,`rgba(255,220,170,${(0.45 * a).toFixed(3)})`);
          grad.addColorStop(1,   `rgba(255,200,140,0)`);
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          ctx.fillStyle = grad;
          ctx.fillRect(edgePx - radius, cy - radius, radius * 2, radius * 2);
          ctx.restore();
        } else {
          growthPulseAtRef.current = 0;
        }
      }

      // Dust motes
      if (dust.length > 0) {
        ctx.save();
        for (const p of dust) {
          const a = Math.max(0, p.life / p.life0);
          if (a < 0.02) continue;
          ctx.globalAlpha = a * 0.85;
          ctx.fillStyle = "rgba(205,225,250,1)";
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      ctx.restore();
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      mql.removeEventListener("change", onPrefChange);
    };
  }, [barHeight, compactFillRef]);

  // Canvas is taller than the bar to give rising dust motes room above.
  const canvasHeight = barHeight + 16;
  return (
    <canvas
      ref={canvasRef}
      className="flex-1 block"
      style={{ width: "100%", height: `${canvasHeight}px` }}
      aria-hidden
    />
  );
}
