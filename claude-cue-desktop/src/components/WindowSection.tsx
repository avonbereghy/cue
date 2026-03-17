import type { WindowMetrics } from "@/lib/types";
import { formatTokens, formatCost, estimateCost, formatModelName } from "@/lib/format";
import { ProgressBar } from "./ProgressBar";

interface WindowSectionProps {
  name: string;
  metrics: WindowMetrics;
  tokenLimit: number;
}

function resetsIn(windowName: string): string {
  const now = new Date();
  let resetDate: Date;

  if (windowName === "Session (5hr)") {
    resetDate = new Date(now.getTime() + 5 * 3600 * 1000);
  } else if (windowName === "Today") {
    resetDate = new Date(now);
    resetDate.setHours(24, 0, 0, 0);
  } else {
    // This Week — next Monday
    const day = now.getDay(); // 0=Sun
    const daysUntilMon = day === 0 ? 1 : 8 - day;
    resetDate = new Date(now);
    resetDate.setDate(now.getDate() + daysUntilMon);
    resetDate.setHours(0, 0, 0, 0);
  }

  const remainingMs = Math.max(0, resetDate.getTime() - now.getTime());
  const hours = Math.floor(remainingMs / 3_600_000);
  const mins = Math.floor((remainingMs % 3_600_000) / 60_000);

  if (hours >= 24) return `Resets in ${Math.floor(hours / 24)}d`;
  if (hours > 0) return `Resets in ${hours}h`;
  return `Resets in ${mins}m`;
}

export function WindowSection({ name, metrics, tokenLimit }: WindowSectionProps) {
  const totalTokens = metrics.inputTokens + metrics.outputTokens;
  const totalToolUses = Object.values(metrics.toolCounts).reduce((a, b) => a + b, 0);
  const progressPercent = tokenLimit > 0 ? Math.min(1, totalTokens / tokenLimit) : 0;
  const cost = estimateCost(metrics.modelTokens);

  const topTools = Object.entries(metrics.toolCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8);
  const remainingTools = Object.keys(metrics.toolCounts).length - 8;

  const modelEntries = Object.entries(metrics.modelTokens).sort(
    ([, a], [, b]) => (b[0] + b[1]) - (a[0] + a[1]),
  );

  function progressColorClass(): string {
    const pct = progressPercent * 100;
    if (pct > 80) return "text-red-500";
    if (pct > 50) return "text-orange-400";
    return "text-yellow-400";
  }

  return (
    <div className="rounded-lg bg-white/5 p-3 space-y-2.5" aria-label={`${name} usage window`} role="region">
      {/* Header: window name + percentage + cost */}
      <div className="flex items-center">
        <span className="font-semibold">{name}</span>
        <span className="flex-1" />
        {tokenLimit > 0 && (
          <span className={`text-xl font-semibold mono-nums mr-3 ${progressColorClass()}`}>
            {Math.round(progressPercent * 100)}%
          </span>
        )}
        {totalTokens > 0 && (
          <span className="font-mono text-sm text-white/50">{formatCost(cost)}</span>
        )}
      </div>

      {/* Progress bar + reset timer */}
      {tokenLimit > 0 && (
        <div className="space-y-1">
          <ProgressBar value={totalTokens} max={tokenLimit} />
          <div className="flex justify-between text-[10px] text-white/30">
            <span>{resetsIn(name)}</span>
            <span className="mono-nums">
              {formatTokens(totalTokens)} / {formatTokens(tokenLimit)}
            </span>
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="flex items-center gap-4 text-xs text-white/50">
        <span title="Total tokens">⇅ {formatTokens(totalTokens)}</span>
        <span title="Input">↓ {formatTokens(metrics.inputTokens)}</span>
        <span title="Output">↑ {formatTokens(metrics.outputTokens)}</span>
        <span title="Sessions">● {metrics.sessionCount}</span>
        <span title="Messages">
          💬 {metrics.userMessageCount + metrics.assistantMessageCount}
        </span>
        {totalToolUses > 0 && <span title="Tools">🔧 {totalToolUses}</span>}
      </div>

      {/* Tool breakdown chips */}
      {topTools.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {topTools.map(([toolName, count]) => (
            <span
              key={toolName}
              className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-white/10"
            >
              {toolName} {count}
            </span>
          ))}
          {remainingTools > 0 && (
            <span className="text-[10px] text-white/30">+{remainingTools}</span>
          )}
        </div>
      )}

      {/* Model breakdown (if multiple models) */}
      {modelEntries.length > 1 && (
        <div className="flex items-center gap-3 flex-wrap">
          {modelEntries.map(([model, [input, output]]) => (
            <span key={model} className="text-[10px] text-white/30">
              {formatModelName(model)}: {formatTokens(input + output)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
