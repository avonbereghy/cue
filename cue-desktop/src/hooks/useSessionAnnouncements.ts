import { useEffect, useRef } from "react";
import type { EnrichedSession } from "@/lib/types";
import { announce } from "@/lib/a11y";

/**
 * Announce meaningful session state transitions to screen-reader / eyes-away
 * users. The whole value of a monitor is "tell me when something needs me," so
 * waiting/error are assertive and done is polite. Only transitions are
 * announced (not the initial snapshot), keyed off the previous poll's states.
 */
export function useSessionAnnouncements(sessions: EnrichedSession[]): void {
  const prevStates = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const prev = prevStates.current;
    const next = new Map<string, string>();
    for (const s of sessions) {
      const id = s.info.id;
      const state = s.info.state;
      next.set(id, state);
      const before = prev.get(id);
      if (before !== undefined && before !== state) {
        const title = s.displayTitle || "A session";
        if (state === "waiting") announce(`${title} needs you`, "assertive");
        else if (state === "error") announce(`${title} hit an error`, "assertive");
        else if (state === "done") announce(`${title} finished`, "polite");
      }
    }
    prevStates.current = next;
  }, [sessions]);
}
