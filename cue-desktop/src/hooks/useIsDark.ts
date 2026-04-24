import { useEffect, useState } from "react";

/**
 * Live-subscribing theme flags. Reads `data-glass` and `data-theme` on the
 * document root (set by main.tsx) and re-renders when either flips.
 * Memoized components that read the DOM during render would otherwise pick
 * up stale values after a theme change.
 */
function readTheme(): { isDark: boolean; isGlass: boolean } {
  if (typeof document === "undefined") return { isDark: true, isGlass: false };
  const el = document.documentElement;
  const isGlass = el.hasAttribute("data-glass");
  const isDark = isGlass || el.getAttribute("data-theme") !== "light";
  return { isDark, isGlass };
}

export function useTheme(): { isDark: boolean; isGlass: boolean } {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-glass"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

export function useIsDark(): boolean {
  return useTheme().isDark;
}
