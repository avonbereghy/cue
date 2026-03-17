import type { EnrichedSession } from "@/lib/types";
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
  const totalMessages = sessions.reduce((sum, s) => sum + s.metrics.messageCount, 0);
  const totalTokens = sessions.reduce(
    (sum, s) => sum + s.metrics.inputTokens + s.metrics.outputTokens,
    0,
  );
  const {
    pendingBySession,
    permissionHistory,
    approvePermission,
    denyPermission,
    refreshHistory,
  } = usePermissions();

  // Count total pending permissions for the stats header
  const totalPending = Object.values(pendingBySession).reduce(
    (sum, reqs) => sum + reqs.length,
    0,
  );

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
          {sessions.map((session) => {
            const pending = pendingBySession[session.info.id] ?? [];
            const history = permissionHistory[session.info.id] ?? [];
            const hasPermissionActivity = pending.length > 0 || history.length > 0;

            return (
              <div key={session.info.id} className="space-y-2">
                <SessionCard session={session} />

                {/* Pending permission prompts */}
                {pending.map((req) => (
                  <PermissionPrompt
                    key={req.requestId}
                    request={req}
                    onApprove={() => approvePermission(session.info.id, req.requestId)}
                    onDeny={() => denyPermission(session.info.id, req.requestId)}
                  />
                ))}

                {/* Permission history (collapsible, shown when session has had permission activity) */}
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
            );
          })}
        </div>
      )}
    </div>
  );
}
