import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EnrichedSession, Settings, SignalPreset } from "@/lib/types";
import { loadPreset as loadPresetEngine, isLoaded as isPresetLoaded, setGate as setGateEngine } from "@/lib/presetEngine";
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
  const [titleAnimation, setTitleAnimation] = useState("none");
  const [animationSpeed, setAnimationSpeed] = useState(1.2);
  const [randomAnimation, setRandomAnimation] = useState(false);
  const [signalString, setSignalString] = useState(false);
  const [signalFrequency, setSignalFrequency] = useState(1.0);
  const [signalMode, setSignalMode] = useState("simulated");
  const [signalAlpha, setSignalAlpha] = useState(0.25);
  const [signalAmplitude, setSignalAmplitude] = useState(0.25);
  const [signalEcho, setSignalEcho] = useState(1.0);
  const [signalBass, setSignalBass] = useState(true);
  const [signalMids, setSignalMids] = useState(true);
  const [signalTreble, setSignalTreble] = useState(true);
  const [signalColorDark, setSignalColorDark] = useState("#ffffff");
  const [signalColorLight, setSignalColorLight] = useState("#000000");
  const [signalOffset, setSignalOffset] = useState(0.5);
  const [particleEnabled, setParticleEnabled] = useState(true);
  const [particleSpeed, setParticleSpeed] = useState(1.0);
  const [particleRate, setParticleRate] = useState(1.0);
  const [particleSparks, setParticleSparks] = useState(3);
  const [activePresetId, setActivePresetId] = useState("");
  const [presetBootAttempted, setPresetBootAttempted] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const testState = "working" as const;
  const [keyPressSpeed, setKeyPressSpeed] = useState(0.35);
  const [keyReleaseSpeed, setKeyReleaseSpeed] = useState(0.4);
  const [autoReorder, setAutoReorder] = useState(false);
  const cardPositions = useRef<Map<string, DOMRect>>(new Map());
  const prevStates = useRef<Map<string, string>>(new Map());
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

  // Load settings and poll for changes (so Signal Settings window edits sync)
  const applySettings = useCallback((s: Settings) => {
    setPermissionsEnabled(s.permissionsEnabled);
    setTitleAnimation(s.titleAnimation ?? "none");
    setAnimationSpeed(s.animationSpeed ?? 1.2);
    setRandomAnimation(s.randomAnimation ?? false);
    setSignalString(s.signalString ?? false);
    setSignalFrequency(s.signalFrequency ?? 1.0);
    const mode = s.signalMode === "audio" ? "preset" : (s.signalMode ?? "simulated");
    setSignalMode(mode);
    setSignalAlpha(s.signalAlpha ?? 0.25);
    setSignalAmplitude(s.signalAmplitude ?? 0.25);
    setSignalEcho(s.signalEcho ?? 1.0);
    setSignalBass(s.signalBass ?? true);
    setSignalMids(s.signalMids ?? true);
    setSignalTreble(s.signalTreble ?? true);
    setSignalColorDark(s.signalColorDark ?? "#ffffff");
    setSignalColorLight(s.signalColorLight ?? "#000000");
    setSignalOffset(s.signalOffset ?? 0.5);
    setParticleEnabled(s.particleEnabled ?? true);
    setParticleSpeed(s.particleSpeed ?? 1.0);
    setParticleRate(s.particleRate ?? 1.0);
    setParticleSparks(s.particleSparks ?? 3);
    setGateEngine(s.signalGate ?? 0.05);
    setActivePresetId(s.activePresetId ?? "");
    setKeyPressSpeed(s.keyPressSpeed ?? 0.35);
    setKeyReleaseSpeed(s.keyReleaseSpeed ?? 0.4);
    setAutoReorder(s.autoReorder ?? false);
    document.documentElement.style.setProperty("--font-scale", String(s.fontScale ?? 1.0));
    setTestMode(s.testMode ?? false);
  }, []);

  useEffect(() => {
    invoke<Settings>("get_settings").then(applySettings).catch(() => {});
    // Poll every 2s so changes from Signal Settings window sync live
    const id = setInterval(() => {
      invoke<Settings>("get_settings").then(applySettings).catch(() => {});
    }, 2000);
    return () => clearInterval(id);
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

  // Sort sessions: autoReorder moves working/waiting/error to top.
  // Without autoReorder: arrival order (oldest first).
  const sortedSessions = (() => {
    const all = testMode && testSession ? [...sessions, testSession] : [...sessions];
    if (autoReorder) {
      const priority = (s: EnrichedSession) => {
        const st = s.info.state;
        if (st === "waiting") return 0;
        if (st === "error") return 1;
        if (st === "working" || st === "subagent") return 2;
        return 3;
      };
      return all.sort((a, b) => {
        const pa = priority(a);
        const pb = priority(b);
        if (pa !== pb) return pa - pb;
        return b.info.lastActivity - a.info.lastActivity;
      });
    }
    return all.sort((a, b) => a.info.startedAt - b.info.startedAt);
  })();

  // FLIP animation — only active when autoReorder is on
  const sortKey = sortedSessions.map(s => s.info.id).join(",");
  const stateKey = sortedSessions.map(s => s.info.state).join(",");

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    if (autoReorder) {
      const prev = cardPositions.current;

      // Detect which sessions just transitioned to working/subagent
      const justBecameWorking = new Set<string>();
      for (const session of sortedSessions) {
        const id = session.info.id;
        const oldState = prevStates.current.get(id);
        const newState = session.info.state;
        if (
          (newState === "working" || newState === "subagent") &&
          oldState !== undefined &&
          oldState !== "working" && oldState !== "subagent"
        ) {
          justBecameWorking.add(id);
        }
      }

      // FLIP: DOM is updated but not yet painted
      if (prev.size > 0) {
        const cards = list.querySelectorAll<HTMLElement>("[data-session-id]");
        cards.forEach((el) => {
          const id = el.dataset.sessionId!;
          const oldRect = prev.get(id);
          if (!oldRect) return;
          const newRect = el.getBoundingClientRect();
          const dy = oldRect.top - newRect.top;
          if (Math.abs(dy) < 1) return;

          const isSliding = justBecameWorking.has(id) && dy < -10;
          const cardEl = el.querySelector<HTMLElement>(".session-card");

          if (isSliding && cardEl) {
            // Slide up as floating card, then snap key down on arrival
            cardEl.classList.remove("session-card--pressed");
            cardEl.classList.add("session-card--floating", "session-card--sliding");

            el.style.zIndex = "50";
            el.style.position = "relative";
            el.style.transform = `translateY(${dy}px)`;
            el.style.transition = "none";

            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                el.style.transition = "transform 500ms cubic-bezier(0.25, 0.1, 0.25, 1)";
                el.style.transform = "translateY(0)";

                const onSlideEnd = () => {
                  el.style.transition = "";
                  el.style.transform = "";
                  el.style.zIndex = "";
                  el.style.position = "";
                  el.removeEventListener("transitionend", onSlideEnd);
                  cardEl.classList.remove("session-card--sliding", "session-card--floating");
                  cardEl.classList.add("session-card--pressed");
                };
                el.addEventListener("transitionend", onSlideEnd);
              });
            });
          } else {
            // Normal FLIP for displaced cards
            el.style.transform = `translateY(${dy}px)`;
            el.style.transition = "none";

            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                el.style.transition = "transform 500ms cubic-bezier(0.25, 0.1, 0.25, 1)";
                el.style.transform = "translateY(0)";
                const cleanup = () => {
                  el.style.transition = "";
                  el.style.transform = "";
                  el.removeEventListener("transitionend", cleanup);
                };
                el.addEventListener("transitionend", cleanup);
              });
            });
          }
        });
      }
    }

    // Update state tracking
    const newStates = new Map<string, string>();
    for (const session of sortedSessions) {
      newStates.set(session.info.id, session.info.state);
    }
    prevStates.current = newStates;

    // Snapshot positions for next render
    const cards = list.querySelectorAll<HTMLElement>("[data-session-id]");
    const positions = new Map<string, DOMRect>();
    cards.forEach((el) => {
      const id = el.dataset.sessionId!;
      positions.set(id, el.getBoundingClientRect());
    });
    cardPositions.current = positions;
  }, [sortKey, stateKey, autoReorder]);

  // Keyboard animation handler — listens for Tauri events from keyboard window
  useEffect(() => {
    const handler = (payload: { animation: string }) => {
      const list = listRef.current;
      if (!list) return;
      const { animation } = payload;
      // Only animate idle/done sessions — skip working/subagent/waiting
      const cards = Array.from(list.querySelectorAll<HTMLElement>("[data-session-state]"))
        .filter((wrapper) => {
          const state = wrapper.dataset.sessionState;
          return state !== "working" && state !== "subagent" && state !== "waiting";
        })
        .map((wrapper) => wrapper.querySelector<HTMLElement>(".session-card"))
        .filter((el): el is HTMLElement => el !== null);
      if (cards.length === 0) return;

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
      }
    };

    let unlisten: (() => void) | undefined;
    listen<{ animation: string }>("keyboard-animation", (event) => {
      handler(event.payload);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Helper to update a setting and persist immediately

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
              <div key={session.info.id} data-session-id={session.info.id} data-session-state={session.info.state} className="space-y-2">
                <SessionCard session={session} titleAnimation={titleAnimation} animationSpeed={animationSpeed} randomAnimation={randomAnimation} signalString={signalString} signalFrequency={signalFrequency} signalMode={signalMode} signalAlpha={signalAlpha} signalAmplitude={signalAmplitude} signalEcho={signalEcho} signalBass={signalBass} signalMids={signalMids} signalTreble={signalTreble} signalColorDark={signalColorDark} signalColorLight={signalColorLight} signalOffset={signalOffset} particleEnabled={particleEnabled} particleSpeed={particleSpeed} particleRate={particleRate} particleSparks={particleSparks} keyPressSpeed={keyPressSpeed} keyReleaseSpeed={keyReleaseSpeed} />

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
                    <SessionCard session={revived.session} titleAnimation="none" signalString={signalString} signalFrequency={signalFrequency} signalMode={signalMode} signalAlpha={signalAlpha} signalAmplitude={signalAmplitude} signalEcho={signalEcho} signalBass={signalBass} signalMids={signalMids} signalTreble={signalTreble} signalColorDark={signalColorDark} signalColorLight={signalColorLight} signalOffset={signalOffset} particleEnabled={particleEnabled} particleSpeed={particleSpeed} particleRate={particleRate} particleSparks={particleSparks} revived />
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

        </div>
      )}
    </div>
  );
}
