import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DismissButton } from "./DismissButton";

describe("DismissButton", () => {
  it("calls onDismiss with the session id when clicked", () => {
    const onDismiss = vi.fn();
    render(<DismissButton sessionId="abc123" title="My Project" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss my project/i }));
    expect(onDismiss).toHaveBeenCalledWith("abc123");
  });

  it("stops propagation so it never triggers the card's open-project click", () => {
    const onDismiss = vi.fn();
    const onCardClick = vi.fn();
    render(
      <div onClick={onCardClick}>
        <DismissButton sessionId="s1" title="Proj" onDismiss={onDismiss} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it("is a native button (so every card's click guard skips it)", () => {
    render(<DismissButton sessionId="s1" title="Proj" onDismiss={() => {}} />);
    expect(screen.getByRole("button").tagName).toBe("BUTTON");
  });
});
