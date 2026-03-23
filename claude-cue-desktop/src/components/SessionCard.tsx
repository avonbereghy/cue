import { useState, useCallback, useRef, useEffect } from "react";

/** Deterministic per-character hash for stable animation randomness */
function charHash(i: number, title: string): number {
  return (i * 2654435761 + title.charCodeAt(i % title.length) * 40503) >>> 0;
}

/** Bell-curve value (0..1) from hash, approximated via central limit theorem */
function bellFromHash(hash: number): number {
  return ((hash & 0xFF) / 255 + ((hash >> 8) & 0xFF) / 255 + ((hash >> 16) & 0xFF) / 255) / 3;
}
import type { EnrichedSession } from "@/lib/types";
import { STATE_DOT_COLORS, STATE_BADGE_BG, STATE_COLORS } from "@/lib/types";
import { formatTokens, formatDuration } from "@/lib/format";
import { SignalString } from "./SignalString";
import type { StrikePulse } from "./SignalString";

interface SessionCardProps {
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
  particleEnabled?: boolean;
  particleSpeed?: number;
  particleRate?: number;
  particleSparks?: number;
  revived?: boolean;
  keyPressSpeed?: number;
  keyReleaseSpeed?: number;
}

export function SessionCard({ session, titleAnimation = "none", animationSpeed = 1.2, randomAnimation = false, signalString = false, signalFrequency = 1.0, signalMode = "simulated", signalAlpha = 0.25, signalAmplitude = 0.25, signalEcho = 1.0, signalBass = true, signalMids = true, signalTreble = true, signalColorDark = "#ffffff", signalColorLight = "#000000", signalOffset = 0, particleEnabled = true, particleSpeed = 1.0, particleRate = 1.0, particleSparks = 3, revived = false, keyPressSpeed = 0.35, keyReleaseSpeed = 0.4 }: SessionCardProps) {
  const { info, metrics } = session;
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Strike detection refs for piano string physics
  const cardRef = useRef<HTMLDivElement>(null);
  const titleContainerRef = useRef<HTMLSpanElement>(null);
  const pulsesRef = useRef<StrikePulse[]>([]);
  const lastStrikeCycleRef = useRef<Map<number, number>>(new Map());
  const strikeRafRef = useRef<number>(0);

  const [isNarrow, setIsNarrow] = useState(false);

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      setIsNarrow(entry.contentRect.width < 600);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const isAnimating = (info.state === "working" || info.state === "subagent") && titleAnimation !== "none";

  // Mathematical strike detection — computes each character's animation phase
  // and fires a pulse when it crosses the "peak displacement" threshold
  useEffect(() => {
    if (!isAnimating || !signalString) {
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
  }, [isAnimating, signalString, session.displayTitle, titleAnimation, animationSpeed, randomAnimation]);

  const isWorking = info.state === "working" || info.state === "subagent";
  const isWaiting = info.state === "waiting";
  const isError = info.state === "error";

  const dotColor = STATE_DOT_COLORS[info.state] ?? "bg-green-500";
  const dotPulse = info.state === "working" || info.state === "waiting" || info.state === "subagent" ? "dot-pulse" : "";
  const badgeBg = STATE_BADGE_BG[info.state] ?? "bg-green-500/20 text-green-500";
  const titleColor = STATE_COLORS[info.state] ?? "text-green-500";

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

  const ariaLabel = `${session.stateDisplayName}: ${session.displayTitle}, running ${formatDuration(session.durationSecs)}`;

  return (
    <div
      ref={cardRef}
      className={`relative overflow-hidden rounded-lg border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 session-card ${
        isWorking ? "session-card--pressed" : "session-card--floating"
      } ${
        isWaiting ? "session-card--waiting" : isError ? "session-card--error" : ""
      } ${
        signalString && (signalMode === "preset" || signalMode === "audio") ? "px-4 py-5 space-y-5" : "p-3 space-y-2.5"
      }`}
      tabIndex={0}
      aria-label={ariaLabel}

      style={{
        "--anim-speed": `${animationSpeed}s`,
        "--key-press-speed": `${keyPressSpeed}s`,
        "--key-release-speed": `${keyReleaseSpeed}s`,
      } as React.CSSProperties}
    >
      {/* Signal String background — audio-driven strings behind card content */}
      {signalString && !revived && isWorking && <SignalString state={info.state} frequency={signalFrequency} revived={revived} pulses={pulsesRef} signalMode={signalMode} signalAlpha={signalAlpha} signalAmplitude={signalAmplitude} signalEcho={signalEcho} signalBass={signalBass} signalMids={signalMids} signalTreble={signalTreble} signalColorDark={signalColorDark} signalColorLight={signalColorLight} signalOffset={signalOffset} particleEnabled={particleEnabled} particleSpeed={particleSpeed} particleRate={particleRate} particleSparks={particleSparks} sessionId={info.id} />}

      <div className="relative z-10 flex gap-3">
        {/* Left: all content rows */}
        <div className="flex-1 min-w-0 space-y-2.5">
          {/* Row 1: Status dot + title + state badge + git branch + duration */}
          <div className="flex items-center gap-2">
            <span className={`inline-block w-2.5 h-2.5 rounded-full ${dotColor} ${dotPulse} shrink-0`} aria-hidden="true" />
            {(info.state === "working" || info.state === "subagent") && titleAnimation !== "none" ? (
              <span
                ref={titleContainerRef}
                className={`font-semibold ${titleColor} anim-${titleAnimation} whitespace-nowrap overflow-hidden`}
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
              <span className={`font-semibold truncate ${titleColor}`}>
                {session.displayTitle}
              </span>
            )}
            {metrics.customTitle && (
              <span className="text-xs text-white/30 truncate">
                {session.workspaceName}
              </span>
            )}
            <span className={`text-xs px-2 py-0.5 rounded-full ${badgeBg}`}>
              {session.stateDisplayName}
            </span>
            {!isNarrow && (
              <span className="text-[0.625rem] text-white/50 truncate font-mono" title={info.workspace}>
                {shortPath}
              </span>
            )}
            {!isNarrow && metrics.gitBranch && (
              <span className="text-[0.625rem] text-white/30 truncate shrink-0">
                <span className="mr-0.5">&#9702;</span>
                {metrics.gitBranch}
              </span>
            )}
            <span className="ml-auto text-sm font-mono text-white/50 mono-nums shrink-0">
              {formatDuration(session.durationSecs)}
            </span>
          </div>

          {/* Signal String separator — always present for consistent card height; animates only when working/revived */}
          {/* Spacer — consistent card height whether strings are active or not */}
          {signalString && <div style={{ height: "12px" }} />}

          {/* Row 2: Metrics */}
          <div className="flex items-center gap-x-4 gap-y-1 text-xs text-white/50">
            {!isNarrow && truncatedId && (
              <button
                onClick={copySessionId}
                className="flex items-center gap-1 font-mono text-white/30 hover:text-white/60 transition-colors cursor-pointer whitespace-nowrap"
                title={`Copy session ID: ${info.id}`}
                aria-label={`Copy session ID ${info.id}`}
              >
                {truncatedId}&hellip;
                <span className="text-[0.625rem]">{copied ? "\u2713" : ""}</span>
              </button>
            )}
            <span className="whitespace-nowrap" title="User / Total messages">
              &#128172; {metrics.userMessageCount}/{metrics.messageCount}
            </span>
            <span className="whitespace-nowrap">
              &#8595; {formatTokens(aggregatedInputTokens)} in
            </span>
            <span className="whitespace-nowrap">
              &#8593; {formatTokens(aggregatedOutputTokens)} out
            </span>
            {aggregatedToolUses > 0 && (
              <span className="whitespace-nowrap">
                &#128295; {aggregatedToolUses} tools
              </span>
            )}
            {hasSubagents && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-1 text-cyan-600 hover:text-cyan-500 transition-colors cursor-pointer text-[0.625rem] font-mono px-1.5 py-0.5 rounded-full border border-cyan-600/40 hover:border-cyan-500/50 whitespace-nowrap"
                aria-label={expanded ? "Collapse agent team" : "Expand agent team"}
                aria-expanded={expanded}
              >
                <span>{expanded ? "\u25BE" : "\u25B8"}</span>
                <span>{subagents.length} agents</span>
              </button>
            )}
            {!isNarrow && session.modelDisplayName !== "\u2014" && (
              <span className="text-[0.625rem] text-white/30 whitespace-nowrap">
                {session.modelDisplayName}
              </span>
            )}
            {!isNarrow && session.sourceDisplay !== "\u2014" && (
              <span className="text-[0.625rem] text-white/30 whitespace-nowrap">
                {session.sourceDisplay}
              </span>
            )}
          </div>

          {/* Row 3: Tool chips + cache hit rate */}
          {topTools.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {topTools.map(([name, count]) => (
                <span
                  key={name}
                  className="text-[0.625rem] font-mono px-1.5 py-0.5 rounded-full bg-white/10"
                >
                  {name} {count}
                </span>
              ))}
              {remainingTools > 0 && (
                <span className="text-[0.625rem] text-white/30">+{remainingTools}</span>
              )}
              <span className="ml-auto" />
            </div>
          )}
        </div>

        {/* Right: Context bar — full card height with vertical "Context" label */}
        {metrics.lastInputTokens > 0 && (
          <div className="flex flex-col items-center shrink-0" title={`Context: ${formatTokens(metrics.lastInputTokens)} / ${formatTokens(session.contextLimit)}`}>
            <div className="relative flex-1 w-3 rounded-full bg-white/8 overflow-hidden">
              <div
                className="absolute bottom-0 left-0 right-0 rounded-full transition-all duration-500"
                style={{
                  height: `${Math.min(session.contextUsagePercent * 100, 100)}%`,
                  background: session.contextUsagePercent > 0.8
                    ? session.contextUsagePercent > 0.95 ? "#ef4444" : "#f59e0b"
                    : "#22c55e",
                  opacity: 0.35,
                }}
              />
              <span
                className="absolute inset-0 z-10 flex items-center justify-center text-[0.5rem] font-semibold text-white/60 tracking-widest uppercase pointer-events-none"
                style={{ writingMode: "vertical-rl", textOrientation: "mixed" }}
              >
                Context
              </span>
            </div>
            <span className="text-[0.5625rem] text-white/30 mono-nums leading-none mt-0.5">
              {Math.round(session.contextUsagePercent * 100)}%
            </span>
          </div>
        )}
      </div>

      {/* Row 5: Expanded agent team */}
      {expanded && hasSubagents && (() => {
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
              <span className={`shrink-0 ${agent.isActive ? "text-cyan-400/80" : "text-white/30"}`}>
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
          <div className="pl-3 space-y-1 border-l-2 border-cyan-400/20">
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
  );
}
