import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { debounce } from "./debounce";

describe("debounce", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs once, after the window, with the latest args", () => {
    const fn = vi.fn();
    const d = debounce(fn, 200);
    d("a");
    d("b");
    d("c");
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(199);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("c");
  });

  it("flush() runs the pending call immediately and only once", () => {
    const fn = vi.fn();
    const d = debounce(fn, 200);
    d("x");
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("x");
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel() drops the pending call", () => {
    const fn = vi.fn();
    const d = debounce(fn, 200);
    d("y");
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
  });

  it("flush()/cancel() with nothing pending are no-ops", () => {
    const fn = vi.fn();
    const d = debounce(fn, 200);
    d.flush();
    d.cancel();
    expect(fn).not.toHaveBeenCalled();
  });

  it("restarts the timer on each call (trailing edge)", () => {
    const fn = vi.fn();
    const d = debounce(fn, 200);
    d("1");
    vi.advanceTimersByTime(150);
    d("2"); // resets the 200ms window
    vi.advanceTimersByTime(150);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("2");
  });
});
