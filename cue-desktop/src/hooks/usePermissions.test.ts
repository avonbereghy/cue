import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { PermissionRequest } from "@/lib/types";

// Capture the listeners the hook registers, keyed by event name, so tests can
// drive `permission-request` / `sessions-updated` events synchronously.
type Listener = (event: { payload: unknown }) => void;
const listeners: Record<string, Listener[]> = {};
function emit(event: string, payload: unknown) {
  for (const cb of listeners[event] ?? []) cb({ payload });
}

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    (listeners[event] ??= []).push(cb);
    return Promise.resolve(() => {
      listeners[event] = (listeners[event] ?? []).filter((c) => c !== cb);
    });
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { usePermissions } from "./usePermissions";

function req(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: "r1",
    sessionId: "s1",
    toolName: "Bash",
    toolInput: { command: "npm install" },
    summary: "Run: npm install",
    hookEventName: "PermissionRequest",
    receivedAt: Date.now() / 1000,
    ...overrides,
  };
}

// The hook only reads `info.id` / `info.state` off each session, and `emit`
// forwards an `unknown` payload, so a minimal structural stand-in is enough —
// no cast to the full EnrichedSession shape needed.
function sess(id: string, state: string): { info: { id: string; state: string } } {
  return { info: { id, state } };
}

beforeEach(() => {
  for (const k of Object.keys(listeners)) delete listeners[k];
  invokeMock.mockReset();
});

describe("usePermissions — sessions-updated wipe tolerance", () => {
  it("keeps a just-added prompt when a stale snapshot claims the session isn't waiting", async () => {
    // Backend ground truth: r1 is STILL pending (the snapshot was just stale).
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_pending_permissions") return Promise.resolve([req()]);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => usePermissions());

    // Fast path adds the prompt.
    act(() => emit("permission-request", req()));
    expect(result.current.pendingBySession.s1).toHaveLength(1);

    // Stale sessions-updated (session not "waiting" yet). The old code wiped
    // the prompt here; now it re-syncs and the backend confirms it's pending.
    await act(async () => {
      emit("sessions-updated", [sess("s1", "working")]);
    });

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("get_pending_permissions"),
    );
    await waitFor(() =>
      expect(result.current.pendingBySession.s1).toHaveLength(1),
    );
  });

  it("drops a prompt once the backend confirms it is no longer pending", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_pending_permissions") return Promise.resolve([]); // gone
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => usePermissions());
    act(() => emit("permission-request", req()));
    expect(result.current.pendingBySession.s1).toHaveLength(1);

    await act(async () => {
      emit("sessions-updated", [sess("s1", "working")]);
    });

    await waitFor(() =>
      expect(result.current.pendingBySession.s1).toBeUndefined(),
    );
  });

  it("does not query the backend when every pending session is still waiting", async () => {
    invokeMock.mockResolvedValue([req()]);

    const { result } = renderHook(() => usePermissions());
    act(() => emit("permission-request", req()));

    await act(async () => {
      emit("sessions-updated", [sess("s1", "waiting")]);
    });

    expect(invokeMock).not.toHaveBeenCalledWith("get_pending_permissions");
    expect(result.current.pendingBySession.s1).toHaveLength(1);
  });
});
