import type { EnrichedSession } from "@/lib/types";

interface RestingDisclosureProps {
  sessions: EnrichedSession[];
  onRestore: (id: string) => void;
  /** Extra classes for the host layout (e.g. "col-span-full" inside the
   *  instrument grid). */
  className?: string;
}

/**
 * The "Resting" group — sessions tucked out of the main view (auto-hidden after
 * sitting idle, or manually dismissed) but recoverable in one click. Rendered by
 * EVERY dashboard view (instrument + all Looks) from this single component, so
 * the affordance can't drift per-skin. It styles itself entirely from
 * `currentColor` + opacity (no fixed white/black), so it inherits each Look's
 * ink and stays legible on both the dark instrument surface and the paper Looks.
 * Collapsed by default — a resting session also re-surfaces on its own the moment
 * it becomes active again, so this is the deliberate "where did it go" affordance,
 * not a required step.
 */
export function RestingDisclosure({ sessions, onRestore, className = "" }: RestingDisclosureProps) {
  if (sessions.length === 0) return null;
  return (
    <details className={`resting-disclosure ${className}`}>
      <summary className="resting-summary">
        <span className="resting-rule" />
        <span className="resting-label">
          <span aria-hidden className="resting-caret">{"▸"}</span>
          Resting ({sessions.length})
        </span>
        <span className="resting-rule" />
      </summary>
      <div className="resting-list">
        {sessions.map((s) => (
          <div key={s.info.id} className="resting-row">
            <span aria-hidden className="resting-dot" />
            <span className="resting-title" title={s.displayTitle}>{s.displayTitle}</span>
            <span className="resting-reason">
              {s.restingReason === "dismissed" ? "dismissed" : "idle"}
            </span>
            <span className="resting-workspace" title={s.info.workspace}>{s.workspaceName}</span>
            <button
              type="button"
              className="resting-restore"
              onClick={() => onRestore(s.info.id)}
              aria-label={`Restore ${s.displayTitle} to the active list`}
            >
              Restore
            </button>
          </div>
        ))}
      </div>
    </details>
  );
}
