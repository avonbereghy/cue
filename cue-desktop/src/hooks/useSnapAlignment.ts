import { useEffect, useState } from "react";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";

export type SnapAlignment = "left" | "right";

/**
 * Which horizontal half of its monitor the window currently occupies.
 *
 * Lets the card column hug the snapped edge: when the user snaps Cue to the
 * right half of the screen the column right-aligns; to the left half, it
 * left-aligns. Below the column's max-width the column is full-width, so the
 * alignment is a visual no-op there — it only matters once the window is wider
 * than the cards.
 *
 * Recomputed on every move/resize via the Tauri window events. All geometry is
 * in physical pixels (window outer rect + monitor rect share the same unit), so
 * no scale-factor conversion is needed for the center comparison. Defaults to
 * "left" until the first async read resolves, and on any error, so the layout
 * matches the historical left-leaning behavior when geometry is unavailable.
 */
export function useSnapAlignment(): SnapAlignment {
  const [align, setAlign] = useState<SnapAlignment>("left");

  useEffect(() => {
    const win = getCurrentWindow();
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    const recompute = async () => {
      try {
        const [pos, size, mon] = await Promise.all([
          win.outerPosition(),
          win.outerSize(),
          currentMonitor(),
        ]);
        if (cancelled || !mon) return;
        const windowCenter = pos.x + size.width / 2;
        const monitorCenter = mon.position.x + mon.size.width / 2;
        setAlign(windowCenter >= monitorCenter ? "right" : "left");
      } catch {
        // Geometry unavailable (e.g. headless / detached) — keep prior value.
      }
    };

    void recompute();
    // Register listeners; if the effect already tore down before they
    // resolved, unlisten immediately so we never leak a subscription.
    const track = (p: Promise<() => void>) =>
      p.then((un) => {
        if (cancelled) un();
        else unlisteners.push(un);
      });
    void track(win.onMoved(() => void recompute()));
    void track(win.onResized(() => void recompute()));

    return () => {
      cancelled = true;
      unlisteners.forEach((un) => un());
    };
  }, []);

  return align;
}
