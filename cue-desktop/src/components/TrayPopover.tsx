import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSessionMonitor } from "@/hooks/useSessionMonitor";
import type { EnrichedSession } from "@/lib/types";
import { cleanPromptText } from "@/lib/format";

// State color palette mirrors src-tauri/src/tray.rs::color_for_state
// Returned as { rail, pillBg, pillText } so the row + state pill can use
// matched but distinct intensities.
type StateColors = { rail: string; pillBg: string; pillText: string };

function stateColors(state: string, isLight: boolean): StateColors {
  const palette: Record<string, [string, string]> = {
    working:    ["255,255,255", "210,224,240"],
    thinking:   ["232,123,53",  "232,123,53"],
    waiting:    ["255,204,0",   "212,160,0"],
    error:      ["255,69,58",   "220,50,40"],
    subagent:   ["124,197,255", "70,160,235"],
    compacting: ["139,159,212", "100,120,180"],
    clearing:   ["196,144,180", "165,110,150"],
    idle:       ["212,165,116", "180,135,90"],
    done:       ["48,209,88",   "30,170,70"],
  };
  const [dark, light] = palette[state] ?? palette.done;
  const rgb = isLight ? light : dark;
  return {
    rail:     `rgb(${rgb})`,
    pillBg:   `rgba(${rgb}, ${isLight ? 0.14 : 0.18})`,
    pillText: isLight ? `rgb(${light})` : `rgb(${dark})`,
  };
}

const STATE_LABELS: Record<string, string> = {
  working: "Working",
  thinking: "Thinking",
  waiting: "Waiting",
  error: "Error",
  subagent: "Subagent",
  compacting: "Compacting",
  clearing: "Clearing",
  idle: "Idle",
  done: "Done",
};

function fmtDuration(secs: number): string {
  const t = Math.max(0, Math.floor(secs));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

// Current context-window tokens — matches what SessionCard shows: the size
// of the most recent API call (lastInputTokens), not cumulative billing.
function currentContextTokens(s: EnrichedSession): number {
  return s.metrics.lastInputTokens;
}

// State indicator: pulsing dot for active states, solid for terminal.
function StateDot({ state, color }: { state: string; color: string }) {
  const pulses = ["working", "thinking", "subagent", "compacting", "clearing"].includes(state);
  return (
    <span
      className={pulses ? "tray-pulse" : ""}
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: 999,
        backgroundColor: color,
        boxShadow: `0 0 6px ${color}`,
      }}
    />
  );
}

function SessionRow({ session, isLight }: { session: EnrichedSession; isLight: boolean }) {
  const colors = stateColors(session.info.state, isLight);
  const label = STATE_LABELS[session.info.state] ?? session.info.state;
  const tokens = currentContextTokens(session);
  // contextUsagePercent is a fraction (0–1); convert to whole percent.
  const ctxPct = Math.min(100, Math.max(0, session.contextUsagePercent * 100));
  const subBadge = session.info.activeSubagents && session.info.activeSubagents > 0
    ? `${session.info.activeSubagents} sub`
    : null;
  const teamBadge = session.info.teamName ?? null;
  const subprocBadge = session.info.subprocess ?? null;
  const promptPreview = cleanPromptText(session.metrics.lastPrompt).trim().split("\n")[0]?.slice(0, 80) ?? "";

  return (
    <div
      className="tray-row"
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 12px 10px 16px",
        borderRadius: 8,
      }}
    >
      {/* State-tinted left rail */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 4,
          top: 8,
          bottom: 8,
          width: 3,
          borderRadius: 2,
          backgroundColor: colors.rail,
          opacity: 0.9,
        }}
      />

      {/* Top line: name + state + duration */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span
          style={{
            fontWeight: 600,
            fontSize: 13,
            letterSpacing: "-0.01em",
            color: "var(--tray-text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: "1 1 auto",
            minWidth: 0,
          }}
          title={session.workspaceName}
        >
          {session.workspaceName}
        </span>

        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "2px 7px 2px 6px",
            borderRadius: 999,
            backgroundColor: colors.pillBg,
            color: colors.pillText,
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: "0.02em",
            flex: "0 0 auto",
          }}
        >
          <StateDot state={session.info.state} color={colors.pillText} />
          {label}
        </span>

        <span
          className="mono-nums"
          style={{
            fontSize: 11,
            color: "var(--tray-muted)",
            fontVariantNumeric: "tabular-nums",
            flex: "0 0 auto",
          }}
        >
          {fmtDuration(session.durationSecs)}
        </span>
      </div>

      {/* Optional badges row (subprocess, team, subagent count) */}
      {(subprocBadge || teamBadge || subBadge) && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {subprocBadge && <Badge text={subprocBadge} tint="violet" isLight={isLight} />}
          {teamBadge && <Badge text={teamBadge} tint="blue" isLight={isLight} />}
          {subBadge && <Badge text={subBadge} tint="cyan" isLight={isLight} />}
        </div>
      )}

      {/* Context bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            flex: "1 1 auto",
            height: 3,
            borderRadius: 2,
            backgroundColor: "var(--tray-bar-track)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${ctxPct}%`,
              height: "100%",
              backgroundColor: colors.rail,
              opacity: 0.75,
              transition: "width 600ms cubic-bezier(0.16, 1, 0.3, 1)",
            }}
          />
        </div>
        <span
          className="mono-nums"
          style={{
            fontSize: 10.5,
            color: "var(--tray-muted)",
            fontVariantNumeric: "tabular-nums",
            flex: "0 0 auto",
          }}
        >
          {fmtTokens(tokens)} · {ctxPct.toFixed(0)}%
        </span>
      </div>

      {/* Bottom line: model + prompt preview */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "baseline",
          fontSize: 11,
          color: "var(--tray-muted)",
          minWidth: 0,
        }}
      >
        {session.modelDisplayName && (
          <span style={{ flex: "0 0 auto", opacity: 0.85 }}>
            {session.modelDisplayName}
            {session.effortLevel ? ` · ${session.effortLevel}` : ""}
          </span>
        )}
        {promptPreview && (
          <span
            style={{
              flex: "1 1 auto",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              opacity: 0.7,
              minWidth: 0,
            }}
            title={cleanPromptText(session.metrics.lastPrompt)}
          >
            › {promptPreview}
          </span>
        )}
      </div>
    </div>
  );
}

function Badge({ text, tint, isLight }: { text: string; tint: "violet" | "blue" | "cyan"; isLight: boolean }) {
  const map = {
    violet: ["167,139,250", "139,92,246"],
    blue:   ["96,165,250",  "59,130,246"],
    cyan:   ["103,232,249", "34,211,238"],
  } as const;
  const [dark, light] = map[tint];
  const rgb = isLight ? light : dark;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 6px",
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.02em",
        color: `rgb(${rgb})`,
        backgroundColor: `rgba(${rgb}, ${isLight ? 0.12 : 0.18})`,
      }}
    >
      {text}
    </span>
  );
}

function FooterButton({
  label,
  onClick,
  variant = "default",
}: {
  label: string;
  onClick: () => void;
  variant?: "default" | "danger";
}) {
  return (
    <button
      onClick={onClick}
      className="tray-footer-btn"
      data-variant={variant}
      style={{
        flex: "1 1 auto",
        padding: "6px 10px",
        borderRadius: 6,
        fontSize: 11.5,
        fontWeight: 500,
        background: "transparent",
        border: "1px solid var(--tray-border)",
        color: variant === "danger" ? "var(--tray-danger)" : "var(--tray-text)",
        cursor: "pointer",
        transition: "background 120ms ease, border-color 120ms ease",
      }}
    >
      {label}
    </button>
  );
}

export function TrayPopoverPage() {
  const sessions = useSessionMonitor();

  // Track current theme so colors recompute when the user switches dark/light.
  // The root <html> data-theme attribute is set by main.tsx and updated on
  // system theme change.
  const readIsLight = () =>
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "light";
  const [isLight, setIsLight] = useState(readIsLight);

  useEffect(() => {
    const observer = new MutationObserver(() => setIsLight(readIsLight()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  // Hide on Escape — the Rust side also hides on blur.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        invoke("hide_tray_popover").catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Re-fetch immediately when popover becomes visible (covers cases where the
  // window was hidden when the last sessions-updated event fired).
  useEffect(() => {
    const unlisten = listen("tray-popover-shown", () => {
      invoke("get_sessions").catch(() => {});
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Sort: active states first, then by recent activity. Stable for render.
  const sorted = useMemo(() => {
    const order: Record<string, number> = {
      working: 0, thinking: 0, subagent: 0, compacting: 0, clearing: 0,
      waiting: 1, error: 1,
      idle: 2, done: 2,
    };
    return [...sessions].sort((a, b) => {
      const oa = order[a.info.state] ?? 3;
      const ob = order[b.info.state] ?? 3;
      if (oa !== ob) return oa - ob;
      return b.info.lastActivity - a.info.lastActivity;
    });
  }, [sessions]);

  const activeCount = useMemo(
    () => sessions.filter((s) =>
      ["working", "thinking", "subagent", "compacting", "clearing"].includes(s.info.state),
    ).length,
    [sessions],
  );

  return (
    <div className="tray-popover" data-tray-light={isLight ? "1" : "0"}>
      <div className="tray-header">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--tray-text)",
            opacity: 0.85,
          }}>
            Cue
          </span>
          <span style={{
            fontSize: 11,
            color: "var(--tray-muted)",
          }}>
            {sessions.length === 0
              ? "no sessions"
              : `${sessions.length} session${sessions.length === 1 ? "" : "s"}${activeCount > 0 ? ` · ${activeCount} active` : ""}`}
          </span>
        </div>
      </div>

      <div className="tray-list">
        {sorted.length === 0 ? (
          <div style={{
            padding: "28px 16px",
            textAlign: "center",
            fontSize: 12,
            color: "var(--tray-muted)",
          }}>
            No active sessions yet.<br/>
            <span style={{ opacity: 0.7 }}>Open a Claude Code session to see it here.</span>
          </div>
        ) : (
          sorted.slice(0, 12).map((s) => (
            <SessionRow key={s.info.id} session={s} isLight={isLight} />
          ))
        )}
      </div>

      <div className="tray-footer">
        <FooterButton
          label="Dashboard"
          onClick={() => {
            invoke("open_dashboard_from_tray").catch(() => {});
          }}
        />
        <FooterButton
          label="Settings"
          onClick={() => {
            invoke("open_settings_from_tray").catch(() => {});
          }}
        />
        <FooterButton
          label="Quit"
          variant="danger"
          onClick={() => {
            invoke("quit_app").catch(() => {});
          }}
        />
      </div>
    </div>
  );
}
