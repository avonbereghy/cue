import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EnrichedSession, Settings, SignalPreset } from "@/lib/types";
import { TITLE_ANIMATIONS, ANIMATION_SPEEDS } from "@/lib/types";
import { loadPreset as loadPresetEngine, isLoaded as isPresetLoaded } from "@/lib/presetEngine";
import { formatTokens } from "@/lib/format";
import { StatBadge } from "./StatBadge";
import { SessionCard } from "./SessionCard";
import { PermissionPrompt } from "./PermissionPrompt";
import { PermissionHistory } from "./PermissionHistory";
import { usePermissions } from "@/hooks/usePermissions";

const REVIVED_STORAGE_KEY = "claude-cue-revived-sessions";

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

export function SessionsTab({ sessions }: SessionsTabProps) {
  const [permissionsEnabled, setPermissionsEnabled] = useState(false);
  const [titleAnimation, setTitleAnimation] = useState("flip");
  const [animationSpeed, setAnimationSpeed] = useState(1.2);
  const [randomAnimation, setRandomAnimation] = useState(false);
  const [signalString, setSignalString] = useState(false);
  const [signalFrequency, setSignalFrequency] = useState(1.0);
  const [signalMode, setSignalMode] = useState("simulated");
  const [signalAlpha, setSignalAlpha] = useState(1.0);
  const [signalAmplitude, setSignalAmplitude] = useState(0.5);
  const [signalEcho, setSignalEcho] = useState(0.5);
  const [activePresetId, setActivePresetId] = useState("");
  const [presetBootAttempted, setPresetBootAttempted] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [testState, setTestState] = useState<"working" | "idle">("working");
  const [sortLocked, setSortLocked] = useState(false);
  const [lockedOrder, setLockedOrder] = useState<string[]>([]);
  const cardPositions = useRef<Map<string, DOMRect>>(new Map());
  const listRef = useRef<HTMLDivElement>(null);
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(
    new Set(),
  );
  const [revivedSessions, setRevivedSessions] = useState<RevivedSession[]>(loadRevivedSessions);
  const [reviveClicks, setReviveClicks] = useState<Record<string, number>>({});
  const prevSessionIdsRef = useRef<Set<string>>(new Set());
  const prevSessionsRef = useRef<EnrichedSession[]>([]);

  // Track disappeared sessions (-> add to revived) and reappeared ones (-> remove from revived)
  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.info.id));
    const prevIds = prevSessionIdsRef.current;

    setRevivedSessions((prev) => {
      let next = prev;

      // Add newly disappeared sessions
      if (prevIds.size > 0) {
        const disappeared: RevivedSession[] = [];
        for (const id of prevIds) {
          if (!currentIds.has(id) && !prev.some((r) => r.session.info.id === id)) {
            const snapshot = prevSessionsRef.current.find((s) => s.info.id === id);
            if (snapshot) {
              disappeared.push({ session: snapshot, revivedAt: Date.now() });
            }
          }
        }
        if (disappeared.length > 0) {
          next = [...next, ...disappeared];
        }
      }

      // Remove revived sessions that reappeared (revive succeeded)
      const filtered = next.filter((r) => !currentIds.has(r.session.info.id));

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
    setRevivedSessions((prev) => {
      const next = prev.filter((r) => r.session.info.id !== sessionId);
      saveRevivedSessions(next);
      return next;
    });
  }, []);

  const handleClearAllRevived = useCallback(() => {
    setRevivedSessions([]);
    saveRevivedSessions([]);
  }, []);

  const totalMessages = sessions.reduce((sum, s) => sum + s.metrics.messageCount, 0);
  const totalTokens = sessions.reduce(
    (sum, s) => {
      const subTokens = (s.metrics.subagents ?? []).reduce(
        (sub, a) => sub + a.inputTokens + a.outputTokens, 0,
      );
      return sum + s.metrics.inputTokens + s.metrics.outputTokens + subTokens;
    },
    0,
  );
  const {
    pendingBySession,
    permissionHistory,
    approvePermission,
    denyPermission,
    refreshHistory,
  } = usePermissions();

  const totalPending = Object.values(pendingBySession).reduce(
    (sum, reqs) => sum + reqs.length,
    0,
  );

  // Check if permissions are enabled in settings
  useEffect(() => {
    invoke<Settings>("get_settings")
      .then((s) => {
        setPermissionsEnabled(s.permissionsEnabled);
        setTitleAnimation(s.titleAnimation ?? "flip");
        setAnimationSpeed(s.animationSpeed ?? 1.2);
        setRandomAnimation(s.randomAnimation ?? false);
        setSignalString(s.signalString ?? false);
        setSignalFrequency(s.signalFrequency ?? 1.0);
        // Backward compat: treat "audio" as "preset"
        const mode = s.signalMode === "audio" ? "preset" : (s.signalMode ?? "simulated");
        setSignalMode(mode);
        setSignalAlpha(s.signalAlpha ?? 1.0);
        setSignalAmplitude(s.signalAmplitude ?? 0.5);
        setSignalEcho(s.signalEcho ?? 0.5);
        setActivePresetId(s.activePresetId ?? "");
        setTestMode(s.testMode ?? false);
      })
      .catch(() => {});
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

  // Sort sessions: by priority (waiting > working > rest) unless locked
  const sortedSessions = (() => {
    if (sortLocked && lockedOrder.length > 0) {
      // Preserve locked order; new sessions go to end
      const orderMap = new Map(lockedOrder.map((id, i) => [id, i]));
      return [...sessions].sort((a, b) => {
        const ai = orderMap.get(a.info.id) ?? Infinity;
        const bi = orderMap.get(b.info.id) ?? Infinity;
        return ai - bi;
      });
    }
    return [...sessions].sort((a, b) => {
      const priority = (s: EnrichedSession) =>
        s.info.state === "waiting" ? 0 : s.info.state === "working" ? 1 : 2;
      return priority(a) - priority(b);
    });
  })();

  // Capture positions before render for FLIP animation
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // Snapshot current positions
    const cards = list.querySelectorAll<HTMLElement>("[data-session-id]");
    const prevPositions = new Map<string, DOMRect>();
    cards.forEach((el) => {
      const id = el.dataset.sessionId!;
      prevPositions.set(id, el.getBoundingClientRect());
    });
    cardPositions.current = prevPositions;
  });

  // FLIP animate after DOM updates
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const prev = cardPositions.current;
    if (prev.size === 0) return;

    const cards = list.querySelectorAll<HTMLElement>("[data-session-id]");
    cards.forEach((el) => {
      const id = el.dataset.sessionId!;
      const oldRect = prev.get(id);
      if (!oldRect) return;
      const newRect = el.getBoundingClientRect();
      const dy = oldRect.top - newRect.top;
      if (Math.abs(dy) < 1) return;

      // Invert: jump to old position
      el.style.transform = `translateY(${dy}px)`;
      el.style.transition = "none";

      // Play: animate to new position
      requestAnimationFrame(() => {
        el.style.transition = "transform 400ms cubic-bezier(0.25, 0.8, 0.25, 1)";
        el.style.transform = "";
        const cleanup = () => {
          el.style.transition = "";
          el.removeEventListener("transitionend", cleanup);
        };
        el.addEventListener("transitionend", cleanup);
      });
    });
  }, [sortedSessions.map(s => s.info.id).join(",")]);

  // Lock/unlock handler
  const toggleSortLock = useCallback(() => {
    if (sortLocked) {
      setSortLocked(false);
      setLockedOrder([]);
    } else {
      setSortLocked(true);
      setLockedOrder(sortedSessions.map(s => s.info.id));
    }
  }, [sortLocked, sortedSessions]);

  // Build synthetic test session when test mode is enabled
  const testSession: EnrichedSession | null = testMode ? {
    info: {
      id: "__test__",
      workspace: "/test/preview",
      state: testState,
      lastActivity: Date.now() / 1000,
      startedAt: Date.now() / 1000 - 300,
      source: "terminal",
    },
    metrics: {
      messageCount: 42,
      userMessageCount: 12,
      inputTokens: 156000,
      outputTokens: 24000,
      cacheCreationTokens: 8000,
      cacheReadTokens: 72000,
      model: "claude-sonnet-4-6",
      lastInputTokens: 156000,
      customTitle: "Test Session",
      gitBranch: "main",
      toolCounts: { Read: 15, Edit: 8, Bash: 6, Grep: 4 },
      subagents: [],
    },
    workspaceName: "preview",
    displayTitle: "Test Session",
    stateIcon: testState === "working" ? "\u27F3" : "\u25CB",
    stateDisplayName: testState === "working" ? "Working" : "Idle",
    durationSecs: 300,
    contextLimit: 1_000_000,
    contextUsagePercent: 0.156,
    modelDisplayName: "Sonnet 4.6",
    sourceDisplay: "Terminal",
    hasSubagents: false,
  } : null;

  // Helper to update a setting and persist immediately
  const updateSetting = useCallback(async (patch: Partial<Settings>) => {
    try {
      const current = await invoke<Settings>("get_settings");
      const updated = { ...current, ...patch };
      await invoke("update_settings", { newSettings: updated });
    } catch (err) {
      console.error("Failed to update setting:", err);
    }
  }, []);

  const hasContent = sessions.length > 0 || revivedSessions.length > 0 || testMode;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Stats header */}
      <div className="flex items-center gap-6 px-4 py-3 bg-white/5 border-b border-white/10">
        <StatBadge icon="●" label="Sessions" value={`${sessions.length}`} color="text-green-500" />
        <StatBadge icon="💬" label="Messages" value={`${totalMessages}`} color="text-blue-400" />
        <StatBadge icon="⇅" label="Tokens" value={formatTokens(totalTokens)} color="text-purple-400" />
        {totalPending > 0 && (
          <StatBadge icon="⏸" label="Pending" value={`${totalPending}`} color="text-yellow-400" />
        )}
        <div className="ml-auto">
          <button
            onClick={toggleSortLock}
            className={`flex items-center justify-center w-6 h-6 rounded transition-colors ${
              sortLocked
                ? "bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/25"
                : "bg-white/5 text-white/30 hover:text-white/50 hover:bg-white/10"
            }`}
            title={sortLocked ? "Unlock sort order" : "Lock current sort order"}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              {sortLocked ? (
                <>
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </>
              ) : (
                <>
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* Session list or empty state */}
      {!hasContent ? (
        <div className="flex-1 flex flex-col items-center justify-center text-white/40 gap-2">
          <span className="text-4xl">○</span>
          <span className="text-lg font-medium">No Active Sessions</span>
          <span className="text-sm">Sessions will appear here when Claude Code is running</span>
        </div>
      ) : (
        <div ref={listRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* Active sessions */}
          {sortedSessions.map((session) => {
            const pending = pendingBySession[session.info.id] ?? [];
            const history = permissionHistory[session.info.id] ?? [];
            const hasPermissionActivity = pending.length > 0 || history.length > 0;
            const isCollapsed = collapsedSessions.has(session.info.id);

            return (
              <div key={session.info.id} data-session-id={session.info.id} className="space-y-2">
                <SessionCard session={session} titleAnimation={titleAnimation} animationSpeed={animationSpeed} randomAnimation={randomAnimation} signalString={signalString} signalFrequency={signalFrequency} signalMode={signalMode} signalAlpha={signalAlpha} signalAmplitude={signalAmplitude} signalEcho={signalEcho} />

                {/* Permission section (when enabled and has activity) */}
                {permissionsEnabled && hasPermissionActivity && (
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
          })}

          {/* Test session */}
          {testMode && testSession && (
            <div data-session-id="__test__" className="space-y-2">
              <SessionCard session={testSession} titleAnimation={titleAnimation} animationSpeed={animationSpeed} randomAnimation={randomAnimation} signalString={signalString} signalFrequency={signalFrequency} signalMode={signalMode} signalAlpha={signalAlpha} signalAmplitude={signalAmplitude} signalEcho={signalEcho} />
            </div>
          )}

          {/* Revived (ended) sessions */}
          {revivedSessions.length > 0 && (
            <>
              <div className="flex items-center gap-3 pt-4 pb-1">
                <div className="flex-1 border-t border-red-500/20" />
                <span className="text-xs text-red-400/60 uppercase tracking-wider font-medium">
                  Ended Sessions
                </span>
                <div className="flex-1 border-t border-red-500/20" />
                <button
                  onClick={handleClearAllRevived}
                  className="text-xs text-red-400/50 hover:text-red-400 transition-colors px-2 py-0.5 rounded hover:bg-red-500/10"
                >
                  Clear All
                </button>
              </div>
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
                    <SessionCard session={revived.session} titleAnimation="none" signalString={signalString} signalFrequency={signalFrequency} signalMode={signalMode} signalAlpha={signalAlpha} signalAmplitude={signalAmplitude} signalEcho={signalEcho} revived />
                    <div className="absolute inset-0 flex items-center justify-center gap-3 z-10">
                      <span className="text-xs text-red-400/70 font-mono tabular-nums">
                        {formatReviveElapsed(revived.revivedAt)}
                      </span>
                      <button
                        onClick={() => handleReviveClick(revived.session)}
                        className={`px-4 py-2 rounded-lg text-white text-sm font-semibold transition-colors shadow-lg ${
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
                        className="px-3 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white/60 hover:text-white/80 text-sm transition-colors"
                        title="Dismiss"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {/* Test mode: inline animation settings */}
          {testMode && (
            <>
              <div className="flex items-center gap-3 pt-6 pb-2">
                <div className="flex-1 border-t border-white/10" />
                <span className="text-[10px] text-white/30 uppercase tracking-wider">
                  Test Settings
                </span>
                <div className="flex-1 border-t border-white/10" />
              </div>
              <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-2 space-y-2">
                {/* State toggle pills */}
                <div className="flex items-center justify-between gap-4 py-1">
                  <span className="text-xs text-white/70">Session State</span>
                  <div className="flex items-center gap-1">
                    {(["working", "idle"] as const).map((st) => (
                      <button
                        key={st}
                        onClick={() => setTestState(st)}
                        className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors ${
                          testState === st
                            ? st === "working"
                              ? "bg-white/20 text-white"
                              : "bg-gray-500/20 text-gray-400"
                            : "bg-white/5 text-white/30 hover:bg-white/10 hover:text-white/50"
                        }`}
                      >
                        {st === "working" ? "Working" : "Idle"}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Title Animation */}
                <div className="flex items-center justify-between gap-4 py-1">
                  <span className="text-xs text-white/70">Title Animation</span>
                  <select
                    value={titleAnimation}
                    onChange={(e) => {
                      setTitleAnimation(e.target.value);
                      updateSetting({ titleAnimation: e.target.value });
                    }}
                    className="bg-white/10 border border-white/10 rounded px-2 py-1 text-xs text-white/70 outline-none cursor-pointer hover:bg-white/15 transition-colors"
                  >
                    {TITLE_ANIMATIONS.map((a) => (
                      <option key={a.id} value={a.id} className="bg-neutral-800 text-white">{a.label}</option>
                    ))}
                  </select>
                </div>
                {/* Animation Speed */}
                <div className="flex items-center justify-between gap-4 py-1">
                  <span className="text-xs text-white/70">Speed</span>
                  <select
                    value={animationSpeed}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setAnimationSpeed(v);
                      updateSetting({ animationSpeed: v });
                    }}
                    className="bg-white/10 border border-white/10 rounded px-2 py-1 text-xs text-white/70 outline-none cursor-pointer hover:bg-white/15 transition-colors"
                  >
                    {ANIMATION_SPEEDS.map((s) => (
                      <option key={s.id} value={s.id} className="bg-neutral-800 text-white">{s.label}</option>
                    ))}
                  </select>
                </div>
                {/* Random Delays */}
                <div className="flex items-center justify-between gap-4 py-1">
                  <span className="text-xs text-white/70">Random Delays</span>
                  <button
                    onClick={() => {
                      const v = !randomAnimation;
                      setRandomAnimation(v);
                      updateSetting({ randomAnimation: v });
                    }}
                    className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${randomAnimation ? "bg-blue-500" : "bg-white/20"}`}
                    role="switch"
                    aria-checked={randomAnimation}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${randomAnimation ? "translate-x-4" : ""}`} />
                  </button>
                </div>
                {/* Signal String */}
                <div className="flex items-center justify-between gap-4 py-1">
                  <span className="text-xs text-white/70">Signal String</span>
                  <button
                    onClick={() => {
                      const v = !signalString;
                      setSignalString(v);
                      updateSetting({ signalString: v });
                    }}
                    className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${signalString ? "bg-blue-500" : "bg-white/20"}`}
                    role="switch"
                    aria-checked={signalString}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${signalString ? "translate-x-4" : ""}`} />
                  </button>
                </div>
                {signalString && (
                  <>
                    {/* Mode */}
                    <div className="flex items-center justify-between gap-4 py-1">
                      <span className="text-xs text-white/70">Mode</span>
                      <select
                        value={signalMode}
                        onChange={(e) => {
                          setSignalMode(e.target.value);
                          updateSetting({ signalMode: e.target.value });
                        }}
                        className="bg-white/10 border border-white/10 rounded px-2 py-1 text-xs text-white/70 outline-none cursor-pointer hover:bg-white/15 transition-colors"
                      >
                        <option value="simulated" className="bg-neutral-800 text-white">Simulated</option>
                        <option value="preset" className="bg-neutral-800 text-white">Preset</option>
                      </select>
                    </div>
                    {/* Opacity */}
                    <div className="flex items-center gap-2 py-1">
                      <span className="text-xs text-white/70 w-16 shrink-0">Opacity</span>
                      <span className="text-[10px] text-white/30 font-mono w-8 text-right shrink-0">{Math.round(signalAlpha * 100)}%</span>
                      <input type="range" min={0.05} max={1.0} step={0.01} value={signalAlpha}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          setSignalAlpha(v);
                          updateSetting({ signalAlpha: v });
                        }}
                        className="flex-1 h-1 rounded appearance-none cursor-pointer bg-white/10 accent-blue-500"
                      />
                    </div>
                    {/* Amplitude */}
                    <div className="flex items-center gap-2 py-1">
                      <span className="text-xs text-white/70 w-16 shrink-0">Amplitude</span>
                      <span className="text-[10px] text-white/30 font-mono w-8 text-right shrink-0">{signalAmplitude.toFixed(2)}x</span>
                      <input type="range" min={0.01} max={1.0} step={0.01} value={signalAmplitude}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          setSignalAmplitude(v);
                          updateSetting({ signalAmplitude: v });
                        }}
                        className="flex-1 h-1 rounded appearance-none cursor-pointer bg-white/10 accent-blue-500"
                      />
                    </div>
                    {/* Echo */}
                    <div className="flex items-center gap-2 py-1">
                      <span className="text-xs text-white/70 w-16 shrink-0">Echo</span>
                      <span className="text-[10px] text-white/30 font-mono w-8 text-right shrink-0">{Math.round(signalEcho * 50)}%</span>
                      <input type="range" min={0} max={2.0} step={0.01} value={signalEcho}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          setSignalEcho(v);
                          updateSetting({ signalEcho: v });
                        }}
                        className="flex-1 h-1 rounded appearance-none cursor-pointer bg-white/10 accent-blue-500"
                      />
                    </div>
                    {/* Frequency (simulated mode only) */}
                    {signalMode !== "preset" && (
                      <div className="flex items-center gap-2 py-1">
                        <span className="text-xs text-white/70 w-16 shrink-0">Frequency</span>
                        <span className="text-[10px] text-white/30 font-mono w-8 text-right shrink-0">{signalFrequency.toFixed(2)}x</span>
                        <input type="range" min={0.2} max={3.0} step={0.01} value={signalFrequency}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            setSignalFrequency(v);
                            updateSetting({ signalFrequency: v });
                          }}
                          className="flex-1 h-1 rounded appearance-none cursor-pointer bg-white/10 accent-blue-500"
                        />
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
