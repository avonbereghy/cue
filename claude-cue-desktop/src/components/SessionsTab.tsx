import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EnrichedSession } from "@/lib/types";
import type { Settings } from "@/lib/types";
import { formatTokens } from "@/lib/format";
import { StatBadge } from "./StatBadge";
import { SessionCard } from "./SessionCard";
import { PermissionPrompt } from "./PermissionPrompt";
import { PermissionHistory } from "./PermissionHistory";
import { usePermissions } from "@/hooks/usePermissions";

interface SessionsTabProps {
  sessions: EnrichedSession[];
}

export function SessionsTab({ sessions }: SessionsTabProps) {
  const [permissionsEnabled, setPermissionsEnabled] = useState(false);
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(
    new Set(),
  );

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
      .then((s) => setPermissionsEnabled(s.permissionsEnabled))
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
      {sessions.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-white/40 gap-2">
          <span className="text-4xl">○</span>
          <span className="text-lg font-medium">No Active Sessions</span>
          <span className="text-sm">Sessions will appear here when Claude Code is running</span>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
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
                <SessionCard session={session} />

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
        </div>
      )}
    </div>
  );
}
