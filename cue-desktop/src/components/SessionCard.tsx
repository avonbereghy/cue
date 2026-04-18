import React, { useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { usePageVisible } from "@/hooks/usePageVisible";

/** Deterministic per-character hash for stable animation randomness */
function charHash(i: number, title: string): number {
  return (i * 2654435761 + title.charCodeAt(i % title.length) * 40503) >>> 0;
}

/** Bell-curve value (0..1) from hash, approximated via central limit theorem */
function bellFromHash(hash: number): number {
  return ((hash & 0xFF) / 255 + ((hash >> 8) & 0xFF) / 255 + ((hash >> 16) & 0xFF) / 255) / 3;
}

/**
 * Tailwind text color for the effort-level word, rendered inline after the
 * model name with an em-dash separator. Ramps cool → warm with intensity.
 * Unknown future values fall back to neutral so new level names Anthropic
 * adds still render (just without a bespoke color).
 */
function effortTextClass(level: string): string {
  switch (level.toLowerCase()) {
    case "auto":   return "text-white/55";
    case "low":    return "text-sky-300/90";
    case "medium": return "text-emerald-300/90";
    case "high":   return "text-amber-300/90";
    case "xhigh":  return "text-orange-300/90";
    case "max":    return "text-rose-300/90";
    default:       return "text-white/55";
  }
}
import type { EnrichedSession } from "@/lib/types";
import { STATE_HEX, STATE_HEX_LIGHT, STATE_DOT_HEX, STATE_DOT_HEX_LIGHT, STATE_BADGE_HEX, STATE_BADGE_HEX_LIGHT } from "@/lib/types";
import { formatTokens, formatDuration } from "@/lib/format";
import { SignalString } from "./SignalString";
import type { StrikePulse } from "./SignalString";
import { FluxEffect, FLUX_EXIT_MS } from "./FluxEffect";
import { StatusDot } from "./StatusDot";
import { CompactTankEffect } from "./CompactTankEffect";

/** Assumed duration of a /compact run. Drain fills the tank left→empty over
 *  this window; a faster second phase plays when the state actually exits. */
const COMPACT_DRAIN_MS = 120_000;
/** Duration of the accelerated fast-drain once state leaves "compacting". */
const COMPACT_EXIT_MS = 250;

export interface SessionCardProps {
  session: EnrichedSession;
  titleAnimation?: string;
  animationSpeed?: number;
  randomAnimation?: boolean;
  signalString?: boolean;
  signalFrequency?: number;
  signalMode?: string;
  signalAlpha?: number;
  signalAmplitude?: number;
  signalEcho?: number;
  signalBass?: boolean;
  signalMids?: boolean;
  signalTreble?: boolean;
  signalColorDark?: string;
  signalColorLight?: string;
  signalOffset?: number;
  signalEffect?: string;
  sandEnabled?: boolean;
  sandIntensity?: number;
  sandDirection?: number;
  sandDensity?: number;
  sandSpeed?: number;
  sandGrainSize?: number;
  sandTurbulence?: number;
  sandAlpha?: number;
  /** Flux effect (thinking state) */
  fluxEnabled?: boolean;
  fluxAlpha?: number;
  fluxIntensity?: number;
  fluxDensity?: number;
  fluxSpeed?: number;
  fluxLineLength?: number;
  fluxTurbulence?: number;
  cordRetractDelay?: number;
  cordDeployForce?: number;
  cordRetractForce?: number;
  stringSpread?: number;
  revived?: boolean;
  keyPressSpeed?: number;
  keyReleaseSpeed?: number;
  compactMode?: boolean;
  slimMode?: boolean;
  /** Context bar visibility: "always", "never", or "after200k" */
  contextThreshold?: string;
  /** Context display mode: "percent", "tokens", "remaining", "both" */
  contextDisplay?: string;
  /** Beta: show per-tool usage pills */
  showToolPills?: boolean;
  /** Beta: show current running tool in header */
  showCurrentTool?: boolean;
  /** Beta: show config counts row */
  showConfigCounts?: boolean;
  /** Timer display: "minutes" (HH:MM), "seconds" (HH:MM:SS), or "off" */
  timerDisplay?: string;
  /** Per-card expand override: 0=compact, 1=slim (no details), 2=full details. undefined = use global mode. */
  expandOverride?: number;
  onExpandCycle?: () => void;
  /** True when another session shares the same displayTitle — shows last prompt for disambiguation */
  isDuplicate?: boolean;
}

function PromptPopup({ text, onClose, isDark }: {
  text: string;
  onClose: () => void;
  isDark: boolean;
}) {
  useEffect(() => {
    const handleClick = () => onClose();
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 99999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.35)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
      }}
    >
      <div
        style={{
          background: isDark ? "rgba(28,28,32,0.96)" : "rgba(255,255,255,0.97)",
          border: isDark ? "1px solid rgba(255,255,255,0.13)" : "1px solid rgba(0,0,0,0.10)",
          borderRadius: "14px",
          padding: "20px 24px",
          maxWidth: text.length > 300 ? "680px" : "460px",
          width: "calc(100% - 48px)",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: isDark
            ? "0 24px 64px rgba(0,0,0,0.7), 0 4px 16px rgba(0,0,0,0.5)"
            : "0 24px 48px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.10)",
          animation: "prompt-popup-in 0.15s cubic-bezier(0.34, 1.4, 0.64, 1) forwards",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{
          fontSize: "0.65rem",
          fontStyle: "normal",
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: isDark ? "rgba(255,255,255,0.30)" : "rgba(0,0,0,0.35)",
          marginBottom: "8px",
          flexShrink: 0,
        }}>
          Last prompt
        </div>
        <div style={{
          fontSize: "0.85rem",
          lineHeight: "1.65",
          color: isDark ? "rgba(255,255,255,0.82)" : "rgba(0,0,0,0.72)",
          fontStyle: "italic",
          wordBreak: "break-word",
          overflowY: "auto",
          whiteSpace: "pre-wrap",
        }}>
          {text}
        </div>
      </div>
    </div>,
    document.body
  );
}

function SessionCardBase({ session, titleAnimation = "none", animationSpeed = 1.2, randomAnimation = false, signalString = false, signalFrequency = 1.0, signalMode = "simulated", signalAlpha = 0.25, signalAmplitude = 0.25, signalEcho = 1.0, signalBass = true, signalMids = true, signalTreble = true, signalColorDark = "#ffffff", signalColorLight = "#000000", signalOffset = 0, signalEffect = "string", sandEnabled = false, sandIntensity = 1.0, sandDirection = 0, sandDensity = 1.0, sandSpeed = 1.0, sandGrainSize = 1.0, sandTurbulence = 0.5, sandAlpha = 0.7, fluxEnabled = true, fluxAlpha = 0.9, fluxIntensity = 1.5, fluxDensity = 1.0, fluxSpeed = 1.0, fluxLineLength = 0.55, fluxTurbulence = 1.0, cordRetractDelay = 2.0, cordDeployForce = 1.1, cordRetractForce = 1.25, stringSpread = 0.15, revived = false, keyPressSpeed = 0.35, keyReleaseSpeed = 0.4, compactMode = false, slimMode = false, contextThreshold = "always", contextDisplay = "percent", showToolPills = false, showCurrentTool = false, showConfigCounts = false, timerDisplay = "seconds", expandOverride, onExpandCycle, isDuplicate = false }: SessionCardProps) {
  // Effective display mode: expandOverride takes precedence over global compact/slim
  const effectiveCompact = expandOverride !== undefined ? expandOverride === 0 : compactMode;
  const effectiveSlim = expandOverride !== undefined ? expandOverride <= 1 : slimMode;
  const { info, metrics } = session;
  const contextTokenThreshold = session.contextLimit >= 1_000_000 ? 200000 : 120000;
  const contextMeetsThreshold = contextThreshold !== "after200k" || metrics.lastInputTokens >= contextTokenThreshold;
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [promptPopupOpen, setPromptPopupOpen] = useState(false);
  const pageVisible = usePageVisible();

  // Sticky state: hold error/waiting states for a minimum duration before fading out
  const STICKY_HOLD_MS = 3500;
  // Two pieces of state diverge briefly during the thinking → working handoff:
  //   displayState — "physical" state: drives press-down, flux tint, ember border
  //   labelState   — "semantic" state: drives badge text, StatusDot icon, title color
  // On any other transition they track together.
  const [displayState, setDisplayState] = useState(info.state);
  const [labelState, setLabelState] = useState(info.state);
  const stickyUntilRef = useRef(0);

  // Thinking → working/subagent handoff staging. The commit (label + press-down
  // + flux retract) is driven by the SignalString's onStringsConnected callback
  // firing when all three bands have landed (clipFraction ≥ 0.98). After that
  // we wait HANDOFF_POST_CONNECT_MS so the third band's arrival is fully
  // registered, then flip both states at once. A fallback timer guards against
  // the connected signal never arriving (e.g., reduced-motion or a stalled
  // rAF loop).
  const HANDOFF_POST_CONNECT_MS = 450;
  const HANDOFF_FALLBACK_MS = 2200;
  const handoffCommitTimerRef = useRef<number | null>(null);

  // Flux linger: keep the FluxEffect mounted while thinking AND for a short
  // tail after thinking ends, so the per-line retract animation can play out
  // before the component unmounts. `fluxActive` drives the growth gate
  // (true → grow to full, false → retract toward zero).
  //
  // The string sweep + reveal hold now happen BEFORE displayState flips out
  // of thinking (see handoff choreography above), so flux active flips false
  // in lock-step with the press-down. No extra sweep delay here.
  const [fluxMounted, setFluxMounted] = useState(displayState === "thinking");
  const [fluxActive, setFluxActive] = useState(displayState === "thinking");
  const fluxUnmountTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const isThinking = displayState === "thinking";
    const clearTimers = () => {
      if (fluxUnmountTimerRef.current !== null) {
        window.clearTimeout(fluxUnmountTimerRef.current);
        fluxUnmountTimerRef.current = null;
      }
    };
    if (isThinking) {
      clearTimers();
      setFluxMounted(true);
      setFluxActive(true);
    } else if (fluxMounted) {
      // displayState just left thinking → begin retract immediately.
      // The strings have already finished their sweep during Phase A/B.
      setFluxActive(false);
      fluxUnmountTimerRef.current = window.setTimeout(() => {
        setFluxMounted(false);
        fluxUnmountTimerRef.current = null;
      }, FLUX_EXIT_MS + 80);
    }
    return clearTimers;
  }, [displayState, fluxMounted]);

  // Unmount-only cleanup for the handoff timer.
  useEffect(() => {
    return () => {
      if (handoffCommitTimerRef.current !== null) window.clearTimeout(handoffCommitTimerRef.current);
    };
  }, []);

  // Compacting drain: fillRef is read every frame by both the tank canvas and
  // the pulsing bar (via a DOM style write). Two phases — a slow linear drain
  // while state === "compacting" (assumed 2min window), then a short fast
  // drain to 0 when state transitions out. tankMounted is true iff fill > 0.
  const compactFillRef = useRef(1);
  const compactPhaseRef = useRef<"idle" | "draining" | "exiting">("idle");
  const compactStartRef = useRef(0);
  const compactExitStartRef = useRef(0);
  const compactExitFromRef = useRef(0);
  const compactRafRef = useRef<number | null>(null);
  const [tankMounted, setTankMounted] = useState(false);
  // Snapshot of lastInputTokens at compact start. While the post-compact
  // reading still matches this value, the bar would show the pre-compact
  // size (e.g. 381K / 1M) which is misleading — the new conversation has
  // actually been shrunk to a summary. Stay on the spinner until a fresh
  // API call updates the token count.
  const preCompactTokensRef = useRef<number | null>(null);
  const [staleAfterCompact, setStaleAfterCompact] = useState(false);

  useEffect(() => {
    const tick = () => {
      compactRafRef.current = null;
      const now = performance.now();
      if (compactPhaseRef.current === "draining") {
        const f = Math.max(0, 1 - (now - compactStartRef.current) / COMPACT_DRAIN_MS);
        compactFillRef.current = f;
      } else if (compactPhaseRef.current === "exiting") {
        const t = Math.min(1, (now - compactExitStartRef.current) / COMPACT_EXIT_MS);
        compactFillRef.current = compactExitFromRef.current * (1 - t);
        if (t >= 1) {
          compactPhaseRef.current = "idle";
          compactFillRef.current = 0;
        }
      }
      if (compactPhaseRef.current !== "idle") {
        compactRafRef.current = requestAnimationFrame(tick);
      } else {
        setTankMounted(false);
      }
    };

    if (displayState === "compacting") {
      // Enter / re-enter drain. A fresh entry (phase was idle) starts full;
      // otherwise we resume from wherever fill currently sits so a brief
      // flicker out of compacting doesn't reset the tank visually.
      // Special case: if we were already in the accelerated exit phase, the
      // fill has been draining at ~250ms pace and is probably near zero —
      // that's NOT a brief flicker, it's a real re-entry, so reset to full
      // instead of carrying a near-empty tank back into "compacting".
      if (compactPhaseRef.current === "idle" || compactPhaseRef.current === "exiting") {
        compactFillRef.current = 1;
        preCompactTokensRef.current = metrics.lastInputTokens;
      }
      compactStartRef.current = performance.now() - (1 - compactFillRef.current) * COMPACT_DRAIN_MS;
      compactPhaseRef.current = "draining";
      setTankMounted(true);
      setStaleAfterCompact(true);
    } else if (compactPhaseRef.current === "draining") {
      // State left compacting — accelerate to empty.
      compactPhaseRef.current = "exiting";
      compactExitStartRef.current = performance.now();
      compactExitFromRef.current = compactFillRef.current;
    }
    // Always re-schedule rAF if a phase is active. Without this, if the
    // effect re-runs mid-exit (e.g., displayState transitions exiting→done→idle
    // in quick succession), the cleanup cancels rAF but no new frame is
    // scheduled, and the tank gets stuck at a non-zero fill — visible as a
    // periwinkle sliver on the card's left edge in idle.
    if (compactPhaseRef.current !== "idle" && compactRafRef.current === null) {
      compactRafRef.current = requestAnimationFrame(tick);
    }

    return () => {
      if (compactRafRef.current !== null) {
        cancelAnimationFrame(compactRafRef.current);
        compactRafRef.current = null;
      }
    };
  }, [displayState, metrics.lastInputTokens]);

  // Clear the stale flag once a fresh API reading lands. lastInputTokens
  // changes when the first post-compact request completes, which is the
  // signal that the shown percentage reflects the new conversation.
  useEffect(() => {
    if (!staleAfterCompact) return;
    if (preCompactTokensRef.current === null) return;
    if (metrics.lastInputTokens !== preCompactTokensRef.current) {
      setStaleAfterCompact(false);
      preCompactTokensRef.current = null;
    }
  }, [metrics.lastInputTokens, staleAfterCompact]);

  // One-shot smooth-exit window applied during the thinking→working commit.
  // Flips .session-card--smooth-exit on simultaneously with the label/display
  // flip so the resulting CSS property changes interpolate over the longer
  // outExpo duration. Cleared after the transition settles.
  const [smoothExit, setSmoothExit] = useState(false);
  const smoothExitTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (smoothExitTimerRef.current !== null) window.clearTimeout(smoothExitTimerRef.current);
    };
  }, []);

  // One-shot entry animation — fires a single CSS keyframe when the card
  // enters a state that benefits from a moment of attention (error, done,
  // waiting). The class is cleared after the keyframe runs so the animation
  // replays on every fresh entry rather than sticking.
  const [entryAnim, setEntryAnim] = useState<"error" | "done" | "waiting" | null>(null);
  const entryAnimTimerRef = useRef<number | null>(null);
  const prevDisplayStateRef = useRef(displayState);
  useEffect(() => {
    const prev = prevDisplayStateRef.current;
    prevDisplayStateRef.current = displayState;
    if (prev === displayState) return;
    let anim: "error" | "done" | "waiting" | null = null;
    let duration = 0;
    if (displayState === "error" && prev !== "error") {
      anim = "error"; duration = 420;
    } else if (
      displayState === "done" &&
      (prev === "working" || prev === "subagent" || prev === "thinking" || prev === "waiting")
    ) {
      anim = "done"; duration = 720;
    } else if (displayState === "waiting" && prev !== "waiting") {
      anim = "waiting"; duration = 1000;
    }
    if (!anim) return;
    if (entryAnimTimerRef.current !== null) window.clearTimeout(entryAnimTimerRef.current);
    setEntryAnim(anim);
    entryAnimTimerRef.current = window.setTimeout(() => {
      setEntryAnim(null);
      entryAnimTimerRef.current = null;
    }, duration);
  }, [displayState]);
  useEffect(() => {
    return () => {
      if (entryAnimTimerRef.current !== null) window.clearTimeout(entryAnimTimerRef.current);
    };
  }, []);

  // Track latest info.state so the delayed commit reads the current value at
  // fire time instead of the value captured when commitHandoff was called.
  const latestStateRef = useRef(info.state);
  latestStateRef.current = info.state;

  const commitHandoff = useCallback((delayMs: number) => {
    if (handoffCommitTimerRef.current !== null) {
      window.clearTimeout(handoffCommitTimerRef.current);
    }
    handoffCommitTimerRef.current = window.setTimeout(() => {
      if (smoothExitTimerRef.current !== null) window.clearTimeout(smoothExitTimerRef.current);
      const target = latestStateRef.current;
      setSmoothExit(true);
      setLabelState(target);
      setDisplayState(target);
      handoffCommitTimerRef.current = null;
      // Clear a hair after the longest transition (border/shadow = 850ms)
      // so the class keeps the slower easing in effect until everything lands.
      // Outlast the slower flux retract (FLUX_EXIT_MS = 2500ms) so the
      // card's easing class stays on through the needles' full decay.
      smoothExitTimerRef.current = window.setTimeout(() => {
        setSmoothExit(false);
        smoothExitTimerRef.current = null;
      }, 2700);
    }, delayMs);
  }, []);

  // SignalString fires this once per deploy cycle when all three bands have
  // fully landed. That's our cue to commit the working-state swap after a
  // short grace window — so the label/press-down/flux-retract only happen
  // after the third string has connected, never before.
  const handleStringsConnected = useCallback(() => {
    const targetIsHandoffable = info.state === "working" || info.state === "subagent";
    if (!targetIsHandoffable) return;
    if (displayState !== "thinking") return;
    // Replace the fallback timer (or any stale commit) with the short
    // post-connect commit. If no commit is pending (race condition), start
    // one anyway — we've confirmed strings are connected.
    commitHandoff(HANDOFF_POST_CONNECT_MS);
  }, [info.state, displayState, commitHandoff]);

  useEffect(() => {
    const clearHandoff = () => {
      if (handoffCommitTimerRef.current !== null) {
        window.clearTimeout(handoffCommitTimerRef.current);
        handoffCommitTimerRef.current = null;
      }
    };

    const now = Date.now();

    // Everything already synced to info.state — nothing to do.
    if (info.state === displayState && info.state === labelState) {
      clearHandoff();
      return;
    }

    const targetIsHandoffable = info.state === "working" || info.state === "subagent";

    // Mid-handoff pass-through: a pending commit will finish the transition.
    // Only interfere if info.state has diverged from the handoff target.
    if (handoffCommitTimerRef.current !== null && targetIsHandoffable) return;

    // Pending commit with a now-irrelevant target gets aborted; the branches
    // below re-stage as needed.
    clearHandoff();

    const isSticky = displayState === "error" || displayState === "waiting";

    // Entering a sticky state — record hold deadline, sync both immediately.
    if (info.state === "error" || info.state === "waiting") {
      stickyUntilRef.current = now + STICKY_HOLD_MS;
      setDisplayState(info.state);
      setLabelState(info.state);
      return;
    }

    // Leaving a sticky state — delay if hold hasn't expired.
    if (isSticky && now < stickyUntilRef.current) {
      const remaining = stickyUntilRef.current - now;
      const timer = setTimeout(() => {
        setDisplayState(info.state);
        setLabelState(info.state);
      }, remaining);
      return () => clearTimeout(timer);
    }

    // Thinking → working/subagent: don't touch either state yet. Strings start
    // redeploying (driven inside SignalString off info.state); when all three
    // land the onStringsConnected callback replaces this fallback with a
    // 200ms commit. The fallback is a safety net so state never hangs if the
    // connected signal never fires (reduced motion, stalled rAF, etc.).
    if (displayState === "thinking" && labelState === "thinking" && targetIsHandoffable) {
      commitHandoff(HANDOFF_FALLBACK_MS);
      return;
    }

    // Subagent ↔ working — same ambient-active group but different tint and
    // status icon. Turn on smoothExit briefly so the tint morph rides the
    // outExpo curve instead of snapping. Shorter window than the full
    // thinking→working handoff since no flux retract is involved.
    const isActiveMorph =
      (displayState === "subagent" && info.state === "working") ||
      (displayState === "working" && info.state === "subagent");
    if (isActiveMorph) {
      if (smoothExitTimerRef.current !== null) window.clearTimeout(smoothExitTimerRef.current);
      setSmoothExit(true);
      smoothExitTimerRef.current = window.setTimeout(() => {
        setSmoothExit(false);
        smoothExitTimerRef.current = null;
      }, 900);
    }

    // Thinking → non-handoffable (typically idle or done): route through the
    // same commitHandoff delay + smoothExit path as thinking→working. A short
    // settle window (250ms) lets the animating title's per-char keyframes
    // ease toward rest before unmounting, and smoothExit stretches the
    // border/background/shadow/tint morph over 2.5s so it rides in lock-step
    // with the flux-needle retract (FLUX_EXIT_MS). Without this, the card's
    // CSS properties snap in 0.4s while flux keeps retracting — the mid-
    // retract snap reads as a visible flash.
    if (displayState === "thinking" && !targetIsHandoffable) {
      commitHandoff(250);
      return;
    }

    // Default — sync both immediately.
    setDisplayState(info.state);
    setLabelState(info.state);
  }, [info.state, displayState, labelState, commitHandoff]);

  // Strike detection refs for piano string physics
  const cardRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const titleContainerRef = useRef<HTMLSpanElement>(null);
  const pulsesRef = useRef<StrikePulse[]>([]);
  const lastStrikeCycleRef = useRef<Map<number, number>>(new Map());
  const strikeRafRef = useRef<number>(0);

  const [cardWidth, setCardWidth] = useState(9999);
  const isNarrow = cardWidth < 600;
  const hidePromptPill = cardWidth < 420;
  const hideTimer = cardWidth < 340;

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      setCardWidth(entry.contentRect.width);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const isAnimating = (info.state === "working" || info.state === "thinking" || info.state === "subagent") && titleAnimation !== "none";

  // Mathematical strike detection — computes each character's animation phase
  // and fires a pulse when it crosses the "peak displacement" threshold
  useEffect(() => {
    if (!isAnimating || !signalString || !pageVisible) {
      lastStrikeCycleRef.current.clear();
      return;
    }

    const title = session.displayTitle;

    // Build timing info for each non-space character (same logic as render)
    const chars: { charIndex: number; delay: number; duration: number }[] = [];
    [...title].forEach((ch, i) => {
      if (ch === " ") return;

      const hash = charHash(i, title);
      const bell = bellFromHash(hash);

      const charDuration = randomAnimation
        ? Math.max(0.15, animationSpeed * (0.4 + bell * 1.2))
        : animationSpeed;
      const charDelay = randomAnimation
        ? ((hash % 1000) / 1000) * animationSpeed
        : i * 0.05;

      chars.push({ charIndex: i, delay: charDelay, duration: charDuration });
    });

    // Strike at peak displacement: bounce hits at 60%, others at 50%
    const strikePhase = titleAnimation === "bounce" ? 0.6 : 0.5;
    const totalChars = chars.length;

    // Reset tracking for fresh synchronization with CSS animations
    lastStrikeCycleRef.current.clear();
    const startTime = performance.now();

    const tick = (now: number) => {
      const t = (now - startTime) / 1000;

      // Measure title position for x-mapping (cached by browser when layout unchanged)
      const cardEl = cardRef.current;
      const titleEl = titleContainerRef.current;
      const cardWidth = cardEl?.offsetWidth ?? 500;
      const titleLeft = titleEl?.offsetLeft ?? 20;
      const titleWidth = titleEl?.offsetWidth ?? 150;

      for (let ci = 0; ci < chars.length; ci++) {
        const { charIndex, delay, duration } = chars[ci];
        const elapsed = t - delay;
        if (elapsed < 0) continue;

        const cycle = Math.floor(elapsed / duration);
        const phase = (elapsed % duration) / duration;
        const lastCycle = lastStrikeCycleRef.current.get(charIndex) ?? -1;

        if (phase >= strikePhase && cycle > lastCycle) {
          lastStrikeCycleRef.current.set(charIndex, cycle);

          // Map character position to normalized 0..1 on the card
          const charX = titleLeft + (ci / Math.max(totalChars - 1, 1)) * titleWidth;
          const normalizedX = Math.min(Math.max(charX / cardWidth, 0), 1);

          pulsesRef.current.push({
            originX: normalizedX,
            startTime: now,
            amplitude: 1.0,
          });
        }
      }

      // Expire old pulses
      if (pulsesRef.current.length > 0) {
        const cutoff = now - 4000;
        pulsesRef.current = pulsesRef.current.filter(p => p.startTime > cutoff);
        if (pulsesRef.current.length > 50) {
          pulsesRef.current = pulsesRef.current.slice(-50);
        }
      }

      strikeRafRef.current = requestAnimationFrame(tick);
    };

    strikeRafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(strikeRafRef.current);
    };
  }, [isAnimating, signalString, session.displayTitle, titleAnimation, animationSpeed, randomAnimation, pageVisible]);

  const isWorking = displayState === "working" || displayState === "subagent" || displayState === "compacting" || displayState === "clearing";
  const isWaiting = displayState === "waiting";
  const isError = displayState === "error";

  const isGlass = typeof document !== "undefined" && document.documentElement.hasAttribute("data-glass");
  const isDark = isGlass || (typeof document !== "undefined" ? document.documentElement.getAttribute("data-theme") !== "light" : true);

  const STATE_DISPLAY_NAME: Record<string, string> = {
    working: "Working", thinking: "Thinking", waiting: "Waiting", error: "Error",
    subagent: "Subagent", compacting: "Compacting", clearing: "Clearing", idle: "Idle", done: "Done", ended: "Ended",
  };

  // Two color streams during the handoff:
  //   labelHex — semantic (StatusDot, visible labels). Follows labelState so
  //              the icon and dot color swap mid-transition along with text.
  //   fluxTintHex — physical (flux streamline tint). While the flux is
  //                 retracting (fluxActive=false), lock to the thinking color
  //                 so the needles don't shift hue mid-retract — the retract
  //                 reads as a single decaying orange rather than a color-flip.
  const labelHex = (isDark ? STATE_DOT_HEX : STATE_DOT_HEX_LIGHT)[labelState] ?? (isDark ? "#a8a29e" : "#78716c");
  const fluxTintStateKey = fluxActive ? displayState : "thinking";
  const fluxTintHex = (isDark ? STATE_DOT_HEX : STATE_DOT_HEX_LIGHT)[fluxTintStateKey] ?? (isDark ? "#a8a29e" : "#78716c");

  const badgeHex = (isDark ? STATE_BADGE_HEX : STATE_BADGE_HEX_LIGHT)[labelState] ?? { bg: isDark ? "rgba(168,162,158,0.15)" : "rgba(120,113,108,0.12)", text: isDark ? "#a8a29e" : "#78716c" };
  const titleHex = (isDark ? STATE_HEX : STATE_HEX_LIGHT)[labelState] ?? (isDark ? "#a8a29e" : "#78716c");
  const activeSubs = info.activeSubagents ?? 0;
  const displayStateName = labelState === "subagent" && activeSubs > 0
    ? `Subagents(${activeSubs})`
    : STATE_DISPLAY_NAME[labelState] ?? session.stateDisplayName;

  // During the smooth-exit window, text/background colors stretch longer and
  // use the same outExpo curve as the card to keep the whole retract in sync.
  const stateTransition = smoothExit
    ? "color 2500ms cubic-bezier(0.16, 1, 0.3, 1), background-color 2500ms cubic-bezier(0.16, 1, 0.3, 1)"
    : "color 600ms ease, background-color 600ms ease";

  const subagents = metrics.subagents ?? [];
  const hasSubagents = session.hasSubagents;

  // Aggregated metrics (parent + all children)
  const aggregatedInputTokens = metrics.inputTokens + subagents.reduce((s, a) => s + a.inputTokens, 0);
  const aggregatedOutputTokens = metrics.outputTokens + subagents.reduce((s, a) => s + a.outputTokens, 0);
  const aggregatedToolUses = Object.values(metrics.toolCounts).reduce((a, b) => a + b, 0)
    + subagents.reduce((s, a) => s + Object.values(a.toolCounts).reduce((x, y) => x + y, 0), 0);

  const maxTools = isNarrow ? 3 : 6;
  const topTools = Object.entries(metrics.toolCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, maxTools);
  const remainingTools = Object.keys(metrics.toolCounts).length - maxTools;

  const truncatedId = info.id ? info.id.slice(0, 8) : "";

  // Shorten workspace path: replace home dir with ~
  const shortPath = info.workspace.replace(/^\/Users\/[^/]+/, "~");

  const copySessionId = useCallback(() => {
    if (!info.id || !navigator.clipboard) return;
    navigator.clipboard.writeText(info.id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [info.id]);

  const ariaLabel = `${displayStateName}: ${session.displayTitle}, running ${formatDuration(session.durationSecs)}`;

  return (
    <div style={{ position: "relative" }}>
      {/* Vine border — rendered OUTSIDE the card's overflow-hidden so vines can overflow */}
    <div
      ref={cardRef}
      className={`overflow-hidden rounded-lg border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 session-card ${
        effectiveCompact ? "session-card--compact" : ""
      } ${
        isWorking ? "session-card--pressed" : "session-card--floating"
      } ${
        isWaiting ? "session-card--waiting" : isError ? "session-card--error" : displayState === "thinking" ? "session-card--thinking" : displayState === "compacting" ? "session-card--compacting" : displayState === "clearing" ? "session-card--clearing" : ""
      } ${
        smoothExit ? "session-card--smooth-exit" : ""
      } ${
        entryAnim ? `session-card--enter-${entryAnim}` : ""
      } ${
        effectiveCompact ? "px-2.5 py-1.5 space-y-0"
        : signalString && (signalMode === "preset" || signalMode === "audio" || signalMode === "live") ? "px-4 pt-4 pb-2 space-y-4" : "px-3 pt-2 pb-1 space-y-2"
      } ${effectiveSlim && !effectiveCompact ? "flex flex-col" : ""} ${
        compactMode ? "cursor-pointer" : ""
      }`}
      tabIndex={0}
      aria-label={ariaLabel}
      onClick={compactMode && onExpandCycle ? onExpandCycle : undefined}

      style={{
        position: "relative",
        isolation: "isolate",
        "--anim-speed": `${animationSpeed}s`,
        "--key-press-speed": `${keyPressSpeed}s`,
        "--key-release-speed": `${keyReleaseSpeed}s`,
        ...(effectiveSlim && !effectiveCompact ? { minHeight: "120px" } : {}),
      } as React.CSSProperties}
    >

      {/* Signal String / Sand — renders behind all content */}
      {signalString && (revived || info.state !== "ended") && <SignalString state={info.state} frequency={signalFrequency} revived={revived} pulses={pulsesRef} signalMode={signalMode} signalAlpha={signalAlpha} signalAmplitude={signalAmplitude} signalEcho={signalEcho} signalBass={signalBass} signalMids={signalMids} signalTreble={signalTreble} signalColorDark={signalColorDark} signalColorLight={signalColorLight} signalOffset={signalOffset} signalEffect={signalEffect} sandEnabled={sandEnabled} sandIntensity={sandIntensity} sandDirection={sandDirection} sandDensity={sandDensity} sandSpeed={sandSpeed} sandGrainSize={sandGrainSize} sandTurbulence={sandTurbulence} sandAlpha={sandAlpha} cordRetractDelay={cordRetractDelay} cordDeployForce={cordDeployForce} cordRetractForce={cordRetractForce} stringSpread={stringSpread} sessionId={info.id} contentRef={contentRef} keyReleaseSpeed={keyReleaseSpeed} onStringsConnected={handleStringsConnected} />}

      {/* Flux streamline overlay on thinking cards, tinted by the state color.
          Mounted by a linger timer: stays while thinking is active, lingers
          briefly after exit so the shader's per-line retract can play out
          before the component unmounts. `active={fluxActive}` drives the
          enter/exit growth ramp; sibling cards get different stagger phases
          via their session id seed. */}
      {signalString && fluxEnabled && fluxMounted && (
        <FluxEffect
          color={fluxTintHex}
          seed={info.id}
          active={fluxActive}
          alpha={fluxAlpha}
          intensity={fluxIntensity}
          density={fluxDensity}
          speed={fluxSpeed}
          lineLength={fluxLineLength}
          turbulence={fluxTurbulence}
          bass={signalBass}
          mids={signalMids}
          treble={signalTreble}
        />
      )}

      {/* Compacting tank — periwinkle water that drains right-to-left over
          the assumed 2min compact window, then fast-empties on state exit. */}
      {tankMounted && <CompactTankEffect fillRef={compactFillRef} />}

      <div ref={contentRef} className={`${effectiveCompact ? "space-y-0" : "space-y-2.5"} ${effectiveSlim && !effectiveCompact ? "flex flex-col flex-1" : ""}`} style={{ position: "relative", zIndex: 10 }}>
          {/* Row 1: Status dot + state badge + title + prompt pill + duration
              Shrink priority: prompt pill first (shrinks → hides), timer second, title last */}
          <div className="relative flex items-center gap-2 min-w-0 overflow-hidden">
            <StatusDot state={labelState} color={labelHex} />
            <span
              className="text-xs px-2 py-0.5 rounded-full text-center shrink-0"
              style={{
                // Layer the tinted bg over an opaque base so flux/sand behind
                // the card can't bleed through the pill. linear-gradient serves
                // as a uniform overlay of the 18%-alpha tint on top of a solid
                // app-bg base.
                background: `linear-gradient(${badgeHex.bg}, ${badgeHex.bg}), ${isDark ? "#0e0e0e" : "#f5f5f5"}`,
                color: badgeHex.text,
                transition: stateTransition,
                minWidth: "8.5em",
              }}
            >
              {displayStateName}
            </span>
            {(info.state === "working" || info.state === "thinking" || info.state === "subagent") && titleAnimation !== "none" ? (
              <span
                ref={titleContainerRef}
                className={`font-semibold anim-${titleAnimation} whitespace-nowrap overflow-hidden shrink-0`}
                style={{
                  color: titleHex,
                  transition: stateTransition,
                  // Halo matches card bg so flux streamlines can't bleed
                  // through glyph gaps and muddy the title.
                  textShadow: isDark
                    ? "0 0 6px rgba(14,14,14,0.9), 0 0 3px rgba(14,14,14,0.9)"
                    : "0 0 6px rgba(245,245,245,0.9), 0 0 3px rgba(245,245,245,0.9)",
                }}
                aria-label={session.displayTitle}
              >
                {[...session.displayTitle].map((ch, i) => {
                  if (ch === " ") return <span key={i} className="title-space" />;

                  const hash = charHash(i, session.displayTitle);
                  const bell = bellFromHash(hash);
                  const charSpeed = randomAnimation
                    ? Math.max(0.15, animationSpeed * (0.4 + bell * 1.2))
                    : animationSpeed;
                  const delay = randomAnimation
                    ? `${((hash % 1000) / 1000) * animationSpeed}s`
                    : `${i * 0.05}s`;

                  return (
                    <span
                      key={i}
                      className="title-char"
                      style={{
                        animationDelay: delay,
                        animationDuration: randomAnimation ? `${charSpeed.toFixed(2)}s` : undefined,
                      }}
                    >{ch}</span>
                  );
                })}
              </span>
            ) : (
              <span
                className="font-semibold whitespace-nowrap shrink-0"
                style={{
                  color: titleHex,
                  transition: stateTransition,
                  textShadow: isDark
                    ? "0 0 6px rgba(14,14,14,0.9), 0 0 3px rgba(14,14,14,0.9)"
                    : "0 0 6px rgba(245,245,245,0.9), 0 0 3px rgba(245,245,245,0.9)",
                }}
              >
                {session.displayTitle}
              </span>
            )}
            {metrics.customTitle && session.displayTitle !== session.workspaceName && (
              <span className="text-xs text-white/40 truncate min-w-0 shrink">
                {session.workspaceName}
              </span>
            )}
            {!hidePromptPill && isDuplicate && !metrics.customTitle && metrics.lastPrompt && (!metrics.lastPromptSessionId || metrics.lastPromptSessionId === info.id) && (
              <>
                <span
                  className="text-[0.65rem] px-1.5 py-0.5 rounded-full bg-white/10 text-white/55 italic overflow-hidden whitespace-nowrap text-ellipsis min-w-0 shrink border-0 cursor-pointer hover:bg-white/18 hover:text-white/75 transition-colors"
                  style={{ maxWidth: "140px" }}
                  onClick={(e) => { e.stopPropagation(); setPromptPopupOpen((v) => !v); }}
                >
                  {metrics.lastPrompt}
                </span>
                {promptPopupOpen && (
                  <PromptPopup
                    text={metrics.lastPrompt}
                    onClose={() => setPromptPopupOpen(false)}
                    isDark={isDark}
                  />
                )}
              </>
            )}
            {activeSubs > 0 && displayState !== "subagent" && (
              <span className="text-xs px-2 py-0.5 rounded-full shrink-0" style={{ backgroundColor: "rgba(139,92,246,0.25)", color: "#c4b5fd" }}>
                {activeSubs} subprocess{activeSubs !== 1 ? "es" : ""}
              </span>
            )}
            {info.subprocess && (
              <span className="text-xs px-2 py-0.5 rounded-full shrink-0" style={{ backgroundColor: "rgba(139,92,246,0.25)", color: "#c4b5fd" }}>
                via {info.subprocess}
              </span>
            )}
            {showCurrentTool && !effectiveCompact && !effectiveSlim && session.runningToolName && (
              <span className="inline-block text-[0.625rem] font-mono px-1.5 py-0.5 rounded-full bg-white/10 text-white/50 truncate w-[200px] shrink-0 overflow-hidden whitespace-nowrap" title={session.runningToolTarget || session.runningToolName}>
                {session.runningToolName}
                {session.runningToolTarget && <span className="text-white/30"> {session.runningToolTarget}</span>}
              </span>
            )}
            {!isNarrow && !effectiveCompact && !effectiveSlim && (
              <span className="text-[0.625rem] text-white/50 truncate font-mono" title={info.workspace}>
                {shortPath}
              </span>
            )}
            {!isNarrow && !effectiveCompact && !effectiveSlim && metrics.gitBranch && (
              <span className="text-[0.625rem] text-white/40 truncate shrink-0 flex items-center gap-1">
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 opacity-50"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z" /></svg>
                {metrics.gitBranch}
                {session.gitStatus?.dirty && <span className="text-yellow-500">*</span>}
                {(session.gitStatus?.ahead ?? 0) > 0 && <span className="text-green-500/60">{"\u2191"}{session.gitStatus!.ahead}</span>}
                {(session.gitStatus?.behind ?? 0) > 0 && <span className="text-red-500/60">{"\u2193"}{session.gitStatus!.behind}</span>}
              </span>
            )}
            {!hideTimer && !effectiveCompact && timerDisplay !== "off" && (
            <span className={`ml-auto text-[0.625rem] font-mono mono-nums shrink-0 ${isGlass ? "text-white/65" : "text-white/40"}`}>
              {timerDisplay === "minutes"
                ? formatDuration(session.durationSecs).slice(0, 5)
                : formatDuration(session.durationSecs)}
            </span>
            )}
          </div>

          {/* Agent subtitle — team agents (from JSONL or hook) or sessions with a custom title */}
          {(() => {
            const teamName = info.teamName || metrics.teamName;
            const agentName = info.agentName || metrics.agentName;
            const subtitle = teamName
              ? `${agentName || "team agent"} · ${teamName}`
              : metrics.customTitle || null;
            return subtitle ? (
              <div style={{ position: "relative", height: 0, overflow: "visible", paddingLeft: "calc(20px + 0.5rem)", marginTop: "-0.5rem" }}>
                <span style={{ fontSize: "0.65rem", color: titleHex, opacity: 0.55, fontWeight: 400, whiteSpace: "nowrap" }}>
                  {subtitle}
                </span>
              </div>
            ) : null;
          })()}

          {/* Rows 2-3 hidden in compact and slim mode */}
          {!effectiveCompact && !effectiveSlim && (<>
          {/* Row 2: Metrics */}
          <div className="relative flex items-center gap-1.5 flex-wrap text-xs text-white/50">
            {truncatedId && (
              <button
                onClick={copySessionId}
                className="flex items-center gap-1 font-mono text-[0.625rem] px-1.5 py-0.5 rounded-full bg-white/10 text-white/30 hover:text-white/60 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                title={`Copy session ID: ${info.id}`}
                aria-label={`Copy session ID ${info.id}`}
              >
                {truncatedId}&hellip;
                {copied && <span>{"\u2713"}</span>}
              </button>
            )}
            <span className="text-[0.625rem] font-mono px-1.5 py-0.5 rounded-full bg-white/10 text-white/40 whitespace-nowrap" title="User / Total messages">
              &#128172; {metrics.userMessageCount}/{metrics.messageCount}
            </span>
            <span className="text-[0.625rem] font-mono px-1.5 py-0.5 rounded-full bg-white/10 text-white/40 whitespace-nowrap">
              &#8595; {formatTokens(aggregatedInputTokens)} in
            </span>
            <span className="text-[0.625rem] font-mono px-1.5 py-0.5 rounded-full bg-white/10 text-white/40 whitespace-nowrap">
              &#8593; {formatTokens(aggregatedOutputTokens)} out
            </span>
            {aggregatedToolUses > 0 && (
              <span className="text-[0.625rem] font-mono px-1.5 py-0.5 rounded-full bg-white/10 text-white/40 whitespace-nowrap">
                &#128295; {aggregatedToolUses} tools
              </span>
            )}
            {hasSubagents && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-1 text-blue-600 hover:text-blue-500 transition-colors cursor-pointer text-[0.625rem] font-mono px-1.5 py-0.5 rounded-full border border-blue-600/40 hover:border-blue-500/50 whitespace-nowrap"
                aria-label={expanded ? "Collapse agent team" : "Expand agent team"}
                aria-expanded={expanded}
              >
                <span>{expanded ? "\u25BE" : "\u25B8"}</span>
                <span>{subagents.length} agents</span>
              </button>
            )}
            {session.todoTotal > 0 && (
              <span className="text-[0.625rem] font-mono px-1.5 py-0.5 rounded-full bg-white/10 text-white/40 whitespace-nowrap" title={session.todoCurrent || undefined}>
                {"\u2610"} {session.todoCompleted}/{session.todoTotal}
              </span>
            )}
            {session.totalDurationSecs > 0 && (
              <span className="text-[0.625rem] font-mono px-1.5 py-0.5 rounded-full bg-white/10 text-white/40 whitespace-nowrap" title="Total session time">
                &#9201; {formatDuration(session.totalDurationSecs)}
              </span>
            )}
            {session.outputTokensPerSec > 0 && (info.state === "working" || info.state === "thinking" || info.state === "subagent") && (
              <span className="text-[0.625rem] font-mono px-1.5 py-0.5 rounded-full bg-white/10 text-white/40 whitespace-nowrap">
                {session.outputTokensPerSec.toFixed(1)} tok/s
              </span>
            )}
            {!isNarrow && session.sourceDisplay !== "\u2014" && (
              <span className="text-[0.625rem] font-mono px-1.5 py-0.5 rounded-full bg-white/10 text-white/40 whitespace-nowrap">
                {session.sourceDisplay}
              </span>
            )}
          </div>

          {/* Row 3: Tool chips (beta) */}
          {showToolPills && topTools.length > 0 && (
            <div className="relative flex items-center gap-1.5 flex-wrap">
              {topTools.map(([name, count]) => (
                <span
                  key={name}
                  className="text-[0.625rem] font-mono px-1.5 py-0.5 rounded-full bg-white/10 text-white/40"
                >
                  {name} {count}
                </span>
              ))}
              {remainingTools > 0 && (
                <span className="text-[0.625rem] text-white/40">+{remainingTools}</span>
              )}
              <span className="ml-auto" />
            </div>
          )}
          </>)}

          {/* Spacer pushes context bar to bottom in slim mode */}
          {effectiveSlim && !effectiveCompact && <div className="flex-1" />}

          {/* Model name + context bar — grouped tightly */}
          {!effectiveCompact && (() => {
            const showContext = contextThreshold !== "never" && contextMeetsThreshold;
            const isCompactCtx = contextDisplay === "compact";
            const modelSpanInner = (
              <span
                className={`text-[0.625rem] font-mono flex items-center gap-1 ${isGlass ? "text-white/55" : "text-white/30"}`}
                style={{ visibility: session.modelDisplayName !== "\u2014" || session.effortLevel ? "visible" : "hidden" }}
              >
                {session.modelDisplayName !== "\u2014" ? session.modelDisplayName : "\u00A0"}
                {session.provider && <span className={isGlass ? "text-white/40" : "text-white/20"}> ({session.provider})</span>}
                {session.effortLevel && (
                  <>
                    <span className={isGlass ? "text-white/35" : "text-white/20"}>{"\u2014"}</span>
                    <span
                      className={`font-medium ${effortTextClass(session.effortLevel)}`}
                      title={`Effort level: ${session.effortLevel}`}
                    >
                      {session.effortLevel}
                    </span>
                  </>
                )}
              </span>
            );
            return (
            <div className="flex flex-col gap-1">
          {/* In compact-context mode the model row is rendered inside the
              grouped block below so the bar can share its width. Otherwise
              render it here, right-aligned. */}
          {!(isCompactCtx && showContext) && (
            <div className="self-end">{modelSpanInner}</div>
          )}

          {/* Row 4: Context usage — right-aligned to match timer position */}
          {showContext && (() => {
            const barColor = (() => {
              const p = Math.min(Math.max(session.contextUsagePercent, 0), 1);
              const green = [34, 197, 94];
              const yellow = [245, 158, 11];
              const red = [239, 68, 68];
              const [a, b, t] = p < 0.5
                ? [green, yellow, p / 0.5]
                : [yellow, red, (p - 0.5) / 0.5];
              const r = Math.round(a[0] + (b[0] - a[0]) * t);
              const g = Math.round(a[1] + (b[1] - a[1]) * t);
              const bl = Math.round(a[2] + (b[2] - a[2]) * t);
              return `rgb(${r},${g},${bl})`;
            })();
            const pct = Math.round(session.contextUsagePercent * 100);
            const tokStr = `${formatTokens(metrics.lastInputTokens)} / ${formatTokens(session.contextLimit)}`;
            // While Claude is compacting or the post-compact token count
            // hasn't refreshed yet, show the spinner instead of a misleading
            // pre-compact size. Once a fresh API reading lands the stale
            // flag clears and the bar/text swap in.
            const isCompactingUI = displayState === "compacting";
            const isLoading = isCompactingUI || staleAfterCompact || metrics.lastInputTokens === 0;

            if (contextDisplay === "compact") {
              return (
                <div
                  style={{
                    // fit-content + marginLeft: auto = shrink to widest child
                    // (the model row) and right-align within the flex-col
                    // parent. Stretch makes the bar row fill to match.
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "stretch",
                    width: "fit-content",
                    marginLeft: "auto",
                    rowGap: "4px",
                    minWidth: "90px",
                  }}
                >
                  {modelSpanInner}
                  {/* Progress bar row — always rendered. During compacting
                      it's empty (no fill); stale fill shows after. Keeping
                      this row present prevents the card from changing height
                      when the state toggles. */}
                  <div className="flex items-center gap-1.5">
                    <div className="flex-1 relative h-1.5 rounded-full bg-white/8 overflow-hidden">
                      {!isLoading && (
                        <div
                          className="absolute left-0 top-0 bottom-0 rounded-full transition-all duration-500"
                          style={{
                            width: `${Math.min(session.contextUsagePercent * 100, 100)}%`,
                            background: barColor,
                            opacity: 0.25,
                          }}
                        />
                      )}
                    </div>
                  </div>
                  {/* Third row: spinner when loading, stale/live tokens
                      otherwise. Always present so height stays constant. */}
                  {isLoading ? (
                    <div className="flex items-center justify-end" style={{ minHeight: "0.9rem" }}>
                      <svg className={`w-3 h-3 animate-spin shrink-0 ${isGlass ? "text-white/55" : "text-white/35"}`} viewBox="0 0 16 16" fill="none">
                        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
                        <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    </div>
                  ) : (
                    <span
                      className={`text-[0.625rem] mono-nums ${isGlass ? "text-white/55" : "text-white/30"}`}
                      style={{ textAlign: "right", minHeight: "0.9rem" }}
                    >
                      {tokStr}
                    </span>
                  )}
                </div>
              );
            }

            return (
              <div className="relative flex items-center gap-1.5">
                <span className={`text-[0.625rem] shrink-0 ${isGlass ? "text-white/65" : "text-white/40"}`}>Context</span>
                {isLoading ? (
                  <>
                    <div className="flex-1 relative h-1.5 rounded-full bg-white/8 overflow-hidden" />
                    <svg className="w-3 h-3 animate-spin shrink-0" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
                      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </>
                ) : (
                  <>
                    <div className="flex-1 relative h-1.5 rounded-full bg-white/8 overflow-hidden">
                      <div
                        className="absolute left-0 top-0 bottom-0 rounded-full transition-all duration-500"
                        style={{
                          width: `${Math.min(session.contextUsagePercent * 100, 100)}%`,
                          background: barColor,
                          opacity: 0.25,
                        }}
                      />
                    </div>
                    <span className={`text-[0.625rem] mono-nums shrink-0 ${isGlass ? "text-white/75" : "text-white/50"}`}>
                      {(() => {
                        switch (contextDisplay) {
                          case "tokens": return tokStr;
                          case "remaining": return `${100 - pct}% free`;
                          case "both": return `${pct}% (${tokStr})`;
                          default: return `${pct}%`;
                        }
                      })()}
                    </span>
                    {contextDisplay !== "tokens" && contextDisplay !== "both" && (
                      <span className={`text-[0.625rem] mono-nums shrink-0 ${isGlass ? "text-white/55" : "text-white/30"}`}>
                        {tokStr}
                      </span>
                    )}
                  </>
                )}
              </div>
            );
          })()}
            </div>
            );
          })()}

          {/* Token breakdown — detail mode only, when context >= 85% */}
          {!effectiveCompact && !effectiveSlim && session.contextUsagePercent >= 0.85 && (
            metrics.cacheReadTokens > 0 || metrics.cacheCreationTokens > 0
          ) && (
            <div className="relative flex items-center gap-1.5 text-[0.625rem] text-white/30 mono-nums">
              <span className="text-white/40 shrink-0">Tokens</span>
              <span>{formatTokens(metrics.inputTokens - metrics.cacheReadTokens - metrics.cacheCreationTokens)} input</span>
              {metrics.cacheReadTokens > 0 && (
                <span>{"\u00B7"} <span className="text-blue-400/60">{formatTokens(metrics.cacheReadTokens)}</span> cache read</span>
              )}
              {metrics.cacheCreationTokens > 0 && (
                <span>{"\u00B7"} <span className="text-purple-400/60">{formatTokens(metrics.cacheCreationTokens)}</span> cache write</span>
              )}
            </div>
          )}

          {/* Rate limits (from statusline bridge) */}
          {!effectiveCompact && !effectiveSlim && session.rateLimits && (session.rateLimits.fiveHourPercent > 0 || session.rateLimits.sevenDayPercent > 0) && (
            <div className="relative flex items-center gap-2 flex-wrap">
              <span className="text-[0.625rem] text-white/40 shrink-0 w-6">5h</span>
              <div className="flex-1 relative h-1 rounded-full bg-white/8 overflow-hidden min-w-[40px]">
                <div className="absolute left-0 top-0 bottom-0 rounded-full transition-all duration-500" style={{
                  width: `${Math.min(session.rateLimits.fiveHourPercent, 100)}%`,
                  background: session.rateLimits.fiveHourPercent >= 90 ? "#ef4444" : session.rateLimits.fiveHourPercent >= 75 ? "#d946ef" : "#3b82f6",
                  opacity: 0.4,
                }} />
              </div>
              <span className="text-[0.625rem] text-white/40 mono-nums shrink-0">{Math.round(session.rateLimits.fiveHourPercent)}%</span>
              {session.rateLimits.sevenDayPercent > 0 && (<>
                <span className="text-[0.625rem] text-white/40 shrink-0 w-6">7d</span>
                <div className="flex-1 relative h-1 rounded-full bg-white/8 overflow-hidden min-w-[40px]">
                  <div className="absolute left-0 top-0 bottom-0 rounded-full transition-all duration-500" style={{
                    width: `${Math.min(session.rateLimits.sevenDayPercent, 100)}%`,
                    background: session.rateLimits.sevenDayPercent >= 90 ? "#ef4444" : session.rateLimits.sevenDayPercent >= 75 ? "#d946ef" : "#3b82f6",
                    opacity: 0.4,
                  }} />
                </div>
                <span className="text-[0.625rem] text-white/40 mono-nums shrink-0">{Math.round(session.rateLimits.sevenDayPercent)}%</span>
              </>)}
              {session.rateLimits.limitReached && (
                <span className="text-[0.625rem] text-red-400 font-medium">Limit reached</span>
              )}
            </div>
          )}

          {/* Config counts (beta) */}
          {showConfigCounts && !effectiveCompact && !effectiveSlim && session.configCounts && (
            (session.configCounts.claudeMdCount + session.configCounts.rulesCount + session.configCounts.mcpServers + session.configCounts.hooksCount) > 0
          ) && (
            <div className="relative flex items-center gap-1.5 text-[0.625rem] text-white/30">
              {session.configCounts.claudeMdCount > 0 && <span>{session.configCounts.claudeMdCount} CLAUDE.md</span>}
              {session.configCounts.rulesCount > 0 && <span>{"\u00B7"} {session.configCounts.rulesCount} rules</span>}
              {session.configCounts.mcpServers > 0 && <span>{"\u00B7"} {session.configCounts.mcpServers} MCP</span>}
              {session.configCounts.hooksCount > 0 && <span>{"\u00B7"} {session.configCounts.hooksCount} hooks</span>}
            </div>
          )}
      </div>

      {/* Row 5: Expanded agent team */}
      {!effectiveCompact && !effectiveSlim && expanded && hasSubagents && (() => {
        const activeAgents = subagents.filter(a => a.isActive);
        const completedAgents = subagents.filter(a => !a.isActive);

        const renderAgent = (agent: typeof subagents[0], i: number, list: typeof subagents) => {
          const agentTotalTokens = agent.inputTokens + agent.outputTokens;
          const agentToolUses = Object.values(agent.toolCounts).reduce((a, b) => a + b, 0);
          const isLast = i === list.length - 1;
          const prefix = isLast ? "\u2514\u2500" : "\u251C\u2500";
          const label = agent.slug || agent.agentId.slice(0, 8);
          return (
            <div key={agent.agentId || i} className="flex items-center gap-2 text-xs text-white/50">
              <span className="font-mono text-white/30 shrink-0">{prefix}</span>
              <span className={`shrink-0 ${agent.isActive ? "text-blue-400/80" : "text-white/30"}`}>
                @{label}
              </span>
              {agent.description && (
                <span className="text-white/30 truncate text-[0.625rem]" title={agent.description}>
                  {agent.description}
                </span>
              )}
              <span className="ml-auto flex items-center gap-3 shrink-0 mono-nums">
                {agentToolUses > 0 && (
                  <span className="text-[0.625rem]">{agentToolUses} tools</span>
                )}
                <span className="text-[0.625rem]">{formatTokens(agentTotalTokens)} tokens</span>
              </span>
            </div>
          );
        };

        return (
          <div className="pl-3 space-y-1 border-l-2 border-blue-400/20">
            {activeAgents.map((agent, i) => renderAgent(agent, i, activeAgents))}
            {completedAgents.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-white/30 hover:text-white/50 transition-colors py-0.5 select-none">
                  {completedAgents.length} completed agent{completedAgents.length !== 1 ? "s" : ""}
                </summary>
                <div className="mt-1 space-y-1">
                  {completedAgents.map((agent, i) => renderAgent(agent, i, completedAgents))}
                </div>
              </details>
            )}
          </div>
        );
      })()}
    </div>
    </div>
  );
}

// Memoized export: prevents re-render when parent re-renders but session + settings props
// haven't changed. The session object is compared by reference — callers should ensure
// stable references (e.g. same array slot in sessions list) to get the full benefit.
export const SessionCard = React.memo(SessionCardBase);
