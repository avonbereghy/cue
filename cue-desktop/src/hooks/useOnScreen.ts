import { useState, useEffect, RefObject } from "react";

/**
 * Returns true while the referenced element intersects the viewport at all
 * (even one pixel). Intended for gating expensive rAF canvas loops on cards
 * that may be scrolled off-screen — off-screen cards should not spend CPU.
 *
 * Defaults to true pre-mount so first-frame work isn't gated by the first
 * IntersectionObserver callback landing.
 */
export function useOnScreen<T extends Element>(ref: RefObject<T | null>): boolean {
  const [onScreen, setOnScreen] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setOnScreen(entry.isIntersecting);
      },
      { root: null, threshold: 0 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [ref]);

  return onScreen;
}
