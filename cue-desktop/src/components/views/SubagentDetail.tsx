import type { SubagentMetrics } from "@/lib/types";
import {
  formatTokens,
  formatElapsedCompact,
  formatClockTime,
  formatModelName,
  cleanPromptText,
} from "@/lib/format";

// Inline "quick report" for a single child agent, expanded under its row in the
// card. Shared by all four card renderers (SessionCard + the Almanac/Studio/
// Night skins), so its palette arrives as CSS-var / color STRINGS — the same
// adopt-any-Look trick CardExtras uses. It renders plain text only (never
// dangerouslySetInnerHTML): the agent's live activity or final result, its
// task, model, status, runtime, token split, and tool breakdown.
export interface SubagentDetailPalette {
  /** Primary ink for the activity/result line. */
  text: string;
  /** Secondary ink for the model/status/runtime meta. */
  muted: string;
  /** Tertiary ink for field labels. */
  faint: string;
  /** Hairline rule for the left accent + separators. */
  rule: string;
  /** Monospace font-family stack. */
  mono: string;
  /** Accent color — the running-tool highlight + active left edge. */
  accent: string;
}

/** Task line: the meta.json description, falling back to the slug / short id. */
function taskLabel(agent: SubagentMetrics): string {
  const desc = agent.description?.trim();
  if (desc) return desc;
  if (agent.slug) return agent.slug;
  return agent.agentId ? agent.agentId.slice(0, 8) : "subagent";
}

/** Runtime readout: "running 2m14s" while live, else the finished duration
 *  (with the clock range as the title), else just a start stamp. */
function runtimeLabel(agent: SubagentMetrics, nowSecs: number): { text: string; title?: string } | null {
  if (agent.startedAt == null) return null;
  if (agent.isActive) {
    return { text: `running ${formatElapsedCompact(agent.startedAt, nowSecs)}` };
  }
  if (agent.endedAt != null) {
    return {
      text: formatElapsedCompact(agent.startedAt, agent.endedAt),
      title: `${formatClockTime(agent.startedAt)} → ${formatClockTime(agent.endedAt)}`,
    };
  }
  return { text: `started ${formatClockTime(agent.startedAt).slice(0, 5)}` };
}

/** Tool breakdown sorted busiest-first: "Read ×12 · Bash ×5". */
function toolBreakdown(agent: SubagentMetrics): string {
  return Object.entries(agent.toolCounts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} ×${n}`)
    .join(" · ");
}

export function SubagentDetail({
  agent,
  palette,
}: {
  agent: SubagentMetrics;
  palette: SubagentDetailPalette;
}) {
  const { text, muted, faint, rule, mono, accent } = palette;
  const model = formatModelName(agent.model);
  const status = agent.isActive ? "Active" : "Returned";
  const runtime = runtimeLabel(agent, Date.now() / 1000);
  const tools = toolBreakdown(agent);

  const cacheDenom = agent.cacheReadTokens + agent.cacheCreationTokens;
  const cachePct = cacheDenom > 0 ? Math.round((agent.cacheReadTokens / cacheDenom) * 100) : null;

  // The heart: what the agent is doing (live) or did (returned). A running tool
  // wins while active; otherwise the last assistant text is the result.
  const running = agent.isActive && agent.runningToolName ? agent.runningToolName : null;
  const resultText = cleanPromptText(agent.lastAssistantText);

  const labelStyle: React.CSSProperties = { color: faint, marginRight: 6 };

  return (
    <div
      role="region"
      aria-label={`${taskLabel(agent)} — quick report`}
      // Isolate the panel from the card root: every card opens the workspace on
      // click and its guard only exempts button/a/input/[role=button], so a click
      // (or a text-selection mousedown to copy the Result) inside this region
      // would otherwise bubble up and launch openSession. Stop both here.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        margin: "2px 0 6px",
        padding: "7px 9px",
        borderLeft: `2px solid ${agent.isActive ? accent : rule}`,
        background: "rgba(127,127,127,0.06)",
        borderRadius: "0 4px 4px 0",
        fontFamily: mono,
        fontSize: 10.5,
        lineHeight: 1.55,
        color: muted,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      {/* Activity / result — shown first, prominent. */}
      {running ? (
        <div style={{ color: text }}>
          <span style={{ color: accent, fontWeight: 600 }}>Running:</span> {running}
          {agent.runningToolTarget ? ` — ${agent.runningToolTarget}` : ""}
        </div>
      ) : resultText ? (
        <div style={{ color: text }}>
          <span style={labelStyle}>Result</span>
          <span
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 4,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {resultText}
          </span>
        </div>
      ) : (
        <div style={{ color: faint, fontStyle: "italic" }}>
          {agent.isActive ? "Working — no output yet" : "No output recorded"}
        </div>
      )}

      {/* Task */}
      <div>
        <span style={labelStyle}>Task</span>
        <span style={{ color: muted }}>{taskLabel(agent)}</span>
      </div>

      {/* Model · status · runtime */}
      <div style={{ color: muted }}>
        {model !== "—" && (
          <>
            <span title={agent.model}>{model}</span>
            {" · "}
          </>
        )}
        <span style={{ color: agent.isActive ? accent : faint }}>{status}</span>
        {runtime && (
          <span title={runtime.title}>
            {" · "}
            {runtime.text}
          </span>
        )}
      </div>

      {/* Tokens */}
      <div>
        <span style={labelStyle}>Tokens</span>
        <span style={{ color: muted }}>
          {formatTokens(agent.inputTokens)} in · {formatTokens(agent.outputTokens)} out
          {cachePct != null ? ` · ${cachePct}% cache` : ""}
        </span>
      </div>

      {/* Tool breakdown */}
      {tools && (
        <div>
          <span style={labelStyle}>Tools</span>
          <span style={{ color: muted }}>{tools}</span>
        </div>
      )}
    </div>
  );
}
