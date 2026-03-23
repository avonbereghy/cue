import type { PermissionLogEntry } from "@/lib/types";

interface PermissionHistoryProps {
  entries: PermissionLogEntry[];
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now() / 1000;
  const diff = Math.max(0, now - timestamp);

  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function PermissionHistory({ entries }: PermissionHistoryProps) {
  if (entries.length === 0) {
    return (
      <div className="text-xs text-white/30 py-2">
        No permission history
      </div>
    );
  }

  return (
    <div className="space-y-1 max-h-48 overflow-y-auto">
      {entries.map((entry, i) => (
        <div
          key={`${entry.timestamp}-${i}`}
          className="flex items-center gap-2 text-xs py-1"
        >
          <span className="text-white/30 w-14 shrink-0 mono-nums">
            {formatRelativeTime(entry.timestamp)}
          </span>
          <span className="text-white/50 flex-1 truncate">
            {entry.toolInputSummary}
          </span>
          <span
            className={`px-1.5 py-0.5 rounded-full text-[0.625rem] font-medium ${
              entry.decision.toLowerCase() === "allow"
                ? "bg-green-500/20 text-green-400"
                : "bg-red-500/20 text-red-400"
            }`}
          >
            {entry.decision.toLowerCase() === "allow" ? "Approved" : "Denied"}
          </span>
        </div>
      ))}
    </div>
  );
}
