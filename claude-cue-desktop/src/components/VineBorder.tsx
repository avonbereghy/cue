import { useRef, useEffect } from "react";
import { usePageVisible } from "@/hooks/usePageVisible";

/**
 * VineBorder — 2-3 elegant organic tendrils that wrap the card perimeter.
 * Only mounted when the card is working/subagent. Unmounting removes the canvas.
 */

interface Tendril {
  /** Phase offset around the perimeter (0..1) */
  phase: number;
  /** Base line width */
  width: number;
  /** How far the tendril wanders from the card edge */
  drift: number;
  /** Animation speed multiplier */
  speed: number;
  /** Base opacity */
  opacity: number;
}

const TENDRILS: Tendril[] = [
  { phase: 0.0,  width: 2.5, drift: 5,  speed: 0.15, opacity: 0.55 },
  { phase: 0.33, width: 1.8, drift: 4,  speed: 0.12, opacity: 0.40 },
  { phase: 0.66, width: 1.2, drift: 3,  speed: 0.18, opacity: 0.30 },
];

export function VineBorder() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef(0);
  const pageVisible = usePageVisible();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pageVisible) return;

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

    let lastFrameTime = 0;
    const FRAME_INTERVAL = 1000 / 30; // 30fps cap

    const draw = (now: number) => {
      if (now - lastFrameTime < FRAME_INTERVAL) {
        animRef.current = requestAnimationFrame(draw);
        return;
      }
      lastFrameTime = now;

      const t = now / 1000;
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;

      ctx.clearRect(0, 0, w, h);

      const isDark = document.documentElement.getAttribute("data-theme") !== "light";
      const ov = 6; // overflow margin
      const cardW = w - ov * 2;
      const cardH = h - ov * 2;
      const perimeter = 2 * (cardW + cardH);
      const cornerR = 8; // match card border-radius

      // Convert perimeter distance to x,y + normal (inward-pointing)
      // Follows card edge with rounded corners
      const perimToXY = (d: number): { x: number; y: number; nx: number; ny: number } => {
        const pd = ((d % perimeter) + perimeter) % perimeter;

        // Top edge
        if (pd < cardW) {
          return { x: ov + pd, y: ov, nx: 0, ny: 1 };
        }
        // Right edge
        if (pd < cardW + cardH) {
          const a = pd - cardW;
          return { x: ov + cardW, y: ov + a, nx: -1, ny: 0 };
        }
        // Bottom edge (right to left)
        if (pd < 2 * cardW + cardH) {
          const a = pd - cardW - cardH;
          return { x: ov + cardW - a, y: ov + cardH, nx: 0, ny: -1 };
        }
        // Left edge (bottom to top)
        const a = pd - 2 * cardW - cardH;
        return { x: ov, y: ov + cardH - a, nx: 1, ny: 0 };
      };

      for (const tendril of TENDRILS) {
        const { phase, width, drift, speed, opacity } = tendril;

        // Main tendril stroke
        ctx.beginPath();
        ctx.lineWidth = width;
        ctx.strokeStyle = isDark
          ? `rgba(180, 170, 160, ${opacity})`
          : `rgba(60, 50, 45, ${opacity})`;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        const steps = 160;
        const stepSize = perimeter / steps;

        for (let i = 0; i <= steps; i++) {
          const d = i * stepSize + phase * perimeter;
          const pt = perimToXY(d);

          // Gentle organic wave — two low-frequency sines that slowly shift
          const wave1 = Math.sin(d * 0.012 + t * speed * 2) * drift;
          const wave2 = Math.sin(d * 0.023 - t * speed * 1.4 + phase * 10) * drift * 0.4;
          const displacement = wave1 + wave2;

          const x = pt.x + pt.nx * displacement;
          const y = pt.y + pt.ny * displacement;

          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }

        ctx.stroke();
      }

      // Draw corner knots — small flourishes where tendrils cross at corners
      const corners = [
        { x: ov + cornerR, y: ov + cornerR },
        { x: ov + cardW - cornerR, y: ov + cornerR },
        { x: ov + cardW - cornerR, y: ov + cardH - cornerR },
        { x: ov + cornerR, y: ov + cardH - cornerR },
      ];

      for (let ci = 0; ci < corners.length; ci++) {
        const c = corners[ci];
        const knotSize = 3 + Math.sin(t * 0.3 + ci * 1.57) * 1;

        ctx.beginPath();
        ctx.arc(c.x, c.y, knotSize, 0, Math.PI * 2);
        ctx.fillStyle = isDark
          ? `rgba(160, 150, 140, 0.20)`
          : `rgba(60, 50, 45, 0.15)`;
        ctx.fill();
      }

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(animRef.current);
      obs.disconnect();
    };
  }, [pageVisible]);

  const OV = 6;

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none"
      style={{
        position: "absolute",
        top: -OV,
        left: -OV,
        width: `calc(100% + ${OV * 2}px)`,
        height: `calc(100% + ${OV * 2}px)`,
        zIndex: 20,
      }}
      aria-hidden="true"
    />
  );
}
