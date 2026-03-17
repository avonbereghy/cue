import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EnrichedSession } from "@/lib/types";

export function useSessionMonitor(): EnrichedSession[] {
  const [sessions, setSessions] = useState<EnrichedSession[]>([]);

  useEffect(() => {
    // Initial fetch
    invoke<EnrichedSession[]>("get_sessions").then(setSessions).catch(console.error);

    // Subscribe to live updates
    const unlisten = listen<EnrichedSession[]>("sessions-updated", (event) => {
      setSessions(event.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return sessions;
}
