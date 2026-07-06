import { describe, it, expect, vi } from "vitest";
import { releaseGlContext } from "./webgl";

describe("releaseGlContext", () => {
  it("calls loseContext via the WEBGL_lose_context extension", () => {
    const loseContext = vi.fn();
    const getExtension = vi.fn((name: string) =>
      name === "WEBGL_lose_context" ? { loseContext } : null,
    );
    releaseGlContext({ getExtension } as unknown as WebGLRenderingContext);
    expect(getExtension).toHaveBeenCalledWith("WEBGL_lose_context");
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it("is a no-op (no throw) when gl is null or undefined", () => {
    expect(() => releaseGlContext(null)).not.toThrow();
    expect(() => releaseGlContext(undefined)).not.toThrow();
  });

  it("is a no-op (no throw) when the extension is unavailable", () => {
    const gl = { getExtension: () => null } as unknown as WebGLRenderingContext;
    expect(() => releaseGlContext(gl)).not.toThrow();
  });

  it("does not throw if getExtension itself throws", () => {
    const gl = {
      getExtension: () => {
        throw new Error("context lost");
      },
    } as unknown as WebGLRenderingContext;
    expect(() => releaseGlContext(gl)).not.toThrow();
  });
});
