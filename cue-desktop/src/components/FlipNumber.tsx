/**
 * FlipNumber — odometer-style flip animation for changing numeric strings.
 *
 * When `value` changes, each character position whose glyph differs plays a
 * vertical flip: the outgoing glyph rotates up and away while the incoming
 * glyph flips in from below. Unchanged positions hold steady. Characters
 * flip in a left→right cascade with a small per-slot stagger so the motion
 * reads as a single wave rather than a synchronized thud.
 *
 * No React re-renders per frame — each transition is a one-shot WAAPI pair
 * (transient "old" overlay fading out, live slot rotating in). Reduced-motion
 * swaps silently to the new value.
 */
import { useEffect, useRef } from "react";

interface FlipNumberProps {
  /** The current display string. On change, a flip animation plays. */
  value: string;
  className?: string;
  style?: React.CSSProperties;
  /** Per-character flip duration (ms). */
  duration?: number;
  /** Delay between successive character flips (ms). */
  stagger?: number;
}

export function FlipNumber({
  value,
  className,
  style,
  duration = 380,
  stagger = 32,
}: FlipNumberProps) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const prevRef = useRef<string>(value);
  // Tracks the in-flight outgoing-overlay (element + animation) per slot
  // index so rapid `value` changes can cancel and clean up the previous
  // animation before appending a new one. Without this, overlapping flips
  // leak orphan DOM nodes when the counter ticks faster than `duration`.
  const liveOverlaysRef = useRef<Map<number, { el: HTMLSpanElement; anim: Animation }>>(new Map());

  // Cancel any in-flight overlays and clean up their DOM nodes on unmount.
  useEffect(() => {
    const live = liveOverlaysRef.current;
    return () => {
      live.forEach(({ el, anim }) => {
        anim.cancel();
        el.remove();
      });
      live.clear();
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const prev = prevRef.current;
    if (prev === value) return;
    prevRef.current = value;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const slots = container.querySelectorAll<HTMLSpanElement>("[data-flip-slot]");
    const prevArr = [...prev];
    const nextArr = [...value];
    const len = nextArr.length;
    const prevLen = prevArr.length;
    const live = liveOverlaysRef.current;

    const containerRect = container.getBoundingClientRect();
    let flipIndex = 0;

    for (let i = 0; i < len; i++) {
      const slot = slots[i];
      if (!slot) continue;
      // Newly-added positions (string grew): no outgoing glyph to flip — let
      // the slot appear normally without spawning a blank overlay.
      if (i >= prevLen) continue;
      const oldC = prevArr[i];
      const newC = nextArr[i];
      if (oldC === newC) continue;

      // Kill any still-running overlay for this slot before appending a new
      // one — prevents DOM-node accumulation when `value` changes faster
      // than the flip animation's duration.
      const existing = live.get(i);
      if (existing) {
        existing.anim.cancel();
        existing.el.remove();
        live.delete(i);
      }

      // Old glyph rendered as a sibling overlay (attached to the container, not
      // the slot) so its rotateX doesn't inherit the slot's own rotation.
      const slotRect = slot.getBoundingClientRect();
      const old = document.createElement("span");
      old.textContent = oldC === " " || oldC === "" ? "\u00A0" : oldC;
      old.style.cssText =
        `position:absolute;` +
        `left:${slotRect.left - containerRect.left}px;` +
        `top:${slotRect.top - containerRect.top}px;` +
        `width:${slotRect.width}px;` +
        `height:${slotRect.height}px;` +
        `display:inline-flex;align-items:center;justify-content:center;` +
        `pointer-events:none;will-change:transform,opacity;` +
        `transform-origin:50% 50%;backface-visibility:hidden;`;
      container.appendChild(old);

      const delay = flipIndex * stagger;
      flipIndex++;

      const oldAnim = old.animate(
        [
          { transform: "translateY(0) rotateX(0deg)", opacity: 1, filter: "blur(0px)" },
          { transform: "translateY(-55%) rotateX(90deg)", opacity: 0, filter: "blur(0.6px)" },
        ],
        { duration, easing: "cubic-bezier(0.55, 0.05, 0.55, 1)", delay, fill: "forwards" },
      );
      // Track this overlay so the next flip in the same slot can cancel it.
      live.set(i, { el: old, anim: oldAnim });
      const cleanup = () => {
        old.remove();
        if (live.get(i)?.anim === oldAnim) live.delete(i);
      };
      oldAnim.onfinish = cleanup;
      oldAnim.oncancel = cleanup;

      slot.animate(
        [
          { transform: "translateY(55%) rotateX(-90deg)", opacity: 0, filter: "blur(0.6px)", offset: 0 },
          { transform: "translateY(55%) rotateX(-90deg)", opacity: 0, filter: "blur(0.6px)", offset: 0.35 },
          { transform: "translateY(0) rotateX(0deg)", opacity: 1, filter: "blur(0px)", offset: 1 },
        ],
        {
          duration: duration + 60,
          easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
          delay,
        },
      );
    }
  }, [value, duration, stagger]);

  return (
    <span
      ref={containerRef}
      className={className}
      aria-label={value}
      style={{
        display: "inline-block",
        position: "relative",
        perspective: "520px",
        ...style,
      }}
    >
      {[...value].map((ch, i) => (
        <span
          key={i}
          data-flip-slot
          style={{
            display: "inline-block",
            transformStyle: "preserve-3d",
            backfaceVisibility: "hidden",
            whiteSpace: "pre",
          }}
        >
          {ch === " " ? "\u00A0" : ch}
        </span>
      ))}
    </span>
  );
}
