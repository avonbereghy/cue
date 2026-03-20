import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EnrichedSession } from "@/lib/types";
import type { Settings } from "@/lib/types";
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
      })
      .catch(() => {});
  }, []);

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

  const hasContent = sessions.length > 0 || revivedSessions.length > 0;

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
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* Active sessions */}
          {[...sessions].sort((a, b) => {
            const priority = (s: EnrichedSession) =>
              s.info.state === "waiting" ? 0 : s.info.state === "working" ? 1 : 2;
            return priority(a) - priority(b);
          }).map((session) => {
            const pending = pendingBySession[session.info.id] ?? [];
            const history = permissionHistory[session.info.id] ?? [];
            const hasPermissionActivity = pending.length > 0 || history.length > 0;
            const isCollapsed = collapsedSessions.has(session.info.id);

            return (
              <div key={session.info.id} className="space-y-2">
                <SessionCard session={session} titleAnimation={titleAnimation} animationSpeed={animationSpeed} randomAnimation={randomAnimation} />

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
                    <SessionCard session={revived.session} titleAnimation="none" />
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
