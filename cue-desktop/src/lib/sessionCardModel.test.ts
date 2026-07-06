import { describe, it, expect } from "vitest";
import type { EnrichedSession, SubagentMetrics } from "./types";
import { usageSummary, usageDisplayStrings } from "./sessionCardModel";

function sub(model: string, o: Partial<SubagentMetrics>): SubagentMetrics {
  return {
    agentId: "a", description: "", slug: "s", model,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    toolCounts: {}, messageCount: 0, isActive: false,
    ...o,
  } as SubagentMetrics;
}

/** Minimal EnrichedSession carrying only the fields usageSummary reads. */
function session(
  metrics: Partial<EnrichedSession["metrics"]>,
): EnrichedSession {
  return {
    metrics: {
      inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
      model: "claude-opus-4-8", subagents: [], toolCounts: {},
      ...metrics,
    },
  } as unknown as EnrichedSession;
}

describe("usageSummary", () => {
  it("reports no data when the session has zero tokens", () => {
    const u = usageSummary(session({}));
    expect(u.hasData).toBe(false);
    expect(u.estCost).toBe(0);
    expect(u.totalTokens).toBe(0);
    expect(u.byModel).toEqual([]);
  });

  it("sums all four buckets across parent + subagents for the lifetime total", () => {
    const u = usageSummary(session({
      inputTokens: 100, outputTokens: 200, cacheCreationTokens: 300, cacheReadTokens: 400,
      subagents: [sub("claude-haiku-4-5", { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 })],
    }));
    expect(u.hasData).toBe(true);
    expect(u.totalTokens).toBe(100 + 200 + 300 + 400 + 1 + 2 + 3 + 4);
  });

  it("computes cache hit rate as cacheRead / (cacheRead + cacheWrite)", () => {
    const u = usageSummary(session({
      inputTokens: 10, cacheReadTokens: 900, cacheCreationTokens: 100,
    }));
    expect(u.cacheHitRate).toBeCloseTo(0.9, 6);
  });

  it("prices the parent and each subagent at its own model", () => {
    // Opus parent: 1M input → $15. Haiku subagent: 1M input → $0.80.
    const u = usageSummary(session({
      model: "claude-opus-4-8", inputTokens: 1_000_000,
      subagents: [sub("claude-haiku-4-5", { inputTokens: 1_000_000 })],
    }));
    expect(u.estCost).toBeCloseTo(15.8, 6);
    // byModel is sorted by cost desc, opus first.
    expect(u.byModel.map((b) => b.model)).toEqual(["claude-opus-4-8", "claude-haiku-4-5"]);
    expect(u.byModel[0].cost).toBeCloseTo(15, 6);
    expect(u.byModel[1].cost).toBeCloseTo(0.8, 6);
  });
});

describe("usageDisplayStrings", () => {
  it("labels cost as an approximate estimate and includes an as-of caveat", () => {
    const d = usageDisplayStrings(usageSummary(session({
      model: "claude-opus-4-8", inputTokens: 1_000_000, cacheReadTokens: 900, cacheCreationTokens: 100,
    })));
    expect(d.cost).toMatch(/^~\$/);
    expect(d.cost).toContain("est");
    expect(d.tokens).toContain("tokens");
    expect(d.cached).toBe("90% cached");
    expect(d.tooltip).toMatch(/prices as of/);
  });

  it("omits the cache clause when there is no cache activity", () => {
    const d = usageDisplayStrings(usageSummary(session({ model: "claude-opus-4-8", inputTokens: 500 })));
    expect(d.cached).toBe("");
  });
});
