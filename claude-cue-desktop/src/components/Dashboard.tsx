import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionMonitor } from "@/hooks/useSessionMonitor";
import { SessionsTab } from "./SessionsTab";
import { SettingsView } from "./SettingsView";

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
  const sessions = useSessionMonitor();

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
    <div className="flex flex-col h-screen">
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
        <button
          onClick={() => invoke("open_keyboard").catch(() => {})}
          className="ml-auto flex items-center gap-1 px-3 py-1.5 rounded-md text-sm transition-colors text-white/50 hover:text-white/70"
          title="Animation Keyboard"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
        </button>
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
