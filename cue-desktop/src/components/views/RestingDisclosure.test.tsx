import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RestingDisclosure } from "./RestingDisclosure";
import type { EnrichedSession } from "@/lib/types";

function restingSession(id: string, title: string, reason: string): EnrichedSession {
  return {
    info: { id, workspace: `/Users/dev/${title}` },
    displayTitle: title,
    workspaceName: `${title}-folder`,
    restingReason: reason,
    resting: true,
  } as unknown as EnrichedSession;
}

describe("RestingDisclosure", () => {
  it("renders nothing when there are no resting sessions", () => {
    const { container } = render(<RestingDisclosure sessions={[]} onRestore={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the count and each resting session with its reason", () => {
    render(
      <RestingDisclosure
        sessions={[restingSession("a", "Alpha", "idle"), restingSession("b", "Beta", "dismissed")]}
        onRestore={() => {}}
      />,
    );
    expect(screen.getByText("Resting (2)")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(screen.getByText("dismissed")).toBeInTheDocument();
  });

  it("routes Restore to onRestore with the session id", () => {
    const onRestore = vi.fn();
    render(
      <RestingDisclosure sessions={[restingSession("a", "Alpha", "idle")]} onRestore={onRestore} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /restore alpha/i }));
    expect(onRestore).toHaveBeenCalledWith("a");
  });
});
