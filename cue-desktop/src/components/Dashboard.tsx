import { useState, useEffect, useCallback, useLayoutEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSessionMonitor } from "@/hooks/useSessionMonitor";
import { useSessionAnnouncements } from "@/hooks/useSessionAnnouncements";
import { SessionsTab } from "./SessionsTab";
import { SettingsView } from "./SettingsView";
import { UsageStatus } from "./UsageStatus";
import { useUpdateCheck } from "@/lib/useUpdateCheck";
import { updateStatusLabel } from "@/lib/updater";
import type { Settings } from "@/lib/types";

type Tab = "Sessions" | "Settings";

export function Dashboard() {
  const [tab, setTab] = useState<Tab>("Sessions");
  const [menuOpen, setMenuOpen] = useState(false);
  const updateCheck = useUpdateCheck();
  const [justExpanded, setJustExpanded] = useState(false);
  const [autoFitWindow, setAutoFitWindow] = useState(true);
  const [showLimitStatus, setShowLimitStatus] = useState(true);
  const sessions = useSessionMonitor();
  useSessionAnnouncements(sessions);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Compact and Standard (slim) densities are retired from the dashboard — the
  // menu-bar dots + tray popover own the lean/compact glance, so the dashboard
  // is always the full Detailed view. Migrate any persisted density off once so
  // a returning user isn't stuck in a mode the UI no longer exposes.
  useEffect(() => {
    invoke<Settings>("get_settings").then((s) => {
      if (s.compactMode || s.slimMode) {
        invoke("update_settings", { newSettings: { ...s, compactMode: false, slimMode: false } }).catch(() => {});
      }
    }).catch(() => {});
  }, []);

  // The tray popover's "Settings" and the native macOS Settings menu reveal the
  // dashboard and emit `navigate-settings`; land on the Settings tab so the
  // action actually does something (without this it just showed Sessions).
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen("navigate-settings", () => setTab("Settings"))
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Display preferences that live on the Dashboard shell — loaded once and kept
  // live (Settings emits settings-changed on save). autoFitWindow controls the
  // window-height fit; showLimitStatus gates the account usage-limit strip.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const apply = (s: Settings) => {
      if (cancelled) return;
      setAutoFitWindow(s.autoFitWindow ?? true);
      setShowLimitStatus(s.showLimitStatus ?? true);
    };
    invoke<Settings>("get_settings").then(apply).catch(() => {});
    listen<Settings>("settings-changed", (e) => apply(e.payload))
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Auto-fit the window height to the session list (the Rust side yields to a
  // manual resize). We measure the bottom of the scroll list's LAST CHILD —
  // which covers the active cards and the "Ended Sessions" section — relative to
  // the position:relative root. Unlike the scroll container's scrollHeight, a
  // last-child measurement still shrinks when the list underfills the window.
  // Skipped off the Sessions tab and when the list is empty.
  const measureAndFitMain = useCallback(() => {
    const root = rootRef.current;
    if (!root || tab !== "Sessions" || !autoFitWindow) return;
    const scroll = root.querySelector<HTMLElement>(".sessions-scroll");
    if (!scroll || scroll.childElementCount === 0) return;
    // Lowest child's bottom — robust to a 2-column grid where uneven rows mean
    // the last DOM node isn't the lowest one on screen.
    let bottom = 0;
    for (const child of Array.from(scroll.children)) {
      const el = child as HTMLElement;
      bottom = Math.max(bottom, el.offsetTop + el.offsetHeight);
    }
    const BOTTOM_GAP = 16;
    invoke("resize_main_to_content", { contentHeight: bottom + BOTTOM_GAP }).catch(() => {});
  }, [tab, autoFitWindow]);

  useLayoutEffect(() => {
    if (tab !== "Sessions") return;
    measureAndFitMain();
    const root = rootRef.current;
    const scroll = root?.querySelector<HTMLElement>(".sessions-scroll");
    if (!scroll) return;
    // Re-fit when a child resizes (a card grows, an agent appears, the Ended
    // Sessions disclosure expands) or when children are added/removed.
    const ro = new ResizeObserver(() => measureAndFitMain());
    const observeChildren = () => {
      ro.disconnect();
      Array.from(scroll.children).forEach((c) => ro.observe(c));
    };
    observeChildren();
    const mo = new MutationObserver(() => { observeChildren(); measureAndFitMain(); });
    mo.observe(scroll, { childList: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [sessions, tab, measureAndFitMain]);

  // Esc closes the overflow menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // "Expand" from the tray popover: play a brief scale-in so the dashboard
  // reads as the popover blooming into the full view.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    listen("dashboard-expanded", () => {
      setJustExpanded(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setJustExpanded(false), 340);
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; if (timer) clearTimeout(timer); unlisten?.(); };
  }, []);

  useEffect(() => {
    localStorage.setItem("selectedDashboardTab", tab);
  }, [tab]);

  const sessionCount = sessions.length;
  // "Active" = a turn is in flight (matches the tray popover's count), so the
  // header reads "8 sessions · 3 active" — live vs. parked at a glance.
  const activeCount = sessions.filter((s) =>
    ["working", "thinking", "subagent", "compacting", "clearing"].includes(s.info.state),
  ).length;

  const menuItemClass =
    "flex items-center gap-2.5 w-full px-3 py-1.5 text-xs text-white/70 hover:bg-white/10 hover:text-white text-left transition-colors";

  return (
    <div
      ref={rootRef}
      className={`relative flex flex-col h-screen ${justExpanded ? "dashboard-expand-in" : ""}`}
      style={{ backgroundColor: "var(--app-bg)" }}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 pt-2.5 pb-1.5">
          {/* Left: context — session count, or back + title in Settings */}
          {tab === "Settings" ? (
            <button
              onClick={() => setTab("Sessions")}
              className="flex items-center gap-1 -ml-1 pl-1 pr-2 h-7 rounded-md text-sm font-medium transition-colors text-white/80 hover:text-white hover:bg-white/10"
              aria-label="Back to Sessions"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="15 6 9 12 15 18" />
              </svg>
              Settings
            </button>
          ) : (
            <span className="text-xs text-white/45 select-none tabular-nums">
              {sessionCount === 0
                ? "No sessions"
                : `${sessionCount} session${sessionCount === 1 ? "" : "s"}${activeCount > 0 ? ` · ${activeCount} active` : ""}`}
            </span>
          )}

          {/* Right: tools */}
          <div className="ml-auto flex items-center gap-2">
            {/* Single "⋯" menu — identical options to the tray popover */}
            <div className="relative">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                className="flex items-center justify-center w-7 h-7 rounded-md transition-colors text-white/70 bg-white/5 hover:bg-white/15 hover:text-white"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="More"
                title="More"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <circle cx="5" cy="12" r="1.7" />
                  <circle cx="12" cy="12" r="1.7" />
                  <circle cx="19" cy="12" r="1.7" />
                </svg>
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} aria-hidden="true" />
                  <div role="menu" className="absolute right-0 top-full mt-1 z-50 min-w-44 rounded-lg border border-white/10 bg-zinc-900/95 backdrop-blur-xl shadow-xl py-1">
                    <button
                      role="menuitem"
                      onClick={() => { setMenuOpen(false); setTab("Settings"); }}
                      className={menuItemClass}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                      Settings
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => { setMenuOpen(false); invoke("open_keyboard").catch(() => {}); }}
                      className={menuItemClass}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
                      </svg>
                      Effects
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => { setMenuOpen(false); invoke("open_theme_picker").catch(() => {}); }}
                      className={menuItemClass}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.5-.7 1.5-1.5 0-.4-.1-.7-.4-1-.3-.3-.4-.7-.4-1 0-.8.7-1.5 1.5-1.5H16c3.3 0 6-2.7 6-6 0-5.5-4.5-9-10-9z" />
                        <circle cx="8.5" cy="7.5" r="1.4" fill="currentColor" stroke="none" />
                        <circle cx="13.5" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
                        <circle cx="17.5" cy="10.5" r="1.4" fill="currentColor" stroke="none" />
                        <circle cx="6.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
                      </svg>
                      Appearance
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => updateCheck.check()}
                      disabled={updateCheck.status === "checking"}
                      className={menuItemClass}
                      title="Check GitHub for a newer Cue and install it"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                        <path d="M21 3v5h-5" />
                      </svg>
                      {updateStatusLabel(updateCheck.status)}
                    </button>
                    <div className="my-1 border-t border-white/10" aria-hidden="true" />
                    <button
                      role="menuitem"
                      onClick={() => { setMenuOpen(false); invoke("quit_app").catch(() => {}); }}
                      className="flex items-center gap-2.5 w-full px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300 text-left transition-colors"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 3v9" />
                        <path d="M6.4 6.6a8 8 0 1 0 11.2 0" />
                      </svg>
                      Quit
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

      {/* Tab content */}
      {tab === "Sessions" && (
        <div role="tabpanel" id="panel-sessions" aria-label="Sessions" className="flex flex-col flex-1 min-h-0">
          {/* Account usage-limit strip — the 5-hour + weekly meters for the
              active Claude account, mirroring the tray popover. */}
          {showLimitStatus && (
            <div className="px-4 pt-0.5 pb-1.5">
              <UsageStatus sessions={sessions} variant="header" />
            </div>
          )}
          <SessionsTab sessions={sessions} />
        </div>
      )}
      {tab === "Settings" && (
        <div role="tabpanel" id="panel-settings" aria-label="Settings" className="flex-1 overflow-y-auto">
          <SettingsView />
        </div>
      )}

    </div>
  );
}
