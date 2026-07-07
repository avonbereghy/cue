import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { EnrichedSession } from "@/lib/types";

vi.mock("@/lib/a11y", () => ({ announce: vi.fn() }));
import { announce } from "@/lib/a11y";
import { useSessionAnnouncements } from "./useSessionAnnouncements";

function sess(id: string, state: string, title = "Proj"): EnrichedSession {
  return { info: { id, state }, displayTitle: title } as unknown as EnrichedSession;
}

describe("useSessionAnnouncements", () => {
  beforeEach(() => vi.mocked(announce).mockClear());

  it("does not announce the initial snapshot", () => {
    renderHook(({ s }) => useSessionAnnouncements(s), {
      initialProps: { s: [sess("a", "working")] },
    });
    expect(announce).not.toHaveBeenCalled();
  });

  it("announces a transition into waiting (assertive)", () => {
    const { rerender } = renderHook(({ s }) => useSessionAnnouncements(s), {
      initialProps: { s: [sess("a", "working", "PorchLite")] },
    });
    rerender({ s: [sess("a", "waiting", "PorchLite")] });
    expect(announce).toHaveBeenCalledWith("PorchLite needs you", "assertive");
  });

  it("announces error (assertive) and done (polite)", () => {
    const { rerender } = renderHook(({ s }) => useSessionAnnouncements(s), {
      initialProps: { s: [sess("a", "working")] },
    });
    rerender({ s: [sess("a", "error")] });
    expect(announce).toHaveBeenCalledWith("Proj hit an error", "assertive");
    rerender({ s: [sess("a", "done")] });
    expect(announce).toHaveBeenCalledWith("Proj finished", "polite");
  });

  it("stays silent when state is unchanged", () => {
    const { rerender } = renderHook(({ s }) => useSessionAnnouncements(s), {
      initialProps: { s: [sess("a", "working")] },
    });
    rerender({ s: [sess("a", "working")] });
    expect(announce).not.toHaveBeenCalled();
  });
});
