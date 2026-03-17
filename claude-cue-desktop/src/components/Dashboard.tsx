import { useState, useEffect, useCallback } from "react";
import { useSessionMonitor } from "@/hooks/useSessionMonitor";
import { useUsageMetrics } from "@/hooks/useUsageMetrics";
import { SessionsTab } from "./SessionsTab";
import { UsageView } from "./UsageView";

type Tab = "Sessions" | "Usage";

const TABS: Tab[] = ["Sessions", "Usage"];

const TAB_ICONS: Record<Tab, string> = {
  Sessions: "⊞",
  Usage: "▤",
};

const TAB_PANEL_IDS: Record<Tab, string> = {
  Sessions: "panel-sessions",
  Usage: "panel-usage",
};

export function Dashboard() {
  const [tab, setTab] = useState<Tab>(() => {
    return (localStorage.getItem("selectedDashboardTab") as Tab) ?? "Sessions";
  });
  const sessions = useSessionMonitor();
  const usageMetrics = useUsageMetrics();

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
      // Focus the newly selected tab button
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
      </div>

      {/* Tab content */}
      {tab === "Sessions" ? (
        <div role="tabpanel" id="panel-sessions" aria-labelledby="tab-Sessions">
          <SessionsTab sessions={sessions} />
        </div>
      ) : (
        <div role="tabpanel" id="panel-usage" aria-labelledby="tab-Usage">
          <UsageView metrics={usageMetrics} />
        </div>
      )}
    </div>
  );
}
