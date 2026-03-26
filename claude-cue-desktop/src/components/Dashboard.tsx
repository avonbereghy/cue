import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSessionMonitor } from "@/hooks/useSessionMonitor";
import { SessionsTab } from "./SessionsTab";
import { SettingsView } from "./SettingsView";
import type { Settings } from "@/lib/types";

type Tab = "Sessions" | "Settings";

const TABS: Tab[] = ["Sessions", "Settings"];

const TAB_ICONS: Record<Tab, string> = {
  Sessions: "\u229e",
  Settings: "\u2699",
};

const TAB_PANEL_IDS: Record<Tab, string> = {
  Sessions: "panel-sessions",
  Settings: "panel-settings",
};

export function Dashboard() {
  const [tab, setTab] = useState<Tab>("Sessions");
  const [compactMode, setCompactMode] = useState(false);
  const [slimMode, setSlimMode] = useState(false);
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

  useEffect(() => {
    localStorage.setItem("selectedDashboardTab", tab);
  }, [tab]);

  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const currentIndex = TABS.indexOf(tab);
      let newIndex = currentIndex;

      if (e.key === "ArrowRight") {
        newIndex = (currentIndex + 1) % TABS.length;
      } else if (e.key === "ArrowLeft") {
        newIndex = (currentIndex - 1 + TABS.length) % TABS.length;
      } else {
        return;
      }

      e.preventDefault();
      setTab(TABS[newIndex]);
      const tabBtn = document.getElementById(`tab-${TABS[newIndex]}`);
      tabBtn?.focus();
    },
    [tab],
  );

  return (
    <div className={`flex flex-col ${compactMode ? "" : "h-screen"}`}>
      {/* Tab bar */}
      <div
        className="flex items-center px-4 py-2 bg-white/5 border-b border-white/10"
        role="tablist"
        aria-label="Dashboard tabs"
        onKeyDown={handleTabKeyDown}
      >
        {TABS.map((t) => (
          <button
            key={t}
            id={`tab-${t}`}
            role="tab"
            aria-selected={tab === t}
            aria-controls={TAB_PANEL_IDS[t]}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => setTab(t)}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md text-sm transition-colors ${
              tab === t
                ? "bg-blue-500/15 text-white"
                : "text-white/50 hover:text-white/70"
            }`}
          >
            <span className="text-xs" aria-hidden="true">{TAB_ICONS[t]}</span>
            {t}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => {
              const next = !compactMode;
              setCompactMode(next);
              invoke<Settings>("get_settings").then((s) => {
                invoke("update_settings", { newSettings: { ...s, compactMode: next } });
              }).catch(() => {});
            }}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-sm transition-colors ${
              compactMode ? "bg-blue-500/15 text-white" : "text-white/50 hover:text-white/70"
            }`}
            title={compactMode ? "Exit Compact Mode" : "Compact Mode"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="3" y1="9" x2="21" y2="9" />
              <line x1="3" y1="15" x2="21" y2="15" />
            </svg>
          </button>
          {!compactMode && (
          <button
            onClick={() => {
              const next = !slimMode;
              setSlimMode(next);
              invoke<Settings>("get_settings").then((s) => {
                invoke("update_settings", { newSettings: { ...s, slimMode: next } });
              }).catch(() => {});
            }}
            className={`flex items-center justify-center w-7 h-7 rounded-md text-sm transition-colors ${
              !slimMode ? "bg-blue-500/15 text-white" : "text-white/50 hover:text-white/70"
            }`}
            title={slimMode ? "Show Details" : "Hide Details"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          </button>
          )}
          <button
            onClick={() => invoke("open_keyboard").catch(() => {})}
            className="flex items-center gap-1 px-3 py-1.5 rounded-md text-sm transition-colors text-white/50 hover:text-white/70"
            title="Animation Keyboard"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </button>
        </div>
      </div>

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
