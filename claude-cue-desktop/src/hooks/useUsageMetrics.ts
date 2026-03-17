import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { WindowMetrics } from "@/lib/types";

export function useUsageMetrics(): Record<string, WindowMetrics> {
  const [metrics, setMetrics] = useState<Record<string, WindowMetrics>>({});

  useEffect(() => {
    // Initial fetch
    invoke<Record<string, WindowMetrics>>("get_usage_metrics")
      .then(setMetrics)
      .catch(console.error);

    // Subscribe to live updates
    const unlisten = listen<Record<string, WindowMetrics>>("usage-updated", (event) => {
      setMetrics(event.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return metrics;
}
