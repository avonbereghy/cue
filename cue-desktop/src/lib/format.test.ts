import { describe, it, expect } from "vitest";
import {
  formatTokens,
  formatDuration,
  formatElapsedCompact,
  formatModelName,
  cleanPromptText,
} from "./format";

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
