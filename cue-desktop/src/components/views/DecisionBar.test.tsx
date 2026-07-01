import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DecisionBar } from "./DecisionBar";
import type { EnrichedSession, PermissionRequest } from "@/lib/types";

vi.mock("@/lib/openSession", () => ({ openSession: vi.fn(() => Promise.resolve()) }));
import { openSession } from "@/lib/openSession";

function makeSession(state: string, awaitingUserPrompt = false): EnrichedSession {
  return {
    info: { id: "s1", workspace: "/Users/dev/Proj", state },
    displayTitle: "Proj",
    metrics: { awaitingUserPrompt },
  } as unknown as EnrichedSession;
}

function makeRequest(id: string): PermissionRequest {
  return {
    requestId: id,
    sessionId: "s1",
    toolName: "Bash",
    toolInput: { command: "ls" },
    summary: "Run ls",
    hookEventName: "PermissionRequest",
    receivedAt: Date.now() / 1000,
  };
}

describe("DecisionBar", () => {
  it("renders nothing when there's no action (idle, no pending)", () => {
    const { container } = render(
      <DecisionBar session={makeSession("idle")} pending={[]} onApprove={() => {}} onDeny={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("routes Approve with the session + request id", () => {
    const onApprove = vi.fn();
    render(
      <DecisionBar
        session={makeSession("waiting")}
        pending={[makeRequest("r1")]}
        onApprove={onApprove}
        onDeny={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(onApprove).toHaveBeenCalledWith("s1", "r1");
  });

  it("routes Deny with the session + request id", () => {
    // Separate render from the Approve case: the prompt disables both buttons
    // once a decision is in flight, so approve + deny can't both fire in one mount.
    const onDeny = vi.fn();
    render(
      <DecisionBar
        session={makeSession("waiting")}
        pending={[makeRequest("r1")]}
        onApprove={() => {}}
        onDeny={onDeny}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(onDeny).toHaveBeenCalledWith("s1", "r1");
  });

  it("shows 'answer in your editor' for an AskUserQuestion/ExitPlanMode wait, routing to the editor (not a fake answer)", () => {
    render(
      <DecisionBar session={makeSession("waiting", true)} pending={[]} onApprove={() => {}} onDeny={() => {}} />,
    );
    // No Approve/Deny — those decisions aren't answerable from Cue.
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /needs your answer/i }));
    expect(openSession).toHaveBeenCalledTimes(1);
  });

  it("shows nothing for a permission wait before its request arrives (no false 'answer in editor')", () => {
    // state==="waiting" but awaitingUserPrompt is false and pending is still
    // empty — a tool permission whose request hasn't reached the frontend yet.
    // Must NOT claim "Cue can't answer this"; it can, once the request lands.
    const { container } = render(
      <DecisionBar session={makeSession("waiting")} pending={[]} onApprove={() => {}} onDeny={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
