import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EnvironmentInfo } from "@/lib/types";

interface OnboardingWizardProps {
  onComplete: () => void;
}

const STEPS = ["Welcome", "Hooks", "Done"] as const;
type Harness = "claude" | "codex";
type HookSetup = {
  configuring: boolean;
  result: "success" | "error" | null;
  error: string | null;
  path: string | null;
};

const EMPTY_HOOK_SETUP: HookSetup = {
  configuring: false,
  result: null,
  error: null,
  path: null,
};

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState(0);
  const [envInfo, setEnvInfo] = useState<EnvironmentInfo | null>(null);
  const [hookSetup, setHookSetup] = useState<Record<Harness, HookSetup>>({
    claude: { ...EMPTY_HOOK_SETUP },
    codex: { ...EMPTY_HOOK_SETUP },
  });
  const [showManual, setShowManual] = useState(false);

  const loadEnv = useCallback(async () => {
    try {
      const info = await invoke<EnvironmentInfo>("detect_environment");
      setEnvInfo(info);
    } catch (err) {
      console.error("Failed to detect environment:", err);
    }
  }, []);

  useEffect(() => {
    loadEnv();
  }, [loadEnv]);

  const handleConfigureHooks = async (harness: Harness) => {
    setHookSetup((current) => ({
      ...current,
      [harness]: { ...EMPTY_HOOK_SETUP, configuring: true },
    }));

    try {
      const command = harness === "claude"
        ? "configure_hooks"
        : "install_cue_codex_hooks";
      const path = await invoke<string>(command);
      setHookSetup((current) => ({
        ...current,
        [harness]: { configuring: false, result: "success", error: null, path },
      }));
    } catch (err) {
      setHookSetup((current) => ({
        ...current,
        [harness]: {
          configuring: false,
          result: "error",
          error: String(err),
          path: null,
        },
      }));
    }
  };

  const handleComplete = async () => {
    try {
      const settings = await invoke<Record<string, unknown>>("get_settings");
      await invoke("update_settings", {
        newSettings: { ...settings, onboardingComplete: true },
      });
    } catch (err) {
      console.error("Failed to save onboarding state:", err);
    }
    onComplete();
  };

  const canNext = () => {
    if (step === 0) return envInfo !== null;
    return true;
  };

  const wizardRef = useRef<HTMLDivElement>(null);

  // Focus trap: keep Tab/Shift+Tab within the wizard
  useEffect(() => {
    const wizard = wizardRef.current;
    if (!wizard) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;

      const focusable = wizard!.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    wizard.addEventListener("keydown", handleKeyDown);
    return () => wizard.removeEventListener("keydown", handleKeyDown);
  }, [step]);

  return (
    <div className="flex flex-col h-screen text-white" style={{ backgroundColor: "var(--app-bg, #1a1a1a)" }} ref={wizardRef} role="dialog" aria-label="Setup wizard">
      {/* Progress Dots */}
      <div
        className="flex items-center justify-center gap-2 py-4 bg-white/5 border-b border-white/10"
        aria-label={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}
        role="group"
      >
        {STEPS.map((name, i) => (
          <div key={name} className="flex items-center gap-2">
            <div
              className={`w-2.5 h-2.5 rounded-full transition-colors ${
                i === step
                  ? "bg-blue-400"
                  : i < step
                    ? "bg-blue-400/40"
                    : "bg-white/20"
              }`}
              aria-label={`${name}: ${i === step ? "current" : i < step ? "completed" : "upcoming"}`}
              role="img"
            />
            <span
              className={`text-xs ${
                i === step ? "text-white" : "text-white/50"
              }`}
              aria-hidden="true"
            >
              {name}
            </span>
            {i < STEPS.length - 1 && (
              <div className="w-8 h-px bg-white/10 mx-1" aria-hidden="true" />
            )}
          </div>
        ))}
      </div>

      {/* Step Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {step === 0 && (
          <StepWelcome envInfo={envInfo} onUseDashboardOnly={handleComplete} />
        )}
        {step === 1 && (
          <StepHooks
            setups={hookSetup}
            showManual={showManual}
            onConfigure={handleConfigureHooks}
            onToggleManual={() => setShowManual(!showManual)}
          />
        )}
        {step === 2 && <StepDone />}
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between px-6 py-4 bg-white/5 border-t border-white/10">
        <button
          onClick={() => setStep(step - 1)}
          disabled={step === 0}
          className="px-4 py-2 rounded-lg text-sm text-white/50 hover:text-white/70 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Back
        </button>

        {step < STEPS.length - 1 ? (
          <button
            onClick={() => setStep(step + 1)}
            disabled={!canNext()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-50"
          >
            Next
          </button>
        ) : (
          <button
            onClick={handleComplete}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-green-500/20 text-green-400 hover:bg-green-500/30"
          >
            Get Started
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Welcome + Environment Detection
// ---------------------------------------------------------------------------

function StepWelcome({
  envInfo,
  onUseDashboardOnly,
}: {
  envInfo: EnvironmentInfo | null;
  onUseDashboardOnly: () => void;
}) {
  return (
    <div>
      <h2 className="text-xl font-semibold text-white mb-2">
        Welcome to Cue
      </h2>
      <p className="text-sm text-white/60 mb-6">
        Monitor Claude Code and Codex sessions together with real-time status
        indicators and usage tracking.
      </p>

      {!envInfo ? (
        <div className="text-white/40 text-sm">Detecting environment...</div>
      ) : (
        <div className="space-y-3">
          <EnvRow
            label="Platform"
            value={envInfo.platform}
            ok={true}
          />

          {envInfo.desktopEnv && (
            <EnvRow
              label="Desktop"
              value={envInfo.desktopEnv}
              ok={true}
            />
          )}

          {envInfo.platform === "linux" && (
            <EnvRow
              label="Display Server"
              value={envInfo.wayland ? "Wayland" : "X11"}
              ok={true}
            />
          )}

          <EnvRow
            label="Claude Code"
            value={
              envInfo.claudeCodeFound
                ? "Installed (~/.claude/ found)"
                : "Not found"
            }
            ok={envInfo.claudeCodeFound}
          />

          <EnvRow
            label="Claude Settings"
            value={
              envInfo.claudeSettingsExists
                ? "Found (~/.claude/settings.json)"
                : "Not yet created"
            }
            ok={envInfo.claudeSettingsExists}
          />

          <EnvRow
            label="Codex"
            value={envInfo.codexFound ? "Installed (Codex home found)" : "Not found"}
            ok={envInfo.codexFound}
          />

          <EnvRow
            label="Codex Hooks"
            value={envInfo.codexHooksExists ? "Found (hooks.json)" : "Not yet configured"}
            ok={envInfo.codexHooksExists}
          />

          {envInfo.wslDistros.length > 0 && (
            <EnvRow
              label="WSL Distros"
              value={envInfo.wslDistros.join(", ")}
              ok={true}
            />
          )}

          {/* Warnings */}
          {envInfo.platform === "linux" &&
            envInfo.desktopEnv?.toUpperCase().includes("GNOME") &&
            !envInfo.hasAppindicator && (
              <div className="mt-4 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                <p className="text-sm text-yellow-400 font-medium">
                  GNOME AppIndicator not detected
                </p>
                <p className="text-xs text-yellow-400/70 mt-1">
                  The system tray requires the AppIndicator extension. Install
                  it with: <code className="bg-white/10 px-1 rounded">sudo apt install gnome-shell-extension-appindicator</code>
                </p>
                <button
                  onClick={onUseDashboardOnly}
                  className="mt-2 px-3 py-1.5 rounded-md text-xs font-medium bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 transition-colors"
                >
                  Use Dashboard Only
                </button>
              </div>
            )}

          {envInfo.platform === "windows" && (
            <div className="mt-4 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
              <p className="text-xs text-blue-400/70">
                Tip: After launching, right-click the taskbar and pin the Claude
                Cue tray icon for easy access.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EnvRow({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-white/5">
      <span className="text-sm text-white/80">{label}</span>
      <span className={`text-sm ${ok ? "text-green-400" : "text-yellow-400"}`}>
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Hook Configuration
// ---------------------------------------------------------------------------

interface StepHooksProps {
  setups: Record<Harness, HookSetup>;
  showManual: boolean;
  onConfigure: (harness: Harness) => void;
  onToggleManual: () => void;
}

function StepHooks({
  setups,
  showManual,
  onConfigure,
  onToggleManual,
}: StepHooksProps) {
  return (
    <div>
      <h2 className="text-xl font-semibold text-white mb-2">
        Configure Hooks
      </h2>
      <p className="text-sm text-white/60 mb-6">
        Enable either harness independently. Cue merges only its own hook
        entries into each provider's config and leaves unrelated settings in place.
        Requires Python 3 on your PATH.
      </p>

      <div className="space-y-3">
        <HarnessSetupCard harness="claude" setup={setups.claude} onConfigure={onConfigure} />
        <HarnessSetupCard harness="codex" setup={setups.codex} onConfigure={onConfigure} />
      </div>

      {/* Manual Instructions */}
      <div className="mt-4">
        <button
          onClick={onToggleManual}
          className="text-sm text-white/40 hover:text-white/60 transition-colors"
        >
          {showManual ? "Hide" : "Show"} Manual Instructions
        </button>

        {showManual && (
          <div className="mt-3 p-4 rounded-lg bg-white/5 border border-white/10">
            <p className="text-xs text-white/60 mb-2">
              Claude hooks live in <code className="bg-white/10 px-1 rounded">~/.claude/settings.json</code>;
              run the shared script as <code className="bg-white/10 px-1 rounded">python3 ~/.claude/hooks/cue-hook &lt;state&gt;</code>.
            </p>
            <pre className="text-xs text-white/50 overflow-x-auto whitespace-pre-wrap">
{`"hooks": {
  "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<cmd> idle", "timeout": 5000 }] }],
  "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<cmd> thinking", "timeout": 5000 }] }],
  "PreToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<cmd> working", "timeout": 5000 }] }],
  "PostToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<cmd> working", "timeout": 5000 }] }],
  "PermissionRequest": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<cmd> waiting", "timeout": 5000 }] }],
  "PostToolUseFailure": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<cmd> error", "timeout": 5000 }] }],
  "StopFailure": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<cmd> error", "timeout": 5000 }] }],
  "SubagentStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<cmd> subagent", "timeout": 5000 }] }],
  "SubagentStop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<cmd> subagent_stop", "timeout": 5000 }] }],
  "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<cmd> idle", "timeout": 5000 }] }],
  "TaskCompleted": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<cmd> done", "timeout": 5000 }] }],
  "Notification": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<cmd> waiting", "timeout": 5000 }] }],
  "PreCompact": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<cmd> compacting", "timeout": 5000 }] }],
  "PostCompact": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<cmd> working", "timeout": 5000 }] }],
  "SessionEnd": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<cmd> remove", "timeout": 5000 }] }]
}`}
            </pre>
            <p className="text-xs text-white/40 mt-2">
              Replace <code className="bg-white/10 px-1 rounded">&lt;cmd&gt;</code> with{" "}
              <code className="bg-white/10 px-1 rounded">python3 ~/.claude/hooks/cue-hook</code> (the
              interpreter path plus the full path to the cue-hook script).
            </p>
            <p className="text-xs text-white/50 mt-4">
              Codex hooks live in <code className="bg-white/10 px-1 rounded">$CODEX_HOME/hooks.json</code>
              (normally <code className="bg-white/10 px-1 rounded">~/.codex/hooks.json</code>). Codex timeout
              values are seconds, and commands use <code className="bg-white/10 px-1 rounded">--harness codex</code>.
              Cue discovers open root sessions independently. Restart Codex after changing hooks, open a trusted project,
              run <code className="bg-white/10 px-1 rounded">/hooks</code>, then enable and trust Cue's command hooks.
              Cue never bypasses this opt-in step.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function HarnessSetupCard({
  harness,
  setup,
  onConfigure,
}: {
  harness: Harness;
  setup: HookSetup;
  onConfigure: (harness: Harness) => void;
}) {
  const label = harness === "claude" ? "Claude Code" : "Codex";
  const config = harness === "claude" ? "~/.claude/settings.json" : "$CODEX_HOME/hooks.json";
  return (
    <div className="rounded-lg bg-white/5 border border-white/10 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm text-white/80">{label}</div>
          <div className="text-xs text-white/35">{config}</div>
        </div>
        <button
          onClick={() => onConfigure(harness)}
          disabled={setup.configuring}
          className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
            setup.result === "success"
              ? "bg-green-500/20 text-green-400"
              : setup.result === "error"
                ? "bg-red-500/20 text-red-400"
                : "bg-blue-500/20 text-blue-400 hover:bg-blue-500/30"
          } disabled:opacity-50`}
        >
          {setup.configuring ? "Configuring..." : setup.result === "success" ? "Configured" : "Enable"}
        </button>
      </div>
      {setup.error && <p className="mt-2 text-xs text-red-400/70">{setup.error}</p>}
      {setup.result === "success" && setup.path && (
        <p className="mt-2 text-xs text-green-400/60 truncate">Installed to {setup.path}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4: Done
// ---------------------------------------------------------------------------

function StepDone() {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12">
      <div className="text-4xl mb-4">&#10003;</div>
      <h2 className="text-xl font-semibold text-white">
        You're all set
      </h2>
    </div>
  );
}
