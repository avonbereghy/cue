import { useState, useEffect, useRef } from "react";
import type { PermissionRequest } from "@/lib/types";

interface PermissionPromptProps {
  request: PermissionRequest;
  onApprove: () => void;
  onDeny: () => void;
}

// Mirrors the backend's PERMISSION_WAIT_TIMEOUT (lib.rs). The backend drops the
// request after this, so the UI must not keep showing live buttons that would
// silently no-op once it has expired.
const TIMEOUT_SECS = 60;

function remainingSecs(receivedAt: number): number {
  return Math.max(0, TIMEOUT_SECS - (Date.now() / 1000 - receivedAt));
}

export function PermissionPrompt({ request, onApprove, onDeny }: PermissionPromptProps) {
  const [expanded, setExpanded] = useState(false);
  const [remaining, setRemaining] = useState(() => remainingSecs(request.receivedAt));
  const approveRef = useRef<HTMLButtonElement>(null);
  const expired = remaining <= 0;

  // Drain the countdown toward the backend's timeout.
  useEffect(() => {
    if (expired) return;
    const id = setInterval(() => {
      setRemaining(remainingSecs(request.receivedAt));
    }, 500);
    return () => clearInterval(id);
  }, [request.receivedAt, expired]);

  // Autofocus Approve so a keyboard user can decide without reaching for the mouse.
  useEffect(() => {
    approveRef.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (expired) return;
    if (e.key === "Enter") {
      e.preventDefault();
      onApprove();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onDeny();
    }
  };

  const pct = Math.max(0, Math.min(1, remaining / TIMEOUT_SECS));

  return (
    <div
      role="alertdialog"
      aria-label={`Permission needed: ${request.summary}`}
      onKeyDown={onKeyDown}
      className="border-l-4 border-yellow-400 bg-yellow-500/5 rounded-r-lg p-3 space-y-2"
    >
      {/* Summary + expand toggle */}
      <div className="flex items-center gap-2">
        <span className="text-yellow-400 text-sm font-medium flex-1">
          {request.summary}
        </span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-white/40 hover:text-white/60 transition-colors"
          aria-label={expanded ? "Collapse details" : "Expand details"}
        >
          {expanded ? "▾" : "▸"} Details
        </button>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <pre className="text-xs text-white/50 bg-white/5 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto">
          {JSON.stringify(request.toolInput, null, 2)}
        </pre>
      )}

      {/* Draining timer — honest about the 60s budget */}
      {!expired && (
        <div className="h-0.5 w-full bg-white/10 rounded-full overflow-hidden" aria-hidden="true">
          <div
            className={`h-full rounded-full transition-[width] duration-500 ease-linear ${
              pct < 0.17 ? "bg-amber-400" : "bg-yellow-400/50"
            }`}
            style={{ width: `${pct * 100}%` }}
          />
        </div>
      )}

      {/* Actions, or an honest expired state instead of dead-but-clickable buttons */}
      {expired ? (
        <div className="flex items-center gap-2 text-xs text-white/40">
          <span className="flex-1">Request expired — Claude moved on.</span>
          <span className="text-[0.625rem] text-white/30">{request.toolName}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button
            ref={approveRef}
            onClick={onApprove}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-500"
          >
            Approve <span className="ml-1 text-[0.5625rem] opacity-60" aria-hidden="true">⏎</span>
          </button>
          <button
            onClick={onDeny}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
          >
            Deny <span className="ml-1 text-[0.5625rem] opacity-60" aria-hidden="true">esc</span>
          </button>
          <span className="text-[0.625rem] text-white/30 ml-auto">
            {request.toolName}
          </span>
        </div>
      )}
    </div>
  );
}
