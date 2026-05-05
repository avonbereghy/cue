import React, { useEffect, useRef, useState } from "react";

/** Crossfade duration (ms) when state changes. Short enough that the icon
 *  doesn't lag behind the rest of the card; long enough to avoid the visible
 *  pop that comes from instantly swapping out one SVG shape for another. */
const STATUS_DOT_FADE_MS = 280;

/** Semantic status indicators — each state gets a distinct shape + animation.
 *  The outer wrapper crossfades between the previous and current shape so
 *  rapid state changes (thinking↔working, working→idle) read as a smooth
 *  transition rather than a hard SVG component swap. */
export function StatusDot({ state, color }: { state: string; color: string }) {
  const [prevState, setPrevState] = useState<string | null>(null);
  const [prevColor, setPrevColor] = useState(color);
  const stateRef = useRef(state);
  const colorRef = useRef(color);
  const fadeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (state === stateRef.current) {
      // State unchanged — let color updates flow through without re-fading.
      colorRef.current = color;
      return;
    }
    if (fadeTimerRef.current !== null) {
      window.clearTimeout(fadeTimerRef.current);
    }
    setPrevState(stateRef.current);
    setPrevColor(colorRef.current);
    stateRef.current = state;
    colorRef.current = color;
    fadeTimerRef.current = window.setTimeout(() => {
      setPrevState(null);
      fadeTimerRef.current = null;
    }, STATUS_DOT_FADE_MS);
    return () => {
      if (fadeTimerRef.current !== null) {
        window.clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = null;
      }
    };
  }, [state, color]);

  return (
    <span
      className="inline-flex items-center justify-center relative shrink-0"
      style={{ width: 12, height: 12 }}
      aria-hidden="true"
    >
      {prevState !== null && prevState !== state && (
        <span
          key={`prev-${prevState}`}
          className="absolute inset-0 inline-flex items-center justify-center"
          style={{
            animation: `status-dot-fade-out ${STATUS_DOT_FADE_MS}ms cubic-bezier(0.4, 0, 0.2, 1) both`,
          }}
        >
          <StatusDotShape state={prevState} color={prevColor} />
        </span>
      )}
      <span
        key={`cur-${state}`}
        className="absolute inset-0 inline-flex items-center justify-center"
        style={{
          animation: `status-dot-fade-in ${STATUS_DOT_FADE_MS}ms cubic-bezier(0.4, 0, 0.2, 1) both`,
        }}
      >
        <StatusDotShape state={state} color={color} />
      </span>
    </span>
  );
}

function StatusDotShape({ state, color }: { state: string; color: string }) {
  const S = 12; // render size px

  switch (state) {

    // ── idle: hollow ring, slow breath ─────────────────────────────────────
    case "idle":
      return (
        <svg width={S} height={S} viewBox="0 0 12 12" className="status-idle shrink-0" aria-hidden="true">
          <circle cx="6" cy="6" r="4.5" fill="none" stroke={color} strokeWidth="1.5" />
        </svg>
      );

    // ── thinking: three-dot wave (ember ellipsis) ───────────────────────────
    case "thinking":
      return (
        <svg width={S} height={S} viewBox="0 0 12 12" className="status-thinking shrink-0" aria-hidden="true">
          <circle cx="2.2" cy="6" r="1.4" fill={color} className="think-1" />
          <circle cx="6"   cy="6" r="1.4" fill={color} className="think-2" />
          <circle cx="9.8" cy="6" r="1.4" fill={color} className="think-3" />
        </svg>
      );

    // ── working: spinning arc ───────────────────────────────────────────────
    case "working":
      return (
        <svg width={S} height={S} viewBox="0 0 12 12" className="status-working shrink-0" aria-hidden="true" style={{ transformOrigin: "center" }}>
          <circle cx="6" cy="6" r="4" fill="none" stroke={color}
            strokeWidth="2.2" strokeDasharray="11 15" strokeLinecap="round" />
        </svg>
      );

    // ── subagent: orbiting constellation ───────────────────────────────────
    case "subagent":
      return (
        <svg width={S} height={S} viewBox="0 0 12 12" className="status-subagent shrink-0" aria-hidden="true">
          <circle cx="6" cy="6" r="1.2" fill={color} />
          <g className="orbit-ring" style={{ transformOrigin: "6px 6px" } as React.CSSProperties}>
            <circle cx="6"   cy="2"   r="1.1" fill={color} />
            <circle cx="9.5" cy="8.5" r="1.1" fill={color} opacity="0.65" />
            <circle cx="2.5" cy="8.5" r="1.1" fill={color} opacity="0.35" />
          </g>
        </svg>
      );

    // ── waiting: flashing diamond ───────────────────────────────────────────
    case "waiting":
      return (
        <svg width={S} height={S} viewBox="0 0 12 12" className="status-waiting shrink-0" aria-hidden="true">
          <path d="M6 1.2 L10.8 6 L6 10.8 L1.2 6 Z" fill={color} />
        </svg>
      );

    // ── error: shaking dash ──────────────────────────────────────────────────
    case "error":
      return (
        <svg width={S} height={S} viewBox="0 0 12 12" className="status-error shrink-0" aria-hidden="true">
          <line x1="2.5" y1="6" x2="9.5" y2="6" stroke={color} strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      );

    // ── compacting: ripple-out (inner core + expanding ring) ───────────────
    case "compacting":
      return (
        <svg width={S} height={S} viewBox="0 0 12 12" className="status-compacting shrink-0" aria-hidden="true">
          <circle cx="6" cy="6" r="2.4" fill={color} className="compact-core" />
          <circle cx="6" cy="6" r="2.4" fill="none" stroke={color} strokeWidth="1" className="compact-ring" />
        </svg>
      );

    // ── clearing: dissolve-up (particles rise and fade) ─────────────────────
    case "clearing":
      return (
        <svg width={S} height={S} viewBox="0 0 12 12" className="status-clearing shrink-0" aria-hidden="true">
          <circle cx="6" cy="8" r="1.4" fill={color} className="clearing-core" />
          <circle cx="4" cy="5" r="0.9" fill={color} className="clearing-particle clearing-p1" />
          <circle cx="6" cy="3.5" r="0.7" fill={color} className="clearing-particle clearing-p2" />
          <circle cx="8" cy="5.5" r="0.8" fill={color} className="clearing-particle clearing-p3" />
        </svg>
      );

    // ── done: static checkmark ──────────────────────────────────────────────
    case "done":
      return (
        <svg width={S} height={S} viewBox="0 0 12 12" className="shrink-0" aria-hidden="true">
          <polyline points="1.5,6.2 4.5,9.5 10.5,2.5"
            fill="none" stroke={color} strokeWidth="2.1"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );

    // ── ended / fallback: dim dash ──────────────────────────────────────────
    case "ended":
      return (
        <svg width={S} height={S} viewBox="0 0 12 12" className="shrink-0" aria-hidden="true">
          <line x1="2.5" y1="6" x2="9.5" y2="6" stroke={color} strokeWidth="2" strokeLinecap="round" />
        </svg>
      );

    default:
      return (
        <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
          style={{ backgroundColor: color }} aria-hidden="true" />
      );
  }
}
