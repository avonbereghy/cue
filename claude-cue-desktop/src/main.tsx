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

// Detect system theme and apply before React renders
invoke<string>("get_theme").then(applyTheme).catch(() => applyTheme("dark"));

// Listen for OS theme changes
const mq = window.matchMedia("(prefers-color-scheme: dark)");
mq.addEventListener("change", () => {
  invoke<string>("get_theme").then(applyTheme).catch(() => {});
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
