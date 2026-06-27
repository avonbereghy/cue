import { useState, useEffect, useCallback } from "react";
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
  const [compactMode, setCompactMode] = useState(false);
  const [slimMode, setSlimMode] = useState(false);
  const [frameless, setFrameless] = useState(false);
  const sessions = useSessionMonitor();
  useSessionAnnouncements(sessions);

  useEffect(() => {
    invoke<Settings>("get_settings").then((s) => {
      setCompactMode(s.compactMode ?? false);
      setSlimMode(s.slimMode ?? false);
    }).catch(() => {});
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<Settings>("settings-changed", (e) => {
      setCompactMode(e.payload.compactMode ?? false);
      setSlimMode(e.payload.slimMode ?? false);
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
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

  // Focus Mode must never be a one-way trap: Esc exits, ⌘⇧F (Ctrl+Shift+F)
  // toggles — so there is always a keyboard escape even if the chrome is gone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && frameless) {
        e.preventDefault();
        exitFocusMode();
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        if (frameless) exitFocusMode();
        else enterFocusMode();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frameless, enterFocusMode, exitFocusMode]);



  useEffect(() => {
    localStorage.setItem("selectedDashboardTab", tab);
  }, [tab]);



  return (
    <div
      className={`relative flex flex-col ${compactMode ? "" : "h-screen"} ${frameless ? "rounded-xl overflow-hidden" : ""}`}
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

      {/* Tab bar — hidden in frameless mode */}
      {!frameless && (
        <div className="flex items-center px-4 pt-2 pb-0">
          {tab === "Settings" && (
            <button
              onClick={() => setTab("Sessions")}
              className="flex items-center justify-center w-7 h-7 rounded-md transition-colors text-white/55 hover:text-white hover:bg-white/10"
              aria-label="Back to Sessions"
              title="Back to Sessions"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="15 6 9 12 15 18" />
              </svg>
            </button>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            <button
              onClick={enterFocusMode}
              className="flex items-center justify-center w-7 h-7 rounded-md transition-colors text-white/55 hover:text-white hover:bg-white/10"
              aria-label="Enter Focus Mode (hide the title bar)"
              title="Focus Mode  ·  ⌘⇧F"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
            <button
              onClick={() => {
                const next = !compactMode;
                setCompactMode(next);
                invoke<Settings>("get_settings")
                  .then((s) =>
                    invoke("update_settings", { newSettings: { ...s, compactMode: next } }),
                  )
                  .catch(console.error);
              }}
              className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
                compactMode ? "text-white" : "text-white/55 hover:text-white hover:bg-white/10"
              }`}
              style={compactMode ? { backgroundColor: "var(--accent-bg)" } : undefined}
              aria-label="Compact view"
              aria-pressed={compactMode}
              title={compactMode ? "Exit Compact view" : "Compact view"}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="4" y="5" width="16" height="6" rx="1.6" />
                <rect x="4" y="13" width="16" height="6" rx="1.6" />
              </svg>
            </button>
            <button
              onClick={() => {
                if (compactMode) return;
                const next = !slimMode;
                setSlimMode(next);
                invoke<Settings>("get_settings")
                  .then((s) =>
                    invoke("update_settings", { newSettings: { ...s, slimMode: next } }),
                  )
                  .catch(console.error);
              }}
              className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
                compactMode ? "text-white/30 cursor-not-allowed"
                : !slimMode ? "text-white" : "text-white/55 hover:text-white hover:bg-white/10"
              }`}
              style={!compactMode && !slimMode ? { backgroundColor: "var(--accent-bg)" } : undefined}
              aria-label="Show session details"
              aria-pressed={!compactMode && !slimMode}
              title={compactMode ? "Details unavailable in Compact view" : slimMode ? "Show Details" : "Hide Details"}
              disabled={compactMode}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <line x1="12" y1="11.5" x2="12" y2="16" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            </button>

            <div className="w-px h-3.5 bg-white/10 mx-1 self-center" aria-hidden="true" />
            <button
              onClick={() => invoke("open_keyboard").catch(() => {})}
              className="flex items-center justify-center w-7 h-7 rounded-md transition-colors text-white/55 hover:text-white hover:bg-white/10"
              aria-label="Animation keyboard"
              title="Animation Keyboard"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </button>
            <button
              onClick={() => invoke("open_theme_picker").catch(() => {})}
              className="flex items-center justify-center w-7 h-7 rounded-md transition-colors text-white/55 hover:text-white hover:bg-white/10"
              aria-label="Theme picker"
              title="Theme Picker"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.5-.7 1.5-1.5 0-.4-.1-.7-.4-1-.3-.3-.4-.7-.4-1 0-.8.7-1.5 1.5-1.5H16c3.3 0 6-2.7 6-6 0-5.5-4.5-9-10-9z" />
                <circle cx="8.5" cy="7.5" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="13.5" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="17.5" cy="10.5" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="6.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
              </svg>
            </button>
            <button
              onClick={() => setTab(tab === "Settings" ? "Sessions" : "Settings")}
              className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
                tab === "Settings" ? "text-white" : "text-white/55 hover:text-white hover:bg-white/10"
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
          </div>
        </div>
      )}

      {/* Tab content */}
      {tab === "Sessions" && (
        <div role="tabpanel" id="panel-sessions" aria-labelledby="tab-Sessions" className="flex flex-col flex-1 min-h-0">
          <SessionsTab sessions={sessions} />
        </div>
      )}
      {tab === "Settings" && (
        <div role="tabpanel" id="panel-settings" aria-labelledby="tab-Settings" className="flex-1 overflow-y-auto">
          <SettingsView />
        </div>
      )}

    </div>
  );
}
