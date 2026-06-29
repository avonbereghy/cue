import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSessionMonitor } from "@/hooks/useSessionMonitor";
import type { EnrichedSession, Settings } from "@/lib/types";
import { cleanPromptText, errorReason } from "@/lib/format";
import { normalizeView } from "@/lib/dashboardViews";
import { openSession } from "@/lib/openSession";
import { useUpdateCheck } from "@/lib/useUpdateCheck";
import { updateStatusLabel } from "@/lib/updater";

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

// Per-Look state hues so the tray rows match the active dashboard skin.
// Instrument keeps its original bright palette (stateColors above).
const LOOK_STATE: Record<string, Record<string, string>> = {
  almanac: { working: "#3a5b73", subagent: "#2f6b63", waiting: "#b07a1e", thinking: "#6a4a6e", compacting: "#6a4a6e", clearing: "#6a4a6e", error: "#a23a2e", done: "#4e6b3a", idle: "#8a7758" },
  night:   { working: "#d8743f", subagent: "#e9c074", waiting: "#f0c067", thinking: "#e8a14a", compacting: "#e8a14a", clearing: "#e8a14a", error: "#c2552e", done: "#9bab74", idle: "#a8967a" },
  studio:  { working: "#4f7a4a", subagent: "#7a6aa8", waiting: "#c97a16", thinking: "#2f7e86", compacting: "#2f7e86", clearing: "#2f7e86", error: "#a83a32", done: "#7d5a2b", idle: "#9a917f" },
};

function colorsForRow(view: string, state: string, isLight: boolean): StateColors {
  if (view === "instrument") return stateColors(state, isLight);
  const hex = LOOK_STATE[view]?.[state] ?? LOOK_STATE[view]?.done ?? "#8a8070";
  return { rail: hex, pillBg: `${hex}26`, pillText: hex };
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

function SessionRow({ session, view, isLight }: { session: EnrichedSession; view: string; isLight: boolean }) {
  const colors = colorsForRow(view, session.info.state, isLight);
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
  const errReason = session.info.state === "error"
    ? errorReason(session.info.errorType, session.metrics.lastErrorMessage)
    : null;

  // Click a row to open its project — in the editor that launched the session
  // (VS Code / Cursor), falling back to the OS file manager. Dismiss the popover
  // since we're handing focus off to that app.
  const openWorkspace = () => {
    openSession(session).finally(() => { invoke("hide_tray_popover").catch(() => {}); });
  };

  return (
    <div
      className="tray-row"
      role="button"
      tabIndex={0}
      onClick={openWorkspace}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openWorkspace();
        }
      }}
      title={`Open ${session.workspaceName}`}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 12px 10px 16px",
        borderRadius: 8,
        cursor: "pointer",
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

      {/* Top line: state + name + duration */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
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
        {errReason ? (
          <span
            style={{
              flex: "1 1 auto",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--tray-danger)",
              opacity: 0.95,
              minWidth: 0,
            }}
            title={errReason}
          >
            ⚠ {errReason}
          </span>
        ) : promptPreview ? (
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
        ) : null}
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

// Cap the rows the glance popover renders; the rest live in the full dashboard.
// Keep in sync with the `.min(12)` pre-size estimate in src-tauri/src/lib.rs.
const MAX_ROWS = 12;

export function TrayPopoverPage() {
  const sessions = useSessionMonitor();

  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const updateCheck = useUpdateCheck();

  // Resize the popover window to fit its content (header + session list) so the
  // window is exactly as tall as the number of sessions: one short row yields a
  // short window, more rows grow it, and the list only scrolls once it would
  // outgrow the screen (the Rust side clamps to a floor and 80% of the monitor).
  // We measure header + the list's unclipped scrollHeight rather than
  // root.scrollHeight because `.tray-list` is overflow:auto, which clips its own
  // offsetHeight to the available flex space. When the "⋯" menu is open it drops
  // from the header and can be taller than a short (few-session) popover, so we
  // also grow the window to the menu's bottom edge — otherwise the lower items
  // (Themes, Quit) get clipped by the window bounds.
  const measureAndResize = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const header = root.querySelector<HTMLElement>(".tray-header");
    const list = root.querySelector<HTMLElement>(".tray-list");
    const SHELL_PADDING_PX = 14; // .tray-popover has padding:6 + 1px borders
    const headerH = header?.offsetHeight ?? 0;
    let total = headerH + (list?.scrollHeight ?? 0) + SHELL_PADDING_PX;
    const menu = menuRef.current;
    if (menu) {
      // Menu is anchored at top:100% of the header's "⋯" with a 4px gap.
      total = Math.max(total, headerH + 4 + menu.offsetHeight + SHELL_PADDING_PX);
    }
    invoke("resize_tray_popover", { contentHeight: total }).catch(() => {});
  }, []);

  // Re-fit when the "⋯" menu opens/closes so a short popover grows to show every
  // item, then shrinks back when it closes.
  useLayoutEffect(() => { measureAndResize(); }, [menuOpen, measureAndResize]);

  // Close the menu when the popover loses focus — the Rust side hides the window
  // on blur, so the menu should never linger open behind a dismissed popover.
  useEffect(() => {
    const onBlur = () => setMenuOpen(false);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

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

  // Active dashboard Look — the tray popover mirrors it. Read from settings (the
  // tray is its own window, so the main window's data-view attribute isn't shared).
  const [view, setView] = useState("instrument");
  useEffect(() => {
    invoke<Settings>("get_settings").then((s) => setView(normalizeView(s.dashboardView))).catch(() => {});
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<Settings>("settings-changed", (e) => setView(normalizeView(e.payload.dashboardView)))
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);
  // Light/dark for chrome not driven by the look's CSS vars (the ⋯ menu, badges):
  // light looks read light, Night reads dark, Instrument follows the app theme.
  const effLight = view === "instrument" ? isLight : view !== "night";

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
      // A re-open with an unchanged session list won't re-fire the [sorted]
      // effect, so re-measure directly — the height tracks the current content
      // on every open, not only when the sessions themselves change.
      requestAnimationFrame(() => measureAndResize());
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [measureAndResize]);

  // Hide ended AND resting sessions from the menu bar — ended ones are revivable
  // in the main app; resting ones (auto-hidden idles + manual dismissals) are
  // recoverable from the dashboard's Resting group. Neither belongs as a
  // menu-bar dot or popover row; the resting count surfaces in the header below.
  const visibleSessions = useMemo(
    () => sessions.filter((s) => s.info.state !== "ended" && !s.resting),
    [sessions],
  );

  const restingCount = useMemo(
    () => sessions.filter((s) => s.resting && s.info.state !== "ended").length,
    [sessions],
  );

  // Sort: active states first, then by recent activity. Stable for render.
  const sorted = useMemo(() => {
    const order: Record<string, number> = {
      working: 0, thinking: 0, subagent: 0, compacting: 0, clearing: 0,
      waiting: 1, error: 1,
      idle: 2, done: 2,
    };
    return [...visibleSessions].sort((a, b) => {
      const oa = order[a.info.state] ?? 3;
      const ob = order[b.info.state] ?? 3;
      if (oa !== ob) return oa - ob;
      return b.info.lastActivity - a.info.lastActivity;
    });
  }, [visibleSessions]);

  const activeCount = useMemo(
    () => visibleSessions.filter((s) =>
      ["working", "thinking", "subagent", "compacting", "clearing"].includes(s.info.state),
    ).length,
    [visibleSessions],
  );

  // Re-fit whenever the visible session list changes (rows added/removed, or a
  // state/prompt update that changes a row's height).
  useLayoutEffect(() => { measureAndResize(); }, [sorted, measureAndResize]);

  return (
    <div ref={rootRef} className="tray-popover" data-view={view} data-tray-light={effLight ? "1" : "0"}>
      <div className="tray-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span className="tray-wordmark" style={{
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
            {visibleSessions.length === 0 && restingCount === 0
              ? "no sessions"
              : `${visibleSessions.length} session${visibleSessions.length === 1 ? "" : "s"}${activeCount > 0 ? ` · ${activeCount} active` : ""}${restingCount > 0 ? ` · ${restingCount} resting` : ""}`}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <button
            className="tray-expand-btn"
            onClick={() => { invoke("open_dashboard_from_tray").catch(() => {}); }}
            title="Open full dashboard"
            aria-label="Expand to full dashboard"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
          <div style={{ position: "relative" }}>
            <button
              className="tray-expand-btn"
              onClick={() => setMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="More"
              aria-label="More"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="19" cy="12" r="1.6" />
              </svg>
            </button>
            {menuOpen && (
              <>
                <div onClick={() => setMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} aria-hidden="true" />
                <div
                  ref={menuRef}
                  role="menu"
                  style={{
                    position: "absolute",
                    right: 0,
                    top: "100%",
                    marginTop: 4,
                    zIndex: 50,
                    minWidth: 150,
                    backgroundColor: effLight ? "#ffffff" : "#1e1e20",
                    border: `1px solid ${effLight ? "rgba(0,0,0,0.10)" : "rgba(255,255,255,0.10)"}`,
                    borderRadius: 8,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
                    padding: "4px 0",
                    overflow: "hidden",
                  }}
                >
                  <button role="menuitem" className="tray-menu-item" onClick={() => { setMenuOpen(false); invoke("open_settings_from_tray").catch(() => {}); }}>Settings</button>
                  <button role="menuitem" className="tray-menu-item" onClick={() => { setMenuOpen(false); invoke("open_keyboard").catch(() => {}); }}>Effects</button>
                  <button role="menuitem" className="tray-menu-item" onClick={() => { setMenuOpen(false); invoke("open_theme_picker").catch(() => {}); }}>Appearance</button>
                  <button role="menuitem" className="tray-menu-item" disabled={updateCheck.status === "checking"} onClick={() => updateCheck.check()}>{updateStatusLabel(updateCheck.status)}</button>
                  <div aria-hidden="true" style={{ height: 1, margin: "4px 8px", backgroundColor: effLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.10)" }} />
                  <button role="menuitem" className="tray-menu-item tray-menu-item-danger" onClick={() => { setMenuOpen(false); invoke("quit_app").catch(() => {}); }}>Quit</button>
                </div>
              </>
            )}
          </div>
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
          <>
            {sorted.slice(0, MAX_ROWS).map((s) => (
              <SessionRow key={s.info.id} session={s} view={view} isLight={effLight} />
            ))}
            {sorted.length > MAX_ROWS && (
              <button
                type="button"
                className="tray-overflow-row"
                onClick={() => { invoke("open_dashboard_from_tray").catch(() => {}); }}
                title="Open the full dashboard to see every session"
              >
                +{sorted.length - MAX_ROWS} more in the dashboard
              </button>
            )}
          </>
        )}
      </div>

    </div>
  );
}
