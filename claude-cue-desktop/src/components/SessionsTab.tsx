import type { EnrichedSession } from "@/lib/types";
import { formatTokens } from "@/lib/format";
import { StatBadge } from "./StatBadge";
import { SessionCard } from "./SessionCard";

interface SessionsTabProps {
  sessions: EnrichedSession[];
}

export function SessionsTab({ sessions }: SessionsTabProps) {
  const totalMessages = sessions.reduce((sum, s) => sum + s.metrics.messageCount, 0);
  const totalTokens = sessions.reduce(
    (sum, s) => sum + s.metrics.inputTokens + s.metrics.outputTokens,
    0,
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Stats header */}
      <div className="flex items-center gap-6 px-4 py-3 bg-white/5 border-b border-white/10">
        <StatBadge icon="●" label="Sessions" value={`${sessions.length}`} color="text-green-500" />
        <StatBadge icon="💬" label="Messages" value={`${totalMessages}`} color="text-blue-400" />
        <StatBadge icon="⇅" label="Tokens" value={formatTokens(totalTokens)} color="text-purple-400" />
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
          {sessions.map((session) => (
            <SessionCard key={session.info.id} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}
