import { useState } from "react";
import type { PermissionRequest } from "@/lib/types";

interface PermissionPromptProps {
  request: PermissionRequest;
  onApprove: () => void;
  onDeny: () => void;
}

export function PermissionPrompt({ request, onApprove, onDeny }: PermissionPromptProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-l-4 border-yellow-400 bg-yellow-500/5 rounded-r-lg p-3 space-y-2">
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

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={onApprove}
          className="px-3 py-1.5 rounded-md text-xs font-medium bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-500"
        >
          Approve
        </button>
        <button
          onClick={onDeny}
          className="px-3 py-1.5 rounded-md text-xs font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
        >
          Deny
        </button>
        <span className="text-[0.625rem] text-white/30 ml-auto">
          {request.toolName}
        </span>
      </div>
    </div>
  );
}
