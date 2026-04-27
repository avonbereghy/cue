import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import type { EnrichedSession, Settings, SignalPreset } from "@/lib/types";
import { loadPreset as loadPresetEngine, isLoaded as isPresetLoaded, setGate as setGateEngine } from "@/lib/presetEngine";
import { SessionCard } from "./SessionCard";
import { BranchView } from "./BranchView";
import type { CardSettings } from "./BranchView";
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

/** Compacting and clearing are ordering-transparent — entering one of these
 *  states should not move the session in the list. */
const isOrderingNeutral = (st: string) => st === "compacting" || st === "clearing";

/** Quiescent = terminal-for-this-turn. Used by the settle/reorder gating. */
const isQuiescent = (st: string) => st === "idle" || st === "done";

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
  const [sandIntensity, setSandIntensity] = useState(0.8);
  const [sandDirection, setSandDirection] = useState(-40);
  const [sandDensity, setSandDensity] = useState(2.5);
  const [sandSpeed, setSandSpeed] = useState(0.7);
  const [sandGrainSize, setSandGrainSize] = useState(0.5);
  const [sandTurbulence, setSandTurbulence] = useState(0.2);
  const [sandAlpha, setSandAlpha] = useState(0.75);
  const [fluxEnabled, setFluxEnabled] = useState(true);
  const [fluxAlpha, setFluxAlpha] = useState(0.9);
  const [fluxIntensity, setFluxIntensity] = useState(1.5);
  const [fluxDensity, setFluxDensity] = useState(1.0);
  const [fluxSpeed, setFluxSpeed] = useState(1.0);
  const [fluxLineLength, setFluxLineLength] = useState(0.55);
  const [fluxTurbulence, setFluxTurbulence] = useState(1.0);
  const [auroraEnabled, setAuroraEnabled] = useState(true);
  const [auroraAlpha, setAuroraAlpha] = useState(0.75);
  const [auroraSpeed, setAuroraSpeed] = useState(0.55);
  const [cordRetractDelay, setCordRetractDelay] = useState(0.2);
  const [cordDeployForce, setCordDeployForce] = useState(1.5);
  const [cordRetractForce, setCordRetractForce] = useState(1.5);
  const [stringSpread, setStringSpread] = useState(0.02);
  const [stringDeployAngle, setStringDeployAngle] = useState(-16.0);
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
  const [showToolCallComets, setShowToolCallComets] = useState(false);
  const [timerDisplay, setTimerDisplay] = useState("seconds");
  const [keyPressSpeed, setKeyPressSpeed] = useState(0.35);
  const [keyReleaseSpeed, setKeyReleaseSpeed] = useState(0.4);
  const [stateOverrides, setStateOverrides] = useState<Record<string, string>>({});
  // Per-session expand level in compact mode: 0=compact, 1=slim, 2=full. Undefined = follow global.
  const [expandOverrides, setExpandOverrides] = useState<Record<string, number>>({});
  const [autoReorder, setAutoReorder] = useState(false);
  // Branch view: horizontal tree layout when window is wide (>60% of screen)
  const [branchView, setBranchView] = useState(false);
  useEffect(() => {
    const check = () => setBranchView(window.innerWidth >= 960);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
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

  // Track ended sessions for the revive list. We ONLY treat sessions that
  // disappear from the list as revivable — that's the signature of a dirty
  // exit (process died, terminal killed, PID gone). Sessions that reach
  // state="ended" came in through a clean SessionEnd hook (user typed /exit
  // or closed the chat cleanly) and shouldn't need reviving — they just
  // disappear silently via the main-list filter.
  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.info.id));
    const prevIds = prevSessionIdsRef.current;

    setRevivedSessions((prev) => {
      let next = prev;
      const alreadyRevived = new Set(prev.map((r) => r.session.info.id));

      if (prevIds.size > 0) {
        const ended: RevivedSession[] = [];

        // Sessions that disappeared entirely — dirty exits only.
        // Snapshot must itself have been in a non-"ended" state, otherwise the
        // disappearance is the tail end of a clean SessionEnd and still
        // doesn't warrant a revive prompt.
        for (const id of prevIds) {
          if (!currentIds.has(id) && !alreadyRevived.has(id)) {
            const snapshot = prevSessionsRef.current.find((s) => s.info.id === id);
            if (snapshot && snapshot.info.state !== "ended") {
              ended.push({ session: snapshot, revivedAt: Date.now() });
            }
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
    setReviveClicks((prev) => {
      const next = (prev[id] ?? 0) + 1;
      if (next >= REVIVE_CLICKS_REQUIRED) {
        invoke("revive_session", {
          sessionId: session.info.id,
          workspace: session.info.workspace,
        }).catch((err) => console.error("Failed to revive session:", err));
        const copy = { ...prev };
        delete copy[id];
        return copy;
      }
      return { ...prev, [id]: next };
    });
  }, []);

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

  const {
    pendingBySession,
    permissionHistory,
    approvePermission,
    denyPermission,
    refreshHistory,
  } = usePermissions();

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
    setSandIntensity(s.sandIntensity ?? 0.8);
    setSandDirection(s.sandDirection ?? -40);
    setSandDensity(s.sandDensity ?? 2.5);
    setSandSpeed(s.sandSpeed ?? 0.7);
    setSandGrainSize(s.sandGrainSize ?? 0.5);
    setSandTurbulence(s.sandTurbulence ?? 0.2);
    setSandAlpha(s.sandAlpha ?? 0.75);
    setFluxEnabled(s.fluxEnabled ?? true);
    setFluxAlpha(s.fluxAlpha ?? 0.9);
    setFluxIntensity(s.fluxIntensity ?? 1.5);
    setFluxDensity(s.fluxDensity ?? 1.0);
    setFluxSpeed(s.fluxSpeed ?? 1.0);
    setFluxLineLength(s.fluxLineLength ?? 0.55);
    setFluxTurbulence(s.fluxTurbulence ?? 1.0);
    setAuroraEnabled(s.auroraEnabled ?? true);
    setAuroraAlpha(s.auroraAlpha ?? 0.75);
    setAuroraSpeed(s.auroraSpeed ?? 0.55);
    setCordRetractDelay(s.cordRetractDelay ?? 0.2);
    setCordDeployForce(s.cordDeployForce ?? 1.5);
    setCordRetractForce(s.cordRetractForce ?? 1.5);
    setStringSpread(s.stringSpread ?? 0.02);
    setStringDeployAngle(s.stringDeployAngle ?? -16.0);
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
    setShowToolCallComets(s.showToolCallComets ?? false);
    setTimerDisplay(s.timerDisplay ?? "seconds");
    if (s.lowPower) document.documentElement.setAttribute("data-low-power", "");
    else document.documentElement.removeAttribute("data-low-power");
  }, []);

  useEffect(() => {
    // Load settings on mount
    invoke<Settings>("get_settings").then(applySettings).catch(() => {});
    // Listen for settings changes from any window (replaces 2s polling).
    // `cancelled` handles the unmount-before-subscribe race: if unmount fires
    // before listen() resolves, we detach immediately instead of leaking.
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<Settings>("settings-changed", (event) => {
      applySettings(event.payload);
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, [applySettings]);

  // Global keyboard shortcuts (Cmd+/- for font scaling)
  useEffect(() => {
    const STEP = 0.05;
    const MIN = 0.75;
    const MAX = 1.5;
    const handleZoom = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      let delta = 0;
      if (e.key === "=" || e.key === "+") delta = STEP;
      else if (e.key === "-") delta = -STEP;
      else if (e.key === "0") delta = 0; // reset
      else return;
      e.preventDefault();
      invoke<Settings>("get_settings").then((s) => {
        const current = s.fontScale ?? 1.0;
        const next = e.key === "0" ? 1.0 : Math.round(Math.min(MAX, Math.max(MIN, current + delta)) * 100) / 100;
        if (next === current) return;
        document.documentElement.style.setProperty("--font-scale", String(next));
        invoke("update_settings", { newSettings: { ...s, fontScale: next } });
      });
    };
    window.addEventListener("keydown", handleZoom);
    return () => window.removeEventListener("keydown", handleZoom);
  }, []);

  // Cmd/Ctrl+D — toggle detail mode (full card details on/off).
  // Entering detail clears both compactMode and slimMode; exiting sets slimMode
  // so cards stay visible without per-session details. Persists via settings
  // so other windows and restarts pick up the change.
  useEffect(() => {
    const handleDetail = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "d" && e.key !== "D") return;
      if (e.shiftKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      invoke<Settings>("get_settings").then((s) => {
        const inDetail = !(s.compactMode ?? false) && !(s.slimMode ?? false);
        const next = inDetail
          ? { ...s, slimMode: true }
          : { ...s, compactMode: false, slimMode: false };
        invoke("update_settings", { newSettings: next });
      });
    };
    window.addEventListener("keydown", handleDetail);
    return () => window.removeEventListener("keydown", handleDetail);
  }, []);

  // Auto-load active preset on launch when preset mode is configured
  useEffect(() => {
    if (presetBootAttempted || signalMode !== "preset" || isPresetLoaded()) return;
    if (!activePresetId) return;
    setPresetBootAttempted(true);
    invoke<SignalPreset>("load_preset", { id: activePresetId })
      .then((preset) => loadPresetEngine(preset))
      .catch(() => {});
  }, [signalMode, activePresetId, presetBootAttempted]);

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
  const SANDBOX_STATES = ["working", "thinking", "waiting", "error", "subagent", "compacting", "idle", "done", "ended"] as const;
  const SANDBOX_STATE_META: Record<string, { icon: string; display: string; key: string }> = {
    working:    { icon: "\u27F3", display: "Working",    key: "W" },
    thinking:   { icon: "\uD83D\uDCAD", display: "Thinking",   key: "T" },
    waiting:    { icon: "\u23F8", display: "Waiting",    key: "P" },
    error:      { icon: "\u2717", display: "Error",      key: "E" },
    subagent:   { icon: "\u2934", display: "Subagent",   key: "A" },
    compacting: { icon: "\u21CA", display: "Compacting", key: "C" },
    idle:       { icon: "\u25CB", display: "Idle",       key: "I" },
    done:       { icon: "\u2713", display: "Done",       key: "D" },
    ended:      { icon: "\u2715", display: "Ended",      key: "X" },
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
  // Tracks when each sandbox session entered an "active" (working|subagent)
  // state. Used by the simulation loop to schedule subagent auto-spawns and
  // resets when the session leaves both active states.
  const sandboxActiveStartRef = useRef<Map<string, number>>(new Map());
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

  // ─── Live simulation for sandbox sessions in working/subagent state ───
  // Drives realistic token growth, tool-call chatter, and auto-spawned
  // subagents so the UI animations (FlipNumber, context-bar glow, signal
  // strings, comet tool-calls, +N cyan bands) actually have data to react
  // to without anyone touching the keyboard.
  //
  //   - Each 500ms tick: for every active session, add output/input/cache
  //     tokens proportional to a drifting outputTokensPerSec (5–80 t/s),
  //     cap at 98% of contextLimit, fire a tool call on average every ~5s
  //     (also injects a 200–4000 token context bump), and roll a new
  //     runningToolName.
  //   - Per-session active-work timer (tracked in sandboxActiveStartRef)
  //     drives the "string count" escalation: at 15s/40s/80s/150s a new
  //     auto subagent is spawned, which flips state to "subagent" and adds
  //     one more diagonal band to the SignalString. Timer persists across
  //     user-driven +Sub/-Sub because both working and subagent count as
  //     "active" — it only resets when the session leaves both states.
  useEffect(() => {
    if (!testMode) {
      sandboxActiveStartRef.current.clear();
      return;
    }
    const TICK_MS = 500;
    // Working-duration thresholds (seconds) at which an auto-subagent
    // spawns. Keyed to feel like "short task = just working", "medium =
    // one helper", "long = a small team" — matches the string count we
    // want on screen the longer a session runs.
    const SUB_THRESHOLDS_SEC = [15, 40, 80, 150];

    const pickTool = (): [string, string] =>
      SANDBOX_TOOLS_ACTIVE[Math.floor(Math.random() * SANDBOX_TOOLS_ACTIVE.length)];

    const handle = window.setInterval(() => {
      const now = Date.now();
      setSandboxSessions((prev) => {
        // Prune tracker entries for sessions that no longer exist OR have
        // left active-state — entering working again starts the clock over.
        const activeIds = new Set(
          prev
            .filter((s) => s.info.state === "working" || s.info.state === "subagent")
            .map((s) => s.info.id),
        );
        for (const id of sandboxActiveStartRef.current.keys()) {
          if (!activeIds.has(id)) sandboxActiveStartRef.current.delete(id);
        }

        let changed = false;
        const next = prev.map((s) => {
          const isActive = s.info.state === "working" || s.info.state === "subagent";
          if (!isActive) return s;

          if (!sandboxActiveStartRef.current.has(s.info.id)) {
            sandboxActiveStartRef.current.set(s.info.id, now);
          }
          const startMs = sandboxActiveStartRef.current.get(s.info.id)!;
          const elapsedSec = (now - startMs) / 1000;
          const dt = TICK_MS / 1000;

          // Output-tokens-per-second random walk bounded to a plausible band.
          const prevTps = s.outputTokensPerSec || 22;
          const tps = Math.max(6, Math.min(80, prevTps + (Math.random() - 0.5) * 10));

          // Base growth: output → linear in tps; input → ~1.6× output
          // (assistant replies grow both sides as they're appended to the
          // next turn); cache reads grow ~4× output (Claude's actual cache
          // traffic dwarfs fresh input).
          const outDelta = Math.round(tps * dt);
          const inDelta = Math.round(tps * dt * 1.6 + Math.random() * 30);
          const cacheDelta = Math.round(tps * dt * 4 + Math.random() * 120);

          let inputTokens = s.metrics.inputTokens + inDelta;
          const outputTokens = s.metrics.outputTokens + outDelta;
          const cacheReadTokens = s.metrics.cacheReadTokens + cacheDelta;
          const cacheCreationTokens = s.metrics.cacheCreationTokens + Math.round(Math.random() * 40);

          let toolCounts = s.metrics.toolCounts;
          let runningToolName = s.runningToolName;
          let runningToolTarget = s.runningToolTarget;

          // Tool call probability: one in every ~5s on expectation. When it
          // fires, bump toolCounts (drives the comet tracer in SessionCard),
          // swap the running tool label, and inject a chunk of tokens
          // representing the tool result being read back into context.
          if (Math.random() < dt / 5) {
            const [name, target] = pickTool();
            toolCounts = { ...toolCounts, [name]: (toolCounts[name] ?? 0) + 1 };
            runningToolName = name;
            runningToolTarget = target;
            const injected = 200 + Math.floor(Math.random() * 4000);
            inputTokens += injected;
          }

          // Clamp input to leave a little headroom so the context bar
          // doesn't hard-lock at the right edge.
          const cap = Math.floor(s.contextLimit * 0.98);
          if (inputTokens > cap) inputTokens = cap;

          // Auto-spawn subagents at working-duration thresholds. We only
          // cross each threshold once per session because the subagent
          // count only ever grows (manual -Sub doesn't reset the timer).
          let subagents = s.metrics.subagents;
          let stateOut = s.info.state;
          let stateIconOut = s.stateIcon;
          let stateDisplayOut = s.stateDisplayName;
          let activeSubsOut = s.info.activeSubagents ?? subagents.length;

          const desiredSubCount = SUB_THRESHOLDS_SEC.reduce(
            (acc, t) => (elapsedSec >= t ? acc + 1 : acc),
            0,
          );
          if (subagents.length < desiredSubCount) {
            const addN = desiredSubCount - subagents.length;
            const newOnes = [];
            for (let k = 0; k < addN; k++) {
              const idx = subagents.length + k;
              newOnes.push({
                agentId: `auto_sub_${s.info.id}_${idx + 1}_${now}_${k}`,
                description: ["Research task", "Code review", "Test runner", "Build validator"][idx % 4],
                slug: ["research", "code-reviewer", "test-runner", "build-validator"][idx % 4],
                inputTokens: Math.floor(Math.random() * 20000 + 3000),
                outputTokens: Math.floor(Math.random() * 5000 + 500),
                cacheCreationTokens: 0,
                cacheReadTokens: Math.floor(Math.random() * 8000),
                model: s.metrics.model,
                toolCounts: { Read: Math.floor(Math.random() * 6 + 1), Grep: Math.floor(Math.random() * 3) },
                messageCount: Math.floor(Math.random() * 10 + 2),
                isActive: true,
              });
            }
            subagents = [...subagents, ...newOnes];
            activeSubsOut = subagents.length;
            const meta = SANDBOX_STATE_META.subagent;
            stateOut = "subagent";
            stateIconOut = meta.icon;
            stateDisplayOut = meta.display;
          }

          changed = true;
          return {
            ...s,
            info: {
              ...s.info,
              state: stateOut,
              activeSubagents: activeSubsOut,
              lastActivity: now / 1000,
            },
            stateIcon: stateIconOut,
            stateDisplayName: stateDisplayOut,
            hasSubagents: subagents.length > 0,
            outputTokensPerSec: tps,
            runningToolName,
            runningToolTarget,
            durationSecs: s.durationSecs + dt,
            totalDurationSecs: s.totalDurationSecs + dt,
            contextUsagePercent: inputTokens / s.contextLimit,
            metrics: {
              ...s.metrics,
              inputTokens,
              outputTokens,
              lastInputTokens: inputTokens,
              cacheReadTokens,
              cacheCreationTokens,
              toolCounts,
              subagents,
            },
          };
        });

        return changed ? next : prev;
      });
    }, TICK_MS);
    return () => {
      window.clearInterval(handle);
    };
    // Re-subscribes only when entering/leaving sandbox mode; SANDBOX_* arrays
    // are stable values baked into the component and read via closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testMode]);

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
    setSandboxSessions((prev) => prev.map((s) => {
      if (s.info.id !== id) return s;
      const nextSubs = state === "subagent"
        ? (s.metrics.subagents.length > 0 ? s.metrics.subagents : [
            { agentId: `sub_auto_1`, description: "Research task", slug: "research", inputTokens: 12000, outputTokens: 3000, cacheCreationTokens: 0, cacheReadTokens: 5000, model: s.metrics.model, toolCounts: { Read: 3, Grep: 2 }, messageCount: 8, isActive: true },
          ])
        : (state === "working" ? [] : s.metrics.subagents);
      return {
        ...s,
        info: { ...s.info, state, activeSubagents: nextSubs.length, lastActivity: Date.now() / 1000 },
        stateIcon: meta.icon,
        stateDisplayName: meta.display,
        hasSubagents: nextSubs.length > 0,
        outputTokensPerSec: (state === "working" || state === "subagent") ? Math.random() * 25 + 5 : 0,
        runningToolName: tool ? tool[0] : (state === "working" ? s.runningToolName : undefined),
        runningToolTarget: tool ? tool[1] : (state === "working" ? s.runningToolTarget : undefined),
        metrics: { ...s.metrics, subagents: nextSubs },
      };
    }));
  }, []);

  const setAllSandboxState = useCallback((state: string) => {
    setSandboxSessions((prev) => prev.map((s) => {
      const meta = SANDBOX_STATE_META[state] ?? SANDBOX_STATE_META.idle;
      const tool = state === "working" ? SANDBOX_TOOLS_ACTIVE[Math.floor(Math.random() * SANDBOX_TOOLS_ACTIVE.length)] : null;
      const nextSubs = state === "subagent"
        ? [{ agentId: `sub_auto`, description: "Research task", slug: "research", inputTokens: 12000, outputTokens: 3000, cacheCreationTokens: 0, cacheReadTokens: 5000, model: s.metrics.model, toolCounts: { Read: 3, Grep: 2 }, messageCount: 8, isActive: true }]
        : [];
      return {
        ...s,
        info: { ...s.info, state, activeSubagents: nextSubs.length, lastActivity: Date.now() / 1000 },
        stateIcon: meta.icon,
        stateDisplayName: meta.display,
        hasSubagents: nextSubs.length > 0,
        outputTokensPerSec: (state === "working" || state === "subagent") ? Math.random() * 25 + 5 : 0,
        runningToolName: tool ? tool[0] : undefined,
        runningToolTarget: tool ? tool[1] : undefined,
        metrics: { ...s.metrics, subagents: nextSubs },
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

  // Toggle subagent count on selected (legacy R-key cycle: 0→1→2→3→4→0)
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
      return {
        ...s,
        info: { ...s.info, activeSubagents: nextCount },
        hasSubagents: nextCount > 0,
        metrics: { ...s.metrics, subagents },
      };
    });
  }, [mutateSandboxSelected]);

  // Add one subagent to the targeted session. Switches state to "subagent"
  // (and stamps activeSubagents on info so the cyan diagonal lines render).
  const addSandboxSubagent = useCallback((id: string) => {
    setSandboxSessions((prev) => prev.map((s) => {
      if (s.info.id !== id) return s;
      const nextCount = s.metrics.subagents.length + 1;
      const newSub = {
        agentId: `sub_${id}_${nextCount}_${Date.now()}`,
        description: ["Research task", "Code review", "Test runner", "Build validator"][(nextCount - 1) % 4],
        slug: ["research", "code-reviewer", "test-runner", "build-validator"][(nextCount - 1) % 4],
        inputTokens: Math.floor(Math.random() * 30000 + 5000),
        outputTokens: Math.floor(Math.random() * 8000 + 1000),
        cacheCreationTokens: 0,
        cacheReadTokens: Math.floor(Math.random() * 10000),
        model: s.metrics.model,
        toolCounts: { Read: Math.floor(Math.random() * 8 + 1), Grep: Math.floor(Math.random() * 4) },
        messageCount: Math.floor(Math.random() * 15 + 3),
        isActive: true,
      };
      const subagents = [...s.metrics.subagents, newSub];
      const meta = SANDBOX_STATE_META.subagent;
      return {
        ...s,
        info: { ...s.info, state: "subagent", activeSubagents: nextCount, lastActivity: Date.now() / 1000 },
        stateIcon: meta.icon,
        stateDisplayName: meta.display,
        hasSubagents: true,
        outputTokensPerSec: Math.max(s.outputTokensPerSec, Math.random() * 25 + 5),
        metrics: { ...s.metrics, subagents },
      };
    }));
  }, []);

  // Remove the most-recently-added subagent (LIFO so the visual line that
  // retracts is the newest one). When the count drops to 0 we revert state
  // to "working" — that's the natural parent state of a subagent run.
  const removeSandboxSubagent = useCallback((id: string) => {
    setSandboxSessions((prev) => prev.map((s) => {
      if (s.info.id !== id) return s;
      if (s.metrics.subagents.length === 0) return s; // edge case: nothing to remove
      const subagents = s.metrics.subagents.slice(0, -1);
      const nextCount = subagents.length;
      if (nextCount === 0) {
        const meta = SANDBOX_STATE_META.working;
        const tool = SANDBOX_TOOLS_ACTIVE[Math.floor(Math.random() * SANDBOX_TOOLS_ACTIVE.length)];
        return {
          ...s,
          info: { ...s.info, state: "working", activeSubagents: 0, lastActivity: Date.now() / 1000 },
          stateIcon: meta.icon,
          stateDisplayName: meta.display,
          hasSubagents: false,
          runningToolName: tool[0],
          runningToolTarget: tool[1],
          metrics: { ...s.metrics, subagents },
        };
      }
      return {
        ...s,
        info: { ...s.info, activeSubagents: nextCount, lastActivity: Date.now() / 1000 },
        metrics: { ...s.metrics, subagents },
      };
    }));
  }, []);

  // Simulate a single tool call on the target session. Bumps one entry in
  // metrics.toolCounts (and updates runningToolName/Target to match) so
  // SessionCard's comet emitter fires a tracer. Flips the session to
  // "working" if it isn't already in working/subagent — a tool call only
  // reads as a real call when the session is actively running.
  const fireSandboxToolCall = useCallback((id: string) => {
    setSandboxSessions((prev) => prev.map((s) => {
      if (s.info.id !== id) return s;
      const [toolName, toolTarget] = SANDBOX_TOOLS_ACTIVE[Math.floor(Math.random() * SANDBOX_TOOLS_ACTIVE.length)];
      const nextToolCounts = { ...s.metrics.toolCounts, [toolName]: (s.metrics.toolCounts[toolName] ?? 0) + 1 };
      const isActive = s.info.state === "working" || s.info.state === "subagent";
      const meta = isActive ? undefined : SANDBOX_STATE_META.working;
      return {
        ...s,
        info: {
          ...s.info,
          state: isActive ? s.info.state : "working",
          lastActivity: Date.now() / 1000,
        },
        stateIcon: meta ? meta.icon : s.stateIcon,
        stateDisplayName: meta ? meta.display : s.stateDisplayName,
        outputTokensPerSec: Math.max(s.outputTokensPerSec, Math.random() * 25 + 5),
        runningToolName: toolName,
        runningToolTarget: toolTarget,
        metrics: { ...s.metrics, toolCounts: nextToolCounts },
      };
    }));
  }, []);

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
          const id = sandboxSessions[sandboxSelectedIdx]?.info.id;
          if (id) setSandboxState(id, state);
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
  // Auto-reorder: gated reorder model.
  //
  // The display order is sticky: once a session occupies a slot, it stays
  // there across state changes. New sessions always appear at the bottom.
  // The order only changes ("shuffle up") when a reorder trigger fires:
  //
  //   • TURN END — any active session transitions to idle/done. Debounced
  //     200ms so near-simultaneous ends collapse into one animation.
  //   • INVARIANT — if any active session ends up below a settled one in
  //     the display (e.g. a new session spawns active at the bottom, or a
  //     session starts a turn below idles), the debounced reorder fires so
  //     actives bubble above settled.
  //   • QUIESCENCE — all sessions have been idle/done for 5+ seconds, full
  //     priority resort with FLIP animation.
  //
  // Between triggers, state changes that don't break the invariant
  // (working→waiting, idle→working while already on top, etc.) do NOT
  // cause reorders — the session just updates in place.
  // ---------------------------------------------------------------------------

  const SETTLE_MS = 5000;

  // Track the most recent non-neutral state per session so the sort/invariant
  // logic can treat a compacting session as if it were still in its prior state.
  const orderingStateRef = useRef<Map<string, string>>(new Map());
  const effectiveState = useCallback((s: EnrichedSession) => {
    const st = s.info.state;
    if (!isOrderingNeutral(st)) return st;
    return orderingStateRef.current.get(s.info.id) ?? st;
  }, []);

  // The "desired" fully-sorted order (used by the deferred full rearrange)
  const reorderPriority = useCallback((s: EnrichedSession) => {
    const st = effectiveState(s);
    if (st === "waiting") return 0;
    if (st === "error") return 1;
    if (
      st === "working" ||
      st === "subagent" ||
      st === "thinking" ||
      st === "compacting" ||
      st === "clearing"
    ) {
      return 2;
    }
    return 3;
  }, [effectiveState]);

  // Track the committed display order (list of session IDs).
  // This only changes when a reorder animation is triggered.
  const committedOrderRef = useRef<string[]>([]);
  const quiesceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAnimatingRef = useRef(false);
  const animationGenRef = useRef(0); // incremented each animation; stale chains check this
  // Set when the effect observes a fresh sortKey while an animation is already
  // in flight. The in-flight run's finally consumes it to retrigger the effect
  // so the deferred reorder doesn't get dropped.
  const pendingReorderRef = useRef(false);
  const isQuiescenceReorderRef = useRef(false);
  // Tracks previous state per session so we can detect turn-end transitions
  // (non-quiescent → quiescent) and fire a gated reorder.
  const prevStatesRef = useRef<Map<string, string>>(new Map());
  // Debounce timer that coalesces near-simultaneous turn ends into one reorder.
  const turnEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending reorder timers on unmount so callbacks don't fire into
  // a dead component and attempt setState.
  useEffect(() => () => {
    if (turnEndTimerRef.current) {
      clearTimeout(turnEndTimerRef.current);
      turnEndTimerRef.current = null;
    }
    if (quiesceTimerRef.current) {
      clearTimeout(quiesceTimerRef.current);
      quiesceTimerRef.current = null;
    }
  }, []);

  // Per-session "settled since" timestamps. A session is "settled" when it
  // has been idle/done for ≥ SETTLE_MS. Active sessions are removed from this map.
  const settledSinceRef = useRef<Map<string, number>>(new Map());

  // Per-session "active since" timestamps. Records when a session first entered
  // working/thinking/subagent state since its last idle/done period. Used to sort
  // active sessions so the longest-working session stays on top.
  const activeSinceRef = useRef<Map<string, number>>(new Map());

  // Check whether ALL sessions are settled (idle/done for 5s+)
  const allSettled = useCallback((list: EnrichedSession[], now: number) => {
    return list.every((s) => {
      if (!isQuiescent(effectiveState(s))) return false;
      const since = settledSinceRef.current.get(s.info.id);
      return since !== undefined && (now - since) >= SETTLE_MS;
    });
  }, [effectiveState]);

  // Build the active (non-ended) session list.
  // Team children (spawned via TeamCreate) are separated so they don't
  // participate in the sort algorithm — they follow their parent's position
  // and are spliced back in after sorting.
  const allActiveSessions = sessions.filter((s) => s.info.state !== "ended");
  const isTeamChild = useCallback(
    (s: EnrichedSession) => !!(s.info.teamName || s.metrics.teamName),
    [],
  );
  const activeSessions = allActiveSessions.filter((s) => !isTeamChild(s));
  const teamChildren = allActiveSessions.filter(isTeamChild);

  // Update settled-since and active-since timestamps, and detect turn ends
  // (any non-quiescent → quiescent transition) to fire the gated reorder.
  // Compacting/clearing are ordering-transparent: we record the prior
  // non-neutral state so a session returning to that state from compacting
  // doesn't look like a transition for ordering purposes.
  const now = Date.now();
  let turnEndDetected = false;
  for (const s of activeSessions) {
    // Record the most recent non-neutral state so effectiveState resolves
    // correctly for compacting/clearing entries.
    if (!isOrderingNeutral(s.info.state)) {
      orderingStateRef.current.set(s.info.id, s.info.state);
    }
    const curr = effectiveState(s);
    const prev = prevStatesRef.current.get(s.info.id);
    if (prev !== undefined && !isQuiescent(prev) && isQuiescent(curr)) {
      turnEndDetected = true;
    }
    prevStatesRef.current.set(s.info.id, curr);

    if (isQuiescent(curr)) {
      // Record when it first became idle/done (if not already tracked)
      if (!settledSinceRef.current.has(s.info.id)) {
        settledSinceRef.current.set(s.info.id, now);
      }
      // No longer active — clear active-since
      activeSinceRef.current.delete(s.info.id);
    } else {
      // Active — clear any settled timestamp
      settledSinceRef.current.delete(s.info.id);
      // Record when it first became active (if not already tracked)
      if (!activeSinceRef.current.has(s.info.id)) {
        activeSinceRef.current.set(s.info.id, now);
      }
    }
  }
  // Prune sessions that no longer exist
  const activeIdSet = new Set(activeSessions.map((s) => s.info.id));
  for (const id of settledSinceRef.current.keys()) {
    if (!activeIdSet.has(id)) settledSinceRef.current.delete(id);
  }
  for (const id of activeSinceRef.current.keys()) {
    if (!activeIdSet.has(id)) activeSinceRef.current.delete(id);
  }
  for (const id of orderingStateRef.current.keys()) {
    if (!activeIdSet.has(id)) orderingStateRef.current.delete(id);
  }
  for (const id of prevStatesRef.current.keys()) {
    if (!activeIdSet.has(id)) prevStatesRef.current.delete(id);
  }

  // Compute fully-sorted desired order (for deferred full rearrange).
  // Two sort blocks: the working set (waiting/error/working/subagent) sorted
  // longest-active-first, and the idle/done set sorted most-recently-idle-first
  // so the session that just settled rises to the top of the idle stack.
  const idleTiebreak = (a: EnrichedSession, b: EnrichedSession) => {
    const sa = settledSinceRef.current.get(a.info.id) ?? 0;
    const sb = settledSinceRef.current.get(b.info.id) ?? 0;
    if (sa !== sb) return sb - sa; // newest-settled first
    return b.info.startedAt - a.info.startedAt; // newer session first
  };
  const desiredOrder = (() => {
    const all = [...activeSessions];
    if (autoReorder) {
      all.sort((a, b) => {
        const pa = reorderPriority(a);
        const pb = reorderPriority(b);
        if (pa !== pb) return pa - pb;
        // Idle/done block: most recently settled goes to the top.
        if (pa === 3) return idleTiebreak(a, b);
        // Working block: longest-active first.
        const aa = activeSinceRef.current.get(a.info.id) ?? Infinity;
        const ba = activeSinceRef.current.get(b.info.id) ?? Infinity;
        if (aa !== ba) return aa - ba;
        return a.info.startedAt - b.info.startedAt;
      });
    } else {
      all.sort((a, b) => {
        // Working set (active) sorts before idle/done.
        const aActive = !isQuiescent(effectiveState(a));
        const bActive = !isQuiescent(effectiveState(b));
        if (aActive !== bActive) return aActive ? -1 : 1;
        if (aActive) {
          const aa = activeSinceRef.current.get(a.info.id) ?? Infinity;
          const ba = activeSinceRef.current.get(b.info.id) ?? Infinity;
          if (aa !== ba) return aa - ba;
          return a.info.startedAt - b.info.startedAt;
        }
        // Idle block: most recently settled first.
        return idleTiebreak(a, b);
      });
    }
    return all.map((s) => s.info.id);
  })();

  // Display order is sticky: existing sessions keep their committed slot,
  // new sessions are appended at the bottom. Order only mutates when a
  // reorder trigger (turn end / quiescence) sets committedOrderRef.
  const sortedSessions = (() => {
    if (!autoReorder) {
      const sorted = [...activeSessions].sort((a, b) => {
        const aActive = !isQuiescent(effectiveState(a));
        const bActive = !isQuiescent(effectiveState(b));
        if (aActive !== bActive) return aActive ? -1 : 1;
        if (aActive) {
          const aa = activeSinceRef.current.get(a.info.id) ?? Infinity;
          const ba = activeSinceRef.current.get(b.info.id) ?? Infinity;
          if (aa !== ba) return aa - ba;
          return a.info.startedAt - b.info.startedAt;
        }
        return idleTiebreak(a, b);
      });
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

    const ordered: EnrichedSession[] = [];
    const used = new Set<string>();
    const committedSet = new Set(committed);
    // Existing sessions keep their committed slot, but we splice NEW sessions
    // into their desiredOrder position instead of appending at the bottom —
    // that way the door/rise animation lands the card in its real home slot
    // and the only motion other cards need is a shuffle-to-make-room.
    //
    // Algorithm: walk desiredOrder. Whenever we hit a "new" id (not in the
    // committed set), insert it into the result at the position of the next
    // still-pending committed anchor. Existing ids are emitted in COMMITTED
    // order (not desired) so sticky positioning is preserved.
    const commitedIter: string[] = committed.filter((id) => sessionMap.has(id));
    let ci = 0;
    for (let di = 0; di < desiredOrder.length; di++) {
      const id = desiredOrder[di];
      if (!sessionMap.has(id)) continue;
      if (committedSet.has(id)) continue; // will be emitted via committed iter
      // This is a new session. Emit committed entries up to (but not
      // including) the next committed anchor that comes after this new id
      // in desiredOrder. Anchor = first committed id whose desiredOrder
      // rank is > this new id's rank.
      const anchor = (() => {
        for (let j = di + 1; j < desiredOrder.length; j++) {
          if (committedSet.has(desiredOrder[j])) return desiredOrder[j];
        }
        return null;
      })();
      if (anchor) {
        while (ci < commitedIter.length && commitedIter[ci] !== anchor) {
          const cid = commitedIter[ci++];
          ordered.push(sessionMap.get(cid)!);
          used.add(cid);
        }
      } else {
        // No committed session comes after this new id in desiredOrder — the
        // new id belongs at the tail, so drain all remaining committed first.
        while (ci < commitedIter.length) {
          const cid = commitedIter[ci++];
          ordered.push(sessionMap.get(cid)!);
          used.add(cid);
        }
      }
      ordered.push(sessionMap.get(id)!);
      used.add(id);
    }
    // Drain remaining committed entries (those after the last-inserted new id).
    while (ci < commitedIter.length) {
      const cid = commitedIter[ci++];
      if (!used.has(cid)) {
        ordered.push(sessionMap.get(cid)!);
        used.add(cid);
      }
    }
    // Safety: any session still not placed (shouldn't happen) goes last.
    for (const id of desiredOrder) {
      if (!used.has(id) && sessionMap.has(id)) {
        ordered.push(sessionMap.get(id)!);
        used.add(id);
      }
    }

    // Don't overwrite committed order during an in-flight animation —
    // the animation owns the position snapshot and will update on completion.
    if (!isAnimatingRef.current) {
      committedOrderRef.current = ordered.map((s) => s.info.id);
    }
    return ordered;
  })();

  // Splice team children back into sortedSessions after their parent.
  // Children follow the parent that has activeSubagents in the same workspace.
  // If no unique parent is found, children go at the end.
  const sortedWithChildren = (() => {
    if (teamChildren.length === 0) return sortedSessions;
    // Build workspace→parent index (only parents with active subagents)
    const parentByWs = new Map<string, { id: string; count: number }>();
    for (const p of sortedSessions) {
      if ((p.info.activeSubagents ?? 0) > 0 || p.hasSubagents) {
        const entry = parentByWs.get(p.info.workspace);
        if (entry) {
          entry.count++; // multiple parents — ambiguous
        } else {
          parentByWs.set(p.info.workspace, { id: p.info.id, count: 1 });
        }
      }
    }
    // Assign children to parents
    const childrenByParent = new Map<string, EnrichedSession[]>();
    const orphans: EnrichedSession[] = [];
    for (const child of teamChildren) {
      const cw = child.info.workspace;
      let assigned = false;
      for (const [pw, entry] of parentByWs) {
        if (entry.count === 1 && (cw === pw || cw.startsWith(pw + "/"))) {
          const list = childrenByParent.get(entry.id) ?? [];
          list.push(child);
          childrenByParent.set(entry.id, list);
          assigned = true;
          break;
        }
      }
      if (!assigned) orphans.push(child);
    }
    // Build final list: insert children right after their parent
    const result: EnrichedSession[] = [];
    for (const s of sortedSessions) {
      result.push(s);
      const kids = childrenByParent.get(s.info.id);
      if (kids) result.push(...kids);
    }
    result.push(...orphans);
    return result;
  })();

  // Keep refs to latest values so the timer callback can re-check
  const activeSessionsRef = useRef(activeSessions);
  activeSessionsRef.current = activeSessions;
  const desiredOrderRef = useRef(desiredOrder);
  desiredOrderRef.current = desiredOrder;

  // Invariant check: no active (non-quiescent) session should sit below a
  // settled (quiescent) session in the committed order. Violated when a
  // session starts a turn while below settled ones — or when a new session
  // lands at the bottom already active. Treated as a reorder trigger so
  // actives always bubble above settled.
  let invariantViolated = false;
  {
    let sawSettled = false;
    for (const s of sortedSessions) {
      if (isQuiescent(effectiveState(s))) {
        sawSettled = true;
      } else if (sawSettled) {
        invariantViolated = true;
        break;
      }
    }
  }

  // Reorder trigger: fires on turn end OR invariant violation. Debounced
  // 200ms so near-simultaneous transitions collapse into one FLIP animation.
  // Uses `turnEndTimerRef.current === null` as the coalescing guard so we
  // don't endlessly reschedule while the invariant keeps being true each
  // render — the first detection schedules, subsequent renders no-op until
  // the timer fires. Between triggers, the display stays pinned.
  if ((turnEndDetected || invariantViolated) && autoReorder && turnEndTimerRef.current === null) {
    turnEndTimerRef.current = setTimeout(() => {
      turnEndTimerRef.current = null;
      if (isAnimatingRef.current) return;
      const curKey = committedOrderRef.current.join(",");
      const desKey = desiredOrderRef.current.join(",");
      if (curKey === desKey) return;
      committedOrderRef.current = [...desiredOrderRef.current];
      setReorderTick((t) => t + 1);
    }, 200);
  }

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
    // animation owns cardPositions. Flag the pending reorder so the in-flight
    // run's finally retriggers this effect; without that, a reorder that
    // arrives mid-animation is silently dropped (cardPositions gets written
    // from post-animation DOM, so the re-run sees a no-op diff).
    if (isAnimatingRef.current) {
      pendingReorderRef.current = true;
      return;
    }

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
    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const movers: {
      el: HTMLElement;
      dy: number;
      idx: number;
      domTop: number;
      height: number;
    }[] = [];
    // New cards — ones that didn't exist in the prior snapshot. They animate
    // with a "door opens + rise up" entrance in their correct slot (not a
    // FLIP slide from a previous position, since they have none).
    const newCards: { el: HTMLElement; height: number }[] = [];

    cards.forEach((el, idx) => {
      const id = el.dataset.sessionId!;
      const oldRect = prev.get(id);
      const newRect = el.getBoundingClientRect();
      if (!oldRect) {
        // Fresh session entering — hide it IMMEDIATELY (pre-paint) so the
        // existing reorder swaps can land without the new card's content
        // flashing in its final slot. While the swaps run, two "door" panels
        // matching the app background cover the slot so it reads as negative
        // space between the shuffling cards. When the swap queue drains,
        // runSpawns slides the doors apart and rises the card up through the
        // gap. Skipped under prefers-reduced-motion.
        if (!prefersReducedMotion) {
          const cardInner = el.querySelector<HTMLElement>(".session-card");
          if (cardInner) {
            cardInner.style.opacity = "0";
            cardInner.style.transform = "translateY(100%) scale(0.96)";
            cardInner.style.transformOrigin = "50% 0%";
            cardInner.style.willChange = "transform, opacity";
          }
          newCards.push({ el, height: newRect.height });
        }
        return;
      }
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

    if (movers.length === 0 && newCards.length === 0) {
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
    isQuiescenceReorderRef.current = false;

    // ─── Sequential adjacent-swap choreography ───
    // Instead of animating every card simultaneously to its new slot, we
    // decompose the permutation (prev order → next order) into a sequence
    // of adjacent swaps and play them one pair at a time. Each swap: the
    // two cards translate in opposite directions, passing through each
    // other in the same column (temporary overlap during crossing is fine;
    // they never land on the same slot). Reads as walking a card up the
    // ladder rung by rung — the exact feel the user asked for.
    //
    // Algorithm: selection sort from the top. For each target slot i, find
    // the card that belongs there and bubble it up via adjacent swaps with
    // its upper neighbors. This groups swaps by "this card is climbing"
    // so the eye can follow one traveler at a time.

    // Build element / position maps. nextRect captures the card's current
    // DOM-layout geometry (top + height); virtualY starts at its prev-snapshot
    // top so the pre-paint can hold cards in their old visual positions.
    const elById = new Map<string, HTMLElement>();
    const nextRectById = new Map<string, DOMRect>();
    const nextOrderAll: string[] = [];
    cards.forEach((el) => {
      const id = el.dataset.sessionId!;
      elById.set(id, el);
      nextRectById.set(id, el.getBoundingClientRect());
      nextOrderAll.push(id);
    });
    const prevEntries = [...prev.entries()]
      .filter(([id]) => elById.has(id))
      .sort((a, b) => a[1].top - b[1].top);
    const prevOrder = prevEntries.map(([id]) => id);

    // Initial translateY per existing card = prevTop - nextTop. After all
    // swaps, each card's dy must decay to 0 so the cleanup phase (which
    // clears transforms) doesn't cause a visible snap.
    const dyById = new Map<string, number>();
    for (const [id, rect] of prevEntries) {
      const nextTop = nextRectById.get(id)?.top ?? 0;
      dyById.set(id, rect.top - nextTop);
    }

    // Selection-sort swap sequence. Each entry is an adjacent pair
    // [upperId, lowerId] that will trade visual slots. Produced top-down
    // so consecutive swaps describe one card climbing up the ladder.
    const working = [...prevOrder];
    const nextOrderExisting = nextOrderAll.filter((id) => prev.has(id));
    const swaps: [string, string][] = [];
    for (let target = 0; target < nextOrderExisting.length; target++) {
      const desired = nextOrderExisting[target];
      const cur = working.indexOf(desired);
      if (cur === -1 || cur === target) continue;
      for (let j = cur; j > target; j--) {
        const upper = working[j - 1];
        const lower = working[j];
        swaps.push([upper, lower]);
        working[j - 1] = lower;
        working[j] = upper;
      }
    }

    // Inter-card gap in the current layout (derived from first two siblings).
    // Used along with per-card heights to compute the pixel delta of each
    // adjacent swap: upper moves DOWN by (lower's height + gap); lower moves
    // UP by (upper's height + gap). For uniform heights these are equal and
    // the two cards pass through each other symmetrically.
    let gap = 0;
    if (nextOrderAll.length >= 2) {
      const r0 = nextRectById.get(nextOrderAll[0])!;
      const r1 = nextRectById.get(nextOrderAll[1])!;
      gap = Math.max(0, r1.top - (r0.top + r0.height));
    }

    // Pre-paint: hold every existing card at its prev visual position via
    // translateY. DOM has already rendered in next order, so without this
    // there would be one paint at the final slots before swaps begin. Pure
    // transform, compositor-only — child canvases keep rendering.
    for (const id of prevOrder) {
      const el = elById.get(id)!;
      el.style.willChange = "transform";
      el.style.transform = `translateY(${dyById.get(id) ?? 0}px)`;
    }

    // Swap motion config. Two cards passing through each other use a true
    // symmetric ease-in-out (S-curve): slow start, accelerate as they cross,
    // decelerate to settle. Duration is long enough (~500ms) for the eye to
    // track the trade without feeling sluggish; consecutive swaps still chain
    // into a continuous walk when the same card climbs multiple rungs.
    const SWAP_DUR = 520;
    const SWAP_EASING = "cubic-bezier(0.65, 0, 0.35, 1)";
    const SWAP_GAP = 40; // ms beat between swaps so the pair reads as discrete

    const cleanupExistingTransforms = () => {
      for (const id of prevOrder) {
        const el = elById.get(id);
        if (!el) continue;
        el.style.transform = "";
        el.style.willChange = "";
      }
    };

    // ─── New-card spawn phase (runs after swap queue drains) ───
    //
    // Sliding-doors reveal: two panels the color of the app background cover
    // the new card's slot — reading as negative space between the already-
    // settled cards. The panels slide apart vertically (top panel up, bottom
    // panel down) and the card rises from below its slot up through the
    // opening gap. Door glide and card rise overlap for continuity.
    const DOOR_DUR = 420;
    const RISE_DUR = 720;
    const RISE_DELAY = 180;
    const SPAWN_EASING = "cubic-bezier(0.37, 0, 0.63, 1)";
    const doorNodes: HTMLDivElement[] = [];
    const cleanupSpawnState = () => {
      for (const nc of newCards) {
        const cardInner = nc.el.querySelector<HTMLElement>(".session-card");
        if (cardInner) {
          cardInner.style.opacity = "";
          cardInner.style.transform = "";
          cardInner.style.transformOrigin = "";
          cardInner.style.willChange = "";
        }
        nc.el.style.position = "";
        nc.el.style.overflow = "";
      }
      for (const door of doorNodes) {
        if (door.parentNode) door.parentNode.removeChild(door);
      }
      doorNodes.length = 0;
    };

    const runSpawns = async () => {
      const spawnAnims: Animation[] = [];
      for (const nc of newCards) {
        const { el } = nc;
        if (!el.isConnected) continue;
        const cardInner = el.querySelector<HTMLElement>(".session-card");
        if (!cardInner) continue;

        // Door container — absolute over the slot, clips the rising card so
        // it stays visually inside the reveal gap instead of overflowing the
        // slot boundaries. Sits above the card (z:5) so doors cover the
        // card's travel through the lower half of the slot. `overflow:hidden`
        // on el keeps the translated card from bleeding into the neighbor
        // below while it's still sitting outside its slot.
        el.style.position = "relative";
        el.style.overflow = "hidden";
        const doorContainer = document.createElement("div");
        doorContainer.style.cssText =
          "position:absolute;inset:0;pointer-events:none;z-index:5;" +
          "overflow:hidden;border-radius:inherit;";
        const topDoor = document.createElement("div");
        topDoor.style.cssText =
          "position:absolute;left:0;right:0;top:0;height:50%;" +
          "background:var(--app-bg);box-shadow:0 1px 0 rgba(255,255,255,0.04);" +
          "will-change:transform;";
        const bottomDoor = document.createElement("div");
        bottomDoor.style.cssText =
          "position:absolute;left:0;right:0;bottom:0;height:50%;" +
          "background:var(--app-bg);box-shadow:0 -1px 0 rgba(255,255,255,0.04);" +
          "will-change:transform;";
        doorContainer.appendChild(topDoor);
        doorContainer.appendChild(bottomDoor);
        el.appendChild(doorContainer);
        doorNodes.push(doorContainer);

        const topDoorAnim = topDoor.animate(
          [
            { transform: "translateY(0)" },
            { transform: "translateY(-100%)" },
          ],
          { duration: DOOR_DUR, easing: SPAWN_EASING, fill: "forwards" },
        );
        const bottomDoorAnim = bottomDoor.animate(
          [
            { transform: "translateY(0)" },
            { transform: "translateY(100%)" },
          ],
          { duration: DOOR_DUR, easing: SPAWN_EASING, fill: "forwards" },
        );
        spawnAnims.push(topDoorAnim, bottomDoorAnim);

        const riseAnim = cardInner.animate(
          [
            { opacity: 0, transform: "translateY(100%) scale(0.96)", offset: 0 },
            { opacity: 0.7, transform: "translateY(42%) scale(0.98)", offset: 0.45 },
            { opacity: 1, transform: "translateY(0px) scale(1)", offset: 1 },
          ],
          {
            duration: RISE_DUR,
            delay: RISE_DELAY,
            easing: SPAWN_EASING,
            // `both`: hold start state during delay AND end state after, so
            // the card doesn't snap back to its pre-paint translateY(100%)
            // in the tick between animation end and cleanup clearing inline
            // styles.
            fill: "both",
          },
        );
        spawnAnims.push(riseAnim);
      }
      if (spawnAnims.length > 0) {
        await Promise.all(spawnAnims.map((a) => a.finished.catch(() => null)));
      }
    };

    // Under reduced motion, skip the swap animation entirely — cards land
    // in their new slots instantly. New-card spawns also collapse to an
    // instant reveal (the rise animation's `fill: backwards` makes this
    // work because we never start it).
    if (prefersReducedMotion) {
      cleanupExistingTransforms();
      cleanupSpawnState();
      const allCards = list.querySelectorAll<HTMLElement>("[data-session-id]");
      const positions = new Map<string, DOMRect>();
      const ids: string[] = [];
      allCards.forEach((c) => {
        positions.set(c.dataset.sessionId!, c.getBoundingClientRect());
        ids.push(c.dataset.sessionId!);
      });
      cardPositions.current = positions;
      committedOrderRef.current = ids;
      isAnimatingRef.current = false;
      setReorderTick((t) => t + 1);
      return;
    }

    const runSequence = async () => {
      try {
        for (const [upperId, lowerId] of swaps) {
          if (animationGenRef.current !== gen) return;
          const elU = elById.get(upperId);
          const elL = elById.get(lowerId);
          if (!elU || !elL || !elU.isConnected || !elL.isConnected) continue;

          const hU = nextRectById.get(upperId)?.height ?? 0;
          const hL = nextRectById.get(lowerId)?.height ?? 0;

          const curDyU = dyById.get(upperId) ?? 0;
          const curDyL = dyById.get(lowerId) ?? 0;
          // Upper moves DOWN by (lower's height + gap); lower moves UP by
          // (upper's height + gap). Uniform-height cards pass through each
          // other symmetrically; non-uniform heights still produce a valid
          // adjacent swap because total span of the two slots is conserved.
          const newDyU = curDyU + (hL + gap);
          const newDyL = curDyL - (hU + gap);

          const aU = elU.animate(
            [
              { transform: `translateY(${curDyU}px)` },
              { transform: `translateY(${newDyU}px)` },
            ],
            { duration: SWAP_DUR, easing: SWAP_EASING, fill: "forwards" },
          );
          const aL = elL.animate(
            [
              { transform: `translateY(${curDyL}px)` },
              { transform: `translateY(${newDyL}px)` },
            ],
            { duration: SWAP_DUR, easing: SWAP_EASING, fill: "forwards" },
          );
          await Promise.all([aU.finished, aL.finished]);
          if (animationGenRef.current !== gen) return;

          // Bake the end state into inline transform, then cancel the WAAPI
          // effect so it doesn't stack with subsequent swaps on the same card.
          elU.style.transform = `translateY(${newDyU}px)`;
          elL.style.transform = `translateY(${newDyL}px)`;
          aU.cancel();
          aL.cancel();

          dyById.set(upperId, newDyU);
          dyById.set(lowerId, newDyL);

          // Tiny beat between swaps so each pair reads as its own event.
          if (SWAP_GAP > 0) {
            await new Promise((r) => setTimeout(r, SWAP_GAP));
          }
        }

        // All swaps complete — spawn new cards into the settled order.
        if (animationGenRef.current === gen) {
          await runSpawns();
        }
      } finally {
        // If a reorder was requested mid-flight, the latest sortKey no longer
        // matches the DOM we just animated toward. Capture cards' *current*
        // visual positions (getBoundingClientRect reflects applied transforms)
        // as the "from" snapshot BEFORE clearing transforms — the re-run can
        // then diff against the new DOM layout and animate from where cards
        // visually are, avoiding a snap.
        if (pendingReorderRef.current && animationGenRef.current === gen) {
          const liveCards = list.querySelectorAll<HTMLElement>("[data-session-id]");
          const livePositions = new Map<string, DOMRect>();
          liveCards.forEach((c) => {
            livePositions.set(c.dataset.sessionId!, c.getBoundingClientRect());
          });
          cardPositions.current = livePositions;
          cleanupExistingTransforms();
          cleanupSpawnState();
          isAnimatingRef.current = false;
          pendingReorderRef.current = false;
          setReorderTick((t) => t + 1);
          return;
        }
        cleanupExistingTransforms();
        cleanupSpawnState();
        if (animationGenRef.current !== gen) return;
        isAnimatingRef.current = false;
        const allCards = list.querySelectorAll<HTMLElement>("[data-session-id]");
        const positions = new Map<string, DOMRect>();
        const ids: string[] = [];
        allCards.forEach((c) => {
          const cid = c.dataset.sessionId!;
          positions.set(cid, c.getBoundingClientRect());
          ids.push(cid);
        });
        cardPositions.current = positions;
        committedOrderRef.current = ids;
        setReorderTick((t) => t + 1);
      }
    };

    void runSequence();

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

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<{ animation: string }>("keyboard-animation", (event) => {
      handler(event.payload);
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Helper to update a setting and persist immediately


  // State button color mapping for sandbox controls
  const SANDBOX_STATE_COLORS: Record<string, string> = {
    working: "bg-white/15 text-white/80 hover:bg-white/25",
    thinking: "bg-orange-400/20 text-orange-400 hover:bg-orange-400/30",
    waiting: "bg-yellow-400/20 text-yellow-400 hover:bg-yellow-400/30",
    error: "bg-red-500/20 text-red-500 hover:bg-red-500/30",
    subagent: "bg-[#7CC5FF]/20 text-[#7CC5FF] hover:bg-[#7CC5FF]/30",
    compacting: "bg-[#8B9FD4]/20 text-[#8B9FD4] hover:bg-[#8B9FD4]/30",
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
          <div ref={listRef} className={`flex-1 ${compactMode ? "overflow-visible p-2 space-y-1.5" : "overflow-y-auto sessions-scroll p-4 pb-12 space-y-3"}`}>
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
                    <SessionCard session={effectiveSession} titleAnimation={titleAnimation} animationSpeed={animationSpeed} randomAnimation={randomAnimation} signalString={lowPower ? false : signalString} signalFrequency={signalFrequency} signalMode={signalMode} signalAlpha={signalAlpha} signalAmplitude={signalAmplitude} signalEcho={signalEcho} signalBass={signalBass} signalMids={signalMids} signalTreble={signalTreble} signalColorDark={signalColorDark} signalColorLight={signalColorLight} signalOffset={signalOffset} signalEffect={lowPower ? "string" : signalEffect} sandEnabled={lowPower ? false : sandEnabled} sandIntensity={sandIntensity} sandDirection={sandDirection} sandDensity={sandDensity} sandSpeed={sandSpeed} sandGrainSize={sandGrainSize} sandTurbulence={sandTurbulence} sandAlpha={sandAlpha} fluxEnabled={lowPower ? false : fluxEnabled} fluxAlpha={fluxAlpha} fluxIntensity={fluxIntensity} fluxDensity={fluxDensity} fluxSpeed={fluxSpeed} fluxLineLength={fluxLineLength} fluxTurbulence={fluxTurbulence} auroraEnabled={lowPower ? false : auroraEnabled} auroraAlpha={auroraAlpha} auroraSpeed={auroraSpeed} cordRetractDelay={cordRetractDelay} cordDeployForce={cordDeployForce} cordRetractForce={cordRetractForce} stringSpread={stringSpread} stringDeployAngle={stringDeployAngle} keyPressSpeed={keyPressSpeed} keyReleaseSpeed={keyReleaseSpeed} compactMode={compactMode} slimMode={slimMode} contextThreshold={contextThreshold} contextDisplay={contextDisplay} showToolPills={showToolPills} showCurrentTool={showCurrentTool} showConfigCounts={showConfigCounts} showToolCallComets={showToolCallComets} timerDisplay={timerDisplay} lowPower={lowPower} />
                  </div>

                  {/* Per-session state controls — hidden in screenshot mode */}
                  {isSelected && !screenshotMode && (() => {
                    const subagentCount = session.info.activeSubagents ?? session.metrics.subagents.length ?? 0;
                    const canRemoveSub = subagentCount > 0;
                    return (
                    <div className="flex items-center gap-1 px-2 py-1 rounded-b-lg bg-amber-500/5 border border-t-0 border-amber-500/15 -mt-px">
                      {SANDBOX_STATES.filter((st) => st !== "subagent").map((st) => {
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
                      {/* Subagent add/remove pair (replaces single Subagent toggle) */}
                      <button
                        onClick={() => addSandboxSubagent(session.info.id)}
                        title="Add subagent (switches state to Subagent)"
                        className={`px-1.5 py-0.5 rounded text-[0.55rem] font-medium transition-colors ${SANDBOX_STATE_COLORS.subagent}`}
                      >
                        <span className="opacity-50 mr-0.5">+</span>
                        Sub{subagentCount > 0 ? ` (${subagentCount})` : ""}
                      </button>
                      <button
                        onClick={() => canRemoveSub && removeSandboxSubagent(session.info.id)}
                        disabled={!canRemoveSub}
                        title={canRemoveSub ? "Remove last subagent (LIFO; reverts to Working at 0)" : "No subagents to remove"}
                        className={`px-1.5 py-0.5 rounded text-[0.55rem] font-medium transition-colors ${
                          canRemoveSub
                            ? SANDBOX_STATE_COLORS.subagent
                            : "bg-white/5 text-white/20 cursor-not-allowed"
                        }`}
                      >
                        <span className="opacity-50 mr-0.5">−</span>
                        Sub
                      </button>
                      {/* Simulate a tool call — fires a comet tracer. Flips
                          to Working if the session isn't already active. */}
                      <button
                        onClick={() => fireSandboxToolCall(session.info.id)}
                        title="Simulate a tool call (fires a comet)"
                        className="px-1.5 py-0.5 rounded text-[0.55rem] font-medium transition-colors bg-white/10 text-white/70 hover:bg-white/20"
                      >
                        <span className="opacity-50 mr-0.5">→</span>
                        Tool call
                      </button>
                      <div className="ml-auto">
                        <button
                          onClick={() => removeSandboxSession(session.info.id)}
                          className="px-1.5 py-0.5 rounded text-[0.55rem] text-red-400/40 hover:text-red-400 hover:bg-red-500/15 transition-colors"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Branch view: show side-by-side layout when window is wide enough and
  // team children exist.
  // ---------------------------------------------------------------------------
  const hasTeamChildren = teamChildren.length > 0;
  const showBranchView = branchView && hasTeamChildren && !compactMode;

  // Collect card settings for BranchView passthrough
  const cardSettings: CardSettings = {
    titleAnimation, animationSpeed, randomAnimation,
    signalString: lowPower ? false : signalString,
    signalFrequency, signalMode, signalAlpha, signalAmplitude, signalEcho,
    signalBass, signalMids, signalTreble, signalColorDark, signalColorLight,
    signalOffset, signalEffect: lowPower ? "string" : signalEffect,
    sandEnabled: lowPower ? false : sandEnabled,
    sandIntensity, sandDirection, sandDensity, sandSpeed, sandGrainSize,
    sandTurbulence, sandAlpha,
    fluxEnabled: lowPower ? false : fluxEnabled,
    fluxAlpha, fluxIntensity, fluxDensity, fluxSpeed, fluxLineLength, fluxTurbulence,
    auroraEnabled: lowPower ? false : auroraEnabled,
    auroraAlpha, auroraSpeed,
    cordRetractDelay, cordDeployForce,
    cordRetractForce, stringSpread, stringDeployAngle, keyPressSpeed, keyReleaseSpeed,
    compactMode, slimMode, contextThreshold, contextDisplay,
    showToolPills, showCurrentTool, showConfigCounts, showToolCallComets, timerDisplay,
  };

  // ---------------------------------------------------------------------------
  // Normal mode render
  // ---------------------------------------------------------------------------
  return (
    <div className={compactMode ? "flex flex-col" : "flex flex-col flex-1 min-h-0"}>
      {/* Session list or empty state */}
      {sessions.length === 0 && revivedSessions.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-white/60 gap-2">
          <span className="text-4xl">○</span>
          <span className="text-lg font-medium">No Active Sessions</span>
          <span className="text-sm text-white/40">Sessions will appear here when Claude Code is running</span>
        </div>
      ) : (
        <div ref={listRef} className={`flex-1 ${compactMode ? "overflow-visible p-2 space-y-1.5" : "overflow-y-auto sessions-scroll p-4 pb-12 space-y-3"}`}>
          {/* Empty active sessions message */}
          {sessions.length === 0 && revivedSessions.length > 0 && (
            <div className="flex flex-col items-center justify-center text-white/60 gap-2 py-12">
              <span className="text-4xl">○</span>
              <span className="text-lg font-medium">No Active Sessions</span>
              <span className="text-sm text-white/40">Sessions will appear here when Claude Code is running</span>
            </div>
          )}
          {/* Active sessions — branch view or vertical stack */}
          {showBranchView ? (
            <BranchView
              sessions={sortedWithChildren}
              cardSettings={cardSettings}
              compactMode={compactMode}
              expandOverrides={expandOverrides}
              onExpandCycle={(id) => {
                setExpandOverrides((prev) => {
                  const current = prev[id] ?? 0;
                  const next = (current + 1) % 3;
                  if (next === 0) { const copy = { ...prev }; delete copy[id]; return copy; }
                  return { ...prev, [id]: next };
                });
              }}
            />
          ) : (() => {
            // Compute which displayTitles appear more than once
            const titleCounts = new Map<string, number>();
            for (const s of sortedWithChildren) {
              titleCounts.set(s.displayTitle, (titleCounts.get(s.displayTitle) ?? 0) + 1);
            }
            const duplicateTitles = new Set(
              [...titleCounts.entries()].filter(([, count]) => count > 1).map(([title]) => title)
            );
            return sortedWithChildren.map((session, idx) => {
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
                <SessionCard session={effectiveSession} titleAnimation={titleAnimation} animationSpeed={animationSpeed} randomAnimation={randomAnimation} signalString={lowPower ? false : signalString} signalFrequency={signalFrequency} signalMode={signalMode} signalAlpha={signalAlpha} signalAmplitude={signalAmplitude} signalEcho={signalEcho} signalBass={signalBass} signalMids={signalMids} signalTreble={signalTreble} signalColorDark={signalColorDark} signalColorLight={signalColorLight} signalOffset={signalOffset} signalEffect={lowPower ? "string" : signalEffect} sandEnabled={lowPower ? false : sandEnabled} sandIntensity={sandIntensity} sandDirection={sandDirection} sandDensity={sandDensity} sandSpeed={sandSpeed} sandGrainSize={sandGrainSize} sandTurbulence={sandTurbulence} sandAlpha={sandAlpha} fluxEnabled={lowPower ? false : fluxEnabled} fluxAlpha={fluxAlpha} fluxIntensity={fluxIntensity} fluxDensity={fluxDensity} fluxSpeed={fluxSpeed} fluxLineLength={fluxLineLength} fluxTurbulence={fluxTurbulence} auroraEnabled={lowPower ? false : auroraEnabled} auroraAlpha={auroraAlpha} auroraSpeed={auroraSpeed} cordRetractDelay={cordRetractDelay} cordDeployForce={cordDeployForce} cordRetractForce={cordRetractForce} stringSpread={stringSpread} stringDeployAngle={stringDeployAngle} keyPressSpeed={keyPressSpeed} keyReleaseSpeed={keyReleaseSpeed} compactMode={compactMode} slimMode={slimMode} contextThreshold={contextThreshold} contextDisplay={contextDisplay} showToolPills={showToolPills} showCurrentTool={showCurrentTool} showConfigCounts={showConfigCounts} showToolCallComets={showToolCallComets} timerDisplay={timerDisplay} lowPower={lowPower} isDuplicate={duplicateTitles.has(session.displayTitle)} expandOverride={compactMode ? expandOverrides[session.info.id] : undefined} onExpandCycle={compactMode ? () => {
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
                      <SessionCard session={revived.session} titleAnimation="none" signalString={signalString} signalFrequency={signalFrequency} signalMode={signalMode} signalAlpha={signalAlpha} signalAmplitude={signalAmplitude} signalEcho={signalEcho} signalBass={signalBass} signalMids={signalMids} signalTreble={signalTreble} signalColorDark={signalColorDark} signalColorLight={signalColorLight} signalOffset={signalOffset} signalEffect={signalEffect} sandEnabled={sandEnabled} sandIntensity={sandIntensity} sandDirection={sandDirection} sandDensity={sandDensity} sandSpeed={sandSpeed} sandGrainSize={sandGrainSize} sandTurbulence={sandTurbulence} sandAlpha={sandAlpha} fluxEnabled={fluxEnabled} fluxAlpha={fluxAlpha} fluxIntensity={fluxIntensity} fluxDensity={fluxDensity} fluxSpeed={fluxSpeed} fluxLineLength={fluxLineLength} fluxTurbulence={fluxTurbulence} auroraEnabled={auroraEnabled} auroraAlpha={auroraAlpha} auroraSpeed={auroraSpeed} revived />
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
