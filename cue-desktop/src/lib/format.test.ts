import { describe, it, expect, beforeEach } from "vitest";
import {
  formatTokens,
  formatDuration,
  formatElapsedCompact,
  formatModelName,
  formatCost,
  estimateCost,
  cleanPromptText,
  errorReason,
  getProjectAccent,
  __resetProjectAccents,
} from "./format";

describe("errorReason", () => {
  it("prefers the actual transcript message", () => {
    expect(errorReason("rate_limit", "Model unavailable: claude-fable-5")).toBe(
      "Model unavailable: claude-fable-5",
    );
  });
  it("falls back to a friendly label for a known category", () => {
    expect(errorReason("rate_limit", null)).toBe("Rate limited");
    expect(errorReason("billing_error")).toBe("Billing problem");
  });
  it("humanizes an unknown category", () => {
    expect(errorReason("some_new_code")).toBe("some new code");
  });
  it("returns null when there is nothing to show", () => {
    expect(errorReason(null, null)).toBeNull();
    expect(errorReason(undefined, "   ")).toBeNull();
  });
});

describe("formatTokens", () => {
  it("renders raw counts below 1000", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });
  it("renders K with one decimal only when needed", () => {
    expect(formatTokens(1000)).toBe("1K");
    expect(formatTokens(1500)).toBe("1.5K");
    expect(formatTokens(2000)).toBe("2K");
  });
  it("renders M with one decimal only when needed", () => {
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
  it("rolls the K→M rounding boundary up instead of printing '1000.0K'", () => {
    expect(formatTokens(999_949)).toBe("999.9K"); // just under — stays K
    expect(formatTokens(999_950)).toBe("1.0M"); // would round to 1000.0K → M
    expect(formatTokens(999_999)).toBe("1.0M");
  });
  it("rolls the M→B rounding boundary up instead of printing '1000.0M'", () => {
    expect(formatTokens(999_949_000)).toBe("999.9M"); // just under — stays M
    expect(formatTokens(999_950_000)).toBe("1.0B"); // would round to 1000.0M → B
    expect(formatTokens(1_000_000_000)).toBe("1B");
  });
});

describe("formatDuration", () => {
  it("zero-pads h:m:s", () => {
    expect(formatDuration(0)).toBe("00:00:00");
    expect(formatDuration(65)).toBe("00:01:05");
    expect(formatDuration(3661)).toBe("01:01:01");
  });
  it("clamps negatives to zero", () => {
    expect(formatDuration(-5)).toBe("00:00:00");
  });
});

describe("formatElapsedCompact", () => {
  it("uses seconds under a minute", () => {
    expect(formatElapsedCompact(0, 12)).toBe("12s");
  });
  it("uses m+s under an hour", () => {
    expect(formatElapsedCompact(0, 134)).toBe("2m14s");
  });
  it("uses h+m at/over an hour", () => {
    expect(formatElapsedCompact(0, 3780)).toBe("1h03m");
  });
  it("clamps negative spans to zero", () => {
    expect(formatElapsedCompact(100, 0)).toBe("0s");
  });
});

describe("formatModelName", () => {
  it("prettifies a claude-* id", () => {
    expect(formatModelName("claude-opus-4-8")).toBe("Opus 4.8");
    expect(formatModelName("claude-sonnet-4-6")).toBe("Sonnet 4.6");
  });
  it("renders an em-dash for unknown/empty", () => {
    expect(formatModelName("unknown")).toBe("—");
    expect(formatModelName("")).toBe("—");
  });
});

describe("formatCost", () => {
  it("shows $0.00 only for a true zero", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(-1)).toBe("$0.00");
  });
  it("shows <$0.01 for a non-zero sub-cent amount — a cheap turn must not read as free", () => {
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(0.0099)).toBe("<$0.01");
  });
  it("shows two decimals at/above a cent", () => {
    expect(formatCost(0.01)).toBe("$0.01");
    expect(formatCost(0.42)).toBe("$0.42");
    expect(formatCost(12.5)).toBe("$12.50");
  });
});

describe("estimateCost (cache-aware)", () => {
  it("prices all four buckets — cache read at 0.1x input, cache write at 1.25x input", () => {
    // Opus per 1M tokens: $15 in · $75 out · $1.50 cache-read · $18.75 cache-write.
    const cost = estimateCost({
      "claude-opus-4-8": { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
    });
    expect(cost).toBeCloseTo(15 + 75 + 1.5 + 18.75, 6);
  });
  it("prices each model at its OWN tier and sums (a Haiku subagent isn't billed at Opus rates)", () => {
    const cost = estimateCost({
      "claude-opus-4-8": { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, // $15
      "claude-haiku-4-5": { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, // $0.80
    });
    expect(cost).toBeCloseTo(15.8, 6);
  });
  it("falls back to Sonnet-tier for an unknown model family", () => {
    const cost = estimateCost({ "some-new-model-9": { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(cost).toBeCloseTo(3, 6); // Sonnet input rate
  });
  it("is zero for an empty map", () => {
    expect(estimateCost({})).toBe(0);
  });
});

describe("cleanPromptText", () => {
  it("returns empty for null/undefined", () => {
    expect(cleanPromptText(null)).toBe("");
    expect(cleanPromptText(undefined)).toBe("");
  });
  it("passes plain text through unchanged", () => {
    expect(cleanPromptText("fix the build")).toBe("fix the build");
  });
  it("collapses slash-command wrapper tags to '/name args'", () => {
    const raw =
      "<command-message>deploy</command-message><command-name>/deploy</command-name><command-args>staging now</command-args>";
    expect(cleanPromptText(raw)).toBe("/deploy staging now");
  });
});

describe("getProjectAccent", () => {
  // Hue windows deliberately clear of every status color + the rate-limit bars.
  const SAFE_WINDOWS: [number, number][] = [
    [70, 118],
    [160, 196],
    [250, 278],
    [330, 352],
  ];
  const hueOf = (color: string): number => {
    const m = color.match(/^hsl\((\d+),/);
    if (!m) throw new Error(`not an hsl() color: ${color}`);
    return Number(m[1]);
  };
  const inSafeWindow = (hue: number) => SAFE_WINDOWS.some(([lo, hi]) => hue >= lo && hue <= hi);

  beforeEach(() => __resetProjectAccents());

  it("is stable: the same workspace always gets the same color", () => {
    const a = getProjectAccent("/Users/me/dev/api", true);
    const b = getProjectAccent("/Users/me/dev/api", true);
    expect(a).toBe(b);
  });

  it("never lands a hue inside a status-color band", () => {
    for (let i = 0; i < 50; i++) {
      const hue = hueOf(getProjectAccent(`/Users/me/project-${i}`, true));
      expect(inSafeWindow(hue)).toBe(true);
    }
  });

  it("spreads the first several projects into distinct colors", () => {
    const colors = ["a", "b", "c", "d", "e"].map((p) => getProjectAccent(`/ws/${p}`, true));
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("uses different lightness/saturation for dark vs light", () => {
    const dark = getProjectAccent("/ws/same", true);
    const light = getProjectAccent("/ws/same", false);
    expect(dark).not.toBe(light);
    expect(hueOf(dark)).toBe(hueOf(light));
  });
});
