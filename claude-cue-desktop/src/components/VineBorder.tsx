import { useRef, useEffect } from "react";
import { usePageVisible } from "@/hooks/usePageVisible";

/**
 * VineBorder — animated dark twisting vines that wrap the entire card perimeter.
 * Only mounted when the card is working/subagent. Unmounting removes the canvas
 * and stops all rAF loops — zero overhead on idle cards.
 */

// Vine strand definition — each vine has its own speed, thickness, and wobble
interface VineStrand {
  seed: number;
  speed: number;       // how fast it undulates
  thickness: number;   // base line width
  wobble: number;      // amplitude of lateral displacement
  offset: number;      // phase offset along the perimeter
  opacity: number;     // base opacity
}

const STRANDS: VineStrand[] = [
  { seed: 1, speed: 0.3,  thickness: 3.5, wobble: 8,  offset: 0.0,  opacity: 0.85 },
  { seed: 2, speed: 0.25, thickness: 2.8, wobble: 7,  offset: 0.15, opacity: 0.75 },
  { seed: 3, speed: 0.35, thickness: 2.0, wobble: 5,  offset: 0.35, opacity: 0.65 },
  { seed: 4, speed: 0.2,  thickness: 3.2, wobble: 9,  offset: 0.55, opacity: 0.80 },
  { seed: 5, speed: 0.28, thickness: 1.5, wobble: 4,  offset: 0.7,  opacity: 0.55 },
];

export function VineBorder() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef(0);
  const pageVisible = usePageVisible();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Pause when page is hidden
    if (!pageVisible) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const obs = new ResizeObserver(resize);
    obs.observe(canvas);

    const draw = (now: number) => {
      const t = now / 1000;
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;

      ctx.clearRect(0, 0, w, h);

      const isDark = document.documentElement.getAttribute("data-theme") !== "light";

      // The canvas extends OVERFLOW px beyond the card on each side.
      // The card edge sits at (ov, ov) to (w - ov, h - ov) in canvas coords.
      const ov = 12; // must match OVERFLOW constant
      const cardW = w - ov * 2;
      const cardH = h - ov * 2;

      // Perimeter: total distance around the card edge
      const perimeter = 2 * (cardW + cardH);

      // Convert perimeter distance to x,y point + normal direction
      // Normal points inward; vines wobble both inward and outward (overflow)
      const perimeterToXY = (d: number): { x: number; y: number; nx: number; ny: number } => {
        const pd = ((d % perimeter) + perimeter) % perimeter;

        // Top edge (left to right)
        if (pd < cardW) {
          return { x: ov + pd, y: ov, nx: 0, ny: 1 };
        }
        // Right edge (top to bottom)
        if (pd < cardW + cardH) {
          const along = pd - cardW;
          return { x: ov + cardW, y: ov + along, nx: -1, ny: 0 };
        }
        // Bottom edge (right to left)
        if (pd < 2 * cardW + cardH) {
          const along = pd - cardW - cardH;
          return { x: ov + cardW - along, y: ov + cardH, nx: 0, ny: -1 };
        }
        // Left edge (bottom to top)
        const along = pd - 2 * cardW - cardH;
        return { x: ov, y: ov + cardH - along, nx: 1, ny: 0 };
      };

      // Draw each vine strand
      for (const strand of STRANDS) {
        const { seed, speed, thickness, wobble, offset, opacity } = strand;

        ctx.beginPath();
        ctx.lineWidth = thickness;

        const baseColor = isDark
          ? `rgba(30, 25, 22, ${opacity})`
          : `rgba(50, 40, 35, ${opacity})`;
        ctx.strokeStyle = baseColor;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        const steps = 200;
        const stepSize = perimeter / steps;

        for (let i = 0; i <= steps; i++) {
          const d = i * stepSize + offset * perimeter;
          const pt = perimeterToXY(d);

          // Organic wobble: multiple sine waves with different frequencies
          const s = seed * 1000;
          const wave1 = Math.sin(d * 0.02 + t * speed * 2 + s) * wobble;
          const wave2 = Math.sin(d * 0.035 - t * speed * 1.3 + s * 0.7) * wobble * 0.5;
          const wave3 = Math.sin(d * 0.007 + t * speed * 0.5 + s * 1.3) * wobble * 0.8;
          // Twist: vines intertwine by crossing over each other
          const twist = Math.sin(d * 0.015 + t * speed * 1.7 + seed * 3.14) * wobble * 0.6;

          const displacement = wave1 + wave2 + wave3 + twist;

          const x = pt.x + pt.nx * displacement;
          const y = pt.y + pt.ny * displacement;

          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }

        ctx.stroke();

        // Draw thinner highlight strand slightly offset for depth
        ctx.beginPath();
        ctx.lineWidth = thickness * 0.3;
        const highlightColor = isDark
          ? `rgba(55, 45, 40, ${opacity * 0.5})`
          : `rgba(75, 60, 50, ${opacity * 0.4})`;
        ctx.strokeStyle = highlightColor;

        for (let i = 0; i <= steps; i++) {
          const d = i * stepSize + offset * perimeter;
          const pt = perimeterToXY(d);

          const s = seed * 1000 + 500;
          const wave1 = Math.sin(d * 0.02 + t * speed * 2 + s) * wobble * 0.7;
          const wave2 = Math.sin(d * 0.035 - t * speed * 1.3 + s * 0.7) * wobble * 0.35;
          const wave3 = Math.sin(d * 0.007 + t * speed * 0.5 + s * 1.3) * wobble * 0.55;
          const twist = Math.sin(d * 0.015 + t * speed * 1.7 + seed * 3.14 + 1.0) * wobble * 0.4;

          const displacement = wave1 + wave2 + wave3 + twist + thickness * 0.5;

          const x = pt.x + pt.nx * displacement;
          const y = pt.y + pt.ny * displacement;

          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }

        ctx.stroke();
      }

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(animRef.current);
      obs.disconnect();
    };
  }, [pageVisible]);

  // Overflow margin: vines extend this many px beyond the card edge
  const OVERFLOW = 12;

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none"
      style={{
        position: "absolute",
        top: -OVERFLOW,
        left: -OVERFLOW,
        width: `calc(100% + ${OVERFLOW * 2}px)`,
        height: `calc(100% + ${OVERFLOW * 2}px)`,
        zIndex: 20,
      }}
      aria-hidden="true"
    />
  );
}
