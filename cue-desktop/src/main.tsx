import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SIGNAL_THEMES, applyThemeCssVars } from "@/lib/types";
import { applyDashboardView } from "@/lib/dashboardViews";
import type { Settings } from "@/lib/types";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Night Study borrows the active color theme's accent for its lamplight/brass,
// but keeps its native amber for the neutral "default" theme so it always debuts
// warm. Setting/clearing --night-accent on <html> retints night.css live.
function applyNightAccent(view: string | undefined, themeId: string, accent: string) {
  const el = document.documentElement;
  if (view === "night" && themeId !== "default") el.style.setProperty("--night-accent", accent);
  else el.style.removeProperty("--night-accent");
}

// Monotonic token guarding every theme write. applyTheme, the settings-changed
// handler, and window.__applyTheme each do their own async round trip
// (get_settings / resolveTheme), so two rapid triggers can resolve out of
// order. Each path stamps itself with the next value up front and drops its DOM
// writes if a newer trigger has since superseded it — so the latest wins even
// when an earlier request's promise settles last.
let themeSeq = 0;

function applyTheme(theme: string) {
  const seq = ++themeSeq;
  // Glass theme always forces dark mode. Derive this from the persisted
  // activeThemeId, NOT the live data-glass attribute: on cold start applyThemeCssVars
  // (the only setter of data-glass) hasn't run yet, so reading the attribute here
  // would miss a persisted glass theme and leave dark text on the transparent
  // surface. Mirrors the settings-changed handler below.
  invoke<Settings>("get_settings").then((s) => {
    if (seq !== themeSeq) return; // a newer trigger already applied — drop stale
    const themeId = s.activeThemeId ?? "default";
    const isGlass = themeId === "glass";
    const effectiveTheme = isGlass ? "dark" : theme;
    document.documentElement.setAttribute("data-theme", effectiveTheme);
    document.body.style.color = effectiveTheme === "light" ? "#1a1a1a" : "#fff";
    const signalTheme = SIGNAL_THEMES.find(t => t.id === themeId) ?? SIGNAL_THEMES[0];
    applyThemeCssVars(signalTheme);
    // Apply the dashboard "Look" AFTER the theme so a skin's shell overrides win.
    applyDashboardView(s.dashboardView);
    applyNightAccent(s.dashboardView, themeId, signalTheme.accentColor);
    // Apply low power mode attribute
    if (s.lowPower) document.documentElement.setAttribute("data-low-power", "");
    else document.documentElement.removeAttribute("data-low-power");
  }).catch(() => {
    if (seq !== themeSeq) return; // superseded — don't clobber a newer resolution
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

// Re-apply theme CSS vars when settings change (e.g. theme picker selects glass)
listen<Settings>("settings-changed", (event) => {
  // Share applyTheme's monotonic token: the synchronous palette/look writes
  // below always reflect the latest event (JS is single-threaded), and
  // stamping here means any still-pending applyTheme with an older token drops
  // its resolution instead of clobbering this newer palette.
  const seq = ++themeSeq;
  const s = event.payload;
  const themeId = s.activeThemeId ?? "default";
  const signalTheme = SIGNAL_THEMES.find(t => t.id === themeId) ?? SIGNAL_THEMES[0];
  applyThemeCssVars(signalTheme);
  applyDashboardView(s.dashboardView);
  applyNightAccent(s.dashboardView, themeId, signalTheme.accentColor);
  const isGlass = themeId === "glass";
  if (isGlass) {
    document.documentElement.setAttribute("data-theme", "dark");
    document.body.style.color = "#fff";
  } else {
    resolveTheme(s.theme ?? "auto").then((effective) => {
      if (seq !== themeSeq) return; // superseded by a newer theme trigger
      document.documentElement.setAttribute("data-theme", effective);
      document.body.style.color = effective === "light" ? "#1a1a1a" : "#fff";
    });
  }
});

// Expose for SettingsView to call when theme changes
window.__applyTheme = (pref: string) => {
  resolveTheme(pref).then(applyTheme).catch(() => applyTheme("dark"));
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
