import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
  it("renders live Approve/Deny for an active request and fires them", () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(<PermissionPrompt request={makeReq()} onApprove={onApprove} onDeny={onDeny} />);
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(onApprove).toHaveBeenCalledTimes(1);
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

  it("supports keyboard: Enter approves, Escape denies", () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(<PermissionPrompt request={makeReq()} onApprove={onApprove} onDeny={onDeny} />);
    const dialog = screen.getByRole("alertdialog");
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(onApprove).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onDeny).toHaveBeenCalledTimes(1);
  });
});
