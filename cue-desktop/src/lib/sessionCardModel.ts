// Shared, skin-agnostic derivation for the alternative dashboard "Looks"
// (Almanac / Studio / Night Study). The instrument SessionCard computes most of
// this inline; the new looks share it here so feature parity has ONE source of
// truth instead of drifting across three card components.
//
// Nothing here knows about colors/fonts — each look maps the returned semantic
// data onto its own palette. Pure functions only (no React, no DOM).

import type { EnrichedSession } from "./types";
import { formatTokens, formatCost, formatModelName, estimateCost, PRICE_TABLE_ASOF, type ModelUsage } from "./format";

/** States where a turn is actively in flight (mirrors the tray/header "active"
 *  count). Used to gate "alive" treatments and tok/s. */
export const ACTIVE_STATES: ReadonlySet<string> = new Set([
  "working", "thinking", "subagent", "compacting", "clearing",
]);

export function isActiveState(state: string): boolean {
  return ACTIVE_STATES.has(state);
}

/** Human-facing display names for each session state. */
export const STATE_DISPLAY_NAME: Record<string, string> = {
  working: "Working", thinking: "Thinking", waiting: "Waiting", error: "Error",
  subagent: "Subagent", compacting: "Compacting", clearing: "Clearing",
  idle: "Idle", done: "Done", ended: "Ended",
};

/** Green → amber → red ramp for context usage (0..1). Matches the instrument
 *  card's rest-state silk color so the meaning is consistent across looks. */
export function contextRampRgb(pct: number): [number, number, number] {
  const p = Math.min(Math.max(pct, 0), 1);
  const green: [number, number, number] = [34, 197, 94];
  const yellow: [number, number, number] = [245, 158, 11];
  const red: [number, number, number] = [239, 68, 68];
  const [a, b, t] = p < 0.5 ? [green, yellow, p / 0.5] : [yellow, red, (p - 0.5) / 0.5];
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

export function rgbCss([r, g, b]: [number, number, number], alpha = 1): string {
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Permission-mode pill metadata, or null when there's nothing worth showing.
 *  Mirrors the instrument card's visibility rules: BYPASS always shows (highest
 *  stakes); the others only while the session is actively driving the terminal,
 *  since the user can silently shift-tab cycle them and the value would lag. */
export interface PermissionModeMeta {
  key: string;
  label: string;
  symbol: string;
  title: string;
  /** safe → risky, for the skin to color: "read" | "auto" | "danger" | "locked" */
  tone: "read" | "auto" | "danger" | "locked";
}

const PERMISSION_MODE_META: Record<string, PermissionModeMeta> = {
  plan:              { key: "plan", label: "PLAN", symbol: "▮▮", tone: "read", title: "Plan mode — read-only research, no tools execute" },
  acceptEdits:       { key: "acceptEdits", label: "ACCEPT", symbol: "⏵⏵", tone: "auto", title: "Accept edits — auto-approves file edits and safe filesystem ops" },
  auto:              { key: "auto", label: "AUTO", symbol: "▶▶", tone: "auto", title: "Auto mode — every tool call goes through a safety classifier (research preview)" },
  bypassPermissions: { key: "bypassPermissions", label: "BYPASS", symbol: "⚠⚠", tone: "danger", title: "Bypass permissions — every tool auto-approves; use only in isolated environments" },
  dontAsk:           { key: "dontAsk", label: "LOCKED", symbol: "⊘", tone: "locked", title: "Don't-ask mode — auto-denies anything not pre-allowlisted" },
};

export function permissionModeMeta(mode: string | undefined, state: string): PermissionModeMeta | null {
  if (!mode || mode === "default") return null;
  const m = PERMISSION_MODE_META[mode];
  if (!m) return null;
  if (mode !== "bypassPermissions" && !ACTIVE_STATES.has(state)) return null;
  return m;
}

/** Aggregated parent + subagent token / tool totals. */
export function aggregateMetrics(session: EnrichedSession): {
  inputTokens: number; outputTokens: number; toolUses: number;
} {
  const { metrics } = session;
  const subs = metrics.subagents ?? [];
  const inputTokens = metrics.inputTokens + subs.reduce((s, a) => s + a.inputTokens, 0);
  const outputTokens = metrics.outputTokens + subs.reduce((s, a) => s + a.outputTokens, 0);
  const toolUses = Object.values(metrics.toolCounts).reduce((a, b) => a + b, 0)
    + subs.reduce((s, a) => s + Object.values(a.toolCounts).reduce((x, y) => x + y, 0), 0);
  return { inputTokens, outputTokens, toolUses };
}

/** Git branch + working-tree status, pre-formatted into renderable parts. */
export interface BranchStatus {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
}

export function branchStatus(session: EnrichedSession): BranchStatus | null {
  const branch = session.metrics.gitBranch;
  if (!branch) return null;
  const g = session.gitStatus;
  return {
    branch,
    dirty: !!g?.dirty,
    ahead: g?.ahead ?? 0,
    behind: g?.behind ?? 0,
  };
}

/** Shorten an absolute workspace path to ~ for the home dir. */
export function shortPath(workspace: string): string {
  return workspace.replace(/^\/Users\/[^/]+/, "~");
}

/** Context-meter display strings. */
export function contextDisplay(session: EnrichedSession): {
  pct: number; tokens: string; unknown: boolean;
} {
  const pct = Math.round(session.contextUsagePercent * 100);
  const tokens = `${formatTokens(session.metrics.lastInputTokens)} / ${formatTokens(session.contextLimit)}`;
  const unknown = session.metrics.lastInputTokens === 0;
  return { pct, tokens, unknown };
}

/** Token cache breakdown — surfaced once context is heavy (≥85%), matching the
 *  instrument card's deep-context detail row. */
export function cacheBreakdown(session: EnrichedSession): {
  show: boolean; input: number; cacheRead: number; cacheWrite: number;
} {
  const m = session.metrics;
  const show = session.contextUsagePercent >= 0.85 && (m.cacheReadTokens > 0 || m.cacheCreationTokens > 0);
  return { show, input: m.inputTokens, cacheRead: m.cacheReadTokens, cacheWrite: m.cacheCreationTokens };
}

/** Per-session usage economics — the money/volume/efficiency summary rendered
 *  in the expanded card's deep-telemetry section. Skin-agnostic (raw numbers;
 *  each render site formats + colors them). Aggregates the parent conversation
 *  and every subagent, each priced at ITS OWN model, so a cheap-Haiku subagent
 *  under an Opus session isn't billed at Opus rates. */
export interface UsageSummary {
  /** True once any billable tokens exist — render sites hide the row otherwise. */
  hasData: boolean;
  /** Estimated cost in USD (cache-aware; approximate — see PRICE_TABLE_ASOF). */
  estCost: number;
  /** Lifetime billable tokens (all four buckets, parent + subagents). Distinct
   *  from the context bar's live occupancy — this is cumulative volume. */
  totalTokens: number;
  /** Cache hit rate 0..1 = cacheRead / (cacheRead + cacheWrite). Matches the
   *  Rust `SessionMetrics::cache_hit_rate()` semantics. */
  cacheHitRate: number;
  /** Per-model cost split (desc), for the tooltip. Empty when cost rounds to 0. */
  byModel: { model: string; cost: number }[];
}

export function usageSummary(session: EnrichedSession): UsageSummary {
  const m = session.metrics;
  const subs = m.subagents ?? [];

  // Accumulate the four billable buckets per model across parent + subagents.
  const perModel = new Map<string, ModelUsage>();
  const add = (model: string, input: number, output: number, cacheRead: number, cacheWrite: number) => {
    const key = model || "unknown";
    const cur = perModel.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    cur.input += input;
    cur.output += output;
    cur.cacheRead += cacheRead;
    cur.cacheWrite += cacheWrite;
    perModel.set(key, cur);
  };
  add(m.model, m.inputTokens, m.outputTokens, m.cacheReadTokens, m.cacheCreationTokens);
  for (const a of subs) add(a.model, a.inputTokens, a.outputTokens, a.cacheReadTokens, a.cacheCreationTokens);

  const usageMap: Record<string, ModelUsage> = {};
  let totalTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const [model, u] of perModel) {
    usageMap[model] = u;
    totalTokens += u.input + u.output + u.cacheRead + u.cacheWrite;
    cacheRead += u.cacheRead;
    cacheWrite += u.cacheWrite;
  }

  const byModel = [...perModel.entries()]
    .map(([model, u]) => ({ model, cost: estimateCost({ [model]: u }) }))
    .filter((x) => x.cost > 0)
    .sort((a, b) => b.cost - a.cost);

  const cacheDenom = cacheRead + cacheWrite;
  return {
    hasData: totalTokens > 0,
    estCost: estimateCost(usageMap),
    totalTokens,
    cacheHitRate: cacheDenom > 0 ? cacheRead / cacheDenom : 0,
    byModel,
  };
}

/** Pre-formatted display strings for the usage row, so the instrument card and
 *  the shared skin footer render identical copy (only the styling differs). The
 *  leading "~" and trailing "est" are load-bearing honesty for an estimate. */
export function usageDisplayStrings(u: UsageSummary): {
  cost: string; tokens: string; cached: string; tooltip: string;
} {
  const split = u.byModel.map((b) => `${formatModelName(b.model)}: ${formatCost(b.cost)}`).join(" · ");
  return {
    cost: `~${formatCost(u.estCost)} est`,
    tokens: `${formatTokens(u.totalTokens)} tokens`,
    cached: u.cacheHitRate > 0 ? `${Math.round(u.cacheHitRate * 100)}% cached` : "",
    tooltip: [split, `estimated · cache-aware · prices as of ${PRICE_TABLE_ASOF}`]
      .filter(Boolean)
      .join("\n"),
  };
}

/** Sum of the Claude config counts (CLAUDE.md + rules + MCP + hooks). */
export function configCountsTotal(session: EnrichedSession): number {
  const c = session.configCounts;
  if (!c) return 0;
  return c.claudeMdCount + c.rulesCount + c.mcpServers + c.hooksCount;
}

/** Warning color for a rate-limit usage percent; null below the warn threshold
 *  (caller uses a muted/neutral fill there). amber/red read as warnings in any look. */
export function rateLimitColor(pct: number): string | null {
  if (pct >= 90) return "#ef4444";
  if (pct >= 75) return "#f59e0b";
  return null;
}

/** Split a subagent list into still-running vs. finished. */
export function splitSubagents(subs: EnrichedSession["metrics"]["subagents"]): {
  active: EnrichedSession["metrics"]["subagents"];
  completed: EnrichedSession["metrics"]["subagents"];
} {
  return {
    active: subs.filter((a) => a.isActive),
    completed: subs.filter((a) => !a.isActive),
  };
}
