import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EnrichedSession } from "@/lib/types";

export function useSessionMonitor(): EnrichedSession[] {
  const [sessions, setSessions] = useState<EnrichedSession[]>([]);
  const lastUpdateRef = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;
    // Initial fetch
    invoke<EnrichedSession[]>("get_sessions")
      .then((s) => { if (!cancelled) setSessions(s); })
      .catch(console.error);

    // Subscribe to live updates via events
    const unlisten = listen<EnrichedSession[]>("sessions-updated", (event) => {
      if (cancelled) return;
      setSessions(event.payload);
      lastUpdateRef.current = Date.now();
    });

    // Polling fallback: macOS may throttle webview JS events when
    // the window is unfocused, causing event-only updates to stall.
    // Poll every 2s if no event was received in the last 3s.
    const pollTimer = setInterval(() => {
      if (Date.now() - lastUpdateRef.current > 3000) {
        invoke<EnrichedSession[]>("get_sessions")
          .then((s) => { if (!cancelled) setSessions(s); })
          .catch(() => {});
      }
    }, 2000);

    return () => {
      cancelled = true;
      unlisten.then((fn) => fn()).catch(() => {});
      clearInterval(pollTimer);
    };
  }, []);

  return sessions;
}
