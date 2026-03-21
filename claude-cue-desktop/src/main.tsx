import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
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

function getSystemTheme(): string {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Resolve the effective theme from the saved preference. */
function resolveTheme(pref: string): string {
  if (pref === "light" || pref === "dark") return pref;
  return getSystemTheme(); // "auto" or unknown → follow system
}

// Read saved theme preference and apply before React renders
invoke<{ theme?: string }>("get_settings")
  .then((s) => applyTheme(resolveTheme(s.theme ?? "auto")))
  .catch(() => applyTheme(getSystemTheme()));

// Listen for OS theme changes — only matters when preference is "auto"
const mq = window.matchMedia("(prefers-color-scheme: dark)");
mq.addEventListener("change", () => {
  invoke<{ theme?: string }>("get_settings")
    .then((s) => {
      const pref = s.theme ?? "auto";
      if (pref === "auto") applyTheme(getSystemTheme());
    })
    .catch(() => {});
});

// Expose for SettingsView to call when theme changes
(window as unknown as Record<string, unknown>).__applyTheme = (pref: string) => {
  applyTheme(resolveTheme(pref));
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
