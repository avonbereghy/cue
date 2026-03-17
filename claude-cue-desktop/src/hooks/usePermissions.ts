import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { PermissionRequest, PermissionLogEntry } from "@/lib/types";

export function usePermissions() {
  const [pendingBySession, setPendingBySession] = useState<
    Record<string, PermissionRequest[]>
  >({});
  const [permissionHistory, setPermissionHistory] = useState<
    Record<string, PermissionLogEntry[]>
  >({});

  // Listen for incoming permission requests from Tauri backend
  useEffect(() => {
    const unlisten = listen<PermissionRequest>("permission-request", (event) => {
      const request = event.payload;
      setPendingBySession((prev) => ({
        ...prev,
        [request.sessionId]: [...(prev[request.sessionId] ?? []), request],
      }));
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const refreshHistory = useCallback(async (sessionId: string) => {
    try {
      const entries = await invoke<PermissionLogEntry[]>(
        "get_permission_history",
        { sessionId },
      );
      setPermissionHistory((prev) => ({
        ...prev,
        [sessionId]: entries,
      }));
    } catch (err) {
      console.error("Failed to fetch permission history:", err);
    }
  }, []);

  const approvePermission = useCallback(
    async (sessionId: string, requestId: string) => {
      try {
        await invoke("approve_permission", { sessionId, requestId });
        // Remove from pending
        setPendingBySession((prev) => {
          const updated = { ...prev };
          if (updated[sessionId]) {
            updated[sessionId] = updated[sessionId].filter(
              (r) => r.requestId !== requestId,
            );
            if (updated[sessionId].length === 0) {
              delete updated[sessionId];
            }
          }
          return updated;
        });
        // Refresh history for this session
        refreshHistory(sessionId);
      } catch (err) {
        console.error("Failed to approve permission:", err);
      }
    },
    [refreshHistory],
  );

  const denyPermission = useCallback(
    async (sessionId: string, requestId: string) => {
      try {
        await invoke("deny_permission", { sessionId, requestId });
        // Remove from pending
        setPendingBySession((prev) => {
          const updated = { ...prev };
          if (updated[sessionId]) {
            updated[sessionId] = updated[sessionId].filter(
              (r) => r.requestId !== requestId,
            );
            if (updated[sessionId].length === 0) {
              delete updated[sessionId];
            }
          }
          return updated;
        });
        // Refresh history for this session
        refreshHistory(sessionId);
      } catch (err) {
        console.error("Failed to deny permission:", err);
      }
    },
    [refreshHistory],
  );

  return {
    pendingBySession,
    permissionHistory,
    approvePermission,
    denyPermission,
    refreshHistory,
  };
}
