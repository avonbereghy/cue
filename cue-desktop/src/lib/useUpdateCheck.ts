import { useCallback, useEffect, useRef, useState } from "react";
import { checkForUpdatesManually, type UpdateStatus } from "./updater";

/**
 * Drives the manual "Check for Updates…" menu item, shared by the dashboard and
 * the tray ⋯ menus so the affordance behaves identically on both. Tracks status
 * for honest feedback (the click must say what happened — checking / up to date /
 * installing / failed), guards against double-fire, and resets to idle a few
 * seconds after a terminal result so the menu reverts to "Check for Updates…".
 */
export function useUpdateCheck() {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const inFlight = useRef(false);
  const resetTimer = useRef<number | undefined>(undefined);

  const check = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    window.clearTimeout(resetTimer.current);
    setStatus("checking");
    checkForUpdatesManually().then((outcome) => {
      inFlight.current = false;
      setStatus(outcome);
      // "updating" relaunches the app, so no reset is needed there.
      if (outcome !== "updating") {
        resetTimer.current = window.setTimeout(() => setStatus("idle"), 4000);
      }
    });
  }, []);

  // Clear a pending status-reset timer on unmount so its setStatus can't fire
  // (and warn) after the component is gone.
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  return { status, check };
}
