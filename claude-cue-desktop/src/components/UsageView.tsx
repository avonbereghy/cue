import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { WindowMetrics, Settings } from "@/lib/types";
import { PLAN_PRESETS, USAGE_WINDOWS } from "@/lib/types";
import { WindowSection } from "./WindowSection";

interface UsageViewProps {
  metrics: Record<string, WindowMetrics>;
}

export function UsageView({ metrics }: UsageViewProps) {
  const [selectedPlan, setSelectedPlan] = useState("MaxStandard");
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    invoke<Settings>("get_settings")
      .then((s) => {
        setSettings(s);
        // Detect current plan from saved limits
        const match = PLAN_PRESETS.find(
          (p) =>
            p.name !== "Custom" &&
            p.limits.fiveHour === s.fiveHourTokenLimit &&
            p.limits.daily === s.dailyTokenLimit &&
            p.limits.weekly === s.weeklyTokenLimit,
        );
        setSelectedPlan(match?.name ?? "Custom");
      })
      .catch(console.error);
  }, []);

  function handlePlanChange(planName: string) {
    setSelectedPlan(planName);
    const preset = PLAN_PRESETS.find((p) => p.name === planName);
    if (!preset || preset.name === "Custom") return;

    const newSettings: Settings = {
      onboardingComplete: settings?.onboardingComplete ?? true,
      permissionsEnabled: settings?.permissionsEnabled ?? false,
      fiveHourTokenLimit: preset.limits.fiveHour,
      dailyTokenLimit: preset.limits.daily,
      weeklyTokenLimit: preset.limits.weekly,
      planPreset: preset.displayName,
    };
    setSettings(newSettings);
    invoke("update_settings", { newSettings }).catch(console.error);
  }

  function tokenLimitForWindow(windowName: string): number {
    if (!settings) return 0;
    if (windowName === "Session (5hr)") return settings.fiveHourTokenLimit;
    if (windowName === "Today") return settings.dailyTokenLimit;
    return settings.weeklyTokenLimit;
  }

  const allEmpty = Object.values(metrics).every(
    (m) => m.inputTokens + m.outputTokens === 0,
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Plan picker header */}
      <div className="flex items-center gap-3 px-4 py-2 bg-white/5 border-b border-white/10">
        <span className="text-sm text-white/50" id="plan-picker-label">Plan</span>
        <PlanPicker
          selectedPlan={selectedPlan}
          onPlanChange={handlePlanChange}
        />
      </div>

      {allEmpty ? (
        <div className="flex-1 flex flex-col items-center justify-center text-white/40 gap-2">
          <span className="text-4xl">📊</span>
          <span className="text-lg font-medium">No Usage Recorded</span>
          <span className="text-sm">Usage will appear here as you use Claude Code.</span>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {USAGE_WINDOWS.map((windowName) => {
            const windowMetrics = metrics[windowName] ?? {
              inputTokens: 0,
              outputTokens: 0,
              sessionCount: 0,
              userMessageCount: 0,
              assistantMessageCount: 0,
              toolCounts: {},
              modelTokens: {},
            };
            return (
              <WindowSection
                key={windowName}
                name={windowName}
                metrics={windowMetrics}
                tokenLimit={tokenLimitForWindow(windowName)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PlanPicker with radiogroup semantics and arrow key navigation
// ---------------------------------------------------------------------------

interface PlanPickerProps {
  selectedPlan: string;
  onPlanChange: (planName: string) => void;
}

function PlanPicker({ selectedPlan, onPlanChange }: PlanPickerProps) {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const currentIndex = PLAN_PRESETS.findIndex((p) => p.name === selectedPlan);
      let newIndex = currentIndex;

      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        newIndex = (currentIndex + 1) % PLAN_PRESETS.length;
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        newIndex = (currentIndex - 1 + PLAN_PRESETS.length) % PLAN_PRESETS.length;
      } else {
        return;
      }

      e.preventDefault();
      onPlanChange(PLAN_PRESETS[newIndex].name);
      const btn = document.getElementById(`plan-${PLAN_PRESETS[newIndex].name}`);
      btn?.focus();
    },
    [selectedPlan, onPlanChange],
  );

  return (
    <div
      className="flex rounded-lg bg-white/10 p-0.5"
      role="radiogroup"
      aria-label="Select plan tier"
      aria-labelledby="plan-picker-label"
      onKeyDown={handleKeyDown}
    >
      {PLAN_PRESETS.map((plan) => (
        <button
          key={plan.name}
          id={`plan-${plan.name}`}
          role="radio"
          aria-checked={selectedPlan === plan.name}
          tabIndex={selectedPlan === plan.name ? 0 : -1}
          onClick={() => onPlanChange(plan.name)}
          className={`text-xs px-3 py-1 rounded-md transition-colors ${
            selectedPlan === plan.name
              ? "bg-blue-500/30 text-white"
              : "text-white/50 hover:text-white/70"
          }`}
        >
          {plan.displayName}
        </button>
      ))}
    </div>
  );
}
