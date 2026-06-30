import type { EnrichedSession, PermissionRequest } from "@/lib/types";
import { openSession } from "@/lib/openSession";
import { PermissionPrompt } from "../PermissionPrompt";

interface DecisionBarProps {
  session: EnrichedSession;
  pending: PermissionRequest[];
  onApprove: (sessionId: string, requestId: string) => void;
  onDeny: (sessionId: string, requestId: string) => void;
}

/**
 * The action a session is blocked on, pinned to the TOP of every card (all four
 * views) so it can't get pushed below long context/todo/subagent content.
 *
 * Two cases, and it tells the truth about which (#7 — never a button that no-ops):
 *  - **pending tool permission** → the Approve/Deny prompt, which Cue can actually
 *    answer through the localhost permission channel.
 *  - **`awaitingUserPrompt`** (an AskUserQuestion / ExitPlanMode) → a decision Cue
 *    can SEE but not answer (it flows through a channel with no response path), so
 *    it routes you to the editor/terminal to respond instead of faking an answer.
 *    Gated on the precise `awaitingUserPrompt` flag, NOT a bare `waiting` state, so
 *    it never mislabels a tool-permission wait (which is `waiting` too, before its
 *    request reaches the frontend) as something Cue "can't answer."
 *  - otherwise renders nothing.
 *
 * One component, used everywhere, so the "needs you" affordance can't drift per
 * view.
 */
export function DecisionBar({ session, pending, onApprove, onDeny }: DecisionBarProps) {
  if (pending.length > 0) {
    return (
      <div className="decision-bar">
        {pending.map((req) => (
          <PermissionPrompt
            key={req.requestId}
            request={req}
            onApprove={() => onApprove(session.info.id, req.requestId)}
            onDeny={() => onDeny(session.info.id, req.requestId)}
          />
        ))}
      </div>
    );
  }

  if (session.metrics.awaitingUserPrompt) {
    // A question or plan Cue can't answer from here — route to where you can.
    return (
      <div className="decision-bar">
        <button
          type="button"
          className="decision-answer"
          onClick={(e) => {
            e.stopPropagation();
            void openSession(session);
          }}
          aria-label={`${session.displayTitle} needs your answer — open it in your editor to respond`}
          title="Waiting on your answer (a question or plan). Cue can't answer these — opens the session in your editor."
        >
          <span className="decision-answer__ping" aria-hidden />
          <span className="decision-answer__label">Needs your answer</span>
          <span className="decision-answer__hint">Answer in your editor →</span>
        </button>
      </div>
    );
  }

  return null;
}
