import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SIGNAL_THEMES, applyThemeCssVars } from "@/lib/types";
import type { Settings, SignalTheme, ThemeCustomization } from "@/lib/types";
import { DASHBOARD_VIEWS, normalizeView } from "@/lib/dashboardViews";

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

/** Little preview chip per Look (bg + a representative warm accent). */
const LOOK_SWATCH: Record<string, { bg: string; accent: string }> = {
  instrument: { bg: "#1b1b1b", accent: "#3b82f6" },
  almanac:    { bg: "#f4ecd8", accent: "#a23a2e" },
  night:      { bg: "#241c14", accent: "#e8a14a" },
  studio:     { bg: "#efe6d6", accent: "#bd552e" },
};

// ── Component ─────────────────────────────────────────────────────────────────

export function ThemePickerPage() {
  const [activeId, setActiveId] = useState("default");
  const [view, setView] = useState("instrument");
  const [settings, setSettings] = useState<Settings | null>(null);

  const loadSettings = useCallback(() => {
    invoke<Settings>("get_settings").then((s) => {
      setSettings(s);
      const id = s.activeThemeId ?? "default";
      setActiveId(id);
      setView(normalizeView(s.dashboardView));
      const theme = SIGNAL_THEMES.find((t) => t.id === id);
      if (theme) applyThemeCssVars(theme);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    loadSettings();
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<Settings>("settings-changed", (e) => {
      setSettings(e.payload);
      setActiveId(e.payload.activeThemeId ?? "default");
      setView(normalizeView(e.payload.dashboardView));
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, [loadSettings]);

  // Pick a Look (Instrument / Almanac / Night / Studio). Persisting fires
  // settings-changed, which re-skins the main dashboard live (see main.tsx).
  const selectLook = (id: string) => {
    setView(id);
    invoke<Settings>("get_settings").then((s) => {
      invoke("update_settings", { newSettings: { ...s, dashboardView: id } });
    }).catch(() => {});
  };

  const selectTheme = (theme: SignalTheme) => {
    setActiveId(theme.id);
    const customizations = settings?.themeCustomizations ?? {};
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
  const isInstrument = view === "instrument";
  // Instrument recolors its signal strings + surfaces; Night Study borrows the
  // theme accent for its lamplight. Almanac/Studio ship fixed palettes.
  const showColors = view === "instrument" || view === "night";
  const activeLook = DASHBOARD_VIEWS.find((v) => v.id === view);

  return (
    <div className="h-screen flex flex-col keyboard-panel" data-tauri-drag-region>
      {/* Title bar */}
      <div className="flex items-center px-3 py-1.5 border-b keyboard-panel-border" data-tauri-drag-region>
        <span className="text-[0.625rem] keyboard-panel-dim uppercase tracking-wider" data-tauri-drag-region>Appearance</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Look chooser */}
        <div className="px-2.5 pt-2.5">
          <div className="text-[0.5rem] keyboard-panel-dim uppercase tracking-[0.18em] mb-1.5 px-0.5">Look</div>
          <div className="grid grid-cols-2 gap-1.5">
            {DASHBOARD_VIEWS.map((v) => {
              const sw = LOOK_SWATCH[v.id] ?? LOOK_SWATCH.instrument;
              const isActive = view === v.id;
              return (
                <button
                  key={v.id}
                  onClick={() => selectLook(v.id)}
                  className={`keyboard-key flex items-center gap-2 h-12 px-2 rounded-lg transition-all duration-100 cursor-pointer ${
                    isActive ? "keyboard-key--active ring-1 ring-white/30" : "active:scale-95"
                  }`}
                  title={v.blurb}
                >
                  <span
                    className="w-7 h-7 rounded-md border border-white/15 flex items-center justify-center shrink-0"
                    style={{ backgroundColor: sw.bg }}
                  >
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: sw.accent }} />
                  </span>
                  <span className="text-[0.5625rem] keyboard-panel-dim text-left leading-tight">{v.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Color presets — only for the Instrument look (they recolor the
            signal strings + surfaces; the other looks ship their own palette). */}
        {showColors ? (
          <div className="px-2.5 pt-3">
            <div className="text-[0.5rem] keyboard-panel-dim uppercase tracking-[0.18em] mb-1.5 px-0.5">{isInstrument ? "Color" : "Lamplight"}</div>
            <div className="grid grid-cols-3 gap-1.5">
              {SIGNAL_THEMES.map((theme) => {
                const isActive = activeId === theme.id;
                // In Night, the neutral "default" theme maps to Night's native amber.
                const dot = !isInstrument && theme.id === "default" ? "#e8a14a" : theme.accent;
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
                      style={{ backgroundColor: dot }}
                    />
                    <span className="text-[0.5rem] keyboard-panel-dim mt-1">{theme.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Save / Reset — instrument only (they customize the signal strings +
                sand, which Night Study doesn't use; Night just takes the accent). */}
            {isInstrument && (
              <div className="flex gap-1.5 pt-2.5 pb-2.5">
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
            )}
            {!isInstrument && (
              <p className="text-[0.5rem] keyboard-panel-dim leading-relaxed px-0.5 pt-2 pb-2.5">
                Tints Night Study's lamplight &amp; brass. <span className="opacity-80">Default</span> keeps its native amber.
              </p>
            )}
          </div>
        ) : (
          <div className="px-3.5 pt-4 pb-3">
            <p className="text-[0.5625rem] keyboard-panel-dim leading-relaxed">
              <span className="opacity-80">{activeLook?.label}</span> ships its own hand-made palette &amp; type — there are no separate color presets for this look. Switch to <span className="opacity-80">Instrument</span> for the signal-color themes.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
