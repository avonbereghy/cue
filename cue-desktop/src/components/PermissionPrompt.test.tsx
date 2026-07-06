import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PermissionPrompt } from "./PermissionPrompt";
import type { PermissionRequest } from "@/lib/types";

function makeReq(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
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

describe("PermissionPrompt", () => {
  it("fires Approve on click", () => {
    const onApprove = vi.fn();
    render(<PermissionPrompt request={makeReq()} onApprove={onApprove} onDeny={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("fires Deny on click", () => {
    const onDeny = vi.fn();
    render(<PermissionPrompt request={makeReq()} onApprove={() => {}} onDeny={onDeny} />);
    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it("shows an honest expired state (no clickable buttons) past the 60s budget", () => {
    render(
      <PermissionPrompt
        request={makeReq({ receivedAt: Date.now() / 1000 - 120 })}
        onApprove={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(screen.getByText(/expired/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
  });

  it("Escape denies", () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(<PermissionPrompt request={makeReq()} onApprove={onApprove} onDeny={onDeny} />);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("does NOT globally approve on Enter — the focused button owns Enter", () => {
    // Regression: a container-level Enter→approve inverted the user's decision,
    // approving even when Deny was focused. Enter must never force-approve; the
    // native focused <button> handles Enter/Space itself.
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(<PermissionPrompt request={makeReq()} onApprove={onApprove} onDeny={onDeny} />);
    const dialog = screen.getByRole("alertdialog");
    // Enter bubbling from the container (e.g. while Deny is focused) must not approve.
    fireEvent.keyDown(dialog, { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("button", { name: /deny/i }), { key: "Enter" });
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("Enter on the Deny button denies, never approves", () => {
    // In a real browser Enter on a focused <button> synthesizes a click. jsdom
    // doesn't, so we assert the two guarantees directly: Enter never approves,
    // and activating Deny denies.
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(<PermissionPrompt request={makeReq()} onApprove={onApprove} onDeny={onDeny} />);
    const deny = screen.getByRole("button", { name: /deny/i });
    deny.focus();
    fireEvent.keyDown(deny, { key: "Enter" });
    expect(onApprove).not.toHaveBeenCalled();
    fireEvent.click(deny); // the activation a focused-button Enter performs
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it("disables both buttons while a decision is in flight (blocks duplicate sends)", () => {
    let resolve!: () => void;
    const onApprove = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const onDeny = vi.fn();
    render(<PermissionPrompt request={makeReq()} onApprove={onApprove} onDeny={onDeny} />);
    const approve = screen.getByRole("button", { name: /approve/i });
    const deny = screen.getByRole("button", { name: /deny/i });
    fireEvent.click(approve);
    expect(onApprove).toHaveBeenCalledTimes(1);
    // In flight: both disabled, so a held Enter / double-click no-ops.
    expect(approve).toBeDisabled();
    expect(deny).toBeDisabled();
    fireEvent.click(approve);
    fireEvent.click(deny);
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onDeny).not.toHaveBeenCalled();
    resolve();
  });

  it("re-enables the buttons if the decision invoke rejects", async () => {
    const onApprove = vi.fn(() => Promise.reject(new Error("invoke failed")));
    render(<PermissionPrompt request={makeReq()} onApprove={onApprove} onDeny={() => {}} />);
    const approve = screen.getByRole("button", { name: /approve/i });
    fireEvent.click(approve);
    await waitFor(() => expect(approve).not.toBeDisabled());
    expect(screen.getByRole("button", { name: /deny/i })).not.toBeDisabled();
  });
});
