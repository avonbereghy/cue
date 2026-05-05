import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EnrichedSession } from "@/lib/types";

/**
 * Coalesce window for back-to-back `sessions-updated` events arriving in the
 * same animation frame. When the focus-rehydrate emit and a normal poll land
 * within the same tick, applying both as separate setState calls produces an
 * intermediate render where the FLIP shuffle and the card's own state-effect
 * transition see different snapshots — visible jank. A 16ms (1 frame) debounce
 * is enough to merge the burst without delaying the perceived update.
 */
const COALESCE_MS = 16;

export function useSessionMonitor(): EnrichedSession[] {
  const [sessions, setSessions] = useState<EnrichedSession[]>([]);
  const lastUpdateRef = useRef(Date.now());
  const pendingRef = useRef<EnrichedSession[] | null>(null);
  const flushTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    const flush = () => {
      flushTimerRef.current = null;
      const next = pendingRef.current;
      pendingRef.current = null;
      if (cancelled || next === null) return;
      setSessions(next);
    };

    const apply = (next: EnrichedSession[]) => {
      if (cancelled) return;
      pendingRef.current = next;
      // Reset the staleness clock immediately on receipt — the coalesce
      // window only delays the React commit, not the fact that fresh data
      // arrived. If lastUpdateRef stayed stale during the 16ms window the
      // poll fallback would race against it.
      lastUpdateRef.current = Date.now();
      if (flushTimerRef.current !== null) return;
      flushTimerRef.current = window.setTimeout(flush, COALESCE_MS);
    };

    // Initial fetch — apply synchronously (no need to coalesce a single read).
    invoke<EnrichedSession[]>("get_sessions")
      .then((s) => { if (!cancelled) { setSessions(s); lastUpdateRef.current = Date.now(); } })
      .catch(console.error);

    const unlisten = listen<EnrichedSession[]>("sessions-updated", (event) => {
      apply(event.payload);
    });

    // Polling fallback: macOS may throttle webview JS events when the window
    // is unfocused. Poll every 2s if no event was received in the last 3s.
    const pollTimer = setInterval(() => {
      if (Date.now() - lastUpdateRef.current > 3000) {
        invoke<EnrichedSession[]>("get_sessions")
          .then((s) => apply(s))
          .catch(() => {});
      }
    }, 2000);

    return () => {
      cancelled = true;
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      unlisten.then((fn) => fn()).catch(() => {});
      clearInterval(pollTimer);
    };
  }, []);

  return sessions;
}
