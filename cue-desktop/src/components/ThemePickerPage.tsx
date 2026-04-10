import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SIGNAL_THEMES, applyThemeCssVars } from "@/lib/types";
import type { Settings, SignalTheme, ThemeCustomization } from "@/lib/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

type AppearanceFields = ThemeCustomization;

function extractAppearance(s: Settings): AppearanceFields {
  return {
    signalColorDark: s.signalColorDark,
    signalColorLight: s.signalColorLight,
    signalAlpha: s.signalAlpha,
    signalAmplitude: s.signalAmplitude,
    signalEcho: s.signalEcho,
    signalEffect: s.signalEffect,
    sandEnabled: s.sandEnabled,
    sandIntensity: s.sandIntensity,
    sandDirection: s.sandDirection,
    sandDensity: s.sandDensity,
    sandSpeed: s.sandSpeed,
    sandGrainSize: s.sandGrainSize,
    sandTurbulence: s.sandTurbulence,
    sandAlpha: s.sandAlpha,
  };
}

function themeDefaults(theme: SignalTheme): AppearanceFields {
  return {
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
  };
}

function committedAppearance(
  themeId: string,
  customizations: Record<string, ThemeCustomization>
): AppearanceFields {
  if (customizations[themeId]) return customizations[themeId];
  const theme = SIGNAL_THEMES.find((t) => t.id === themeId);
  if (!theme) return customizations[themeId] ?? ({} as AppearanceFields);
  return themeDefaults(theme);
}

const EPS = 0.001;
function appearanceDirty(a: AppearanceFields, b: AppearanceFields): boolean {
  return (
    a.signalColorDark !== b.signalColorDark ||
    a.signalColorLight !== b.signalColorLight ||
    a.signalEffect !== b.signalEffect ||
    a.sandEnabled !== b.sandEnabled ||
    Math.abs(a.signalAlpha - b.signalAlpha) > EPS ||
    Math.abs(a.signalAmplitude - b.signalAmplitude) > EPS ||
    Math.abs(a.signalEcho - b.signalEcho) > EPS ||
    Math.abs(a.sandIntensity - b.sandIntensity) > EPS ||
    Math.abs(a.sandDirection - b.sandDirection) > EPS ||
    Math.abs(a.sandDensity - b.sandDensity) > EPS ||
    Math.abs(a.sandSpeed - b.sandSpeed) > EPS ||
    Math.abs(a.sandGrainSize - b.sandGrainSize) > EPS ||
    Math.abs(a.sandTurbulence - b.sandTurbulence) > EPS ||
    Math.abs(a.sandAlpha - b.sandAlpha) > EPS
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ThemePickerPage() {
  const [activeId, setActiveId] = useState("default");
  const [settings, setSettings] = useState<Settings | null>(null);

  const loadSettings = useCallback(() => {
    invoke<Settings>("get_settings").then((s) => {
      setSettings(s);
      const id = s.activeThemeId ?? "default";
      setActiveId(id);
      const theme = SIGNAL_THEMES.find((t) => t.id === id);
      if (theme) applyThemeCssVars(theme);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    loadSettings();
    let unlisten: (() => void) | undefined;
    listen<Settings>("settings-changed", (e) => {
      setSettings(e.payload);
      setActiveId(e.payload.activeThemeId ?? "default");
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [loadSettings]);

  const selectTheme = (theme: SignalTheme) => {
    setActiveId(theme.id);
    const customizations = settings?.themeCustomizations ?? {};
    // Apply saved customization if it exists, otherwise apply theme defaults
    const saved = customizations[theme.id];
    const appearance: AppearanceFields = saved ?? themeDefaults(theme);
    applyThemeCssVars(theme);
    const isGlass = theme.id === "glass";
    invoke("set_vibrancy", { enabled: isGlass }).catch(() => {});
    invoke<Settings>("get_settings").then((s) => {
      invoke("update_settings", {
        newSettings: {
          ...s,
          activeThemeId: theme.id,
          signalColorDark: appearance.signalColorDark,
          signalColorLight: appearance.signalColorLight,
          signalAlpha: appearance.signalAlpha,
          signalAmplitude: appearance.signalAmplitude,
          signalEcho: appearance.signalEcho,
          signalEffect: appearance.signalEffect,
          sandEnabled: appearance.sandEnabled,
          sandIntensity: appearance.sandIntensity,
          sandDirection: appearance.sandDirection,
          sandDensity: appearance.sandDensity,
          sandSpeed: appearance.sandSpeed,
          sandGrainSize: appearance.sandGrainSize,
          sandTurbulence: appearance.sandTurbulence,
          sandAlpha: appearance.sandAlpha,
        },
      });
    }).catch(() => {});
  };

  const handleSave = () => {
    if (!settings) return;
    const current = extractAppearance(settings);
    const customizations = { ...(settings.themeCustomizations ?? {}), [activeId]: current };
    invoke("update_settings", {
      newSettings: { ...settings, themeCustomizations: customizations },
    }).then(() => loadSettings()).catch(() => {});
  };

  const handleReset = () => {
    if (!settings) return;
    const theme = SIGNAL_THEMES.find((t) => t.id === activeId);
    if (!theme) return;
    const defaults = themeDefaults(theme);
    const { [activeId]: _removed, ...rest } = settings.themeCustomizations ?? {};
    applyThemeCssVars(theme);
    invoke("update_settings", {
      newSettings: {
        ...settings,
        themeCustomizations: rest,
        signalColorDark: defaults.signalColorDark,
        signalColorLight: defaults.signalColorLight,
        signalAlpha: defaults.signalAlpha,
        signalAmplitude: defaults.signalAmplitude,
        signalEcho: defaults.signalEcho,
        signalEffect: defaults.signalEffect,
        sandEnabled: defaults.sandEnabled,
        sandIntensity: defaults.sandIntensity,
        sandDirection: defaults.sandDirection,
        sandDensity: defaults.sandDensity,
        sandSpeed: defaults.sandSpeed,
        sandGrainSize: defaults.sandGrainSize,
        sandTurbulence: defaults.sandTurbulence,
        sandAlpha: defaults.sandAlpha,
      },
    }).then(() => loadSettings()).catch(() => {});
  };

  const customizations = settings?.themeCustomizations ?? {};
  const currentAppearance = settings ? extractAppearance(settings) : null;
  const committed = committedAppearance(activeId, customizations);
  const isDirty = currentAppearance ? appearanceDirty(currentAppearance, committed) : false;
  const hasCustomization = Boolean(customizations[activeId]);

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

      {/* Save / Reset row */}
      <div className="flex gap-1.5 px-2.5 pb-2.5">
        <button
          onClick={handleSave}
          disabled={!isDirty}
          className={`flex-1 h-7 rounded-md text-[0.5625rem] font-medium tracking-wide transition-all duration-100 ${
            isDirty
              ? "keyboard-key keyboard-key--active cursor-pointer active:scale-95"
              : "keyboard-key opacity-30 cursor-not-allowed"
          }`}
        >
          Save
        </button>
        <button
          onClick={handleReset}
          disabled={!hasCustomization}
          className={`flex-1 h-7 rounded-md text-[0.5625rem] font-medium tracking-wide transition-all duration-100 ${
            hasCustomization
              ? "keyboard-key cursor-pointer active:scale-95"
              : "keyboard-key opacity-30 cursor-not-allowed"
          }`}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
