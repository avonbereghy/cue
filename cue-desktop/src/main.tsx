import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SIGNAL_THEMES, applyThemeCssVars } from "@/lib/types";
import type { Settings } from "@/lib/types";
import App from "./App";

function applyTheme(theme: string) {
  // Glass theme always forces dark mode — check the live data-glass attribute
  // (set by applyThemeCssVars) rather than re-reading settings, which may be stale.
  invoke<Settings>("get_settings").then((s) => {
    const themeId = s.activeThemeId ?? "default";
    const isGlass = document.documentElement.hasAttribute("data-glass");
    const effectiveTheme = isGlass ? "dark" : theme;
    document.documentElement.setAttribute("data-theme", effectiveTheme);
    document.body.style.color = effectiveTheme === "light" ? "#1a1a1a" : "#fff";
    const signalTheme = SIGNAL_THEMES.find(t => t.id === themeId) ?? SIGNAL_THEMES[0];
    applyThemeCssVars(signalTheme);
    // Apply low power mode attribute
    if (s.lowPower) document.documentElement.setAttribute("data-low-power", "");
    else document.documentElement.removeAttribute("data-low-power");
  }).catch(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.body.style.color = theme === "light" ? "#1a1a1a" : "#fff";
  });
}

/** Get the system theme from the Rust backend (reads macOS defaults). */
function fetchSystemTheme(): Promise<string> {
  return invoke<string>("get_theme");
}

/** Resolve the effective theme from the saved preference. */
async function resolveTheme(pref: string): Promise<string> {
  if (pref === "light" || pref === "dark") return pref;
  return fetchSystemTheme(); // "auto" or unknown → follow system
}

// Read saved theme preference and apply before React renders
invoke<{ theme?: string }>("get_settings")
  .then(async (s) => applyTheme(await resolveTheme(s.theme ?? "auto")))
  .catch(async () => applyTheme(await fetchSystemTheme().catch(() => "dark")));

// Listen for system theme changes from Rust backend — only matters when preference is "auto"
listen<string>("system-theme-changed", (event) => {
  invoke<{ theme?: string }>("get_settings")
    .then((s) => {
      const pref = s.theme ?? "auto";
      if (pref === "auto") applyTheme(event.payload);
    })
    .catch(() => {});
});

// Expose for SettingsView to call when theme changes
(window as unknown as Record<string, unknown>).__applyTheme = (pref: string) => {
  resolveTheme(pref).then(applyTheme).catch(() => applyTheme("dark"));
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
