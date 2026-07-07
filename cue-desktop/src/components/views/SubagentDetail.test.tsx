import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SubagentDetail } from "./SubagentDetail";
import type { SubagentDetailPalette } from "./SubagentDetail";
import type { SubagentMetrics } from "@/lib/types";

// The component consumes a SubagentMetrics + a palette, so the fixture is a
// plain object of that exact shape — no cast needed (RateLimitSource style).
function agent(over: Partial<SubagentMetrics> = {}): SubagentMetrics {
  return {
    agentId: "a-1",
    description: "audit the auth flow",
    slug: "sprouting-hellman",
    inputTokens: 1200,
    outputTokens: 340,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    model: "claude-opus-4-20250514",
    toolCounts: {},
    messageCount: 3,
    isActive: false,
    startedAt: 1_000_000,
    endedAt: 1_000_120,
    runningToolName: null,
    runningToolTarget: null,
    lastAssistantText: null,
    ...over,
  };
}

const PALETTE: SubagentDetailPalette = {
  text: "#fff",
  muted: "#ccc",
  faint: "#888",
  rule: "#444",
  mono: "monospace",
  accent: "#7CC5FF",
};

describe("SubagentDetail", () => {
  it("renders the task description and the formatted model", () => {
    const { container } = render(<SubagentDetail agent={agent()} palette={PALETTE} />);
    expect(container.textContent).toContain("audit the auth flow");
    // formatModelName("claude-opus-4-20250514") → "Opus 4.20250514"
    expect(container.textContent).toContain("Opus");
  });

  it("falls back to the slug when the description is empty", () => {
    const { container } = render(
      <SubagentDetail agent={agent({ description: "" })} palette={PALETTE} />,
    );
    expect(container.textContent).toContain("sprouting-hellman");
  });

  it("shows the running-tool line for an active agent (tool + target)", () => {
    const { container } = render(
      <SubagentDetail
        agent={agent({
          isActive: true,
          endedAt: null,
          runningToolName: "Read",
          runningToolTarget: "src/audit.rs",
          // Even with prior prose, the live tool wins.
          lastAssistantText: "earlier thought",
        })}
        palette={PALETTE}
      />,
    );
    expect(container.textContent).toContain("Running:");
    expect(container.textContent).toContain("Read");
    expect(container.textContent).toContain("src/audit.rs");
    expect(container.textContent).toContain("Active");
    // The result label must not appear while a tool is running.
    expect(container.textContent).not.toContain("Result");
  });

  it("shows the result line for a returned agent, not a running line", () => {
    const { container } = render(
      <SubagentDetail
        agent={agent({ isActive: false, lastAssistantText: "Audit complete: no issues found" })}
        palette={PALETTE}
      />,
    );
    expect(container.textContent).toContain("Result");
    expect(container.textContent).toContain("Audit complete: no issues found");
    expect(container.textContent).toContain("Returned");
    expect(container.textContent).not.toContain("Running:");
  });

  it("renders the tool breakdown busiest-first", () => {
    const { container } = render(
      <SubagentDetail
        agent={agent({ toolCounts: { Bash: 5, Read: 12, Edit: 3 } })}
        palette={PALETTE}
      />,
    );
    expect(container.textContent).toContain("Read ×12 · Bash ×5 · Edit ×3");
  });

  it("computes the cache-read percentage", () => {
    const { container } = render(
      <SubagentDetail
        agent={agent({ cacheReadTokens: 90, cacheCreationTokens: 10 })}
        palette={PALETTE}
      />,
    );
    expect(container.textContent).toContain("90% cache");
  });

  it("exposes the row as an accessible region", () => {
    const { getByRole } = render(<SubagentDetail agent={agent()} palette={PALETTE} />);
    expect(getByRole("region")).toBeInTheDocument();
  });
});
