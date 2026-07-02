import { useState, useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { PermissionRequest, PermissionLogEntry, EnrichedSession } from "@/lib/types";

export function usePermissions() {
  const [pendingBySession, setPendingBySession] = useState<
    Record<string, PermissionRequest[]>
  >({});
  const [permissionHistory, setPermissionHistory] = useState<
    Record<string, PermissionLogEntry[]>
  >({});

  // Mirror of the current pending map so async reconciles can read the latest
  // set of requestIds synchronously (without re-subscribing on every change).
  const pendingRef = useRef(pendingBySession);
  useEffect(() => {
    pendingRef.current = pendingBySession;
  }, [pendingBySession]);

  // Listen for incoming permission requests from Tauri backend (fast path).
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

  // Re-sync pending prompts against backend ground truth.
  //
  // A `sessions-updated` snapshot can be up to ~1s stale (the backend emits a
  // cached enriched snapshot on window-focus rehydrate and on its 1s poll), so
  // a session that JUST flipped to "waiting" for a fresh prompt can still look
  // non-waiting in the payload. Trusting that would wipe the just-added prompt
  // and strand the user with no approve/deny UI and no recovery path. Instead
  // we ask the backend which requests are actually still pending and remove a
  // local entry ONLY when the backend confirms it is gone.
  //
  // Inflight-guarded with a trailing re-run so a burst of sessions-updated
  // events collapses to at most one in-flight query plus one follow-up, rather
  // than stacking invokes.
  const reconcileInflight = useRef(false);
  const reconcileQueued = useRef(false);
  // Requests we resolved locally (approve/deny) whose removal the backend may
  // not have processed yet. Suppress re-seeding them from a stale snapshot so a
  // just-answered prompt can't be resurrected; pruned once the backend agrees.
  const recentlyResolvedRef = useRef<Set<string>>(new Set());

  const reconcileOnce = useCallback(async () => {
    // Snapshot what we knew before the async round-trip so we never drop a
    // prompt that arrived via the permission-request fast path while this
    // query was in flight (the backend records a request before it emits the
    // event, but the query may have been dispatched a beat earlier).
    const knownAtStart = new Set<string>();
    for (const reqs of Object.values(pendingRef.current)) {
      for (const r of reqs) knownAtStart.add(r.requestId);
    }

    const backendList = await invoke<PermissionRequest[]>(
      "get_pending_permissions",
    );
    const backendIds = new Set(backendList.map((r) => r.requestId));

    setPendingBySession((prev) => {
      const next: Record<string, PermissionRequest[]> = {};
      // 1) Seed from backend truth — this adds anything we were missing, EXCEPT
      //    a request we just resolved locally: the snapshot can predate the
      //    backend processing our approve/deny, so re-seeding it would remount an
      //    enabled prompt for an already-answered request (a duplicate-decision
      //    error on the next click). Our local resolution is the fresher truth.
      for (const r of backendList) {
        if (recentlyResolvedRef.current.has(r.requestId)) continue;
        (next[r.sessionId] ??= []).push(r);
      }
      // 2) Re-attach local entries the backend didn't return but that arrived
      //    AFTER this query started (not yet visible to it). Entries the
      //    backend omits that WERE known at start are confirmed resolved and
      //    intentionally dropped.
      for (const [sessionId, reqs] of Object.entries(prev)) {
        for (const r of reqs) {
          if (backendIds.has(r.requestId)) continue;
          if (knownAtStart.has(r.requestId)) continue;
          (next[sessionId] ??= []).push(r);
        }
      }
      return next;
    });

    // Once the backend stops reporting a locally-resolved request, it has caught
    // up and the suppression is no longer needed — drop it so the set stays bounded.
    for (const id of [...recentlyResolvedRef.current]) {
      if (!backendIds.has(id)) recentlyResolvedRef.current.delete(id);
    }
  }, []);

  const runReconcile = useCallback(async () => {
    if (reconcileInflight.current) {
      reconcileQueued.current = true;
      return;
    }
    reconcileInflight.current = true;
    try {
      do {
        reconcileQueued.current = false;
        try {
          await reconcileOnce();
        } catch (err) {
          console.error("Failed to reconcile pending permissions:", err);
        }
      } while (reconcileQueued.current);
    } finally {
      reconcileInflight.current = false;
    }
  }, [reconcileOnce]);

  // Clear pending requests when sessions leave "waiting" state or disappear
  // (user answered in Claude Code directly, not through the dashboard). Rather
  // than trust the possibly-stale snapshot, only *trigger* a backend re-sync
  // when it looks like a removal is warranted — reconcileOnce then decides what
  // actually gets dropped.
  useEffect(() => {
    const unlisten = listen<EnrichedSession[]>("sessions-updated", (event) => {
      const waitingIds = new Set(
        event.payload
          .filter((s) => s.info.state === "waiting")
          .map((s) => s.info.id),
      );
      const wouldRemove = Object.keys(pendingRef.current).some(
        (sessionId) => !waitingIds.has(sessionId),
      );
      if (wouldRemove) {
        void runReconcile();
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [runReconcile]);

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
        // Record the local resolution so an in-flight reconcile can't re-seed
        // this request from a snapshot taken before the backend removed it.
        recentlyResolvedRef.current.add(requestId);
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
        // Re-throw so the prompt can re-enable its buttons on a failed invoke
        // (it disables them while a decision is in flight to block duplicates).
        throw err;
      }
    },
    [refreshHistory],
  );

  const denyPermission = useCallback(
    async (sessionId: string, requestId: string) => {
      try {
        await invoke("deny_permission", { sessionId, requestId });
        // Record the local resolution so an in-flight reconcile can't re-seed
        // this request from a snapshot taken before the backend removed it.
        recentlyResolvedRef.current.add(requestId);
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
        // Re-throw so the prompt can re-enable its buttons on a failed invoke
        // (it disables them while a decision is in flight to block duplicates).
        throw err;
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
