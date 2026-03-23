import { useRef, useEffect } from "react";

/**
 * VineBorder — animated dark twisting vines that wrap the entire card perimeter.
 * Multiple vine strands travel along the edges, intertwining with organic curves.
 * Each vine is a series of cubic bezier segments with randomized offsets.
 */

interface VineBorderProps {
  active: boolean;
}

/** Deterministic hash for stable per-vine randomness */
function hash(seed: number): number {
  return ((seed * 2654435761) >>> 0) / 0xFFFFFFFF;
}

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

export function VineBorder({ active }: VineBorderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef(0);
  const opacityRef = useRef(active ? 1 : 0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
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

      // Fade in/out
      const targetOpacity = active ? 1 : 0;
      const fadeSpeed = active ? 0.03 : 0.015;
      opacityRef.current += (targetOpacity - opacityRef.current) * fadeSpeed;
      const globalAlpha = opacityRef.current;

      ctx.clearRect(0, 0, w, h);

      if (globalAlpha < 0.005) {
        animRef.current = requestAnimationFrame(draw);
        return;
      }

      const isDark = document.documentElement.getAttribute("data-theme") !== "light";

      // Perimeter: total distance around the card
      const perimeter = 2 * (w + h);

      // Convert perimeter distance to x,y point + normal direction
      // Inset by 4px so the vine center sits inside the card edge
      const inset = 4;
      const perimeterToXY = (d: number): { x: number; y: number; nx: number; ny: number } => {
        const pd = ((d % perimeter) + perimeter) % perimeter;

        // Top edge (left to right)
        if (pd < w) {
          return { x: pd, y: inset, nx: 0, ny: 1 };
        }
        // Right edge (top to bottom)
        if (pd < w + h) {
          const along = pd - w;
          return { x: w - inset, y: along, nx: -1, ny: 0 };
        }
        // Bottom edge (right to left)
        if (pd < 2 * w + h) {
          const along = pd - w - h;
          return { x: w - along, y: h - inset, nx: 0, ny: -1 };
        }
        // Left edge (bottom to top)
        const along = pd - 2 * w - h;
        return { x: inset, y: h - along, nx: 1, ny: 0 };
      };

      // Draw each vine strand
      for (const strand of STRANDS) {
        const { seed, speed, thickness, wobble, offset, opacity } = strand;

        ctx.beginPath();
        ctx.lineWidth = thickness;

        const baseColor = isDark
          ? `rgba(30, 25, 22, ${opacity * globalAlpha})`
          : `rgba(50, 40, 35, ${opacity * globalAlpha})`;
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
          ? `rgba(55, 45, 40, ${opacity * 0.5 * globalAlpha})`
          : `rgba(75, 60, 50, ${opacity * 0.4 * globalAlpha})`;
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

        // Small thorns/knots along the vine at intervals
        const knots = 8 + seed * 3;
        for (let k = 0; k < knots; k++) {
          const kd = (k / knots) * perimeter + offset * perimeter + t * speed * 40;
          const pt = perimeterToXY(kd);
          const s = seed * 1000;
          const wave = Math.sin(kd * 0.02 + t * speed * 2 + s) * wobble
            + Math.sin(kd * 0.035 - t * speed * 1.3 + s * 0.7) * wobble * 0.5;

          const kx = pt.x + pt.nx * wave;
          const ky = pt.y + pt.ny * wave;

          // Small circular knot
          const knotSize = thickness * (0.5 + hash(seed * 100 + k) * 0.8);
          ctx.beginPath();
          ctx.arc(kx, ky, knotSize, 0, Math.PI * 2);
          ctx.fillStyle = isDark
            ? `rgba(25, 20, 18, ${opacity * 0.7 * globalAlpha})`
            : `rgba(40, 32, 28, ${opacity * 0.6 * globalAlpha})`;
          ctx.fill();
        }
      }

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(animRef.current);
      obs.disconnect();
    };
  }, [active]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 20,
        borderRadius: "inherit",
      }}
      aria-hidden="true"
    />
  );
}
