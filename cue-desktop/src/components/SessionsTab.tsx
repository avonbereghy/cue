import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import type { EnrichedSession, Settings, SignalPreset } from "@/lib/types";
import { loadPreset as loadPresetEngine, isLoaded as isPresetLoaded, setGate as setGateEngine } from "@/lib/presetEngine";
// import { formatTokens } from "@/lib/format";
// import { StatBadge } from "./StatBadge";
import { SessionCard } from "./SessionCard";
import { PermissionPrompt } from "./PermissionPrompt";
import { PermissionHistory } from "./PermissionHistory";
import { usePermissions } from "@/hooks/usePermissions";

const REVIVED_STORAGE_KEY = "cue-revived-sessions";

/** Snapshot stored for revived (ended) sessions */
interface RevivedSession {
  session: EnrichedSession;
  revivedAt: number;
}

function formatReviveElapsed(revivedAt: number): string {
  const elapsed = Math.floor((Date.now() - revivedAt) / 1000);
  if (elapsed < 60) return `${elapsed}s`;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hrs}h ${remainMins}m`;
}

function loadRevivedSessions(): RevivedSession[] {
  try {
    const raw = localStorage.getItem(REVIVED_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRevivedSessions(revived: RevivedSession[]) {
  localStorage.setItem(REVIVED_STORAGE_KEY, JSON.stringify(revived));
}

interface SessionsTabProps {
  sessions: EnrichedSession[];
}

// Persist sandbox sessions across tab switches (component unmounts when Settings tab is open).
// Module-level so it survives React unmount/remount cycles.
let _sandboxSessionsCache: EnrichedSession[] = [];
let _sandboxSelectedIdxCache = -1;

export function SessionsTab({ sessions }: SessionsTabProps) {
  const [permissionsEnabled, setPermissionsEnabled] = useState(false);
  const [titleAnimation, setTitleAnimation] = useState("ripple");
  const [animationSpeed, setAnimationSpeed] = useState(3.5);
  const [randomAnimation, setRandomAnimation] = useState(false);
  const [signalString, setSignalString] = useState(false);
  const [signalFrequency, setSignalFrequency] = useState(1.0);
  const [signalMode, setSignalMode] = useState("simulated");
  const [signalAlpha, setSignalAlpha] = useState(0.7);
  const [signalAmplitude, setSignalAmplitude] = useState(0.15);
  const [signalEcho, setSignalEcho] = useState(1.75);
  const [signalBass, setSignalBass] = useState(true);
  const [signalMids, setSignalMids] = useState(true);
  const [signalTreble, setSignalTreble] = useState(true);
  const [signalColorDark, setSignalColorDark] = useState("#ffffff");
  const [signalColorLight, setSignalColorLight] = useState("#000000");
  const [signalOffset, setSignalOffset] = useState(0.5);
  const [signalEffect, setSignalEffect] = useState("string");
  const [sandEnabled, setSandEnabled] = useState(true);
  const [sandIntensity, setSandIntensity] = useState(1.51);
  const [sandDirection, setSandDirection] = useState(0);
  const [sandDensity, setSandDensity] = useState(8.0);
  const [sandSpeed, setSandSpeed] = useState(3.0);
  const [sandGrainSize, setSandGrainSize] = useState(0.5);
  const [sandTurbulence, setSandTurbulence] = useState(0.4);
  const [sandAlpha, setSandAlpha] = useState(0.9);
  const [cordRetractDelay, setCordRetractDelay] = useState(0.2);
  const [cordDeployForce, setCordDeployForce] = useState(1.5);
  const [cordRetractForce, setCordRetractForce] = useState(1.5);
  const [stringSpread, setStringSpread] = useState(0.02);
  const [activePresetId, setActivePresetId] = useState("");
  const [presetBootAttempted, setPresetBootAttempted] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  const [slimMode, setSlimMode] = useState(false);
  const [contextThreshold, setContextThreshold] = useState("always");
  const [contextDisplay, setContextDisplay] = useState("percent");
  const [lowPower, setLowPower] = useState(false);
  const [showToolPills, setShowToolPills] = useState(false);
  const [showCurrentTool, setShowCurrentTool] = useState(false);
  const [showConfigCounts, setShowConfigCounts] = useState(false);
  const [timerDisplay, setTimerDisplay] = useState("seconds");
  const [keyPressSpeed, setKeyPressSpeed] = useState(0.35);
  const [keyReleaseSpeed, setKeyReleaseSpeed] = useState(0.4);
  const [stateOverrides, setStateOverrides] = useState<Record<string, string>>({});
  // Per-session expand level in compact mode: 0=compact, 1=slim, 2=full. Undefined = follow global.
  const [expandOverrides, setExpandOverrides] = useState<Record<string, number>>({});
  const [autoReorder, setAutoReorder] = useState(false);
  // Ref to current sessions so keyboard handler reads latest value
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const cardPositions = useRef<Map<string, DOMRect>>(new Map());
  const listRef = useRef<HTMLDivElement>(null);
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(
    new Set(),
  );
  const [revivedSessions, setRevivedSessions] = useState<RevivedSession[]>(loadRevivedSessions);
  const [reviveClicks, setReviveClicks] = useState<Record<string, number>>({});
  const prevSessionIdsRef = useRef<Set<string>>(new Set());
  const prevSessionsRef = useRef<EnrichedSession[]>([]);
  const dismissedIdsRef = useRef<Set<string>>(new Set());
  const preCompactSizeRef = useRef<{ width: number; height: number } | null>(null);

  // Auto-resize window only when compact mode is toggled on/off
  const prevCompactRef = useRef(compactMode);
  useEffect(() => {
    const win = getCurrentWindow();
    const wasCompact = prevCompactRef.current;
    prevCompactRef.current = compactMode;

    if (!compactMode) {
      if (wasCompact && preCompactSizeRef.current) {
        const { width, height } = preCompactSizeRef.current;
        win.setSize(new LogicalSize(width, height));
        win.setMinSize(null);
        preCompactSizeRef.current = null;
      }
      return;
    }

    if (!wasCompact) {
      // Save current logical size before shrinking (only on transition into compact)
      win.innerSize().then((phys) => {
        const dpr = window.devicePixelRatio || 1;
        preCompactSizeRef.current = { width: phys.width / dpr, height: phys.height / dpr };

        // Deterministic sizing: fixed card height * session count + chrome
        const activeCount = sessions.filter(s => s.info.state !== "ended").length;
        const CARD_H = 52;     // compact card height (py-1.5 + content + border)
        const CARD_GAP = 6;    // space-y-1.5 = 6px
        const TAB_BAR = 44;    // tab bar height
        const LIST_PAD = 16;   // p-2 top + bottom
        const compactWidth = 420;
        const totalHeight = TAB_BAR + LIST_PAD + activeCount * CARD_H + Math.max(0, activeCount - 1) * CARD_GAP;

        win.setSize(new LogicalSize(compactWidth, totalHeight));
        win.setMinSize(new LogicalSize(200, 60));
      });
    }
  }, [compactMode]);

  // Track ended sessions: sessions that disappear OR transition to "done" state
  // get moved to the revive list. Sessions that reappear get removed from revive.
  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.info.id));
    const prevIds = prevSessionIdsRef.current;

    setRevivedSessions((prev) => {
      let next = prev;
      const alreadyRevived = new Set(prev.map((r) => r.session.info.id));

      if (prevIds.size > 0) {
        const ended: RevivedSession[] = [];

        // Sessions that disappeared entirely
        for (const id of prevIds) {
          if (!currentIds.has(id) && !alreadyRevived.has(id)) {
            const snapshot = prevSessionsRef.current.find((s) => s.info.id === id);
            if (snapshot) {
              ended.push({ session: snapshot, revivedAt: Date.now() });
            }
          }
        }

        // Sessions that transitioned to "ended" (SessionEnd fired — chat exited)
        for (const session of sessions) {
          if (session.info.state === "ended" && !alreadyRevived.has(session.info.id) && !dismissedIdsRef.current.has(session.info.id)) {
            ended.push({ session, revivedAt: Date.now() });
          }
        }

        if (ended.length > 0) {
          next = [...next, ...ended];
        }
      }

      // Remove revived sessions that reappeared with a non-ended state (revive succeeded)
      const filtered = next.filter((r) => {
        const active = sessions.find((s) => s.info.id === r.session.info.id);
        return !active || active.info.state === "ended";
      });

      if (filtered.length !== prev.length || filtered !== next) {
        saveRevivedSessions(filtered);
        return filtered;
      }
      return prev;
    });

    prevSessionIdsRef.current = currentIds;
    prevSessionsRef.current = sessions;
  }, [sessions]);

    // Tick every second to update revive timers
  const [, setTick] = useState(0);
  useEffect(() => {
    if (revivedSessions.length === 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [revivedSessions.length]);

  const REVIVE_CLICKS_REQUIRED = 3;

  const handleReviveClick = useCallback((session: EnrichedSession) => {
    const id = session.info.id;
    const current = reviveClicks[id] ?? 0;
    const next = current + 1;

    if (next >= REVIVE_CLICKS_REQUIRED) {
      // Final click — fire the revive
      setReviveClicks((prev) => {
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });
      invoke("revive_session", {
        sessionId: session.info.id,
        workspace: session.info.workspace,
      }).catch((err) => {
        console.error("Failed to revive session:", err);
      });
    } else {
      setReviveClicks((prev) => ({ ...prev, [id]: next }));
    }
  }, [reviveClicks]);

  const handleDismissRevived = useCallback((sessionId: string) => {
    dismissedIdsRef.current.add(sessionId);
    setRevivedSessions((prev) => {
      const next = prev.filter((r) => r.session.info.id !== sessionId);
      saveRevivedSessions(next);
      return next;
    });
  }, []);

  const handleClearAllRevived = useCallback(() => {
    for (const r of revivedSessions) {
      dismissedIdsRef.current.add(r.session.info.id);
    }
    setRevivedSessions([]);
    saveRevivedSessions([]);
  }, [revivedSessions]);

  // const totalMessages = sessions.reduce((sum, s) => sum + s.metrics.messageCount, 0);
  // const totalTokens = sessions.reduce(
  //   (sum, s) => {
  //     const subTokens = (s.metrics.subagents ?? []).reduce(
  //       (sub, a) => sub + a.inputTokens + a.outputTokens, 0,
  //     );
  //     return sum + s.metrics.inputTokens + s.metrics.outputTokens + subTokens;
  //   },
  //   0,
  // );
  const {
    pendingBySession,
    permissionHistory,
    approvePermission,
    denyPermission,
    refreshHistory,
  } = usePermissions();

  // const totalPending = Object.values(pendingBySession).reduce(
  //   (sum, reqs) => sum + reqs.length,
  //   0,
  // );

  // Load settings and poll for changes (so Signal Settings window edits sync)
  const applySettings = useCallback((s: Settings) => {
    setPermissionsEnabled(s.permissionsEnabled);
    setTitleAnimation(s.titleAnimation ?? "ripple");
    setAnimationSpeed(s.animationSpeed ?? 3.5);
    setRandomAnimation(s.randomAnimation ?? false);
    setSignalString(s.signalString ?? false);
    setSignalFrequency(s.signalFrequency ?? 1.0);
    const mode = s.signalMode === "audio" ? "preset" : s.signalMode === "live" ? "simulated" : (s.signalMode ?? "simulated");
    setSignalMode(mode);
    setSignalAlpha(s.signalAlpha ?? 0.7);
    setSignalAmplitude(s.signalAmplitude ?? 0.15);
    setSignalEcho(s.signalEcho ?? 1.75);
    setSignalBass(s.signalBass ?? true);
    setSignalMids(s.signalMids ?? true);
    setSignalTreble(s.signalTreble ?? true);
    setSignalColorDark(s.signalColorDark ?? "#ffffff");
    setSignalColorLight(s.signalColorLight ?? "#000000");
    setSignalOffset(s.signalOffset ?? 0.5);
    setSignalEffect(s.signalEffect ?? "string");
    setSandEnabled(s.sandEnabled ?? true);
    setSandIntensity(s.sandIntensity ?? 1.51);
    setSandDirection(s.sandDirection ?? 0);
    setSandDensity(s.sandDensity ?? 8.0);
    setSandSpeed(s.sandSpeed ?? 3.0);
    setSandGrainSize(s.sandGrainSize ?? 0.5);
    setSandTurbulence(s.sandTurbulence ?? 0.4);
    setSandAlpha(s.sandAlpha ?? 0.9);
    setCordRetractDelay(s.cordRetractDelay ?? 0.2);
    setCordDeployForce(s.cordDeployForce ?? 1.5);
    setCordRetractForce(s.cordRetractForce ?? 1.5);
    setStringSpread(s.stringSpread ?? 0.02);
    setGateEngine(s.signalGate ?? 0.05);
    setActivePresetId(s.activePresetId ?? "");
    setKeyPressSpeed(s.keyPressSpeed ?? 0.35);
    setKeyReleaseSpeed(s.keyReleaseSpeed ?? 0.4);
    setAutoReorder(s.autoReorder ?? false);
    document.documentElement.style.setProperty("--font-scale", String(s.fontScale ?? 1.0));
    setTestMode(s.testMode ?? false);
    setCompactMode(s.compactMode ?? false);
    if (!(s.compactMode ?? false)) setExpandOverrides({});
    setSlimMode(s.slimMode ?? false);
    setContextThreshold(s.contextThreshold ?? "always");
    setContextDisplay(s.contextDisplay ?? "percent");
    setLowPower(s.lowPower ?? false);
    setShowToolPills(s.showToolPills ?? false);
    setShowCurrentTool(s.showCurrentTool ?? false);
    setShowConfigCounts(s.showConfigCounts ?? false);
    setTimerDisplay(s.timerDisplay ?? "seconds");
    if (s.lowPower) document.documentElement.setAttribute("data-low-power", "");
    else document.documentElement.removeAttribute("data-low-power");
  }, []);

  useEffect(() => {
    // Load settings on mount
    invoke<Settings>("get_settings").then(applySettings).catch(() => {});
    // Listen for settings changes from any window (replaces 2s polling)
    let unlisten: (() => void) | undefined;
    listen<Settings>("settings-changed", (event) => {
      applySettings(event.payload);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [applySettings]);

  // Auto-load active preset on launch when preset mode is configured
  useEffect(() => {
    if (presetBootAttempted || signalMode !== "preset" || isPresetLoaded()) return;
    if (!activePresetId) return;
    setPresetBootAttempted(true);
    invoke<SignalPreset>("load_preset", { id: activePresetId })
      .then((preset) => loadPresetEngine(preset))
      .catch(() => {});
  }, [signalMode, activePresetId, presetBootAttempted]);

  // Live audio disabled — Core Audio Taps permission issue
  // useEffect(() => {
  //   if (signalMode === "live") {
  //     invoke("start_live_audio").catch((e) => console.warn("Live audio start failed:", e));
  //     return () => { invoke("stop_live_audio").catch(() => {}); };
  //   }
  // }, [signalMode]);

  const toggleSessionCollapse = (sessionId: string) => {
    setCollapsedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  };

  // ---------------------------------------------------------------------------
  // Sandbox mode — full keyboard-driven session designer for screenshots
  // ---------------------------------------------------------------------------
  const SANDBOX_STATES = ["working", "thinking", "waiting", "error", "subagent", "idle", "done", "ended"] as const;
  const SANDBOX_STATE_META: Record<string, { icon: string; display: string; key: string }> = {
    working:  { icon: "\u27F3", display: "Working",  key: "W" },
    thinking: { icon: "\uD83D\uDCAD", display: "Thinking", key: "T" },
    waiting:  { icon: "\u23F8", display: "Waiting",  key: "P" },
    error:    { icon: "\u2717", display: "Error",    key: "E" },
    subagent: { icon: "\u2934", display: "Subagent", key: "A" },
    idle:     { icon: "\u25CB", display: "Idle",     key: "I" },
    done:     { icon: "\u2713", display: "Done",     key: "D" },
    ended:    { icon: "\u2715", display: "Ended",    key: "X" },
  };
  const SANDBOX_MODELS = ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5-20251001"] as const;
  const SANDBOX_SOURCES = ["terminal", "vscode", "cursor", "iterm"] as const;
  const SANDBOX_BRANCHES = ["main", "feat/auth", "fix/bug-123", "dev", "feat/dashboard", "release/v2.0", "hotfix/crash"];
  const SANDBOX_WORKSPACES = ["my-app", "api-server", "cue", "web-client", "ml-pipeline", "infra", "docs", "mobile"];
  const SANDBOX_TOOLS_ACTIVE: Array<[string, string]> = [
    ["Write", "src/components/Button.tsx"],
    ["Edit", "src/lib/utils.ts"],
    ["Bash", "npm run test"],
    ["Read", "package.json"],
    ["Grep", "useState"],
    ["Agent", "test-runner"],
    ["Write", "src/hooks/useAuth.ts"],
    ["Bash", "cargo build --release"],
  ];
  const SANDBOX_TITLES = [
    "Implementing auth flow",
    "Fixing race condition",
    "Adding unit tests",
    "Refactoring API layer",
    "Building dashboard UI",
    "Optimizing queries",
    "Writing documentation",
    "Debugging memory leak",
  ];

  const sandboxCounterRef = useRef(0);
  const [sandboxSessions, setSandboxSessions] = useState<EnrichedSession[]>(() => _sandboxSessionsCache);
  const [sandboxSelectedIdx, setSandboxSelectedIdx] = useState<number>(() => _sandboxSelectedIdxCache);
  const [sandboxShowHelp, setSandboxShowHelp] = useState(false);
  const [sandboxEditingTitle, setSandboxEditingTitle] = useState(false);
  const [screenshotMode, setScreenshotMode] = useState(false);
  const [screenshotSaved, setScreenshotSaved] = useState<string | null>(null);
  const sandboxTitleInputRef = useRef<HTMLInputElement>(null);

  // Keep module-level cache in sync so state survives tab switches
  useEffect(() => { _sandboxSessionsCache = sandboxSessions; }, [sandboxSessions]);
  useEffect(() => { _sandboxSelectedIdxCache = sandboxSelectedIdx; }, [sandboxSelectedIdx]);

  // Clean up sandbox sessions when the component unmounts
  useEffect(() => {
    return () => { invoke("clear_sandbox_sessions").catch(() => {}); };
  }, []);

  // Sync sandbox sessions into sessions.json so the real Rust pipeline processes them.
  // Sandbox IDs use the "sandbox-" prefix so they're never confused with real sessions.
  useEffect(() => {
    if (!testMode) {
      // Clean up when leaving sandbox mode
      invoke("clear_sandbox_sessions").catch(() => {});
      return;
    }
    const now = Date.now() / 1000;
    const payload = sandboxSessions.map((s) => ({
      id: s.info.id.startsWith("sandbox-") ? s.info.id : `sandbox-${s.info.id}`,
      workspace: `/sandbox/${s.info.workspace ?? "session"}`,
      state: s.info.state,
      lastActivity: s.info.lastActivity ?? now,
      startedAt: s.info.startedAt ?? now,
      activeSubagents: s.info.activeSubagents ?? 0,
      source: "sandbox",
    }));
    invoke("write_sandbox_sessions", { sessions: payload }).catch(() => {});
  }, [testMode, sandboxSessions]);

  const makeSandboxSession = useCallback((state: string = "idle", overrides?: Partial<{ title: string; workspace: string; model: string; source: string; branch: string; contextPct: number; tool: [string, string] | null; todoCompleted: number; todoTotal: number; subagentCount: number; tokPerSec: number; durationSecs: number }>): EnrichedSession => {
    const n = ++sandboxCounterRef.current;
    const model = overrides?.model ?? SANDBOX_MODELS[n % SANDBOX_MODELS.length];
    const source = overrides?.source ?? SANDBOX_SOURCES[n % SANDBOX_SOURCES.length];
    const meta = SANDBOX_STATE_META[state] ?? SANDBOX_STATE_META.idle;
    const contextPct = overrides?.contextPct ?? (Math.random() * 0.6 + 0.05);
    const contextLimit = model.includes("haiku") ? 200_000 : 1_000_000;
    const modelDisplay = model.includes("opus") ? "Opus 4.6" : model.includes("haiku") ? "Haiku 4.5" : "Sonnet 4.6";
    const sourceDisplay = source === "vscode" ? "VSCode" : source === "cursor" ? "Cursor" : source === "iterm" ? "iTerm" : "Terminal";
    const branch = overrides?.branch ?? SANDBOX_BRANCHES[n % SANDBOX_BRANCHES.length];
    const workspace = overrides?.workspace ?? SANDBOX_WORKSPACES[n % SANDBOX_WORKSPACES.length];
    const title = overrides?.title ?? SANDBOX_TITLES[n % SANDBOX_TITLES.length];
    const tool = overrides?.tool ?? (state === "working" ? SANDBOX_TOOLS_ACTIVE[n % SANDBOX_TOOLS_ACTIVE.length] : null);
    const subagentCount = overrides?.subagentCount ?? (state === "subagent" ? Math.floor(Math.random() * 3) + 1 : 0);
    const todoTotal = overrides?.todoTotal ?? Math.floor(Math.random() * 12 + 3);
    const todoCompleted = overrides?.todoCompleted ?? Math.floor(Math.random() * todoTotal);
    const subagents = Array.from({ length: subagentCount }, (_, i) => ({
      agentId: `sub_${n}_${i}`,
      description: ["Research task", "Code review", "Test runner", "Build validator"][i % 4],
      slug: ["research", "code-reviewer", "test-runner", "build-validator"][i % 4],
      inputTokens: Math.floor(Math.random() * 30000 + 5000),
      outputTokens: Math.floor(Math.random() * 8000 + 1000),
      cacheCreationTokens: 0,
      cacheReadTokens: Math.floor(Math.random() * 10000),
      model,
      toolCounts: { Read: Math.floor(Math.random() * 8 + 1), Grep: Math.floor(Math.random() * 4), Edit: Math.floor(Math.random() * 3) },
      messageCount: Math.floor(Math.random() * 15 + 3),
      isActive: true,
    }));

    return {
      info: {
        id: `__sandbox_${n}__`,
        workspace: `/Users/dev/Projects/${workspace}`,
        state,
        lastActivity: Date.now() / 1000,
        startedAt: Date.now() / 1000 - (overrides?.durationSecs ?? Math.floor(Math.random() * 1800 + 60)),
        source,
      },
      metrics: {
        messageCount: Math.floor(Math.random() * 80 + 10),
        userMessageCount: Math.floor(Math.random() * 20 + 2),
        inputTokens: Math.floor(contextPct * contextLimit * 0.8),
        outputTokens: Math.floor(Math.random() * 60000 + 5000),
        cacheCreationTokens: Math.floor(Math.random() * 20000),
        cacheReadTokens: Math.floor(Math.random() * 100000),
        model,
        lastInputTokens: Math.floor(contextPct * contextLimit * 0.8),
        customTitle: title,
        gitBranch: branch,
        toolCounts: { Read: Math.floor(Math.random() * 25 + 2), Edit: Math.floor(Math.random() * 15 + 1), Bash: Math.floor(Math.random() * 10), Grep: Math.floor(Math.random() * 8), Write: Math.floor(Math.random() * 6), Agent: subagentCount > 0 ? subagentCount : 0 },
        subagents,
        todoItems: [],
      },
      workspaceName: workspace,
      displayTitle: title,
      stateIcon: meta.icon,
      stateDisplayName: meta.display,
      durationSecs: overrides?.durationSecs ?? Math.floor(Math.random() * 1800 + 60),
      totalDurationSecs: overrides?.durationSecs ?? Math.floor(Math.random() * 1800 + 60),
      contextLimit,
      contextUsagePercent: contextPct,
      modelDisplayName: modelDisplay,
      sourceDisplay,
      hasSubagents: subagentCount > 0,
      provider: "",
      outputTokensPerSec: overrides?.tokPerSec ?? (state === "working" || state === "subagent" ? Math.random() * 25 + 5 : 0),
      runningToolName: tool ? tool[0] : undefined,
      runningToolTarget: tool ? tool[1] : undefined,
      todoItems: [],
      todoCompleted,
      todoTotal,
      systemMemory: { totalMb: 32768, usedMb: Math.floor(Math.random() * 16000 + 8000), usagePercent: Math.random() * 50 + 25 },
      claudeVersion: "1.0.33",
    };
  }, []);

  const addSandboxSession = useCallback((state?: string) => {
    setSandboxSessions((prev) => {
      const next = [...prev, makeSandboxSession(state)];
      setSandboxSelectedIdx(next.length - 1);
      return next;
    });
  }, [makeSandboxSession]);

  const removeSandboxSession = useCallback((id: string) => {
    setSandboxSessions((prev) => {
      const next = prev.filter((s) => s.info.id !== id);
      setSandboxSelectedIdx((idx) => Math.min(idx, next.length - 1));
      return next;
    });
  }, []);

  const setSandboxState = useCallback((id: string, state: string) => {
    const meta = SANDBOX_STATE_META[state] ?? SANDBOX_STATE_META.idle;
    const tool = state === "working" ? SANDBOX_TOOLS_ACTIVE[Math.floor(Math.random() * SANDBOX_TOOLS_ACTIVE.length)] : null;
    setSandboxSessions((prev) => prev.map((s) =>
      s.info.id === id ? {
        ...s,
        info: { ...s.info, state, lastActivity: Date.now() / 1000 },
        stateIcon: meta.icon,
        stateDisplayName: meta.display,
        hasSubagents: state === "subagent" ? true : (state === "working" ? false : s.hasSubagents),
        outputTokensPerSec: (state === "working" || state === "subagent") ? Math.random() * 25 + 5 : 0,
        runningToolName: tool ? tool[0] : (state === "working" ? s.runningToolName : undefined),
        runningToolTarget: tool ? tool[1] : (state === "working" ? s.runningToolTarget : undefined),
        metrics: {
          ...s.metrics,
          subagents: state === "subagent" ? (s.metrics.subagents.length > 0 ? s.metrics.subagents : [
            { agentId: `sub_auto_1`, description: "Research task", slug: "research", inputTokens: 12000, outputTokens: 3000, cacheCreationTokens: 0, cacheReadTokens: 5000, model: s.metrics.model, toolCounts: { Read: 3, Grep: 2 }, messageCount: 8, isActive: true },
          ]) : (state === "working" ? [] : s.metrics.subagents),
        },
      } : s,
    ));
  }, []);

  const setAllSandboxState = useCallback((state: string) => {
    setSandboxSessions((prev) => prev.map((s) => {
      const meta = SANDBOX_STATE_META[state] ?? SANDBOX_STATE_META.idle;
      const tool = state === "working" ? SANDBOX_TOOLS_ACTIVE[Math.floor(Math.random() * SANDBOX_TOOLS_ACTIVE.length)] : null;
      return {
        ...s,
        info: { ...s.info, state, lastActivity: Date.now() / 1000 },
        stateIcon: meta.icon,
        stateDisplayName: meta.display,
        hasSubagents: state === "subagent",
        outputTokensPerSec: (state === "working" || state === "subagent") ? Math.random() * 25 + 5 : 0,
        runningToolName: tool ? tool[0] : undefined,
        runningToolTarget: tool ? tool[1] : undefined,
        metrics: {
          ...s.metrics,
          subagents: state === "subagent" ? [{ agentId: `sub_auto`, description: "Research task", slug: "research", inputTokens: 12000, outputTokens: 3000, cacheCreationTokens: 0, cacheReadTokens: 5000, model: s.metrics.model, toolCounts: { Read: 3, Grep: 2 }, messageCount: 8, isActive: true }] : [],
        },
      };
    }));
  }, []);

  // Mutate a specific field on the selected sandbox session
  const mutateSandboxSelected = useCallback((fn: (s: EnrichedSession) => EnrichedSession) => {
    setSandboxSessions((prev) => {
      const idx = sandboxSelectedIdx;
      if (idx < 0 || idx >= prev.length) return prev;
      return prev.map((s, i) => i === idx ? fn(s) : s);
    });
  }, [sandboxSelectedIdx]);

  // Cycle model on selected session
  const cycleSandboxModel = useCallback(() => {
    mutateSandboxSelected((s) => {
      const currentIdx = SANDBOX_MODELS.indexOf(s.metrics.model as typeof SANDBOX_MODELS[number]);
      const nextModel = SANDBOX_MODELS[(currentIdx + 1) % SANDBOX_MODELS.length];
      const modelDisplay = nextModel.includes("opus") ? "Opus 4.6" : nextModel.includes("haiku") ? "Haiku 4.5" : "Sonnet 4.6";
      const contextLimit = nextModel.includes("haiku") ? 200_000 : 1_000_000;
      return { ...s, metrics: { ...s.metrics, model: nextModel }, modelDisplayName: modelDisplay, contextLimit, contextUsagePercent: s.metrics.inputTokens / contextLimit };
    });
  }, [mutateSandboxSelected]);

  // Cycle source on selected session
  const cycleSandboxSource = useCallback(() => {
    mutateSandboxSelected((s) => {
      const currentIdx = SANDBOX_SOURCES.indexOf(s.info.source as typeof SANDBOX_SOURCES[number]);
      const nextSource = SANDBOX_SOURCES[(currentIdx + 1) % SANDBOX_SOURCES.length];
      const sourceDisplay = nextSource === "vscode" ? "VSCode" : nextSource === "cursor" ? "Cursor" : nextSource === "iterm" ? "iTerm" : "Terminal";
      return { ...s, info: { ...s.info, source: nextSource }, sourceDisplay };
    });
  }, [mutateSandboxSelected]);

  // Cycle git branch on selected session
  const cycleSandboxBranch = useCallback(() => {
    mutateSandboxSelected((s) => {
      const currentIdx = SANDBOX_BRANCHES.indexOf(s.metrics.gitBranch ?? "");
      const nextBranch = SANDBOX_BRANCHES[(currentIdx + 1) % SANDBOX_BRANCHES.length];
      return { ...s, metrics: { ...s.metrics, gitBranch: nextBranch } };
    });
  }, [mutateSandboxSelected]);

  // Adjust context usage: [ = -10%, ] = +10%
  const adjustSandboxContext = useCallback((delta: number) => {
    mutateSandboxSelected((s) => {
      const newPct = Math.max(0.01, Math.min(0.99, s.contextUsagePercent + delta));
      const newInput = Math.floor(newPct * s.contextLimit * 0.8);
      return { ...s, contextUsagePercent: newPct, metrics: { ...s.metrics, inputTokens: newInput, lastInputTokens: newInput } };
    });
  }, [mutateSandboxSelected]);

  // Toggle subagent count on selected
  const cycleSandboxSubagents = useCallback(() => {
    mutateSandboxSelected((s) => {
      const currentCount = s.metrics.subagents.length;
      const nextCount = (currentCount + 1) % 5; // 0, 1, 2, 3, 4
      const subagents = Array.from({ length: nextCount }, (_, i) => ({
        agentId: `sub_cycle_${i}`,
        description: ["Research task", "Code review", "Test runner", "Build validator"][i % 4],
        slug: ["research", "code-reviewer", "test-runner", "build-validator"][i % 4],
        inputTokens: Math.floor(Math.random() * 30000 + 5000),
        outputTokens: Math.floor(Math.random() * 8000 + 1000),
        cacheCreationTokens: 0,
        cacheReadTokens: Math.floor(Math.random() * 10000),
        model: s.metrics.model,
        toolCounts: { Read: Math.floor(Math.random() * 8 + 1), Grep: Math.floor(Math.random() * 4) },
        messageCount: Math.floor(Math.random() * 15 + 3),
        isActive: true,
      }));
      return { ...s, hasSubagents: nextCount > 0, metrics: { ...s.metrics, subagents } };
    });
  }, [mutateSandboxSelected]);

  // Cycle running tool on selected
  const cycleSandboxTool = useCallback(() => {
    mutateSandboxSelected((s) => {
      const allTools: Array<[string | undefined, string | undefined]> = [
        [undefined, undefined], // no tool
        ...SANDBOX_TOOLS_ACTIVE,
      ];
      const currentIdx = allTools.findIndex(([name, target]) =>
        (name ?? "") === (s.runningToolName ?? "") && (target ?? "") === (s.runningToolTarget ?? "")
      );
      const [nextName, nextTarget] = allTools[(currentIdx + 1) % allTools.length];
      return { ...s, runningToolName: nextName, runningToolTarget: nextTarget };
    });
  }, [mutateSandboxSelected]);

  // Randomize token metrics on selected
  const randomizeSandboxTokens = useCallback(() => {
    mutateSandboxSelected((s) => {
      const inputTokens = Math.floor(Math.random() * 800000 + 10000);
      const outputTokens = Math.floor(Math.random() * 80000 + 2000);
      return {
        ...s,
        metrics: { ...s.metrics, inputTokens, outputTokens, lastInputTokens: inputTokens, cacheReadTokens: Math.floor(Math.random() * 200000), cacheCreationTokens: Math.floor(Math.random() * 30000), messageCount: Math.floor(Math.random() * 100 + 5) },
        outputTokensPerSec: Math.random() * 30 + 3,
        contextUsagePercent: inputTokens / s.contextLimit,
      };
    });
  }, [mutateSandboxSelected]);

  // Cycle todo progress on selected
  const cycleSandboxTodos = useCallback(() => {
    mutateSandboxSelected((s) => {
      if (s.todoTotal === 0) return { ...s, todoTotal: 7, todoCompleted: 3 };
      if (s.todoCompleted < s.todoTotal) return { ...s, todoCompleted: s.todoCompleted + 1 };
      return { ...s, todoTotal: 0, todoCompleted: 0 };
    });
  }, [mutateSandboxSelected]);

  // Adjust duration on selected: + / - 5 minutes
  const adjustSandboxDuration = useCallback((delta: number) => {
    mutateSandboxSelected((s) => {
      const newDuration = Math.max(10, s.durationSecs + delta);
      return { ...s, durationSecs: newDuration, totalDurationSecs: newDuration, info: { ...s.info, startedAt: Date.now() / 1000 - newDuration } };
    });
  }, [mutateSandboxSelected]);

  // Toggle provider on selected
  const cycleSandboxProvider = useCallback(() => {
    mutateSandboxSelected((s) => {
      const providers = ["", "Bedrock", "Vertex"];
      const idx = providers.indexOf(s.provider);
      return { ...s, provider: providers[(idx + 1) % providers.length] };
    });
  }, [mutateSandboxSelected]);

  // Sandbox presets — pre-built scenes for common screenshot needs
  const SANDBOX_PRESETS: Array<{ key: string; label: string; description: string; build: () => EnrichedSession[] }> = [
    {
      key: "F1", label: "Full House", description: "8 sessions, all states",
      build: () => {
        sandboxCounterRef.current = 0;
        return SANDBOX_STATES.filter(s => s !== "ended").map((state, i) => {
          const extra = i === 0 ? makeSandboxSession("working", { title: "Building dashboard UI", workspace: "cue", branch: "main", contextPct: 0.61, durationSecs: 272, tokPerSec: 12.4, tool: ["Write", "src/components/Dashboard.tsx"] }) : null;
          return extra ?? makeSandboxSession(state);
        }).concat([makeSandboxSession("working", { title: "Running test suite", workspace: "api-server", branch: "feat/auth", contextPct: 0.29, tool: ["Bash", "pytest -x"] })]);
      },
    },
    {
      key: "F2", label: "All Working", description: "4 active sessions",
      build: () => {
        sandboxCounterRef.current = 0;
        return [
          makeSandboxSession("working", { title: "Implementing auth flow", workspace: "api-server", branch: "feat/auth", contextPct: 0.45, tool: ["Write", "src/auth/oauth.ts"] }),
          makeSandboxSession("working", { title: "Building UI components", workspace: "web-client", branch: "feat/dashboard", contextPct: 0.32, tool: ["Edit", "src/components/Card.tsx"] }),
          makeSandboxSession("subagent", { title: "Refactoring database layer", workspace: "ml-pipeline", branch: "dev", contextPct: 0.58, subagentCount: 2 }),
          makeSandboxSession("working", { title: "Writing documentation", workspace: "docs", branch: "main", contextPct: 0.15, tool: ["Write", "README.md"] }),
        ];
      },
    },
    {
      key: "F3", label: "Permission", description: "3 sessions, one waiting",
      build: () => {
        sandboxCounterRef.current = 0;
        return [
          makeSandboxSession("working", { title: "Fixing race condition", workspace: "cue", branch: "fix/bug-123", contextPct: 0.52, tool: ["Edit", "src-tauri/src/lib.rs"] }),
          makeSandboxSession("waiting", { title: "Installing dependencies", workspace: "web-client", branch: "main", contextPct: 0.22, tool: ["Bash", "npm install express"] }),
          makeSandboxSession("done", { title: "Unit tests passing", workspace: "api-server", branch: "feat/auth", contextPct: 0.67, tokPerSec: 0 }),
        ];
      },
    },
    {
      key: "F4", label: "Error", description: "Mixed with error state",
      build: () => {
        sandboxCounterRef.current = 0;
        return [
          makeSandboxSession("working", { title: "Building dashboard UI", workspace: "cue", branch: "main", contextPct: 0.38, tool: ["Write", "src/components/SessionCard.tsx"] }),
          makeSandboxSession("error", { title: "Type check failed", workspace: "web-client", branch: "feat/types", contextPct: 0.71 }),
          makeSandboxSession("subagent", { title: "Optimizing queries", workspace: "api-server", branch: "perf/db", contextPct: 0.44, subagentCount: 3 }),
          makeSandboxSession("idle", { title: "Waiting for input", workspace: "docs", branch: "main", contextPct: 0.12 }),
        ];
      },
    },
    {
      key: "F5", label: "Screenshot", description: "Picture-perfect hero shot",
      build: () => {
        sandboxCounterRef.current = 0;
        return [
          makeSandboxSession("working", { title: "Building auth middleware", workspace: "api-server", model: "claude-opus-4-6", branch: "feat/auth", contextPct: 0.61, durationSecs: 272, tokPerSec: 14.2, tool: ["Write", "src/middleware/auth.ts"], todoTotal: 7, todoCompleted: 3 }),
          makeSandboxSession("subagent", { title: "Running test suite", workspace: "cue", model: "claude-sonnet-4-6", branch: "main", contextPct: 0.29, durationSecs: 728, subagentCount: 2, todoTotal: 15, todoCompleted: 11 }),
          makeSandboxSession("waiting", { title: "Database migration", workspace: "ml-pipeline", model: "claude-sonnet-4-6", branch: "dev", contextPct: 0.45, durationSecs: 156, tool: ["Bash", "prisma migrate deploy"] }),
          makeSandboxSession("done", { title: "Documentation complete", workspace: "docs", model: "claude-haiku-4-5-20251001", branch: "main", contextPct: 0.82, durationSecs: 540, tokPerSec: 0, todoTotal: 5, todoCompleted: 5 }),
          makeSandboxSession("working", { title: "Optimizing bundle size", workspace: "web-client", model: "claude-opus-4-6", branch: "perf/bundle", contextPct: 0.37, durationSecs: 95, tokPerSec: 18.7, tool: ["Edit", "vite.config.ts"] }),
          makeSandboxSession("idle", { title: "Awaiting review", workspace: "infra", model: "claude-sonnet-4-6", branch: "feat/deploy", contextPct: 0.19, durationSecs: 1200 }),
        ];
      },
    },
  ];


  // Load a sandbox preset. F5 (Screenshot) hides chrome, captures, then restores.
  const loadSandboxPreset = useCallback((preset: typeof SANDBOX_PRESETS[number]) => {
    const sessions = preset.build();
    setSandboxSessions(sessions);
    setSandboxSelectedIdx(0);

    if (preset.key === "F5") {
      // Wait 2 frames for sessions to render, then capture
      setScreenshotMode(true);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        invoke<string>("take_window_screenshot")
          .then((path) => {
            setScreenshotSaved(path.replace(/.*\//, "")); // show filename only
            setTimeout(() => setScreenshotSaved(null), 3000);
          })
          .catch((err) => {
            setScreenshotSaved(`Error: ${err}`);
            setTimeout(() => setScreenshotSaved(null), 3000);
          })
          .finally(() => setScreenshotMode(false));
      }));
    }

  }, []);

  // Keyboard handler for sandbox mode
  useEffect(() => {
    if (!testMode) return;

    const handleKey = (e: KeyboardEvent) => {
      // Don't intercept when editing title
      if (sandboxEditingTitle) return;
      // Don't intercept when typing in an input/textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      const key = e.key;
      const shift = e.shiftKey;

      // Number keys 1-8: add session or set state on slot
      if (key >= "1" && key <= "8") {
        const slotIdx = parseInt(key) - 1;
        if (shift) {
          // Shift+N: remove session at slot
          setSandboxSessions((prev) => {
            if (slotIdx >= prev.length) return prev;
            const next = prev.filter((_, i) => i !== slotIdx);
            setSandboxSelectedIdx((idx) => Math.min(idx, next.length - 1));
            return next;
          });
        } else {
          // N: if slot doesn't exist, add new session. If exists, select it.
          setSandboxSessions((prev) => {
            if (slotIdx >= prev.length) {
              const newSession = makeSandboxSession("idle");
              setSandboxSelectedIdx(prev.length);
              return [...prev, newSession];
            }
            setSandboxSelectedIdx(slotIdx);
            return prev;
          });
        }
        e.preventDefault();
        return;
      }

      // 0: clear all
      if (key === "0") {
        setSandboxSessions([]);
        setSandboxSelectedIdx(-1);
        e.preventDefault();
        return;
      }

      // Tab / Shift+Tab: cycle selection
      if (key === "Tab") {
        e.preventDefault();
        setSandboxSessions((prev) => {
          if (prev.length === 0) return prev;
          setSandboxSelectedIdx((idx) => {
            if (shift) return idx <= 0 ? prev.length - 1 : idx - 1;
            return (idx + 1) % prev.length;
          });
          return prev;
        });
        return;
      }

      // State keys (operate on selected, or all with Shift)
      const stateKey = Object.entries(SANDBOX_STATE_META).find(([, m]) => m.key.toLowerCase() === key.toLowerCase());
      if (stateKey) {
        const [state] = stateKey;
        e.preventDefault();
        if (shift) {
          setAllSandboxState(state);
        } else if (sandboxSelectedIdx >= 0) {
          setSandboxSessions((prev) => {
            if (sandboxSelectedIdx >= prev.length) return prev;
            const id = prev[sandboxSelectedIdx].info.id;
            const meta = SANDBOX_STATE_META[state] ?? SANDBOX_STATE_META.idle;
            const tool = state === "working" ? SANDBOX_TOOLS_ACTIVE[Math.floor(Math.random() * SANDBOX_TOOLS_ACTIVE.length)] : null;
            return prev.map((s) =>
              s.info.id === id ? {
                ...s,
                info: { ...s.info, state, lastActivity: Date.now() / 1000 },
                stateIcon: meta.icon,
                stateDisplayName: meta.display,
                hasSubagents: state === "subagent" ? true : (state === "working" ? false : s.hasSubagents),
                outputTokensPerSec: (state === "working" || state === "subagent") ? Math.random() * 25 + 5 : 0,
                runningToolName: tool ? tool[0] : (state === "working" ? s.runningToolName : undefined),
                runningToolTarget: tool ? tool[1] : (state === "working" ? s.runningToolTarget : undefined),
                metrics: {
                  ...s.metrics,
                  subagents: state === "subagent" ? (s.metrics.subagents.length > 0 ? s.metrics.subagents : [{ agentId: `sub_auto_1`, description: "Research task", slug: "research", inputTokens: 12000, outputTokens: 3000, cacheCreationTokens: 0, cacheReadTokens: 5000, model: s.metrics.model, toolCounts: { Read: 3, Grep: 2 }, messageCount: 8, isActive: true }]) : (state === "working" ? [] : s.metrics.subagents),
                },
              } : s,
            );
          });
        }
        return;
      }

      // Property keys (selected session)
      if (sandboxSelectedIdx >= 0) {
        switch (key.toLowerCase()) {
          case "m": cycleSandboxModel(); e.preventDefault(); return;
          case "s": cycleSandboxSource(); e.preventDefault(); return;
          case "b": cycleSandboxBranch(); e.preventDefault(); return;
          case "t": randomizeSandboxTokens(); e.preventDefault(); return;
          case "r": cycleSandboxSubagents(); e.preventDefault(); return;
          case "o": cycleSandboxTodos(); e.preventDefault(); return;
          case "l": cycleSandboxTool(); e.preventDefault(); return;
          case "v": cycleSandboxProvider(); e.preventDefault(); return;
          case "[": adjustSandboxContext(-0.1); e.preventDefault(); return;
          case "]": adjustSandboxContext(0.1); e.preventDefault(); return;
          case "-": adjustSandboxDuration(-300); e.preventDefault(); return;
          case "=": adjustSandboxDuration(300); e.preventDefault(); return;
          case "n":
            setSandboxEditingTitle(true);
            e.preventDefault();
            setTimeout(() => sandboxTitleInputRef.current?.focus(), 50);
            return;
        }
      }

      // F-key presets
      const presetMatch = SANDBOX_PRESETS.find((p) => p.key === key);
      if (presetMatch) {
        loadSandboxPreset(presetMatch);
        e.preventDefault();
        return;
      }

      // ? or / — toggle help
      if (key === "?" || key === "/") {
        setSandboxShowHelp((v) => !v);
        e.preventDefault();
        return;
      }

      // Escape — close help or deselect
      if (key === "Escape") {
        if (sandboxShowHelp) setSandboxShowHelp(false);
        else setSandboxSelectedIdx(-1);
        e.preventDefault();
        return;
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [testMode, sandboxSelectedIdx, sandboxEditingTitle, makeSandboxSession, setAllSandboxState, cycleSandboxModel, cycleSandboxSource, cycleSandboxBranch, randomizeSandboxTokens, cycleSandboxSubagents, cycleSandboxTodos, cycleSandboxTool, cycleSandboxProvider, adjustSandboxContext, adjustSandboxDuration, loadSandboxPreset]);

  // ---------------------------------------------------------------------------
  // Auto-reorder: two-tier sorting system.
  //
  // IMMEDIATE: When a session becomes active (working/thinking/waiting/error/
  // subagent/compacting), it bubbles above all "settled" sessions (idle/done
  // for 5+ seconds). Active sessions keep their relative order. Settled
  // sessions keep their relative order. Only the active↔settled boundary moves.
  //
  // DEFERRED: When ALL sessions have been idle/done for 5+ seconds, a full
  // priority sort runs (waiting > error > working > idle) with FLIP animation.
  // ---------------------------------------------------------------------------

  const SETTLE_MS = 5000;

  // The "desired" fully-sorted order (used by the deferred full rearrange)
  const reorderPriority = useCallback((s: EnrichedSession) => {
    const st = s.info.state;
    if (st === "waiting") return 0;
    if (st === "error") return 1;
    if (st === "working" || st === "subagent") return 2;
    return 3;
  }, []);

  // Track the committed display order (list of session IDs).
  // This only changes when a reorder animation is triggered.
  const committedOrderRef = useRef<string[]>([]);
  const quiesceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAnimatingRef = useRef(false);
  const animationGenRef = useRef(0); // incremented each animation; stale chains check this
  const isQuiescenceReorderRef = useRef(false);
  // Sessions spawned within the last 300ms — forced to bottom until timer fires
  const newSpawnsRef = useRef<Map<string, number>>(new Map());
  const newSpawnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Per-session "settled since" timestamps. A session is "settled" when it
  // has been idle/done for ≥ SETTLE_MS. Active sessions are removed from this map.
  const settledSinceRef = useRef<Map<string, number>>(new Map());

  const isQuiescent = useCallback((st: string) => st === "idle" || st === "done", []);

  // Check whether ALL sessions are settled (idle/done for 5s+)
  const allSettled = useCallback((list: EnrichedSession[], now: number) => {
    return list.every((s) => {
      if (!isQuiescent(s.info.state)) return false;
      const since = settledSinceRef.current.get(s.info.id);
      return since !== undefined && (now - since) >= SETTLE_MS;
    });
  }, [isQuiescent]);

  // Build the active (non-ended) session list
  const activeSessions = sessions.filter((s) => s.info.state !== "ended");

  // Update settled-since timestamps
  const now = Date.now();
  for (const s of activeSessions) {
    if (isQuiescent(s.info.state)) {
      // Record when it first became idle/done (if not already tracked)
      if (!settledSinceRef.current.has(s.info.id)) {
        settledSinceRef.current.set(s.info.id, now);
      }
    } else {
      // Active — clear any settled timestamp
      settledSinceRef.current.delete(s.info.id);
    }
  }
  // Prune sessions that no longer exist
  const activeIdSet = new Set(activeSessions.map((s) => s.info.id));
  for (const id of settledSinceRef.current.keys()) {
    if (!activeIdSet.has(id)) settledSinceRef.current.delete(id);
  }

  // Compute fully-sorted desired order (for deferred full rearrange)
  const desiredOrder = (() => {
    const all = [...activeSessions];
    if (autoReorder) {
      all.sort((a, b) => {
        const pa = reorderPriority(a);
        const pb = reorderPriority(b);
        if (pa !== pb) return pa - pb;
        return b.info.lastActivity - a.info.lastActivity;
      });
    } else {
      all.sort((a, b) => a.info.startedAt - b.info.startedAt);
    }
    return all.map((s) => s.info.id);
  })();

  // The actual display order: partitions committed order into
  // non-settled (top) and settled (bottom), preserving relative order within each.
  const sortedSessions = (() => {
    if (!autoReorder) {
      const sorted = [...activeSessions].sort((a, b) => a.info.startedAt - b.info.startedAt);
      committedOrderRef.current = sorted.map((s) => s.info.id);
      return sorted;
    }

    const committed = committedOrderRef.current;
    const sessionMap = new Map(activeSessions.map((s) => [s.info.id, s]));

    // Bootstrap if no committed order yet
    if (committed.length === 0 || !committed.some((id) => activeIdSet.has(id))) {
      committedOrderRef.current = desiredOrder;
      return desiredOrder.map((id) => sessionMap.get(id)!).filter(Boolean);
    }

    // Build ordered list from committed, adding new sessions
    const ordered: EnrichedSession[] = [];
    const used = new Set<string>();
    const justSpawned: EnrichedSession[] = [];
    for (const id of committed) {
      if (sessionMap.has(id)) {
        ordered.push(sessionMap.get(id)!);
        used.add(id);
      }
    }
    for (const id of desiredOrder) {
      if (!used.has(id) && sessionMap.has(id)) {
        const s = sessionMap.get(id)!;
        // Track newly seen sessions — hold at bottom for 300ms
        if (!newSpawnsRef.current.has(id)) {
          newSpawnsRef.current.set(id, now);
        }
        ordered.push(s);
      }
    }

    // Partition: newly spawned (bottom), non-settled (top), settled (middle)
    const nonSettled: EnrichedSession[] = [];
    const settled: EnrichedSession[] = [];
    for (const s of ordered) {
      const spawnTime = newSpawnsRef.current.get(s.info.id);
      if (spawnTime !== undefined && now - spawnTime < 300) {
        justSpawned.push(s);
        continue;
      }
      // Clear expired spawn tracking
      if (spawnTime !== undefined) {
        newSpawnsRef.current.delete(s.info.id);
      }
      const since = settledSinceRef.current.get(s.info.id);
      const isSettled = since !== undefined && (now - since) >= SETTLE_MS;
      if (isSettled) {
        settled.push(s);
      } else {
        nonSettled.push(s);
      }
    }

    // Schedule reorder after spawn hold expires — reschedule to latest expiry
    // so all spawned sessions are released together.
    if (justSpawned.length > 0) {
      const latestSpawn = Math.max(
        ...justSpawned.map((s) => newSpawnsRef.current.get(s.info.id) ?? 0),
      );
      const remaining = Math.max(50, latestSpawn + 320 - now);
      if (newSpawnTimerRef.current) clearTimeout(newSpawnTimerRef.current);
      newSpawnTimerRef.current = setTimeout(() => {
        newSpawnTimerRef.current = null;
        if (!isAnimatingRef.current) {
          setReorderTick((t) => t + 1);
        }
      }, remaining);
    }

    const result = [...nonSettled, ...settled, ...justSpawned];
    // Don't overwrite committed order during an in-flight animation —
    // the animation owns the position snapshot and will update on completion.
    if (!isAnimatingRef.current) {
      committedOrderRef.current = result.map((s) => s.info.id);
    }
    return result;
  })();

  // Keep refs to latest values so the timer callback can re-check
  const activeSessionsRef = useRef(activeSessions);
  activeSessionsRef.current = activeSessions;
  const desiredOrderRef = useRef(desiredOrder);
  desiredOrderRef.current = desiredOrder;

  // Quiescence timer: when ALL sessions have been settled for 5s,
  // do the full priority rearrange.
  useEffect(() => {
    if (!autoReorder) {
      if (quiesceTimerRef.current) {
        clearTimeout(quiesceTimerRef.current);
        quiesceTimerRef.current = null;
      }
      return;
    }

    const currentOrderKey = sortedSessions.map((s) => s.info.id).join(",");
    const desiredOrderKey = desiredOrder.join(",");
    const orderAlreadyCorrect = currentOrderKey === desiredOrderKey;

    if (allSettled(activeSessions, now) && !orderAlreadyCorrect && !isAnimatingRef.current) {
      // All settled and order differs — start countdown for full rearrange
      if (!quiesceTimerRef.current) {
        quiesceTimerRef.current = setTimeout(() => {
          quiesceTimerRef.current = null;
          if (isAnimatingRef.current) return; // don't fire into a live animation
          const fireTime = Date.now();
          if (!allSettled(activeSessionsRef.current, fireTime)) return;
          committedOrderRef.current = desiredOrderRef.current;
          isQuiescenceReorderRef.current = true;
          setReorderTick((t) => t + 1);
        }, 1000); // short delay — sessions are already 5s settled, just debounce
      }
    } else {
      if (quiesceTimerRef.current) {
        clearTimeout(quiesceTimerRef.current);
        quiesceTimerRef.current = null;
      }
    }
  });

  // State to force re-render when committed order changes via timer
  const [reorderTick, setReorderTick] = useState(0);

  // Keys for FLIP animation tracking
  const sortKey = sortedSessions.map((s) => s.info.id).join(",");

  // FLIP animation — smooth mechanical reorder
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !autoReorder) return;

    // Don't start a new animation while one is in flight — the current
    // animation owns cardPositions and will snapshot on completion.
    // The next render after it finishes will pick up any pending changes.
    if (isAnimatingRef.current) return;

    const prev = cardPositions.current;
    if (prev.size === 0) {
      // First render — just snapshot positions
      const cards = list.querySelectorAll<HTMLElement>("[data-session-id]");
      const positions = new Map<string, DOMRect>();
      cards.forEach((el) => {
        const id = el.dataset.sessionId!;
        positions.set(id, el.getBoundingClientRect());
      });
      cardPositions.current = positions;
      return;
    }

    const cards = list.querySelectorAll<HTMLElement>("[data-session-id]");
    const movers: {
      el: HTMLElement;
      dy: number;
      idx: number;
      domTop: number;
      height: number;
    }[] = [];

    cards.forEach((el, idx) => {
      const id = el.dataset.sessionId!;
      const oldRect = prev.get(id);
      if (!oldRect) return;
      const newRect = el.getBoundingClientRect();
      const dy = oldRect.top - newRect.top;
      if (Math.abs(dy) < 1) return;
      movers.push({
        el,
        dy,
        idx,
        domTop: newRect.top,
        height: newRect.height,
      });
    });

    if (movers.length === 0) {
      // No movement — just snapshot and clear any stale flags
      const allCards = list.querySelectorAll<HTMLElement>("[data-session-id]");
      const positions = new Map<string, DOMRect>();
      allCards.forEach((el) => {
        const id = el.dataset.sessionId!;
        positions.set(id, el.getBoundingClientRect());
      });
      cardPositions.current = positions;
      isQuiescenceReorderRef.current = false;
      isAnimatingRef.current = false; // safety: clear stuck flag
      return;
    }

    isAnimatingRef.current = true;
    const gen = ++animationGenRef.current; // cancellation token

    // ─── Unified WAAPI FLIP animation ───
    // All cards animate simultaneously from old position to new.
    // The hero (biggest upward mover) ducks under with brightness + scale.
    // Pure WAAPI — no CSS transitions, no transitionend, no setTimeout chains.

    isQuiescenceReorderRef.current = false;

    const DURATION = 500; // ms — all cards move together
    const EASING = "cubic-bezier(0.2, 0, 0, 1)"; // Material standard

    // Identify hero: biggest upward mover (or biggest mover if none go up)
    const upwardMovers = movers.filter((m) => m.dy < 0);
    const hero =
      upwardMovers.length > 0
        ? upwardMovers.reduce((a, b) =>
            Math.abs(b.dy) > Math.abs(a.dy) ? b : a,
          )
        : movers.reduce((a, b) =>
            Math.abs(b.dy) > Math.abs(a.dy) ? b : a,
          );

    // Set up z-index so hero ducks under other cards
    const isLight = document.documentElement.dataset.theme === "light";
    const duckBrightness = isLight ? 0.82 : 0.55;
    cards.forEach((el) => {
      el.style.position = "relative";
      el.style.zIndex = "2";
    });
    hero.el.style.zIndex = "1";

    // Track running animations for cleanup
    const animations: Animation[] = [];

    // Animate every mover with WAAPI
    for (const { el, dy } of movers) {
      if (!el.isConnected || Math.abs(dy) < 1) continue;

      const anim = el.animate(
        [
          { transform: `translateY(${dy}px)` },
          { transform: "translateY(0)" },
        ],
        { duration: DURATION, easing: EASING },
      );
      animations.push(anim);
    }

    // Hero duck effect: darken + slight scale through the middle, surface at end
    const heroCard = hero.el.querySelector<HTMLElement>(".session-card");
    if (heroCard) {
      const duckAnim = heroCard.animate(
        [
          { filter: "brightness(1)", transform: "scale(1)" },
          { filter: `brightness(${duckBrightness})`, transform: "scale(0.97)", offset: 0.15 },
          { filter: `brightness(${duckBrightness})`, transform: "scale(0.97)", offset: 0.75 },
          { filter: "brightness(1)", transform: "scale(1)" },
        ],
        { duration: DURATION, easing: EASING },
      );
      animations.push(duckAnim);
    }

    // Snapshot and clean up when all animations finish
    Promise.all(animations.map((a) => a.finished)).then(() => {
      if (animationGenRef.current !== gen) return;
      isAnimatingRef.current = false;
      const allCards = list.querySelectorAll<HTMLElement>("[data-session-id]");
      const positions = new Map<string, DOMRect>();
      const ids: string[] = [];
      allCards.forEach((c) => {
        const cid = c.dataset.sessionId!;
        positions.set(cid, c.getBoundingClientRect());
        ids.push(cid);
        c.style.zIndex = "";
        c.style.position = "";
      });
      cardPositions.current = positions;
      committedOrderRef.current = ids;
      setReorderTick((t) => t + 1);
    }).catch(() => {
      // Animation cancelled (new reorder started) — just clear flag
      if (animationGenRef.current === gen) {
        isAnimatingRef.current = false;
      }
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortKey, autoReorder, reorderTick]);

  // Keyboard animation handler — listens for Tauri events from keyboard window
  useEffect(() => {
    const handler = (payload: { animation: string }) => {
      const list = listRef.current;
      if (!list) return;
      const { animation } = payload;
      // All cards in the list (for connect/disconnect)
      const allCards = Array.from(list.querySelectorAll<HTMLElement>("[data-session-state]"))
        .map((wrapper) => wrapper.querySelector<HTMLElement>(".session-card"))
        .filter((el): el is HTMLElement => el !== null);
      // Only idle/done sessions — skip working/subagent/waiting (for key animations)
      const cards = Array.from(list.querySelectorAll<HTMLElement>("[data-session-state]"))
        .filter((wrapper) => {
          const state = wrapper.dataset.sessionState;
          return state !== "working" && state !== "subagent" && state !== "waiting";
        })
        .map((wrapper) => wrapper.querySelector<HTMLElement>(".session-card"))
        .filter((el): el is HTMLElement => el !== null);
      if (allCards.length === 0) return;

      const press = (el: HTMLElement) => {
        el.classList.remove("session-card--floating");
        el.classList.add("session-card--pressed");
      };
      const release = (el: HTMLElement) => {
        el.classList.remove("session-card--pressed");
        el.classList.add("session-card--floating");
      };
      const toggle = (el: HTMLElement, delay: number) => {
        setTimeout(() => {
          press(el);
          setTimeout(() => release(el), 400);
        }, delay);
      };

      switch (animation) {
        case "tap":
          cards.forEach(press);
          setTimeout(() => cards.forEach(release), 400);
          break;
        case "all-press":
          cards.forEach(press);
          break;
        case "all-release":
          cards.forEach(release);
          break;
        case "random-keys": {
          const count = Math.max(3, Math.ceil(cards.length * 0.6));
          for (let i = 0; i < count; i++) {
            const idx = Math.floor(Math.random() * cards.length);
            toggle(cards[idx], Math.random() * 800);
          }
          break;
        }
        case "chord-ripple":
          cards.forEach((el, i) => toggle(el, i * 80));
          break;
        case "wave-left":
          cards.forEach((el, i) => toggle(el, i * 120));
          break;
        case "wave-right":
          [...cards].reverse().forEach((el, i) => toggle(el, i * 120));
          break;
        case "alternating":
          cards.forEach((el, i) => {
            if (i % 2 === 0) toggle(el, 0);
            else toggle(el, 300);
          });
          break;
        case "cascade-down":
          cards.forEach((el, i) => {
            const delay = i * 150;
            setTimeout(() => {
              press(el);
              // Each card stays pressed longer than the last
              setTimeout(() => release(el), 300 + i * 100);
            }, delay);
          });
          break;
        case "heartbeat":
          // Two quick beats
          cards.forEach((el) => {
            toggle(el, 0);
            toggle(el, 500);
          });
          break;
        case "connect":
          // Override only idle/done/ended sessions to "working" → triggers cord deploy
          // Sessions already working/subagent/waiting/error are left alone
          setSandboxSessions((prev) => {
            const meta = SANDBOX_STATE_META.working;
            return prev.map((s) => {
              const st = s.info.state;
              if (st === "working" || st === "subagent" || st === "waiting") return s;
              return {
                ...s,
                info: { ...s.info, state: "working", lastActivity: Date.now() / 1000 },
                stateIcon: meta.icon,
                stateDisplayName: meta.display,
              };
            });
          });
          setStateOverrides((prev) => {
            const next = { ...prev };
            sessionsRef.current.forEach((s) => {
              const st = s.info.state;
              if (st !== "working" && st !== "subagent" && st !== "waiting") {
                next[s.info.id] = "working";
              }
            });
            return next;
          });
          break;
        case "disconnect":
          // Revert overridden sessions back to their real state (clear overrides)
          // In sandbox, revert only sessions that connect changed (working → idle)
          setSandboxSessions((prev) => {
            const meta = SANDBOX_STATE_META.idle;
            return prev.map((s) => {
              // Only revert sessions that were set to working by connect
              // (real working/subagent sessions shouldn't be touched)
              if (s.info.state !== "working") return s;
              return {
                ...s,
                info: { ...s.info, state: "idle", lastActivity: Date.now() / 1000 },
                stateIcon: meta.icon,
                stateDisplayName: meta.display,
              };
            });
          });
          setStateOverrides({});
          break;
      }
    };

    let unlisten: (() => void) | undefined;
    listen<{ animation: string }>("keyboard-animation", (event) => {
      handler(event.payload);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Helper to update a setting and persist immediately


  // State button color mapping for sandbox controls
  const SANDBOX_STATE_COLORS: Record<string, string> = {
    working: "bg-white/15 text-white/80 hover:bg-white/25",
    thinking: "bg-orange-400/20 text-orange-400 hover:bg-orange-400/30",
    waiting: "bg-yellow-400/20 text-yellow-400 hover:bg-yellow-400/30",
    error: "bg-red-500/20 text-red-500 hover:bg-red-500/30",
    subagent: "bg-blue-400/20 text-blue-400 hover:bg-blue-400/30",
    idle: "bg-gray-500/20 text-gray-400 hover:bg-gray-500/30",
    done: "bg-green-500/20 text-green-500 hover:bg-green-500/30",
    ended: "bg-red-400/20 text-red-400 hover:bg-red-400/30",
  };

  // ---------------------------------------------------------------------------
  // Sandbox mode render
  // ---------------------------------------------------------------------------
  if (testMode) {
    // Sort sandbox sessions the same way as real sessions
    const sortedSandbox = (() => {
      const all = [...sandboxSessions];
      if (autoReorder) {
        return all.sort((a, b) => {
          const pa = reorderPriority(a);
          const pb = reorderPriority(b);
          if (pa !== pb) return pa - pb;
          return b.info.lastActivity - a.info.lastActivity;
        });
      }
      return all.sort((a, b) => a.info.startedAt - b.info.startedAt);
    })();


    // Map sorted sessions back to their original indices for selection highlighting
    const selectedId = sandboxSelectedIdx >= 0 && sandboxSelectedIdx < sandboxSessions.length
      ? sandboxSessions[sandboxSelectedIdx].info.id
      : null;

    return (
      <div className="flex flex-col flex-1 min-h-0 relative">
        {/* Screenshot saved toast */}
        {screenshotSaved && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 rounded-lg bg-black/80 text-white/80 text-xs font-mono backdrop-blur-sm pointer-events-none">
            📸 {screenshotSaved}
          </div>
        )}
        {/* Sandbox header — hidden in screenshot mode */}
        <div className={`flex items-center gap-3 px-4 py-2 bg-amber-500/8 border-b border-amber-500/20 ${screenshotMode ? "hidden" : ""}`}>
          <span className="text-xs font-semibold text-amber-400/90 uppercase tracking-wider">Sandbox</span>
          <span className="text-xs text-white/30">|</span>
          <span className="text-xs text-white/40">{sandboxSessions.length} session{sandboxSessions.length !== 1 ? "s" : ""}</span>
          {selectedId && (
            <>
              <span className="text-xs text-white/30">|</span>
              <span className="text-xs text-amber-400/70">
                #{sandboxSelectedIdx + 1} selected
              </span>
            </>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {/* Preset buttons */}
            {SANDBOX_PRESETS.map((preset) => (
              <button
                key={preset.key}
                onClick={() => loadSandboxPreset(preset)}
                title={`${preset.label}: ${preset.description}`}
                className="px-2 py-0.5 rounded text-[0.6rem] font-medium bg-amber-500/15 text-amber-400/70 hover:bg-amber-500/25 hover:text-amber-400 transition-colors"
              >
                {preset.key}
              </button>
            ))}
            <span className="text-white/10 mx-0.5">|</span>
            <button
              onClick={() => addSandboxSession("idle")}
              className="px-2 py-0.5 rounded text-[0.6rem] font-medium bg-white/10 text-white/70 hover:bg-white/20 hover:text-white transition-colors"
            >
              +
            </button>
            {sandboxSessions.length > 0 && (
              <button
                onClick={() => { setSandboxSessions([]); setSandboxSelectedIdx(-1); }}
                className="px-2 py-0.5 rounded text-[0.6rem] font-medium bg-red-500/15 text-red-400/50 hover:bg-red-500/25 hover:text-red-400 transition-colors"
              >
                Clear
              </button>
            )}
            {sandboxSessions.length > 1 && (
              <button
                onClick={() => {
                  setSandboxSessions((prev) => {
                    const sorted = [...prev].sort((a, b) => {
                      const pa = reorderPriority(a);
                      const pb = reorderPriority(b);
                      if (pa !== pb) return pa - pb;
                      return b.info.lastActivity - a.info.lastActivity;
                    });
                    return sorted;
                  });
                }}
                title="Sort by priority (waiting > error > working > idle)"
                className="px-2 py-0.5 rounded text-[0.6rem] font-medium bg-blue-500/15 text-blue-400/50 hover:bg-blue-500/25 hover:text-blue-400 transition-colors"
              >
                Sort
              </button>
            )}
            <button
              onClick={() => setSandboxShowHelp((v) => !v)}
              className={`px-2 py-0.5 rounded text-[0.6rem] font-medium transition-colors ${sandboxShowHelp ? "bg-amber-500/30 text-amber-300" : "bg-white/10 text-white/50 hover:text-white/70"}`}
            >
              ?
            </button>
          </div>
        </div>

        {/* Inline title editor */}
        {sandboxEditingTitle && sandboxSelectedIdx >= 0 && sandboxSelectedIdx < sandboxSessions.length && (
          <div className="flex items-center gap-2 px-4 py-1.5 bg-amber-500/10 border-b border-amber-500/15">
            <span className="text-[0.6rem] text-amber-400/60 uppercase tracking-wider">Title:</span>
            <input
              ref={sandboxTitleInputRef}
              type="text"
              defaultValue={sandboxSessions[sandboxSelectedIdx].displayTitle}
              className="flex-1 bg-transparent text-xs text-white/90 outline-none border-b border-amber-400/30 focus:border-amber-400/60 py-0.5"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const val = (e.target as HTMLInputElement).value;
                  mutateSandboxSelected((s) => ({ ...s, displayTitle: val, metrics: { ...s.metrics, customTitle: val } }));
                  setSandboxEditingTitle(false);
                } else if (e.key === "Escape") {
                  setSandboxEditingTitle(false);
                }
              }}
              onBlur={(e) => {
                const val = e.target.value;
                mutateSandboxSelected((s) => ({ ...s, displayTitle: val, metrics: { ...s.metrics, customTitle: val } }));
                setSandboxEditingTitle(false);
              }}
            />
          </div>
        )}

        {/* Batch state controls — hidden in screenshot mode */}
        {sandboxSessions.length > 0 && !screenshotMode && (
          <div className="flex items-center gap-1 px-4 py-1.5 bg-white/3 border-b border-white/5">
            <span className="text-[0.55rem] text-white/25 mr-1 uppercase tracking-wider shrink-0">All:</span>
            {SANDBOX_STATES.map((st) => (
              <button
                key={st}
                onClick={() => setAllSandboxState(st)}
                className={`px-1.5 py-0.5 rounded text-[0.55rem] font-medium transition-colors ${SANDBOX_STATE_COLORS[st]}`}
              >
                {SANDBOX_STATE_META[st].display}
              </button>
            ))}
          </div>
        )}

        {/* Help overlay */}
        {sandboxShowHelp && (
          <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-sm overflow-y-auto p-6" onClick={() => setSandboxShowHelp(false)}>
            <div className="max-w-lg mx-auto" onClick={(e) => e.stopPropagation()}>
              <div className="text-sm font-semibold text-amber-400 mb-4 uppercase tracking-wider">Sandbox Keyboard Controls</div>

              <div className="space-y-4 text-[0.7rem]">
                <div>
                  <div className="text-white/50 uppercase tracking-wider text-[0.6rem] mb-1.5">Sessions</div>
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    <kbd className="text-amber-400/90 font-mono">1-8</kbd><span className="text-white/60">Select / add session at slot</span>
                    <kbd className="text-amber-400/90 font-mono">Shift+1-8</kbd><span className="text-white/60">Remove session at slot</span>
                    <kbd className="text-amber-400/90 font-mono">Tab</kbd><span className="text-white/60">Cycle selection forward</span>
                    <kbd className="text-amber-400/90 font-mono">Shift+Tab</kbd><span className="text-white/60">Cycle selection backward</span>
                    <kbd className="text-amber-400/90 font-mono">0</kbd><span className="text-white/60">Clear all sessions</span>
                    <kbd className="text-amber-400/90 font-mono">Esc</kbd><span className="text-white/60">Deselect / close help</span>
                  </div>
                </div>

                <div>
                  <div className="text-white/50 uppercase tracking-wider text-[0.6rem] mb-1.5">State (selected, or Shift = all)</div>
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    {SANDBOX_STATES.map((st) => (
                      <div key={st} className="contents"><kbd className="text-amber-400/90 font-mono">{SANDBOX_STATE_META[st].key}</kbd><span className="text-white/60">{SANDBOX_STATE_META[st].display}</span></div>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-white/50 uppercase tracking-wider text-[0.6rem] mb-1.5">Properties (selected session)</div>
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    <kbd className="text-amber-400/90 font-mono">N</kbd><span className="text-white/60">Edit title</span>
                    <kbd className="text-amber-400/90 font-mono">M</kbd><span className="text-white/60">Cycle model (Opus / Sonnet / Haiku)</span>
                    <kbd className="text-amber-400/90 font-mono">S</kbd><span className="text-white/60">Cycle source (Terminal / VSCode / Cursor / iTerm)</span>
                    <kbd className="text-amber-400/90 font-mono">B</kbd><span className="text-white/60">Cycle git branch</span>
                    <kbd className="text-amber-400/90 font-mono">L</kbd><span className="text-white/60">Cycle running tool</span>
                    <kbd className="text-amber-400/90 font-mono">T</kbd><span className="text-white/60">Randomize token metrics</span>
                    <kbd className="text-amber-400/90 font-mono">R</kbd><span className="text-white/60">Cycle subagent count (0-4)</span>
                    <kbd className="text-amber-400/90 font-mono">O</kbd><span className="text-white/60">Cycle todo progress</span>
                    <kbd className="text-amber-400/90 font-mono">V</kbd><span className="text-white/60">Cycle provider (API / Bedrock / Vertex)</span>
                    <kbd className="text-amber-400/90 font-mono">[ / ]</kbd><span className="text-white/60">Context usage -10% / +10%</span>
                    <kbd className="text-amber-400/90 font-mono">- / =</kbd><span className="text-white/60">Duration -5m / +5m</span>
                  </div>
                </div>

                <div>
                  <div className="text-white/50 uppercase tracking-wider text-[0.6rem] mb-1.5">Presets</div>
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    {SANDBOX_PRESETS.map((preset) => (
                      <div key={preset.key} className="contents"><kbd className="text-amber-400/90 font-mono">{preset.key}</kbd><span className="text-white/60">{preset.label} — {preset.description}</span></div>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-white/50 uppercase tracking-wider text-[0.6rem] mb-1.5">Help</div>
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    <kbd className="text-amber-400/90 font-mono">?</kbd><span className="text-white/60">Toggle this help panel</span>
                  </div>
                </div>
              </div>

              <div className="mt-6 pt-4 border-t border-white/10 text-[0.6rem] text-white/30">
                Press any key to close, or click outside. All keyboard controls only active in sandbox mode.
              </div>
            </div>
          </div>
        )}

        {/* Sandbox sessions or empty state */}
        {sandboxSessions.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-white/40 gap-3">
            <span className="text-4xl">&#9881;</span>
            <span className="text-lg font-medium">Sandbox Mode</span>
            <span className="text-xs text-white/25 max-w-xs text-center leading-relaxed">
              Press <kbd className="text-amber-400/70 font-mono bg-white/5 px-1 rounded">1-8</kbd> to add sessions, <kbd className="text-amber-400/70 font-mono bg-white/5 px-1 rounded">F1-F5</kbd> for presets, <kbd className="text-amber-400/70 font-mono bg-white/5 px-1 rounded">?</kbd> for all controls
            </span>
            <div className="flex gap-2 mt-3">
              {SANDBOX_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  onClick={() => loadSandboxPreset(preset)}
                  className="px-3 py-1.5 rounded text-xs font-medium bg-amber-500/15 text-amber-400/70 hover:bg-amber-500/25 hover:text-amber-400 transition-colors"
                >
                  {preset.key} {preset.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2 mt-1">
              {(["idle", "working", "waiting", "error"] as const).map((st) => (
                <button
                  key={st}
                  onClick={() => addSandboxSession(st)}
                  className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${SANDBOX_STATE_COLORS[st]}`}
                >
                  + {SANDBOX_STATE_META[st].display}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div ref={listRef} className={`flex-1 ${compactMode ? "overflow-visible p-2 space-y-1.5" : "overflow-y-scroll p-4 pb-12 space-y-3"}`}>
            {sortedSandbox.map((session) => {
              // Apply keyboard state override if active
              const overrideState = stateOverrides[session.info.id];
              const effectiveSession = overrideState
                ? { ...session, info: { ...session.info, state: overrideState } }
                : session;
              const isSelected = session.info.id === selectedId;
              // Original (unsorted) index for display
              const originalIdx = sandboxSessions.findIndex((s) => s.info.id === session.info.id);

              return (
                <div key={session.info.id} data-session-id={session.info.id} data-session-state={effectiveSession.info.state} className="space-y-0">
                  {/* Selection indicator + slot number */}
                  <div
                    className="relative"
                    onClick={() => setSandboxSelectedIdx(originalIdx)}
                  >
                    {/* Slot number badge — hidden in screenshot mode */}
                    {!screenshotMode && (
                      <div className={`absolute -left-0.5 top-1 z-10 w-4 h-4 rounded-full flex items-center justify-center text-[0.5rem] font-bold ${isSelected ? "bg-amber-400 text-black" : "bg-white/10 text-white/30"}`}>
                        {originalIdx + 1}
                      </div>
                    )}
                    <SessionCard session={effectiveSession} titleAnimation={titleAnimation} animationSpeed={animationSpeed} randomAnimation={randomAnimation} signalString={lowPower ? false : signalString} signalFrequency={signalFrequency} signalMode={signalMode} signalAlpha={signalAlpha} signalAmplitude={signalAmplitude} signalEcho={signalEcho} signalBass={signalBass} signalMids={signalMids} signalTreble={signalTreble} signalColorDark={signalColorDark} signalColorLight={signalColorLight} signalOffset={signalOffset} signalEffect={lowPower ? "string" : signalEffect} sandEnabled={lowPower ? false : sandEnabled} sandIntensity={sandIntensity} sandDirection={sandDirection} sandDensity={sandDensity} sandSpeed={sandSpeed} sandGrainSize={sandGrainSize} sandTurbulence={sandTurbulence} sandAlpha={sandAlpha} cordRetractDelay={cordRetractDelay} cordDeployForce={cordDeployForce} cordRetractForce={cordRetractForce} stringSpread={stringSpread} keyPressSpeed={keyPressSpeed} keyReleaseSpeed={keyReleaseSpeed} compactMode={compactMode} slimMode={slimMode} contextThreshold={contextThreshold} contextDisplay={contextDisplay} showToolPills={showToolPills} showCurrentTool={showCurrentTool} showConfigCounts={showConfigCounts} timerDisplay={timerDisplay} />
                  </div>

                  {/* Per-session state controls — hidden in screenshot mode */}
                  {isSelected && !screenshotMode && (
                    <div className="flex items-center gap-1 px-2 py-1 rounded-b-lg bg-amber-500/5 border border-t-0 border-amber-500/15 -mt-px">
                      {SANDBOX_STATES.map((st) => {
                        const isCurrent = session.info.state === st;
                        return (
                          <button
                            key={st}
                            onClick={() => setSandboxState(session.info.id, st)}
                            disabled={isCurrent}
                            className={`px-1.5 py-0.5 rounded text-[0.55rem] font-medium transition-colors ${
                              isCurrent
                                ? "bg-amber-400/20 text-amber-300/90 ring-1 ring-amber-400/30"
                                : SANDBOX_STATE_COLORS[st]
                            }`}
                          >
                            <span className="opacity-50 mr-0.5">{SANDBOX_STATE_META[st].key}</span>
                            {SANDBOX_STATE_META[st].display}
                          </button>
                        );
                      })}
                      <div className="ml-auto">
                        <button
                          onClick={() => removeSandboxSession(session.info.id)}
                          className="px-1.5 py-0.5 rounded text-[0.55rem] text-red-400/40 hover:text-red-400 hover:bg-red-500/15 transition-colors"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Normal mode render
  // ---------------------------------------------------------------------------
  return (
    <div className={compactMode ? "flex flex-col" : "flex flex-col flex-1 min-h-0"}>
      {/* Stats header — commented out for now
      {!compactMode && (
      <div className="flex items-center gap-6 px-4 py-3 bg-white/5 border-b border-white/10">
        <StatBadge icon="●" label="Sessions" value={`${sessions.length}`} color="text-green-500" />
        <StatBadge icon="💬" label="Messages" value={`${totalMessages}`} color="text-blue-400" />
        <StatBadge icon="⇅" label="Tokens" value={formatTokens(totalTokens)} color="text-purple-400" />
        {totalPending > 0 && (
          <StatBadge icon="⏸" label="Pending" value={`${totalPending}`} color="text-yellow-400" />
        )}
      </div>
      )}
      */}

      {/* Session list or empty state */}
      {sessions.length === 0 && revivedSessions.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-white/60 gap-2">
          <span className="text-4xl">○</span>
          <span className="text-lg font-medium">No Active Sessions</span>
          <span className="text-sm text-white/40">Sessions will appear here when Claude Code is running</span>
        </div>
      ) : (
        <div ref={listRef} className={`flex-1 ${compactMode ? "overflow-visible p-2 space-y-1.5" : "overflow-y-scroll p-4 pb-12 space-y-3"}`}>
          {/* Empty active sessions message */}
          {sessions.length === 0 && revivedSessions.length > 0 && (
            <div className="flex flex-col items-center justify-center text-white/60 gap-2 py-12">
              <span className="text-4xl">○</span>
              <span className="text-lg font-medium">No Active Sessions</span>
              <span className="text-sm text-white/40">Sessions will appear here when Claude Code is running</span>
            </div>
          )}
          {/* Active sessions */}
          {(() => {
            // Compute which displayTitles appear more than once
            const titleCounts = new Map<string, number>();
            for (const s of sortedSessions) {
              titleCounts.set(s.displayTitle, (titleCounts.get(s.displayTitle) ?? 0) + 1);
            }
            const duplicateTitles = new Set(
              [...titleCounts.entries()].filter(([, count]) => count > 1).map(([title]) => title)
            );
            return sortedSessions.map((session, idx) => {
            const pending = pendingBySession[session.info.id] ?? [];
            const history = permissionHistory[session.info.id] ?? [];
            const hasPermissionActivity = pending.length > 0 || history.length > 0;
            const isCollapsed = collapsedSessions.has(session.info.id);

            // Apply keyboard state override if active
            const overrideState = stateOverrides[session.info.id];
            const effectiveSession = overrideState
              ? { ...session, info: { ...session.info, state: overrideState } }
              : session;

            return (
              <div key={session.info.id} data-session-id={session.info.id} data-session-state={effectiveSession.info.state} className="relative space-y-2" style={{ zIndex: idx + 1 }}>
                <SessionCard session={effectiveSession} titleAnimation={titleAnimation} animationSpeed={animationSpeed} randomAnimation={randomAnimation} signalString={lowPower ? false : signalString} signalFrequency={signalFrequency} signalMode={signalMode} signalAlpha={signalAlpha} signalAmplitude={signalAmplitude} signalEcho={signalEcho} signalBass={signalBass} signalMids={signalMids} signalTreble={signalTreble} signalColorDark={signalColorDark} signalColorLight={signalColorLight} signalOffset={signalOffset} signalEffect={lowPower ? "string" : signalEffect} sandEnabled={lowPower ? false : sandEnabled} sandIntensity={sandIntensity} sandDirection={sandDirection} sandDensity={sandDensity} sandSpeed={sandSpeed} sandGrainSize={sandGrainSize} sandTurbulence={sandTurbulence} sandAlpha={sandAlpha} cordRetractDelay={cordRetractDelay} cordDeployForce={cordDeployForce} cordRetractForce={cordRetractForce} stringSpread={stringSpread} keyPressSpeed={keyPressSpeed} keyReleaseSpeed={keyReleaseSpeed} compactMode={compactMode} slimMode={slimMode} contextThreshold={contextThreshold} contextDisplay={contextDisplay} showToolPills={showToolPills} showCurrentTool={showCurrentTool} showConfigCounts={showConfigCounts} timerDisplay={timerDisplay} isDuplicate={duplicateTitles.has(session.displayTitle)} expandOverride={compactMode ? expandOverrides[session.info.id] : undefined} onExpandCycle={compactMode ? () => {
                  setExpandOverrides((prev) => {
                    const current = prev[session.info.id] ?? 0;
                    const next = (current + 1) % 3;
                    if (next === 0) {
                      const copy = { ...prev };
                      delete copy[session.info.id];
                      return copy;
                    }
                    return { ...prev, [session.info.id]: next };
                  });
                } : undefined} />

                {/* Permission section (when enabled and has activity) */}
                {!compactMode && permissionsEnabled && hasPermissionActivity && (
                  <div className="ml-3 border-l-2 border-yellow-400/20 pl-3 space-y-2">
                    {pending.length > 0 && (
                      <button
                        onClick={() => toggleSessionCollapse(session.info.id)}
                        className="flex items-center gap-1.5 text-xs text-yellow-400/60 hover:text-yellow-400 transition-colors select-none"
                      >
                        <span>{isCollapsed ? "▸" : "▾"}</span>
                        <span>
                          {pending.length} pending permission{pending.length !== 1 ? "s" : ""}
                        </span>
                      </button>
                    )}

                    {!isCollapsed &&
                      pending.map((req) => (
                        <PermissionPrompt
                          key={req.requestId}
                          request={req}
                          onApprove={() => approvePermission(session.info.id, req.requestId)}
                          onDeny={() => denyPermission(session.info.id, req.requestId)}
                        />
                      ))}

                    {hasPermissionActivity && (
                      <details
                        className="text-xs"
                        onToggle={(e) => {
                          if ((e.target as HTMLDetailsElement).open) {
                            refreshHistory(session.info.id);
                          }
                        }}
                      >
                        <summary className="cursor-pointer text-white/30 hover:text-white/50 transition-colors py-1 select-none">
                          Permission history
                        </summary>
                        <div className="mt-1 pl-2 border-l border-white/10">
                          <PermissionHistory entries={history} />
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </div>
            );
          });
          })()}

          {/* Revived (ended) sessions — collapsible, collapsed by default */}
          {!compactMode && !slimMode && revivedSessions.length > 0 && (
            <details className="pt-4 group/revive">
              <summary className="flex items-center gap-3 pb-1 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden rounded-lg px-3 py-2 -mx-3 hover:bg-red-500/8 transition-colors">
                <div className="flex-1 border-t border-red-500/20" />
                <span className="text-xs text-red-400/60 group-hover/revive:text-red-400/90 uppercase tracking-wider font-medium flex items-center gap-1.5 transition-colors">
                  <span className="inline-block transition-transform duration-200 group-open/revive:rotate-90">&#9656;</span>
                  Ended Sessions ({revivedSessions.length})
                </span>
                <div className="flex-1 border-t border-red-500/20" />
                <button
                  onClick={(e) => { e.preventDefault(); handleClearAllRevived(); }}
                  className="text-xs text-red-400/50 hover:text-red-400 transition-colors px-2 py-0.5 rounded hover:bg-red-500/10"
                >
                  Clear All
                </button>
              </summary>
              <div className="space-y-2.5 pt-2">
                {revivedSessions.map((revived) => {
                  const clicks = reviveClicks[revived.session.info.id] ?? 0;
                  const pulseClass = clicks > 0 ? `revived-pulse-${Math.min(clicks, 2)}` : "";
                  const remaining = REVIVE_CLICKS_REQUIRED - clicks;
                  const buttonLabel = clicks === 0
                    ? "Revive"
                    : remaining === 1
                      ? "Confirm!"
                      : `Revive (${clicks}/${REVIVE_CLICKS_REQUIRED})`;

                  return (
                    <div key={revived.session.info.id} className={`revived-card-wrapper relative ${pulseClass}`}>
                      <div key={clicks} className="revived-overlay" />
                      <SessionCard session={revived.session} titleAnimation="none" signalString={signalString} signalFrequency={signalFrequency} signalMode={signalMode} signalAlpha={signalAlpha} signalAmplitude={signalAmplitude} signalEcho={signalEcho} signalBass={signalBass} signalMids={signalMids} signalTreble={signalTreble} signalColorDark={signalColorDark} signalColorLight={signalColorLight} signalOffset={signalOffset} signalEffect={signalEffect} sandEnabled={sandEnabled} sandIntensity={sandIntensity} sandDirection={sandDirection} sandDensity={sandDensity} sandSpeed={sandSpeed} sandGrainSize={sandGrainSize} sandTurbulence={sandTurbulence} sandAlpha={sandAlpha} revived />
                      {/* Full blur overlay */}
                      <div className="absolute inset-0 z-8 rounded-lg overflow-hidden" style={{ backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }} />
                      {/* Title re-rendered on top of blur in original position */}
                      <div className="absolute top-0 left-0 right-0 z-9 px-3 pt-2.5 flex items-center gap-2 pointer-events-none">
                        <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-400 shrink-0" />
                        <span className="font-semibold text-red-400 truncate">{revived.session.displayTitle}</span>
                      </div>
                      {/* Controls overlay */}
                      <div className="absolute inset-0 flex items-center justify-center gap-4 z-10" style={{ paddingTop: "1rem" }}>
                        <span className="text-xs text-red-400/70 font-mono tabular-nums">
                          {formatReviveElapsed(revived.revivedAt)}
                        </span>
                        <button
                          onClick={() => handleReviveClick(revived.session)}
                          className={`px-6 py-2.5 rounded-lg text-white text-base font-semibold transition-colors shadow-lg ${
                            clicks >= 2
                              ? "bg-red-600 hover:bg-red-500 shadow-red-600/40"
                              : clicks >= 1
                                ? "bg-red-500 hover:bg-red-400 shadow-red-500/30"
                                : "bg-red-500 hover:bg-red-400 shadow-red-500/25"
                          }`}
                        >
                          {buttonLabel}
                        </button>
                        <button
                          onClick={() => handleDismissRevived(revived.session.info.id)}
                          className="px-5 py-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white/60 hover:text-white/80 text-base font-medium transition-colors"
                          title="Dismiss"
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
          )}

        </div>
      )}
    </div>
  );
}
