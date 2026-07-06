import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { UsageStatus, limitBarColor, formatReset, deriveRateLimits } from "./UsageStatus";
import type { RateLimitSource } from "./UsageStatus";
import type { RateLimitInfo } from "@/lib/types";

// The component consumes only `rateLimits` (RateLimitSource), so the fixture is
// a plain object of that exact shape — no cast needed.
function sessionWith(rl: RateLimitInfo | undefined): RateLimitSource {
  return { rateLimits: rl };
}

function limits(over: Partial<RateLimitInfo> = {}): RateLimitInfo {
  return {
    fiveHourPercent: 0,
    sevenDayPercent: 0,
    fiveHourResetAt: null,
    sevenDayResetAt: null,
    limitReached: false,
    ...over,
  };
}

describe("limitBarColor", () => {
  it("matches the SessionCard thresholds: blue <75, magenta 75–89, red ≥90", () => {
    expect(limitBarColor(0)).toBe("#3b82f6");
    expect(limitBarColor(74)).toBe("#3b82f6");
    expect(limitBarColor(75)).toBe("#d946ef");
    expect(limitBarColor(89)).toBe("#d946ef");
    expect(limitBarColor(90)).toBe("#ef4444");
    expect(limitBarColor(100)).toBe("#ef4444");
  });
});

describe("formatReset", () => {
  it("formats a known countdown (epoch seconds, hours/minutes)", () => {
    const now = 1_000_000;
    expect(formatReset(now + 2 * 3600 + 13 * 60, now)).toBe("resets 2h 13m");
  });

  it("formats days/hours and the sub-minute / minutes-only / past cases", () => {
    const now = 1_000_000;
    expect(formatReset(now + 4 * 86400 + 6 * 3600, now)).toBe("resets 4d 6h");
    expect(formatReset(now + 5 * 60, now)).toBe("resets 5m");
    expect(formatReset(now + 30, now)).toBe("resets <1m");
    expect(formatReset(now - 10, now)).toBe("resets now");
    expect(formatReset(null, now)).toBeNull();
    expect(formatReset(undefined, now)).toBeNull();
  });
});

describe("deriveRateLimits", () => {
  it("returns the first session that carries rateLimits, else null", () => {
    expect(deriveRateLimits([])).toBeNull();
    expect(deriveRateLimits([sessionWith(undefined)])).toBeNull();
    const rl = limits({ fiveHourPercent: 12 });
    expect(deriveRateLimits([sessionWith(undefined), sessionWith(rl)])).toBe(rl);
  });
});

describe("UsageStatus", () => {
  it("renders both meters with correct integer percents and the header copy", () => {
    render(<UsageStatus sessions={[sessionWith(limits({ fiveHourPercent: 50, sevenDayPercent: 10 }))]} />);
    expect(screen.getByText("5-hour")).toBeInTheDocument();
    expect(screen.getByText("Weekly")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("10%")).toBeInTheDocument();
    expect(screen.getByText(/Usage · active account/)).toBeInTheDocument();
  });

  it("colors each fill by threshold and sets its width to the percent", () => {
    render(<UsageStatus sessions={[sessionWith(limits({ fiveHourPercent: 95, sevenDayPercent: 50 }))]} />);
    const fills = screen.getAllByTestId("usage-meter-fill");
    // 5-hour at 95% → red; weekly at 50% → blue.
    expect(fills[0]).toHaveStyle({ backgroundColor: "#ef4444" });
    expect(fills[0]).toHaveStyle({ width: "95%" });
    expect(fills[1]).toHaveStyle({ backgroundColor: "#3b82f6" });
  });

  it("renders a live reset countdown when a reset time is present", () => {
    // ~3h30m out — far enough that a few ms of drift can't change the readout.
    const soon = Math.floor(Date.now() / 1000) + 3 * 3600 + 30 * 60 + 20;
    render(<UsageStatus sessions={[sessionWith(limits({ fiveHourPercent: 20, fiveHourResetAt: soon }))]} />);
    expect(screen.getByText(/^resets \d/)).toBeInTheDocument();
  });

  it("shows the no-data hint when no session carries rate limits", () => {
    render(<UsageStatus sessions={[sessionWith(undefined)]} />);
    expect(screen.getByText(/No limit data yet/)).toBeInTheDocument();
    expect(screen.queryByText("5-hour")).toBeNull();
  });

  it("surfaces a reached limit", () => {
    render(<UsageStatus sessions={[sessionWith(limits({ fiveHourPercent: 100, limitReached: true }))]} />);
    expect(screen.getByText("Limit reached")).toBeInTheDocument();
  });
});
