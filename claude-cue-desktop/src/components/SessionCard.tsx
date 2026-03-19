import { useState, useCallback } from "react";
import type { EnrichedSession } from "@/lib/types";
import { STATE_DOT_COLORS, STATE_BADGE_BG, STATE_COLORS } from "@/lib/types";
import { formatTokens, formatDuration } from "@/lib/format";
import { ProgressBar } from "./ProgressBar";

interface SessionCardProps {
  session: EnrichedSession;
}

export function SessionCard({ session }: SessionCardProps) {
  const { info, metrics } = session;
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const dotColor = STATE_DOT_COLORS[info.state] ?? "bg-green-500";
  const dotPulse = info.state !== "done" && info.state !== "error" ? "dot-pulse" : "";
  const badgeBg = STATE_BADGE_BG[info.state] ?? "bg-green-500/20 text-green-500";
  const titleColor = info.state === "working" ? "text-white" : (STATE_COLORS[info.state] ?? "text-green-500");

  const subagents = metrics.subagents ?? [];
  const hasSubagents = session.hasSubagents;

  // Aggregated metrics (parent + all children)
  const aggregatedInputTokens = metrics.inputTokens + subagents.reduce((s, a) => s + a.inputTokens, 0);
  const aggregatedOutputTokens = metrics.outputTokens + subagents.reduce((s, a) => s + a.outputTokens, 0);
  const aggregatedToolUses = Object.values(metrics.toolCounts).reduce((a, b) => a + b, 0)
    + subagents.reduce((s, a) => s + Object.values(a.toolCounts).reduce((x, y) => x + y, 0), 0);

  const topTools = Object.entries(metrics.toolCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6);
  const remainingTools = Object.keys(metrics.toolCounts).length - 6;

  const cacheTotal = metrics.cacheCreationTokens + metrics.cacheReadTokens;
  const cacheHitRate = cacheTotal > 0 ? Math.round((metrics.cacheReadTokens / cacheTotal) * 100) : 0;

  const truncatedId = info.id ? info.id.slice(0, 8) : "";

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
      className="rounded-lg bg-white/5 p-3 space-y-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
      tabIndex={0}
      aria-label={ariaLabel}
      title={info.workspace}
    >
      {/* Row 1: Status dot + title + state badge + git branch + duration */}
      <div className="flex items-center gap-2">
        <span className={`inline-block w-2.5 h-2.5 rounded-full ${dotColor} ${dotPulse} shrink-0`} aria-hidden="true" />
        <span className={`font-semibold truncate ${titleColor}`}>
          {session.displayTitle}
        </span>
        {metrics.customTitle && (
          <span className="text-xs text-white/30 truncate">
            {session.workspaceName}
          </span>
        )}
        <span className={`text-xs px-2 py-0.5 rounded-full ${badgeBg}`}>
          {session.stateDisplayName}
        </span>
        {metrics.gitBranch && (
          <span className="text-[10px] text-white/30 truncate">
            <span className="mr-0.5">&#9702;</span>
            {metrics.gitBranch}
          </span>
        )}
        <span className="ml-auto text-sm font-mono text-white/50 mono-nums shrink-0">
          {formatDuration(session.durationSecs)}
        </span>
      </div>

      {/* Row 2: Metrics */}
      <div className="flex items-center gap-4 text-xs text-white/50">
        {truncatedId && (
          <button
            onClick={copySessionId}
            className="flex items-center gap-1 font-mono text-white/30 hover:text-white/60 transition-colors cursor-pointer"
            title={`Copy session ID: ${info.id}`}
            aria-label={`Copy session ID ${info.id}`}
          >
            {truncatedId}&hellip;
            <span className="text-[10px]">{copied ? "\u2713" : ""}</span>
          </button>
        )}
        <span title="User / Total messages">
          &#128172; {metrics.userMessageCount}/{metrics.messageCount}
        </span>
        <span>
          &#8595; {formatTokens(aggregatedInputTokens)} in
        </span>
        <span>
          &#8593; {formatTokens(aggregatedOutputTokens)} out
        </span>
        {aggregatedToolUses > 0 && (
          <span>
            &#128295; {aggregatedToolUses} tools
          </span>
        )}
        {hasSubagents && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-cyan-400/60 hover:text-cyan-400 transition-colors cursor-pointer"
            aria-label={expanded ? "Collapse agent team" : "Expand agent team"}
            aria-expanded={expanded}
          >
            <span className="text-[10px]">{expanded ? "\u25BE" : "\u25B8"}</span>
            <span className="text-[10px]">{subagents.length} agents</span>
          </button>
        )}
        {session.modelDisplayName !== "\u2014" && (
          <span className="text-[10px] text-white/30">
            {session.modelDisplayName}
          </span>
        )}
        {session.sourceDisplay !== "\u2014" && (
          <span className="text-[10px] text-white/30">
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
              className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-white/10"
            >
              {name} {count}
            </span>
          ))}
          {remainingTools > 0 && (
            <span className="text-[10px] text-white/30">+{remainingTools}</span>
          )}
          <span className="ml-auto" />
          {cacheTotal > 0 && (
            <span className="text-[10px] text-white/30">
              Cache {cacheHitRate}%
            </span>
          )}
        </div>
      )}

      {/* Row 4: Context usage bar */}
      {metrics.lastInputTokens > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-white/50">Context</span>
          <div className="flex-1">
            <ProgressBar
              value={metrics.lastInputTokens}
              max={session.contextLimit}
              height="h-1.5"
            />
          </div>
          <span className="text-[10px] text-white/50 mono-nums">
            {Math.round(session.contextUsagePercent * 100)}%
          </span>
          <span className="text-[10px] text-white/30 mono-nums">
            {formatTokens(metrics.lastInputTokens)} / {formatTokens(session.contextLimit)}
          </span>
        </div>
      )}

      {/* Row 5: Expanded agent team */}
      {expanded && hasSubagents && (
        <div className="pl-3 space-y-1 border-l-2 border-cyan-400/20">
          {subagents.map((agent, i) => {
            const agentTotalTokens = agent.inputTokens + agent.outputTokens;
            const agentToolUses = Object.values(agent.toolCounts).reduce((a, b) => a + b, 0);
            const isLast = i === subagents.length - 1;
            const prefix = isLast ? "\u2514\u2500" : "\u251C\u2500";
            const label = agent.slug || agent.agentId.slice(0, 8);
            return (
              <div key={agent.agentId || i} className="flex items-center gap-2 text-xs text-white/50">
                <span className="font-mono text-white/30 shrink-0">{prefix}</span>
                <span className="text-cyan-400/80 shrink-0">
                  @{label}
                </span>
                {agent.description && (
                  <span className="text-white/30 truncate text-[10px]" title={agent.description}>
                    {agent.description}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-3 shrink-0 mono-nums">
                  {agentToolUses > 0 && (
                    <span className="text-[10px]">{agentToolUses} tools</span>
                  )}
                  <span className="text-[10px]">{formatTokens(agentTotalTokens)} tokens</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
