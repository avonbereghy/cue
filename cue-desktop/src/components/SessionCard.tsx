import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
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
import { formatTokens, formatDuration, formatClockTime, formatElapsedCompact, cleanPromptText } from "@/lib/format";
import { SignalString } from "./SignalString";
import type { StrikePulse, CometPulse, ExtraBandSpec } from "./SignalString";
import { FluxEffect, FLUX_EXIT_MS } from "./FluxEffect";
import { AuroraEffect, AURORA_EXIT_MS } from "./AuroraEffect";
import { StatusDot } from "./StatusDot";
import { FlipNumber } from "./FlipNumber";
import { SpoolContextBar } from "./SpoolContextBar";

/** Assumed duration of a /compact run. Drain fills the tank left→empty over
 *  this window; a faster second phase plays when the state actually exits. */
const COMPACT_DRAIN_MS = 120_000;
/** Duration of the accelerated fast-drain once state leaves "compacting". */
const COMPACT_EXIT_MS = 250;

/** Human-facing display names for each session state (used in the state badge
 *  and tooltips). Module-level so it isn't reallocated per render. */
const STATE_DISPLAY_NAME: Record<string, string> = {
  working: "Working", thinking: "Thinking", waiting: "Waiting", error: "Error",
  subagent: "Subagent", compacting: "Compacting", clearing: "Clearing",
  idle: "Idle", done: "Done", ended: "Ended",
};

/** States that represent a turn having ended. Used by the string-promotion
 *  logic to decide when to reset counters. Module-level so the Set isn't
 *  rebuilt each render. */
const TURN_END_STATES: ReadonlySet<string> = new Set([
  "idle", "done", "compacting", "clearing", "ended",
]);

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
  /** Deploy angle in degrees for working strings (tilt around card center) */
  stringDeployAngle?: number;
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
  /** Fire white comet tracers across the strings on every tool call. Off by default. */
  showToolCallComets?: boolean;
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

function SessionCardBase({ session, titleAnimation = "none", animationSpeed = 1.2, randomAnimation = false, signalString = false, signalFrequency = 1.0, signalMode = "simulated", signalAlpha = 0.25, signalAmplitude = 0.25, signalEcho = 1.0, signalBass = true, signalMids = true, signalTreble = true, signalColorDark = "#ffffff", signalColorLight = "#000000", signalOffset = 0, signalEffect = "string", sandEnabled = false, sandIntensity = 1.0, sandDirection = 0, sandDensity = 1.0, sandSpeed = 1.0, sandGrainSize = 1.0, sandTurbulence = 0.5, sandAlpha = 0.7, fluxEnabled = true, fluxAlpha = 0.9, fluxIntensity = 1.5, fluxDensity = 1.0, fluxSpeed = 1.0, fluxLineLength = 0.55, fluxTurbulence = 1.0, cordRetractDelay = 2.0, cordDeployForce = 1.1, cordRetractForce = 1.25, stringSpread = 0.15, stringDeployAngle = -16, revived = false, keyPressSpeed = 0.35, keyReleaseSpeed = 0.4, compactMode = false, slimMode = false, contextThreshold = "always", contextDisplay = "percent", showToolPills = false, showCurrentTool = false, showConfigCounts = false, showToolCallComets = false, timerDisplay = "seconds", expandOverride, onExpandCycle, isDuplicate = false }: SessionCardProps) {
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

  // Aurora linger: same pattern as flux, but gated on the `done` state. Stays
  // mounted briefly after the state changes so the fade-out can play out.
  const [auroraMounted, setAuroraMounted] = useState(displayState === "done");
  const [auroraActive, setAuroraActive] = useState(displayState === "done");
  const auroraUnmountTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const isDone = displayState === "done";
    const clearAuroraTimer = () => {
      if (auroraUnmountTimerRef.current !== null) {
        window.clearTimeout(auroraUnmountTimerRef.current);
        auroraUnmountTimerRef.current = null;
      }
    };
    if (isDone) {
      clearAuroraTimer();
      setAuroraMounted(true);
      setAuroraActive(true);
    } else if (auroraMounted) {
      setAuroraActive(false);
      auroraUnmountTimerRef.current = window.setTimeout(() => {
        setAuroraMounted(false);
        auroraUnmountTimerRef.current = null;
      }, AURORA_EXIT_MS + 80);
    }
    return clearAuroraTimer;
  }, [displayState, auroraMounted]);

  // Unmount-only cleanup for the handoff timer.
  useEffect(() => {
    return () => {
      if (handoffCommitTimerRef.current !== null) window.clearTimeout(handoffCommitTimerRef.current);
    };
  }, []);

  // Compacting drain: fillRef is read every frame by both the tank canvas and
  // the pulsing bar (via a DOM style write). Two phases — a slow linear drain
  // while state === "compacting" (assumed 2min window), then a short fast
  // drain to 0 when state transitions out. Read by SpoolContextBar to drive
  // the linear unwind over the compaction window.
  const compactFillRef = useRef(1);
  const compactPhaseRef = useRef<"idle" | "draining" | "exiting">("idle");
  const compactStartRef = useRef(0);
  const compactExitStartRef = useRef(0);
  const compactExitFromRef = useRef(0);
  const compactRafRef = useRef<number | null>(null);
  // Snapshot of lastInputTokens at compact start. While the post-compact
  // reading still matches this value, the bar would show the pre-compact
  // size (e.g. 381K / 1M) which is misleading — the new conversation has
  // actually been shrunk to a summary. Stay on the spinner until a fresh
  // API call updates the token count.
  const preCompactTokensRef = useRef<number | null>(null);
  const [staleAfterCompact, setStaleAfterCompact] = useState(false);

  useEffect(() => {
    // Effect-local flag: tick() self-reschedules, so when cleanup cancels the
    // pending frame, we also need to stop the tick that's already in flight
    // from queuing a fresh one. Without this, one extra frame can fire after
    // cleanup and loop forever (compactPhaseRef outlives the effect).
    let unmounted = false;
    const tick = () => {
      compactRafRef.current = null;
      if (unmounted) return;
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
      unmounted = true;
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
      const target = latestStateRef.current;
      handoffCommitTimerRef.current = null;
      // If state flipped back to thinking between schedule and fire, bail —
      // the main effect will re-stage a fresh commit when strings reconnect.
      // Broader "not working/subagent" guards are wrong: this callback is
      // also scheduled for working/subagent → idle/done exits (line ~574),
      // and bailing there leaves labelState/displayState stuck on "working"
      // while strings, flux, and dust all animate to the idle state.
      if (target === "thinking") return;
      if (smoothExitTimerRef.current !== null) window.clearTimeout(smoothExitTimerRef.current);
      setSmoothExit(true);
      setLabelState(target);
      setDisplayState(target);
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

    // Working/subagent → retract-target: strings are deployed and need
    // physical retract time (cord physics + damping ≈ 1-2s). Hold displayState
    // briefly so the retract visibly begins under the active label, then
    // commit with smoothExit stretching the tint/border/shadow morph over
    // 2.5s so the card's CSS eases in lockstep with the strings' decay.
    //
    // Retract targets are exactly the "strings retracted" group in
    // SignalString: idle, done, compacting, clearing, ended. Explicitly NOT
    // thinking (strings stay deployed through working↔thinking), and NOT
    // error/waiting (sticky-deployed — handled by the sticky-entry branch
    // above, which fires before this one).
    const isRetractTarget =
      info.state === "idle" ||
      info.state === "done" ||
      info.state === "compacting" ||
      info.state === "clearing" ||
      info.state === "ended";
    const isActiveExit =
      (displayState === "working" || displayState === "subagent") &&
      isRetractTarget;
    if (isActiveExit) {
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

  // Tool-call comets — one thin white tracer per tool call shot across the
  // strings while the session is actively working/subagenting. `prevToolUsesRef`
  // starts null so we seed on mount without emitting a burst for historical
  // tool calls that were already logged before the card rendered.
  const cometsRef = useRef<CometPulse[]>([]);
  const prevToolUsesRef = useRef<number | null>(null);

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

  // ─── Subagent string lines ──────────────────────────────────────────────
  // Track whether we entered the subagent state from working — that's what
  // determines whether the 3 white base lines persist alongside the blue
  // subagent lines, or are suppressed.
  // Subagent state now suppresses base bands unconditionally so the visible
  // string count matches the "Subagents(N)" badge. Previously this latched on
  // a working→subagent transition and kept the 3 base bands rendering
  // alongside, giving N + base_count visible strings.
  const suppressBaseBands = displayState === "subagent";

  // Build the extraBands list. One blue line per active subagent, identified
  // by a stable slot id ("sub-0", "sub-1", …) so add/remove maps correctly to
  // LIFO retract behavior in SignalString.
  //
  // Axis: each line runs roughly bottom-left → top-right with seeded jitter
  // so siblings sit at slightly different angles. Seed = sessionId + slotIdx
  // so each subagent slot has a stable axis across renders.
  const subagentExtraBands = useMemo(() => {
    if (displayState !== "subagent" || activeSubs <= 0) return [];
    // Cyan / subagent blue (#7CC5FF) — same colour family the badge uses.
    const color = isDark ? { r: 124, g: 197, b: 255 } : { r: 42, g: 139, b: 217 };
    const kinds: ("bass" | "mids" | "treble")[] = ["mids", "treble", "bass"];
    const seedHash = (s: string) => {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0) / 0xffffffff;
    };
    const out: { id: string; bandKind: "bass" | "mids" | "treble"; axisStart: { xFrac: number; yFrac: number }; axisEnd: { xFrac: number; yFrac: number }; color: { r: number; g: number; b: number }; phaseJitter: number }[] = [];
    for (let i = 0; i < activeSubs; i++) {
      const id = `${info.id}-sub-${i}`;
      const r1 = seedHash(id + "@y");
      const r4 = seedHash(id + "@phase");
      // Subagent strings now run straight across the card horizontally. Each
      // sibling gets a seeded y position in [0.18, 0.82] — the edge-safe zone
      // that clears the state row and the context bar — so multiple active
      // subagents spread vertically rather than stacking on a single line.
      const yFrac = 0.18 + r1 * 0.64;
      out.push({
        id,
        bandKind: kinds[i % kinds.length],
        axisStart: { xFrac: -0.05, yFrac },
        axisEnd:   { xFrac:  1.05, yFrac },
        color,
        phaseJitter: r4 * Math.PI * 2,
      });
    }
    return out;
  }, [displayState, activeSubs, info.id, isDark]);

  // During the smooth-exit window, text/background colors stretch longer and
  // use the same outExpo curve as the card to keep the whole retract in sync.
  // Normal state changes decelerate with outCubic — state-badge color is a
  // value arrival (new state reached), so it should ease out, not ease-in-out.
  const stateTransition = smoothExit
    ? "color 2500ms cubic-bezier(0.16, 1, 0.3, 1), background-color 2500ms cubic-bezier(0.16, 1, 0.3, 1)"
    : "color 450ms cubic-bezier(0.33, 1, 0.68, 1), background-color 450ms cubic-bezier(0.33, 1, 0.68, 1)";

  const subagents = metrics.subagents ?? [];
  const hasSubagents = session.hasSubagents;

  // Aggregated metrics (parent + all children)
  const aggregatedInputTokens = metrics.inputTokens + subagents.reduce((s, a) => s + a.inputTokens, 0);
  const aggregatedOutputTokens = metrics.outputTokens + subagents.reduce((s, a) => s + a.outputTokens, 0);
  const aggregatedToolUses = Object.values(metrics.toolCounts).reduce((a, b) => a + b, 0)
    + subagents.reduce((s, a) => s + Object.values(a.toolCounts).reduce((x, y) => x + y, 0), 0);

  // Emit a white tracer comet each time the aggregated tool-use count ticks
  // up while the session is actively working. Backend polling can land
  // multiple new calls in one update, so a delta of N stages N comets with
  // small offsets to avoid a synchronized volley. Seed the ref on first
  // observation so mid-stream mounts don't flash every historical call.
  useEffect(() => {
    const prev = prevToolUsesRef.current;
    if (prev === null) {
      prevToolUsesRef.current = aggregatedToolUses;
      return;
    }
    prevToolUsesRef.current = aggregatedToolUses;

    if (!showToolCallComets) return;
    const delta = aggregatedToolUses - prev;
    if (delta <= 0) return;
    if (info.state !== "working" && info.state !== "subagent") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const now = performance.now();
    const count = Math.min(delta, 8); // cap volley size on large bursts
    for (let i = 0; i < count; i++) {
      // Random Y in [0.25, 0.75] of card height — keeps comets inside the
      // visual safe zone (between the top state row and bottom context row).
      const yFrac = 0.25 + Math.random() * 0.50;
      cometsRef.current.push({ startTime: now + i * 90, yFrac });
    }
    if (cometsRef.current.length > 40) {
      cometsRef.current = cometsRef.current.slice(-40);
    }
  }, [aggregatedToolUses, info.state, showToolCallComets]);

  // ─── Progressive working strings ──────────────────────────────────────
  // One string deploys on entering a turn. A new string is added for every
  // 10 seconds of active generation (working / thinking / subagent), up to
  // a max of 5. Waiting / error pauses freeze the clock; the counter is
  // preserved through them and resumes when active again. Turn-end states
  // (idle / done / compacting / clearing / ended) reset the counter to 0.
  //
  //   count = min(5, 1 + floor(activeGenMs / 10_000))
  //
  // Strings 1–3 gate the bass/mids/treble base bands (SignalString deploys
  // in priority [mids, bass, treble]). Strings 4–5 render as mids-physics
  // extra bands at wider vertical offsets.
  // Reset on turn-end states from EITHER signal. displayState has sticky
  // handoff logic that can hold "working" briefly after info.state has already
  // flipped to compacting/idle/done — without also checking info.state, the
  // reset would miss those fast exits and the counter would leak into the
  // next turn.
  const isTurnOngoing = !TURN_END_STATES.has(displayState) && !TURN_END_STATES.has(info.state);
  // Strings are visible (deployed) during working and subagent only. Thinking,
  // waiting, and error do not show strings — the counter is preserved through
  // them, but the strings themselves retract.
  const canDeployStrings = displayState === "working" || displayState === "subagent";
  // The counter only promotes during *purely* working — subagent and thinking
  // accumulate no active-generation time toward the next string.
  const isPromoting = displayState === "working";
  const [stringCount, setStringCount] = useState<number>(0);
  // Cumulative time spent in purely-working state since turn start.
  // Other mid-turn states freeze the clock; the counter is preserved but not
  // promoted until we return to working.
  const activeGenMsRef = useRef(0);
  const lastTickMsRef = useRef<number | null>(null);
  // Cumulative active-generation thresholds for strings 1..5. The first
  // string now also gets a short warm-up so the card doesn't snap straight
  // to a deployed state the instant work starts. Upper strings stretch so
  // 4 and 5 read as increasingly rare.
  //   1st string →  1s    (short warm-up, unchanged)
  //   2nd string → 60s    (2×30s)
  //   3rd string →  3:00  (2×1:30)
  //   4th string → 10:00  (2×5:00)
  //   5th string → 20:00  (2×10:00)
  const STRING_THRESHOLDS_MS = [1_000, 60_000, 180_000, 600_000, 1_200_000];

  useEffect(() => {
    if (!isTurnOngoing) {
      activeGenMsRef.current = 0;
      lastTickMsRef.current = null;
      setStringCount(c => (c === 0 ? c : 0));
      return;
    }
    if (lastTickMsRef.current === null) {
      lastTickMsRef.current = performance.now();
    }
    const tick = () => {
      const now = performance.now();
      const last = lastTickMsRef.current ?? now;
      // Wall-time backstop: if the gap since our last tick is huge, the
      // session was almost certainly inactive in between (component throttled,
      // tab hidden, or a turn-end transition was missed). Treat that gap as a
      // turn boundary and reset the counter rather than silently preserving
      // it across what was effectively a different turn.
      const gap = now - last;
      if (gap > 8_000) {
        activeGenMsRef.current = 0;
        setStringCount(c => (c === 0 ? c : 0));
        lastTickMsRef.current = now;
        return;
      }
      // Only bank time while purely working. Thinking / subagent / waiting /
      // error just advance `last` so the delta when we resume is small.
      if (isPromoting) {
        activeGenMsRef.current += gap;
      }
      lastTickMsRef.current = now;
      const elapsed = activeGenMsRef.current;
      let target = 0;
      for (const ms of STRING_THRESHOLDS_MS) {
        if (elapsed >= ms) target += 1;
      }
      // Hard cap at 5 working strings per session (subagents add their own
      // bands on top of this ceiling — they're accounted for separately).
      target = Math.min(5, target);
      setStringCount(c => {
        const next = c < target ? target : c;
        return Math.min(5, next);
      });
    };
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [isTurnOngoing, isPromoting]);

  // Fallback reset: a new user prompt is the most reliable "new turn" signal
  // available, regardless of whether the previous turn fired its done/idle
  // transition. If userMessageCount ticks up, force the counter back to zero
  // so a leaked accumulator from a stuck previous turn (e.g., Claude Code
  // process died before Stop hook fired) doesn't pre-deploy 4–5 strings on
  // a turn that's only been working for seconds.
  const prevUserMsgCountRef = useRef(metrics.userMessageCount);
  useEffect(() => {
    if (metrics.userMessageCount > prevUserMsgCountRef.current) {
      activeGenMsRef.current = 0;
      lastTickMsRef.current = null;
      setStringCount(c => (c === 0 ? c : 0));
    }
    prevUserMsgCountRef.current = metrics.userMessageCount;
  }, [metrics.userMessageCount]);

  // Target reflects the turn's intended deployment, not the transient
  // displayState. Mid-turn transitions (working → thinking/waiting/error →
  // working) keep the target stable so already-deployed strings aren't
  // mistaken for "should be retracted" and torn down on re-entry. SignalString
  // handles the visual gate via `stringsStayDeployed`. stringCount itself
  // resets on turn-end states, so the target falls to 0 naturally there.
  const isMidTurn =
    canDeployStrings ||
    displayState === "thinking" ||
    displayState === "waiting" ||
    displayState === "error";
  const baseBandsTarget = isMidTurn ? Math.min(stringCount, 3) : 0;

  // Amplitude progression: each new string that spawns during a long working
  // session is 5% louder than the one before (compounded). String N gets a
  // multiplier of 1.05^(N-1). String 1 = 1.0, 2 = 1.05, 3 = 1.1025, 4 = ~1.158,
  // 5 = ~1.2155. Multipliers are assigned to each string at the moment it
  // appears and persist for the rest of the turn. Deploy order is
  // [mids, bass, treble] (see BAND_PRIORITY inside SignalString), so:
  //   string 1 → mids   (bandIdx 1) → 1.0
  //   string 2 → bass   (bandIdx 0) → 1.05
  //   string 3 → treble (bandIdx 2) → 1.1025
  // Strings 4 and 5 are extra bands — their multiplier rides on the
  // ExtraBandSpec.amplitudeMul field set below.
  const AMP_STEP = 1.05;
  const baseBandsAmpMuls: [number, number, number] = [
    AMP_STEP,           // bandIdx 0 (bass)   = string 2
    1,                  // bandIdx 1 (mids)   = string 1
    AMP_STEP * AMP_STEP, // bandIdx 2 (treble) = string 3
  ];

  // Strings 4 and 5 — extras that inherit the active signal theme color and
  // each get their own phase jitter so they wobble out of lockstep with the
  // base bands. String 4 follows mids physics; string 5 follows bass physics
  // — giving them different audio drives is what makes them look distinct
  // from each other, since phase jitter alone won't separate two bands fed by
  // the same audio envelope. Positioned at widened vertical offsets above/
  // below the base-band trio.
  const workingExtraBands = useMemo(() => {
    if (!canDeployStrings || stringCount <= 3) return [];
    const hex = isDark ? signalColorDark : signalColorLight;
    const cleaned = hex.replace("#", "");
    const r = parseInt(cleaned.slice(0, 2), 16) || 255;
    const g = parseInt(cleaned.slice(2, 4), 16) || 255;
    const b = parseInt(cleaned.slice(4, 6), 16) || 255;
    const color = { r, g, b };
    const jitterSeed = (s: string) => {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return ((h >>> 0) / 0xffffffff) * Math.PI * 2;
    };
    const yBelow = Math.min(0.92, 0.5 + stringSpread * 2.0);
    const yAbove = Math.max(0.08, 0.5 - stringSpread * 2.0);
    // Strings 4 and 5 now run on opposing diagonals so together they form an X
    // across the card — the working-string diagonal read, matching base bands
    // (which render tilted via a canvas rotation in SignalString). stringSpread
    // controls how far the corners push past the horizontal midline.
    const xPad = 0.05;
    const bands: ExtraBandSpec[] = [];
    if (stringCount >= 4) {
      bands.push({
        id: `${info.id}-work-4`,
        bandKind: "mids",
        // bottom-left → top-right
        axisStart: { xFrac: -xPad,    yFrac: yBelow },
        axisEnd:   { xFrac: 1 + xPad, yFrac: yAbove },
        color,
        phaseJitter: jitterSeed(`${info.id}@work-4`),
        amplitudeMul: Math.pow(1.05, 3), // string 4
      });
    }
    if (stringCount >= 5) {
      bands.push({
        id: `${info.id}-work-5`,
        bandKind: "bass",
        // top-left → bottom-right (opposite diagonal, forming an X with #4)
        axisStart: { xFrac: -xPad,    yFrac: yAbove },
        axisEnd:   { xFrac: 1 + xPad, yFrac: yBelow },
        color,
        phaseJitter: jitterSeed(`${info.id}@work-5`),
        amplitudeMul: Math.pow(1.05, 4), // string 5
      });
    }
    return bands;
  }, [canDeployStrings, stringCount, stringSpread, info.id, isDark, signalColorDark, signalColorLight]);

  const combinedExtraBands = useMemo(
    () => [...subagentExtraBands, ...workingExtraBands],
    [subagentExtraBands, workingExtraBands],
  );

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
        : signalString && (signalMode === "preset" || signalMode === "audio" || signalMode === "live") ? "px-4 pt-3 pb-1 space-y-4" : "px-3 pt-2 pb-0.5 space-y-2"
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

      {/* Aurora wash — done-state ambient background. Slow FBM flow; mounts
          on done, fades out via AURORA_EXIT_MS when state leaves. */}
      {auroraMounted && (revived || info.state !== "ended") && (
        <AuroraEffect
          seed={info.id}
          active={auroraActive}
          alpha={0.75}
          speed={0.55}
        />
      )}

      {/* Signal String / Sand — renders behind all content */}
      {signalString && (revived || info.state !== "ended") && <SignalString state={info.state} frequency={signalFrequency} revived={revived} pulses={pulsesRef} comets={cometsRef} signalMode={signalMode} signalAlpha={signalAlpha} signalAmplitude={signalAmplitude} signalEcho={signalEcho} signalBass={signalBass} signalMids={signalMids} signalTreble={signalTreble} signalColorDark={signalColorDark} signalColorLight={signalColorLight} signalOffset={signalOffset} signalEffect={signalEffect} sandEnabled={sandEnabled} sandIntensity={sandIntensity} sandDirection={sandDirection} sandDensity={sandDensity} sandSpeed={sandSpeed} sandGrainSize={sandGrainSize} sandTurbulence={sandTurbulence} sandAlpha={sandAlpha} cordRetractDelay={cordRetractDelay} cordDeployForce={cordDeployForce} cordRetractForce={cordRetractForce} stringSpread={stringSpread} stringDeployAngle={stringDeployAngle} sessionId={info.id} contentRef={contentRef} keyReleaseSpeed={keyReleaseSpeed} onStringsConnected={handleStringsConnected} extraBands={combinedExtraBands} suppressBaseBands={suppressBaseBands} baseBandsTarget={baseBandsTarget} baseBandsAmpMuls={baseBandsAmpMuls} />}

      {/* Flux streamline overlay on thinking cards, tinted by the state color.
          Mounted by a linger timer: stays while thinking is active, lingers
          briefly after exit so the shader's per-line retract can play out
          before the component unmounts. `active={fluxActive}` drives the
          enter/exit growth ramp; sibling cards get different stagger phases
          via their session id seed. */}
      {fluxEnabled && fluxMounted && (revived || info.state !== "ended") && (
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

      <div ref={contentRef} className={`${effectiveCompact ? "space-y-0" : "space-y-2.5"} ${effectiveSlim && !effectiveCompact ? "flex flex-col flex-1" : ""}`} style={{ position: "relative", zIndex: 10 }}>
          {/* Row 1: Status dot + state badge + title + prompt pill + duration
              Shrink priority: prompt pill first (shrinks → hides), timer second, title last */}
          <div className="relative flex items-center gap-2 min-w-0 overflow-hidden">
            <span className="self-center flex"><StatusDot state={labelState} color={labelHex} /></span>
            <span
              className="text-xs px-2 py-1 rounded-full text-center shrink-0 leading-none"
              style={{
                // Layer the tinted bg over an opaque base so flux/sand behind
                // the card can't bleed through the pill. linear-gradient serves
                // as a uniform overlay of the 18%-alpha tint on top of a solid
                // app-bg base.
                background: `linear-gradient(${badgeHex.bg}, ${badgeHex.bg}), ${isDark ? "#0e0e0e" : "#f5f5f5"}`,
                color: badgeHex.text,
                transition: stateTransition,
                minWidth: "8.5em",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {displayStateName}
            </span>
            {(info.state === "working" || info.state === "thinking" || info.state === "subagent") && titleAnimation !== "none" ? (
              <span
                ref={titleContainerRef}
                className={`font-semibold anim-${titleAnimation} whitespace-nowrap overflow-hidden shrink-0 leading-none`}
                style={{
                  color: titleHex,
                  transition: stateTransition,
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
                className="font-semibold whitespace-nowrap shrink-0 leading-none"
                style={{
                  color: titleHex,
                  transition: stateTransition,
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
            {(() => {
              // Short transcript snippet inline next to the title — a typographic
              // "›" line instead of a pill. State-tinted text with a right-edge
              // mask-fade so it trails off rather than hitting a hard ellipsis.
              // Gated to duplicate workspaces (disambiguation case); click opens
              // the full PromptPopup.
              if (hidePromptPill || !isDuplicate || metrics.customTitle) return null;
              if (metrics.lastPromptSessionId && metrics.lastPromptSessionId !== info.id) return null;
              const preferAssistant = info.state !== "thinking" && !!metrics.lastAssistantText;
              const rawText = preferAssistant
                ? (metrics.lastAssistantText as string)
                : metrics.lastPrompt;
              const text = cleanPromptText(rawText);
              if (!text) return null;
              const bodyColor = badgeHex.text;
              const glyphColor = labelHex;
              const fadeMask = "linear-gradient(to right, #000 0%, #000 72%, transparent 100%)";
              return (
                <>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setPromptPopupOpen((v) => !v); }}
                    title={preferAssistant ? "Latest assistant message" : "Last prompt"}
                    className="bg-transparent border-0 p-0 cursor-pointer shrink overflow-hidden whitespace-nowrap inline-flex items-center"
                    style={{
                      fontSize: "0.72rem",
                      lineHeight: 1,
                      letterSpacing: "-0.005em",
                      color: bodyColor,
                      fontStyle: preferAssistant ? "normal" : "italic",
                      fontWeight: 400,
                      opacity: 0.9,
                      maxWidth: "180px",
                      WebkitMaskImage: fadeMask,
                      maskImage: fadeMask,
                      transition: "color 200ms, opacity 200ms",
                    }}
                  >
                    <span
                      style={{
                        color: glyphColor,
                        opacity: 0.8,
                        marginRight: "0.35em",
                        fontStyle: "normal",
                        fontWeight: 500,
                      }}
                      aria-hidden
                    >
                      {preferAssistant ? "›" : "»"}
                    </span>
                    {text}
                  </button>
                  {promptPopupOpen && (
                    <PromptPopup
                      text={text}
                      onClose={() => setPromptPopupOpen(false)}
                      isDark={isDark}
                    />
                  )}
                </>
              );
            })()}
            {activeSubs > 0 && displayState !== "subagent" && (
              <span className="self-center text-xs px-2 py-0.5 rounded-full shrink-0" style={{ backgroundColor: "rgba(139,92,246,0.25)", color: "#c4b5fd" }}>
                {activeSubs} subprocess{activeSubs !== 1 ? "es" : ""}
              </span>
            )}
            {info.subprocess && (
              <span className="self-center text-xs px-2 py-0.5 rounded-full shrink-0" style={{ backgroundColor: "rgba(139,92,246,0.25)", color: "#c4b5fd" }}>
                via {info.subprocess}
              </span>
            )}
            {showCurrentTool && !effectiveCompact && !effectiveSlim && session.runningToolName && (
              <span className="self-center inline-block text-[0.625rem] font-mono px-1.5 py-0.5 rounded-full bg-white/10 text-white/50 truncate w-[200px] shrink-0 overflow-hidden whitespace-nowrap" title={session.runningToolTarget || session.runningToolName}>
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
            {!effectiveCompact && (session.modelDisplayName !== "\u2014" || session.effortLevel || (!hideTimer && timerDisplay !== "off")) && (
            <div className="ml-auto self-center flex items-center gap-1.5 shrink-0">
              {session.modelDisplayName !== "\u2014" && (
                <span className={`text-[0.625rem] font-mono flex items-center gap-1 ${isGlass ? "text-white/55" : "text-white/30"}`}>
                  {session.modelDisplayName}
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
              )}
              {!hideTimer && timerDisplay !== "off" && !effectiveSlim && (
                <span className={`text-[0.625rem] font-mono mono-nums ${isGlass ? "text-white/65" : "text-white/40"}`}>
                  {timerDisplay === "minutes"
                    ? formatDuration(session.durationSecs).slice(0, 5)
                    : formatDuration(session.durationSecs)}
                </span>
              )}
            </div>
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

          {/* Context bar */}
          {!effectiveCompact && (() => {
            const showContext = contextThreshold !== "never" && contextMeetsThreshold;
            return (
            <div className="flex flex-col gap-1">

          {/* Row 4: Context usage — right-aligned to match timer position */}
          {showContext && (() => {
            // Rest-state silk color — green→yellow→red ramp against context
            // usage. The blue unwind palette only activates while compacting.
            const restBarRgb = ((): [number, number, number] => {
              const p = Math.min(Math.max(session.contextUsagePercent, 0), 1);
              const green: [number, number, number] = [34, 197, 94];
              const yellow: [number, number, number] = [245, 158, 11];
              const red: [number, number, number] = [239, 68, 68];
              const [a, b, t] = p < 0.5
                ? [green, yellow, p / 0.5]
                : [yellow, red, (p - 0.5) / 0.5];
              return [
                Math.round(a[0] + (b[0] - a[0]) * t),
                Math.round(a[1] + (b[1] - a[1]) * t),
                Math.round(a[2] + (b[2] - a[2]) * t),
              ];
            })();
            const pct = Math.round(session.contextUsagePercent * 100);
            const tokStr = `${formatTokens(metrics.lastInputTokens)} / ${formatTokens(session.contextLimit)}`;
            const isCompactingUI = displayState === "compacting";
            // Spinner runs only when something is genuinely in flight:
            // actively compacting, or awaiting the post-compact API reading
            // that will swap in the new size. Outside of those, no spinner.
            const showSpinner = isCompactingUI || staleAfterCompact;
            // No token data yet and no loading happening — show a static
            // empty circle rather than either a spinner (implies loading)
            // or a "0 / 1M" readout (implies zero context, misleading when
            // the session simply hasn't published metrics yet).
            const contextUnknown = !showSpinner && metrics.lastInputTokens === 0;

            if (contextDisplay === "compact") {
              return (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "stretch",
                    width: "130px",
                    marginLeft: "auto",
                    rowGap: "2px",
                  }}
                >
                  {/* Progress bar row — always rendered. During compacting
                      or while stale post-compact, show empty bar so the old
                      fill doesn't show alongside the loading spinner. */}
                  <div className="flex items-center gap-1.5">
                    <SpoolContextBar
                      fillPercent={staleAfterCompact && !isCompactingUI ? 0 : session.contextUsagePercent}
                      isCompacting={isCompactingUI}
                      compactFillRef={compactFillRef}
                      isDark={isDark}
                      barHeight={10}
                      restColor={restBarRgb}
                    />
                  </div>
                  {/* Third row: spinner while compacting/stale, static
                      empty circle when context is unknown, stale/live
                      tokens otherwise. Always present so height stays
                      constant. */}
                  {showSpinner ? (
                    <div className="flex items-center justify-end" style={{ minHeight: "0.9rem" }}>
                      <svg className={`w-3 h-3 animate-spin shrink-0 ${isGlass ? "text-white/55" : "text-white/35"}`} viewBox="0 0 16 16" fill="none">
                        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
                        <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    </div>
                  ) : contextUnknown ? (
                    <div className="flex items-center justify-end" style={{ minHeight: "0.9rem" }}>
                      <svg className={`w-3 h-3 shrink-0 ${isGlass ? "text-white/45" : "text-white/25"}`} viewBox="0 0 16 16" fill="none">
                        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.5" strokeWidth="2" />
                      </svg>
                    </div>
                  ) : (
                    <FlipNumber
                      value={tokStr}
                      className={`text-[0.625rem] mono-nums ${isGlass ? "text-white/55" : "text-white/30"}`}
                      style={{ textAlign: "right", minHeight: "0.9rem" }}
                    />
                  )}
                </div>
              );
            }

            return (
              <div className="relative flex items-center gap-1.5">
                <span className={`text-[0.625rem] shrink-0 ${isGlass ? "text-white/65" : "text-white/40"}`}>Context</span>
                {showSpinner && !isCompactingUI ? (
                  <>
                    <div className="flex-1 relative h-1.5 rounded-full bg-white/8 overflow-hidden" />
                    <svg className="w-3 h-3 animate-spin shrink-0" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
                      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </>
                ) : contextUnknown ? (
                  <>
                    <div className="flex-1 relative h-1.5 rounded-full bg-white/8 overflow-hidden" />
                    <svg className={`w-3 h-3 shrink-0 ${isGlass ? "text-white/45" : "text-white/25"}`} viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.5" strokeWidth="2" />
                    </svg>
                  </>
                ) : (
                  <>
                    <SpoolContextBar
                      fillPercent={session.contextUsagePercent}
                      isCompacting={isCompactingUI}
                      compactFillRef={compactFillRef}
                      isDark={isDark}
                      barHeight={12}
                      restColor={restBarRgb}
                    />
                    <FlipNumber
                      value={(() => {
                        switch (contextDisplay) {
                          case "tokens": return tokStr;
                          case "remaining": return `${100 - pct}% free`;
                          case "both": return `${pct}% (${tokStr})`;
                          default: return `${pct}%`;
                        }
                      })()}
                      className={`text-[0.625rem] mono-nums shrink-0 ${isGlass ? "text-white/75" : "text-white/50"}`}
                    />
                    {contextDisplay !== "tokens" && contextDisplay !== "both" && (
                      <FlipNumber
                        value={tokStr}
                        className={`text-[0.625rem] mono-nums shrink-0 ${isGlass ? "text-white/55" : "text-white/30"}`}
                      />
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
                <div className="absolute left-0 top-0 bottom-0 rounded-full" style={{
                  transition: "width 500ms cubic-bezier(0.33, 1, 0.68, 1), background-color 300ms cubic-bezier(0.33, 1, 0.68, 1)",
                  width: `${Math.min(session.rateLimits.fiveHourPercent, 100)}%`,
                  background: session.rateLimits.fiveHourPercent >= 90 ? "#ef4444" : session.rateLimits.fiveHourPercent >= 75 ? "#d946ef" : "#3b82f6",
                  opacity: 0.4,
                }} />
              </div>
              <span className="text-[0.625rem] text-white/40 mono-nums shrink-0">{Math.round(session.rateLimits.fiveHourPercent)}%</span>
              {session.rateLimits.sevenDayPercent > 0 && (<>
                <span className="text-[0.625rem] text-white/40 shrink-0 w-6">7d</span>
                <div className="flex-1 relative h-1 rounded-full bg-white/8 overflow-hidden min-w-[40px]">
                  <div className="absolute left-0 top-0 bottom-0 rounded-full" style={{
                  transition: "width 500ms cubic-bezier(0.33, 1, 0.68, 1), background-color 300ms cubic-bezier(0.33, 1, 0.68, 1)",
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
              <span className={`shrink-0 ${agent.isActive ? "text-[#7CC5FF]" : "text-white/30"}`}>
                @{label}
              </span>
              {agent.description && (
                <span className="text-white/30 truncate text-[0.625rem]" title={agent.description}>
                  {agent.description}
                </span>
              )}
              <span className="ml-auto flex items-center gap-3 shrink-0 mono-nums">
                {agent.startedAt != null && (
                  <span
                    className="text-[0.625rem] text-white/35"
                    title={
                      agent.isActive
                        ? `started ${formatClockTime(agent.startedAt)} · live`
                        : agent.endedAt != null
                          ? `${formatClockTime(agent.startedAt)} \u2192 ${formatClockTime(agent.endedAt)}`
                          : `started ${formatClockTime(agent.startedAt)}`
                    }
                  >
                    {formatClockTime(agent.startedAt).slice(0, 5)}
                    {" \u2192 "}
                    {agent.isActive
                      ? "\u25CF"
                      : agent.endedAt != null
                        ? formatClockTime(agent.endedAt).slice(0, 5)
                        : "\u2014"}
                    {agent.endedAt != null && agent.startedAt != null && (
                      <span className="ml-1 text-white/25">
                        {" ("}
                        {formatElapsedCompact(agent.startedAt, agent.endedAt)}
                        {")"}
                      </span>
                    )}
                  </span>
                )}
                {agentToolUses > 0 && (
                  <span className="text-[0.625rem]">{agentToolUses} tools</span>
                )}
                <span className="text-[0.625rem]">{formatTokens(agentTotalTokens)} tokens</span>
              </span>
            </div>
          );
        };

        return (
          <div className="pl-3 space-y-1 border-l-2 border-[#7CC5FF]/25">
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
