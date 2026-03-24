import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
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
  const [titleAnimation, setTitleAnimation] = useState("ripple");
  const [animationSpeed, setAnimationSpeed] = useState(3.5);
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
  const [particleAlpha, setParticleAlpha] = useState(1.0);
  const [cordRetractDelay, setCordRetractDelay] = useState(2.0);
  const [cordDeployForce, setCordDeployForce] = useState(1.0);
  const [cordRetractForce, setCordRetractForce] = useState(1.0);
  const [activePresetId, setActivePresetId] = useState("");
  const [presetBootAttempted, setPresetBootAttempted] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [vineBorder, setVineBorder] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  const [keyPressSpeed, setKeyPressSpeed] = useState(0.35);
  const [keyReleaseSpeed, setKeyReleaseSpeed] = useState(0.4);
  const [stateOverrides, setStateOverrides] = useState<Record<string, string>>({});
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
  const dismissedIdsRef = useRef<Set<string>>(new Set());
  const preCompactSizeRef = useRef<{ width: number; height: number } | null>(null);

  // Auto-resize window to wrap content in compact mode
  useEffect(() => {
    const win = getCurrentWindow();
    if (!compactMode) {
      if (preCompactSizeRef.current) {
        const { width, height } = preCompactSizeRef.current;
        win.setSize(new LogicalSize(width, height));
        win.setMinSize(null);
        preCompactSizeRef.current = null;
      }
      return;
    }

    // Save current logical size before shrinking (only on first activation)
    if (!preCompactSizeRef.current) {
      win.innerSize().then((phys) => {
        const dpr = window.devicePixelRatio || 1;
        preCompactSizeRef.current = { width: phys.width / dpr, height: phys.height / dpr };
      });
    }

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
  }, [compactMode, sessions.length]);

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
    setTitleAnimation(s.titleAnimation ?? "ripple");
    setAnimationSpeed(s.animationSpeed ?? 3.5);
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
    setParticleAlpha(s.particleAlpha ?? 1.0);
    setCordRetractDelay(s.cordRetractDelay ?? 2.0);
    setCordDeployForce(s.cordDeployForce ?? 1.0);
    setCordRetractForce(s.cordRetractForce ?? 1.0);
    setGateEngine(s.signalGate ?? 0.05);
    setActivePresetId(s.activePresetId ?? "");
    setKeyPressSpeed(s.keyPressSpeed ?? 0.35);
    setKeyReleaseSpeed(s.keyReleaseSpeed ?? 0.4);
    setAutoReorder(s.autoReorder ?? false);
    document.documentElement.style.setProperty("--font-scale", String(s.fontScale ?? 1.0));
    setTestMode(s.testMode ?? false);
    setVineBorder(s.vineBorder ?? false);
    setCompactMode(s.compactMode ?? false);
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
  // Sandbox mode — independent simulated sessions with state transition buttons
  // ---------------------------------------------------------------------------
  const SANDBOX_STATES = ["working", "waiting", "error", "subagent", "idle", "done", "ended"] as const;
  const SANDBOX_STATE_META: Record<string, { icon: string; display: string }> = {
    working: { icon: "\u27F3", display: "Working" },
    waiting: { icon: "\u23F8", display: "Waiting" },
    error: { icon: "\u2717", display: "Error" },
    subagent: { icon: "\u2934", display: "Subagent" },
    idle: { icon: "\u25CB", display: "Idle" },
    done: { icon: "\u2713", display: "Done" },
    ended: { icon: "\u2715", display: "Ended" },
  };
  const SANDBOX_MODELS = ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5-20251001"] as const;
  const SANDBOX_SOURCES = ["terminal", "vscode", "cursor", "iterm"] as const;

  const sandboxCounterRef = useRef(0);
  const [sandboxSessions, setSandboxSessions] = useState<EnrichedSession[]>([]);

  const makeSandboxSession = useCallback((state: string = "idle"): EnrichedSession => {
    const n = ++sandboxCounterRef.current;
    const model = SANDBOX_MODELS[n % SANDBOX_MODELS.length];
    const source = SANDBOX_SOURCES[n % SANDBOX_SOURCES.length];
    const meta = SANDBOX_STATE_META[state] ?? SANDBOX_STATE_META.idle;
    const contextPct = Math.random() * 0.6 + 0.05;
    const contextLimit = model.includes("haiku") ? 200_000 : 1_000_000;
    const modelDisplay = model.includes("opus") ? "Opus 4.6" : model.includes("haiku") ? "Haiku 4.5" : "Sonnet 4.6";
    const sourceDisplay = source === "vscode" ? "VSCode" : source === "cursor" ? "Cursor" : source === "iterm" ? "iTerm" : "Terminal";
    return {
      info: {
        id: `__sandbox_${n}__`,
        workspace: `/sandbox/project-${n}`,
        state,
        lastActivity: Date.now() / 1000,
        startedAt: Date.now() / 1000 - Math.floor(Math.random() * 600 + 30),
        source,
      },
      metrics: {
        messageCount: Math.floor(Math.random() * 80 + 5),
        userMessageCount: Math.floor(Math.random() * 20 + 2),
        inputTokens: Math.floor(contextPct * contextLimit * 0.8),
        outputTokens: Math.floor(Math.random() * 40000 + 2000),
        cacheCreationTokens: Math.floor(Math.random() * 15000),
        cacheReadTokens: Math.floor(Math.random() * 80000),
        model,
        lastInputTokens: Math.floor(contextPct * contextLimit * 0.8),
        customTitle: null,
        gitBranch: ["main", "feat/sandbox", "fix/bug-123", "dev"][n % 4],
        toolCounts: { Read: Math.floor(Math.random() * 20), Edit: Math.floor(Math.random() * 12), Bash: Math.floor(Math.random() * 8), Grep: Math.floor(Math.random() * 6) },
        subagents: state === "subagent" ? [{ agentId: `sub_${n}_1`, description: "Research task", slug: "research", inputTokens: 12000, outputTokens: 3000, cacheCreationTokens: 0, cacheReadTokens: 5000, model, toolCounts: { Read: 3, Grep: 2 }, messageCount: 8, isActive: true }] : [],
      },
      workspaceName: `project-${n}`,
      displayTitle: `Sandbox Session ${n}`,
      stateIcon: meta.icon,
      stateDisplayName: meta.display,
      durationSecs: Math.floor(Math.random() * 600 + 30),
      contextLimit,
      contextUsagePercent: contextPct,
      modelDisplayName: modelDisplay,
      sourceDisplay,
      hasSubagents: state === "subagent",
    };
  }, []);

  const addSandboxSession = useCallback((state?: string) => {
    setSandboxSessions((prev) => [...prev, makeSandboxSession(state)]);
  }, [makeSandboxSession]);

  const removeSandboxSession = useCallback((id: string) => {
    setSandboxSessions((prev) => prev.filter((s) => s.info.id !== id));
  }, []);

  const setSandboxState = useCallback((id: string, state: string) => {
    const meta = SANDBOX_STATE_META[state] ?? SANDBOX_STATE_META.idle;
    setSandboxSessions((prev) => prev.map((s) =>
      s.info.id === id ? {
        ...s,
        info: { ...s.info, state, lastActivity: Date.now() / 1000 },
        stateIcon: meta.icon,
        stateDisplayName: meta.display,
        hasSubagents: state === "subagent",
        metrics: {
          ...s.metrics,
          subagents: state === "subagent" ? [{ agentId: `sub_auto`, description: "Research task", slug: "research", inputTokens: 12000, outputTokens: 3000, cacheCreationTokens: 0, cacheReadTokens: 5000, model: s.metrics.model, toolCounts: { Read: 3, Grep: 2 }, messageCount: 8, isActive: true }] : [],
        },
      } : s,
    ));
  }, []);

  const setAllSandboxState = useCallback((state: string) => {
    setSandboxSessions((prev) => prev.map((s) => {
      const meta = SANDBOX_STATE_META[state] ?? SANDBOX_STATE_META.idle;
      return {
        ...s,
        info: { ...s.info, state, lastActivity: Date.now() / 1000 },
        stateIcon: meta.icon,
        stateDisplayName: meta.display,
        hasSubagents: state === "subagent",
        metrics: {
          ...s.metrics,
          subagents: state === "subagent" ? [{ agentId: `sub_auto`, description: "Research task", slug: "research", inputTokens: 12000, outputTokens: 3000, cacheCreationTokens: 0, cacheReadTokens: 5000, model: s.metrics.model, toolCounts: { Read: 3, Grep: 2 }, messageCount: 8, isActive: true }] : [],
        },
      };
    }));
  }, []);

  // Sort sessions: autoReorder moves working/waiting/error to top.
  // Without autoReorder: arrival order (oldest first).
  // Filter out "ended" sessions — they've exited and are in the revive list.
  const sortedSessions = (() => {
    const active = sessions.filter((s) => s.info.state !== "ended");
    const all = [...active];
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
            sessions.forEach((s) => {
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

  const hasContent = sessions.length > 0 || revivedSessions.length > 0;

  // State button color mapping for sandbox controls
  const SANDBOX_STATE_COLORS: Record<string, string> = {
    working: "bg-white/15 text-white/80 hover:bg-white/25",
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

    return (
      <div className="flex flex-col flex-1 min-h-0">
        {/* Sandbox header */}
        <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-500/8 border-b border-amber-500/20">
          <span className="text-xs font-semibold text-amber-400/90 uppercase tracking-wider">Sandbox</span>
          <span className="text-xs text-white/30">|</span>
          <span className="text-xs text-white/40">{sandboxSessions.length} session{sandboxSessions.length !== 1 ? "s" : ""}</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => addSandboxSession("idle")}
              className="px-2.5 py-1 rounded text-xs font-medium bg-white/10 text-white/70 hover:bg-white/20 hover:text-white transition-colors"
            >
              + Add Session
            </button>
            {sandboxSessions.length > 0 && (
              <button
                onClick={() => setSandboxSessions([])}
                className="px-2.5 py-1 rounded text-xs font-medium bg-red-500/15 text-red-400/70 hover:bg-red-500/25 hover:text-red-400 transition-colors"
              >
                Clear All
              </button>
            )}
          </div>
        </div>

        {/* Batch state controls */}
        {sandboxSessions.length > 0 && (
          <div className="flex items-center gap-1.5 px-4 py-2 bg-white/3 border-b border-white/5">
            <span className="text-[0.625rem] text-white/30 mr-1 uppercase tracking-wider">All:</span>
            {SANDBOX_STATES.map((st) => (
              <button
                key={st}
                onClick={() => setAllSandboxState(st)}
                className={`px-2 py-0.5 rounded text-[0.625rem] font-medium transition-colors ${SANDBOX_STATE_COLORS[st]}`}
              >
                {SANDBOX_STATE_META[st].display}
              </button>
            ))}
          </div>
        )}

        {/* Sandbox sessions or empty state */}
        {sandboxSessions.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-white/40 gap-3">
            <span className="text-4xl">&#9881;</span>
            <span className="text-lg font-medium">Sandbox Mode</span>
            <span className="text-sm text-white/30">Add sessions and use the controls to trigger state transitions</span>
            <div className="flex gap-2 mt-2">
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
          <div ref={listRef} className={`flex-1 ${compactMode ? "overflow-visible p-2 space-y-1.5" : "overflow-y-auto p-4 pb-12 space-y-3"}`}>
            {sortedSandbox.map((session) => {
              // Apply keyboard state override if active
              const overrideState = stateOverrides[session.info.id];
              const effectiveSession = overrideState
                ? { ...session, info: { ...session.info, state: overrideState } }
                : session;

              return (
                <div key={session.info.id} data-session-id={session.info.id} data-session-state={effectiveSession.info.state} className="space-y-0">
                  <SessionCard session={effectiveSession} titleAnimation={titleAnimation} animationSpeed={animationSpeed} randomAnimation={randomAnimation} signalString={signalString} signalFrequency={signalFrequency} signalMode={signalMode} signalAlpha={signalAlpha} signalAmplitude={signalAmplitude} signalEcho={signalEcho} signalBass={signalBass} signalMids={signalMids} signalTreble={signalTreble} signalColorDark={signalColorDark} signalColorLight={signalColorLight} signalOffset={signalOffset} particleEnabled={particleEnabled} particleSpeed={particleSpeed} particleRate={particleRate} particleSparks={particleSparks} particleAlpha={particleAlpha} cordRetractDelay={cordRetractDelay} cordDeployForce={cordDeployForce} cordRetractForce={cordRetractForce} keyPressSpeed={keyPressSpeed} keyReleaseSpeed={keyReleaseSpeed} vineBorder={vineBorder} compactMode={compactMode} />

                  {/* State transition controls */}
                  <div className="flex items-center gap-1 px-2 py-1.5 rounded-b-lg bg-white/3 border border-t-0 border-white/5 -mt-px">
                    {SANDBOX_STATES.map((st) => {
                      const isCurrent = session.info.state === st;
                      return (
                        <button
                          key={st}
                          onClick={() => setSandboxState(session.info.id, st)}
                          disabled={isCurrent}
                          className={`px-1.5 py-0.5 rounded text-[0.6rem] font-medium transition-colors ${
                            isCurrent
                              ? "bg-white/20 text-white/90 ring-1 ring-white/30"
                              : SANDBOX_STATE_COLORS[st]
                          }`}
                        >
                          {SANDBOX_STATE_META[st].display}
                        </button>
                      );
                    })}
                    <div className="ml-auto">
                      <button
                        onClick={() => removeSandboxSession(session.info.id)}
                        className="px-1.5 py-0.5 rounded text-[0.6rem] text-red-400/50 hover:text-red-400 hover:bg-red-500/15 transition-colors"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
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
      {/* Stats header */}
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

      {/* Session list or empty state */}
      {!hasContent ? (
        <div className="flex-1 flex flex-col items-center justify-center text-white/40 gap-2">
          <span className="text-4xl">○</span>
          <span className="text-lg font-medium">No Active Sessions</span>
          <span className="text-sm">Sessions will appear here when Claude Code is running</span>
        </div>
      ) : (
        <div ref={listRef} className={`flex-1 ${compactMode ? "overflow-visible p-2 space-y-1.5" : "overflow-y-auto p-4 pb-12 space-y-3"}`}>
          {/* Active sessions */}
          {sortedSessions.map((session) => {
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
              <div key={session.info.id} data-session-id={session.info.id} data-session-state={effectiveSession.info.state} className="space-y-2">
                <SessionCard session={effectiveSession} titleAnimation={titleAnimation} animationSpeed={animationSpeed} randomAnimation={randomAnimation} signalString={signalString} signalFrequency={signalFrequency} signalMode={signalMode} signalAlpha={signalAlpha} signalAmplitude={signalAmplitude} signalEcho={signalEcho} signalBass={signalBass} signalMids={signalMids} signalTreble={signalTreble} signalColorDark={signalColorDark} signalColorLight={signalColorLight} signalOffset={signalOffset} particleEnabled={particleEnabled} particleSpeed={particleSpeed} particleRate={particleRate} particleSparks={particleSparks} particleAlpha={particleAlpha} cordRetractDelay={cordRetractDelay} cordDeployForce={cordDeployForce} cordRetractForce={cordRetractForce} keyPressSpeed={keyPressSpeed} keyReleaseSpeed={keyReleaseSpeed} vineBorder={vineBorder} compactMode={compactMode} />

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
          })}

          {/* Revived (ended) sessions — collapsible, collapsed by default */}
          {!compactMode && revivedSessions.length > 0 && (
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
                      <SessionCard session={revived.session} titleAnimation="none" signalString={signalString} signalFrequency={signalFrequency} signalMode={signalMode} signalAlpha={signalAlpha} signalAmplitude={signalAmplitude} signalEcho={signalEcho} signalBass={signalBass} signalMids={signalMids} signalTreble={signalTreble} signalColorDark={signalColorDark} signalColorLight={signalColorLight} signalOffset={signalOffset} particleEnabled={particleEnabled} particleSpeed={particleSpeed} particleRate={particleRate} particleSparks={particleSparks} particleAlpha={particleAlpha} revived />
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
