import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import App from "./App";

function applyTheme(theme: string) {
  document.documentElement.setAttribute("data-theme", theme);
  if (theme === "light") {
    document.body.style.backgroundColor = "#f5f5f5";
    document.body.style.color = "#1a1a1a";
  } else {
    document.body.style.backgroundColor = "#1a1a1a";
    document.body.style.color = "#fff";
  }
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
