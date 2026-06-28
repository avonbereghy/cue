import { useState, useEffect, useCallback, useLayoutEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSessionMonitor } from "@/hooks/useSessionMonitor";
import { useSessionAnnouncements } from "@/hooks/useSessionAnnouncements";
import { SessionsTab } from "./SessionsTab";
import { SettingsView } from "./SettingsView";
import type { Settings } from "@/lib/types";

type Tab = "Sessions" | "Settings";

export function Dashboard() {
  const [tab, setTab] = useState<Tab>("Sessions");
  const [frameless, setFrameless] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [justExpanded, setJustExpanded] = useState(false);
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

  // Listen for frameless restore from tray menu
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<boolean>("frameless-changed", (e) => {
      setFrameless(e.payload);
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  const enterFocusMode = useCallback(() => {
    setFrameless(true);
    invoke("set_frameless", { frameless: true }).catch(() => {});
  }, []);
  const exitFocusMode = useCallback(() => {
    setFrameless(false);
    invoke("set_frameless", { frameless: false }).catch(() => {});
  }, []);

  // Auto-fit the window height to the session list (the Rust side yields to a
  // manual resize). We measure the bottom of the last card relative to the
  // position:relative root — that captures the toolbar + every card, and unlike
  // the scroll container's scrollHeight it still shrinks when the list
  // underfills the window. Skipped off the Sessions tab and when empty.
  const measureAndFitMain = useCallback(() => {
    const root = rootRef.current;
    if (!root || tab !== "Sessions") return;
    const cards = root.querySelectorAll<HTMLElement>("[data-session-id]");
    if (cards.length === 0) return;
    const last = cards[cards.length - 1];
    const BOTTOM_GAP = 16;
    const total = last.offsetTop + last.offsetHeight + BOTTOM_GAP;
    invoke("resize_main_to_content", { contentHeight: total }).catch(() => {});
  }, [tab]);

  useLayoutEffect(() => {
    if (tab !== "Sessions") return;
    measureAndFitMain();
    const root = rootRef.current;
    if (!root) return;
    const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-session-id]"));
    if (cards.length === 0) return;
    // Re-fit when any card changes height (todos expand, an agent appears, …).
    const ro = new ResizeObserver(() => measureAndFitMain());
    cards.forEach((c) => ro.observe(c));
    return () => ro.disconnect();
  }, [sessions, tab, frameless, measureAndFitMain]);

  // Esc exits Focus Mode and closes the overflow menu. The macOS menu bar's
  // "View > Focus Mode" owns the ⌘⇧F accelerator.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        if (frameless) {
          e.preventDefault();
          exitFocusMode();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frameless, exitFocusMode]);

  // Latest frameless value for the once-subscribed event listeners below.
  const framelessRef = useRef(frameless);
  useEffect(() => {
    framelessRef.current = frameless;
  }, [frameless]);

  // Native "View > Focus Mode" (⌘⇧F) toggles via this event.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen("menu-toggle-focus-mode", () => {
      if (framelessRef.current) exitFocusMode();
      else enterFocusMode();
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, [enterFocusMode, exitFocusMode]);

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

  const menuItemClass =
    "flex items-center gap-2.5 w-full px-3 py-1.5 text-xs text-white/70 hover:bg-white/10 hover:text-white text-left transition-colors";

  return (
    <div
      ref={rootRef}
      className={`relative flex flex-col h-screen ${frameless ? "rounded-xl overflow-hidden" : ""} ${justExpanded ? "dashboard-expand-in" : ""}`}
      style={{ backgroundColor: "var(--app-bg)" }}
    >
      {/* Focus Mode: a thin draggable strip keeps the window movable when the
          title bar is hidden, and an always-visible restore chip guarantees an
          obvious way out (plus Esc / ⌘⇧F). Never a one-way trap. */}
      {frameless && (
        <div
          className="absolute top-0 left-0 right-0 z-50 h-7 flex items-center justify-end px-1.5"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        >
          <button
            onClick={exitFocusMode}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            className="flex items-center justify-center w-6 h-6 rounded-md text-white/40 hover:text-white/90 hover:bg-white/10 transition-colors"
            aria-label="Exit Focus Mode and show the title bar"
            title="Exit Focus Mode  ·  ⌘⇧F or Esc"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
        </div>
      )}

      {/* Toolbar — hidden in Focus Mode */}
      {!frameless && (
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
              {sessionCount === 0 ? "No sessions" : `${sessionCount} session${sessionCount === 1 ? "" : "s"}`}
            </span>
          )}

          {/* Right: tools */}
          <div className="ml-auto flex items-center gap-2">
            {/* Settings */}
            <button
              onClick={() => setTab(tab === "Settings" ? "Sessions" : "Settings")}
              className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
                tab === "Settings" ? "text-white" : "text-white/70 bg-white/5 hover:bg-white/15 hover:text-white"
              }`}
              style={tab === "Settings" ? { backgroundColor: "var(--accent-bg)" } : undefined}
              aria-label="Settings"
              aria-pressed={tab === "Settings"}
              title="Settings"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>

            {/* More — labeled menu for the less-frequent "open a thing" actions */}
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
                      Theme
                    </button>
                    <div className="my-1 border-t border-white/10" aria-hidden="true" />
                    <button
                      role="menuitem"
                      onClick={() => { setMenuOpen(false); enterFocusMode(); }}
                      className={menuItemClass}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="4 14 10 14 10 20" />
                        <polyline points="20 10 14 10 14 4" />
                        <line x1="14" y1="10" x2="21" y2="3" />
                        <line x1="3" y1="21" x2="10" y2="14" />
                      </svg>
                      <span className="flex-1">Focus Mode</span>
                      <span className="text-[0.5625rem] text-white/30" aria-hidden="true">⌘⇧F</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tab content */}
      {tab === "Sessions" && (
        <div role="tabpanel" id="panel-sessions" aria-label="Sessions" className="flex flex-col flex-1 min-h-0">
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
