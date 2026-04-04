import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSessionMonitor } from "@/hooks/useSessionMonitor";
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

  useEffect(() => {
    invoke<Settings>("get_settings").then((s) => {
      setCompactMode(s.compactMode ?? false);
      setSlimMode(s.slimMode ?? false);
    }).catch(() => {});
    let unlisten: (() => void) | undefined;
    listen<Settings>("settings-changed", (e) => {
      setCompactMode(e.payload.compactMode ?? false);
      setSlimMode(e.payload.slimMode ?? false);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Listen for frameless restore from tray menu
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<boolean>("frameless-changed", (e) => {
      setFrameless(e.payload);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);



  useEffect(() => {
    localStorage.setItem("selectedDashboardTab", tab);
  }, [tab]);



  return (
    <div
      className={`relative flex flex-col ${compactMode ? "" : "h-screen"} ${frameless ? "rounded-xl overflow-hidden" : ""}`}
      style={{ backgroundColor: "var(--app-bg)" }}
    >
      {/* Frameless restore button — hover top-right to reveal */}
      {frameless && (
        <div
          className="absolute top-0 right-0 z-50 p-1.5 opacity-0 hover:opacity-100 transition-opacity duration-200"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <button
            onClick={() => {
              setFrameless(false);
              invoke("set_frameless", { frameless: false }).catch(() => {});
            }}
            className="flex items-center justify-center w-6 h-6 rounded-md text-white/40 hover:text-white/80 hover:bg-white/10 transition-colors"
            title="Show Title Bar"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
        <div
          className="flex items-center px-4 py-2 border-b"
          style={{ backgroundColor: "var(--surface-bg)", borderColor: "var(--surface-border)" }}
        >
          {tab === "Settings" && (
            <button
              onClick={() => setTab("Sessions")}
              className="flex items-center justify-center w-7 h-7 rounded-md text-sm transition-colors text-white/50 hover:text-white/70"
              title="Back to Sessions"
            >
              &larr;
            </button>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            <button
              onClick={() => {
                setFrameless(true);
                invoke("set_frameless", { frameless: true }).catch(() => {});
              }}
              className="flex items-center justify-center w-7 h-7 rounded-md text-sm transition-colors text-white/50 hover:text-white/70"
              title="Hide Title Bar (restore via tray menu)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
                invoke<Settings>("get_settings").then((s) => {
                  invoke("update_settings", { newSettings: { ...s, compactMode: next } });
                }).catch(() => {});
              }}
              className={`flex items-center justify-center w-7 h-7 rounded-md text-sm transition-colors ${
                compactMode ? "text-white" : "text-white/50 hover:text-white/70"
              }`}
              style={compactMode ? { backgroundColor: "var(--accent-bg)" } : undefined}
              title={compactMode ? "Exit Compact Mode" : "Compact Mode"}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <line x1="3" y1="15" x2="21" y2="15" />
              </svg>
            </button>
            <button
              onClick={() => {
                if (compactMode) return;
                const next = !slimMode;
                setSlimMode(next);
                invoke<Settings>("get_settings").then((s) => {
                  invoke("update_settings", { newSettings: { ...s, slimMode: next } });
                }).catch(() => {});
              }}
              className={`flex items-center justify-center w-7 h-7 rounded-md text-sm transition-colors ${
                compactMode ? "text-white/15 cursor-not-allowed"
                : !slimMode ? "text-white" : "text-white/50 hover:text-white/70"
              }`}
              style={!compactMode && !slimMode ? { backgroundColor: "var(--accent-bg)" } : undefined}
              title={compactMode ? "Details unavailable in compact mode" : slimMode ? "Show Details" : "Hide Details"}
              disabled={compactMode}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            </button>
            <button
              onClick={() => invoke("open_keyboard").catch(() => {})}
              className="flex items-center justify-center w-7 h-7 rounded-md text-sm transition-colors text-white/50 hover:text-white/70"
              title="Animation Keyboard"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </button>
            <button
              onClick={() => invoke("open_theme_picker").catch(() => {})}
              className="flex items-center justify-center w-7 h-7 rounded-md text-sm transition-colors text-white/50 hover:text-white/70"
              title="Theme Picker"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="13.5" cy="6.5" r="2" />
                <circle cx="17.5" cy="10.5" r="2" />
                <circle cx="8.5" cy="7.5" r="2" />
                <circle cx="6.5" cy="12" r="2" />
                <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.5-.7 1.5-1.5 0-.4-.1-.7-.4-1-.3-.3-.4-.7-.4-1 0-.8.7-1.5 1.5-1.5H16c3.3 0 6-2.7 6-6 0-5.5-4.5-9-10-9z" />
              </svg>
            </button>
            <button
              onClick={() => setTab(tab === "Settings" ? "Sessions" : "Settings")}
              className={`flex items-center justify-center w-7 h-7 rounded-md text-sm transition-colors ${
                tab === "Settings" ? "text-white" : "text-white/50 hover:text-white/70"
              }`}
              style={tab === "Settings" ? { backgroundColor: "var(--accent-bg)" } : undefined}
              title="Settings"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Tab content */}
      {tab === "Sessions" && (
        <div role="tabpanel" id="panel-sessions" aria-labelledby="tab-Sessions">
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
