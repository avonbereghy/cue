import { useEffect, useState } from "react";
import type { RateLimitInfo } from "@/lib/types";

/** UsageStatus only reads `rateLimits` off each session (it's a global signal),
 *  so it accepts any session-like object carrying it. Narrowing to exactly what
 *  the component consumes keeps it decoupled from the full EnrichedSession shape
 *  — and testable without a cast. EnrichedSession[] satisfies this structurally. */
export type RateLimitSource = { rateLimits?: RateLimitInfo | null };

/**
 * Account-level usage-limit meters: a 5-hour meter and a weekly meter for
 * whatever Claude account is currently active. Rendered in both the tray
 * popover (`variant="tray"`) and the dashboard header strip (`variant="header"`),
 * gated by the `showLimitStatus` setting at each call site.
 *
 * The rate limits are a GLOBAL signal — the Rust backend attaches the same
 * RateLimitInfo (read from the shared rate_limits.json the statusline writes)
 * to every session — so we derive the account meter from the first session that
 * carries it rather than any per-session field.
 */

/** Bar color thresholds — MUST match the per-card rate-limit bars in
 *  SessionCard.tsx: blue `#3b82f6` <75%, magenta `#d946ef` 75–89%, red
 *  `#ef4444` ≥90%. */
export function limitBarColor(pct: number): string {
  if (pct >= 90) return "#ef4444";
  if (pct >= 75) return "#d946ef";
  return "#3b82f6";
}

/** Pull the account-level rate limits off the first session that has them.
 *  Returns `null` when no statusline data has landed yet (no session carries
 *  `rateLimits`), which the UI renders as a subtle "enable the statusline" hint
 *  instead of empty meters. */
export function deriveRateLimits(sessions: readonly RateLimitSource[]): RateLimitInfo | null {
  for (const s of sessions) {
    if (s.rateLimits) return s.rateLimits;
  }
  return null;
}

/** Live reset countdown → "resets 2h 13m" / "resets 4d 6h" / "resets <1m".
 *  `resetAt` is EPOCH SECONDS (the units the statusline writes and the Rust
 *  reset hint consumes); `nowSecs` is Date.now()/1000. Returns `null` when the
 *  reset time is unknown so the caller can omit the countdown entirely. */
export function formatReset(
  resetAt: number | null | undefined,
  nowSecs: number,
): string | null {
  if (resetAt == null) return null;
  const remaining = resetAt - nowSecs;
  if (remaining <= 0) return "resets now";
  const totalMin = Math.floor(remaining / 60);
  if (totalMin < 1) return "resets <1m";
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `resets ${days}d ${hours}h`;
  if (hours > 0) return `resets ${hours}h ${mins}m`;
  return `resets ${mins}m`;
}

type Variant = "tray" | "header";

// Tray reads the popover's CSS vars (they adapt to the active Look + light/dark).
// The header strip lives outside the skin-view containers (so their --ink-* vars
// aren't in scope), so it inherits the ambient Look color via `currentColor` —
// dark on the light Looks, light on the dark ones — and derives the muted/track
// tints from it. This is why the header text was invisible when hardcoded white.
const PALETTE: Record<Variant, { text: string; muted: string; track: string }> = {
  tray: {
    text: "var(--tray-text)",
    muted: "var(--tray-muted)",
    track: "var(--tray-bar-track)",
  },
  header: {
    text: "currentColor",
    muted: "color-mix(in srgb, currentColor 58%, transparent)",
    track: "color-mix(in srgb, currentColor 20%, transparent)",
  },
};

function Meter({
  label,
  pct,
  reset,
  colors,
}: {
  label: string;
  pct: number;
  reset: string | null;
  colors: { text: string; muted: string; track: string };
}) {
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: "1 1 0" }}>
      <span style={{ fontSize: 10.5, fontWeight: 600, color: colors.muted, flex: "0 0 auto", width: 46 }}>
        {label}
      </span>
      <div
        style={{
          flex: "1 1 auto",
          height: 4,
          borderRadius: 2,
          backgroundColor: colors.track,
          overflow: "hidden",
          minWidth: 32,
        }}
      >
        <div
          data-testid="usage-meter-fill"
          style={{
            width: `${clamped}%`,
            height: "100%",
            borderRadius: 2,
            backgroundColor: limitBarColor(clamped),
            opacity: 0.6,
            transition:
              "width 500ms cubic-bezier(0.33, 1, 0.68, 1), background-color 300ms cubic-bezier(0.33, 1, 0.68, 1)",
          }}
        />
      </div>
      <span
        className="mono-nums"
        style={{
          fontSize: 10.5,
          color: colors.text,
          fontVariantNumeric: "tabular-nums",
          flex: "0 0 auto",
          width: 30,
          textAlign: "right",
        }}
      >
        {Math.round(clamped)}%
      </span>
      {reset && (
        <span style={{ fontSize: 10, color: colors.muted, flex: "0 0 auto", whiteSpace: "nowrap" }}>
          {reset}
        </span>
      )}
    </div>
  );
}

export function UsageStatus({
  sessions,
  variant = "header",
}: {
  sessions: readonly RateLimitSource[];
  variant?: Variant;
}) {
  const rateLimits = deriveRateLimits(sessions);
  const colors = PALETTE[variant];

  // Recompute the countdowns on a timer so "resets 2h 13m" ticks down without a
  // fresh session poll. 30s keeps the minute readout honest; the cleanup clears
  // the interval so React 19 StrictMode's mount/unmount/mount can't leak one.
  const [nowSecs, setNowSecs] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNowSecs(Date.now() / 1000), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!rateLimits) {
    return (
      <div
        className="usage-status usage-status-empty"
        data-variant={variant}
        style={{ fontSize: 11, color: colors.muted, padding: variant === "tray" ? "6px 12px" : "2px 0" }}
      >
        No limit data yet — enable the Cue statusline
      </div>
    );
  }

  const isTray = variant === "tray";
  return (
    <div
      className="usage-status"
      data-variant={variant}
      style={{
        display: "flex",
        flexDirection: isTray ? "column" : "row",
        alignItems: isTray ? "stretch" : "center",
        gap: isTray ? 6 : 14,
        flexWrap: isTray ? "nowrap" : "wrap",
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: colors.muted,
          flex: "0 0 auto",
        }}
      >
        Usage · active account
      </span>
      <Meter
        label="5-hour"
        pct={rateLimits.fiveHourPercent}
        reset={formatReset(rateLimits.fiveHourResetAt, nowSecs)}
        colors={colors}
      />
      <Meter
        label="Weekly"
        pct={rateLimits.sevenDayPercent}
        reset={formatReset(rateLimits.sevenDayResetAt, nowSecs)}
        colors={colors}
      />
      {rateLimits.limitReached && (
        <span style={{ fontSize: 10, fontWeight: 600, color: "#ef4444", flex: "0 0 auto" }}>
          Limit reached
        </span>
      )}
    </div>
  );
}
