import { describe, it, expect } from "vitest";
import { updateStatusLabel } from "./updater";

describe("updateStatusLabel", () => {
  it("defaults to the actionable 'Check for Updates…' when idle", () => {
    expect(updateStatusLabel("idle")).toBe("Check for Updates…");
  });

  it("gives honest, distinct feedback for every terminal status", () => {
    // A manual check must say what happened — never a silent no-op (#7).
    expect(updateStatusLabel("checking")).toBe("Checking for updates…");
    expect(updateStatusLabel("uptodate")).toBe("You’re up to date");
    expect(updateStatusLabel("updating")).toBe("Update available — installing…");
    expect(updateStatusLabel("error")).toBe("Update check failed");
  });

  it("returns a non-empty label for each status (no dead button text)", () => {
    for (const s of ["idle", "checking", "uptodate", "updating", "error"] as const) {
      expect(updateStatusLabel(s).length).toBeGreaterThan(0);
    }
  });
});
