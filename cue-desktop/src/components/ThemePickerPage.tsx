import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SIGNAL_THEMES, applyThemeCssVars } from "@/lib/types";
import type { Settings, SignalTheme } from "@/lib/types";

export function ThemePickerPage() {
  const [activeId, setActiveId] = useState("default");

  useEffect(() => {
    invoke<Settings>("get_settings").then((s) => {
      setActiveId(s.activeThemeId ?? "default");
      const theme = SIGNAL_THEMES.find((t) => t.id === (s.activeThemeId ?? "default"));
      if (theme) applyThemeCssVars(theme);
    }).catch(() => {});

    let unlisten: (() => void) | undefined;
    listen<Settings>("settings-changed", (e) => {
      setActiveId(e.payload.activeThemeId ?? "default");
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  const selectTheme = (theme: SignalTheme) => {
    setActiveId(theme.id);
    applyThemeCssVars(theme);
    // Toggle native vibrancy when switching to/from glass themes
    const isGlass = theme.id === "glass";
    invoke("set_vibrancy", { enabled: isGlass }).catch(() => {});
    invoke<Settings>("get_settings").then((s) => {
      invoke("update_settings", {
        newSettings: {
          ...s,
          activeThemeId: theme.id,
          signalColorDark: theme.colorDark,
          signalColorLight: theme.colorLight,
          signalAlpha: theme.alpha,
          signalAmplitude: theme.amplitude,
          signalEcho: theme.echo,
          signalEffect: theme.signalEffect,
          sandEnabled: theme.sandEnabled,
          sandIntensity: theme.sandIntensity,
          sandDirection: theme.sandDirection,
          sandDensity: theme.sandDensity,
          sandSpeed: theme.sandSpeed,
          sandGrainSize: theme.sandGrainSize,
          sandTurbulence: theme.sandTurbulence,
          sandAlpha: theme.sandAlpha,
        },
      });
    }).catch(() => {});
  };

  return (
    <div className="h-screen flex flex-col keyboard-panel" data-tauri-drag-region>
      {/* Title bar */}
      <div className="flex items-center px-3 py-1.5 border-b keyboard-panel-border" data-tauri-drag-region>
        <span className="text-[0.625rem] keyboard-panel-dim uppercase tracking-wider" data-tauri-drag-region>Themes</span>
      </div>

      {/* Theme Grid */}
      <div className="flex-1 grid grid-cols-3 gap-1.5 p-2.5 content-center">
        {SIGNAL_THEMES.map((theme) => {
          const isActive = activeId === theme.id;
          return (
            <button
              key={theme.id}
              onClick={() => selectTheme(theme)}
              className={`keyboard-key flex flex-col items-center justify-center h-14 rounded-lg transition-all duration-100 cursor-pointer ${
                isActive ? "keyboard-key--active ring-1 ring-white/30" : "active:scale-95"
              }`}
              title={theme.label}
            >
              <span
                className="w-4 h-4 rounded-full border border-white/20"
                style={{ backgroundColor: theme.accent }}
              />
              <span className="text-[0.5rem] keyboard-panel-dim mt-1">{theme.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
