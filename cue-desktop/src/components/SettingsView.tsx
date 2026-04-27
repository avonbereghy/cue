import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Settings, TITLE_ANIMATIONS, ANIMATION_SPEEDS, SIGNAL_THEMES, applyThemeCssVars } from "@/lib/types";
import type { PresetSummary, SignalPreset } from "@/lib/types";
import { extractPreset } from "@/lib/audioExtractor";
import { loadPreset as loadPresetEngine, isLoaded as isPresetLoaded, getCurrentTime as getPresetTime, seek as presetSeek, setGate as setGateEngine } from "@/lib/presetEngine";

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      onClick={onChange}
      className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${checked ? "bg-blue-500" : "bg-white/20"}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
    >
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200 ${checked ? "translate-x-4" : ""}`} style={{ transitionTimingFunction: "cubic-bezier(0.34, 1.5, 0.64, 1)" }} />
    </button>
  );
}

function Select({ value, options, onChange }: { value: string | number; options: { id: string | number; label: string }[]; onChange: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-white/10 border border-white/10 rounded px-2 py-1 text-xs text-white/70 outline-none cursor-pointer hover:bg-white/15 transition-colors"
    >
      {options.map((opt) => (
        <option key={opt.id} value={opt.id} className="bg-neutral-800 text-white">
          {opt.label}
        </option>
      ))}
    </select>
  );
}

function SettingRow({ label, description, children, onReset }: { label: string; description?: string; children: React.ReactNode; onReset?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0 flex items-center gap-1.5">
        <div>
          <div className="text-xs text-white/90">{label}</div>
          {description && <div className="text-[0.625rem] text-white/50 mt-0.5">{description}</div>}
        </div>
        {onReset && (
          <button onClick={onReset} className="text-[0.5625rem] text-white/15 hover:text-white/50 transition-colors" title="Reset to default">↺</button>
        )}
      </div>
      <div className="flex-1 flex items-center justify-end gap-2">{children}</div>
    </div>
  );
}

function Slider({ value, min, max, step, defaultValue, format, isPct, onChange }: {
  value: number; min: number; max: number; step: number; defaultValue: number;
  format: (v: number) => string; isPct?: boolean; onChange: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setText(format(value));
    setEditing(true);
    setTimeout(() => { inputRef.current?.select(); }, 30);
  };

  const finishEdit = () => {
    setEditing(false);
    const parsed = parseFloat(text.replace(/[^0-9.\-]/g, ""));
    if (!isNaN(parsed)) {
      onChange(Math.max(min, Math.min(max, isPct ? parsed / 100 : parsed)));
    }
  };

  return (
    <div className="flex-1 flex items-center gap-1.5">
      {editing ? (
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={finishEdit}
          onKeyDown={(e) => { if (e.key === "Enter") finishEdit(); if (e.key === "Escape") setEditing(false); }}
          className="w-10 text-[0.625rem] text-white/70 font-mono text-right bg-white/10 border border-white/20 rounded px-1 py-0 outline-none"
        />
      ) : (
        <button
          onClick={startEdit}
          className="text-[0.625rem] text-white/30 font-mono w-10 text-right hover:text-white/60 transition-colors cursor-text"
          title="Click to edit"
        >
          {format(value)}
        </button>
      )}
      <input
        type="range" min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 h-1 rounded appearance-none cursor-pointer bg-white/10 accent-blue-500"
      />
      {Math.abs(value - defaultValue) > 0.001 && (
        <button
          onClick={() => onChange(defaultValue)}
          className="text-[0.5625rem] text-white/20 hover:text-white/50 transition-colors"
          title="Reset to default"
        >
          ↺
        </button>
      )}
    </div>
  );
}

function formatPct(v: number): string { return `${Math.round(v * 100)}%`; }
function formatMul(v: number): string { return `${v.toFixed(2)}x`; }
function formatSec(v: number): string { return `${Math.round(v * 1000)}ms`; }

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Draws band envelope waveforms on a canvas with playhead. Used by BandWaveform, SessionsTab, and BandEnvelopesPage. */
export function drawBandEnvelopes(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  preset: SignalPreset | null,
  bands: { bass: boolean; mids: boolean; treble: boolean },
  dark?: boolean,
  gate: number = 0,
) {
  const isDark = dark ?? document.documentElement.getAttribute("data-theme") !== "light";
  ctx.clearRect(0, 0, w, h);
  if (!preset || preset.bands.bass.length === 0) return;

  const total = preset.bands.bass.length;
  const gateScale = gate < 1 ? 1 / (1 - gate) : 0;
  const applyGate = (v: number) => v <= gate ? 0 : (v - gate) * gateScale;
  const bandDefs = isDark ? [
    { key: "bass" as const, color: "rgba(239, 68, 68, 0.7)", fill: "rgba(239, 68, 68, 0.2)", label: "Bass", enabled: bands.bass },
    { key: "mids" as const, color: "rgba(234, 179, 8, 0.6)", fill: "rgba(234, 179, 8, 0.15)", label: "Mids", enabled: bands.mids },
    { key: "treble" as const, color: "rgba(59, 130, 246, 0.6)", fill: "rgba(59, 130, 246, 0.15)", label: "Treble", enabled: bands.treble },
  ] : [
    { key: "bass" as const, color: "rgba(220, 38, 38, 0.8)", fill: "rgba(220, 38, 38, 0.25)", label: "Bass", enabled: bands.bass },
    { key: "mids" as const, color: "rgba(180, 130, 0, 0.8)", fill: "rgba(180, 130, 0, 0.2)", label: "Mids", enabled: bands.mids },
    { key: "treble" as const, color: "rgba(37, 99, 235, 0.8)", fill: "rgba(37, 99, 235, 0.2)", label: "Treble", enabled: bands.treble },
  ];
  const enabledCount = bandDefs.filter(b => b.enabled).length || 1;
  const bandH = h / enabledCount;

  let lane = 0;
  for (const { key, color, fill, label, enabled } of bandDefs) {
    if (!enabled) continue;
    const data = preset.bands[key];
    const yBase = (lane + 1) * bandH;

    // Filled area
    ctx.beginPath();
    ctx.moveTo(0, yBase);
    for (let x = 0; x < w; x++) {
      const idx = Math.floor((x / w) * total);
      ctx.lineTo(x, yBase - applyGate(data[idx] ?? 0) * bandH * 0.9);
    }
    ctx.lineTo(w, yBase);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    // Stroke
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const idx = Math.floor((x / w) * total);
      const y = yBase - applyGate(data[idx] ?? 0) * bandH * 0.9;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Lane separator
    if (lane > 0) {
      ctx.beginPath();
      ctx.moveTo(0, lane * bandH);
      ctx.lineTo(w, lane * bandH);
      ctx.strokeStyle = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.08)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Label
    ctx.fillStyle = isDark ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.35)";
    ctx.font = "9px system-ui";
    ctx.textAlign = "left";
    ctx.fillText(label, 3, lane * bandH + 10);

    lane++;
  }

  // Playhead
  if (preset.durationSecs > 0) {
    const t = getPresetTime();
    const px = (t / preset.durationSecs) * w;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.strokeStyle = isDark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.4)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** Shared seek-on-canvas handler */
function seekFromCanvas(e: React.MouseEvent<HTMLCanvasElement> | MouseEvent, canvas: HTMLCanvasElement, duration: number) {
  const rect = canvas.getBoundingClientRect();
  const x = ("clientX" in e ? e.clientX : 0) - rect.left;
  const ratio = Math.max(0, Math.min(1, x / rect.width));
  presetSeek(ratio * duration);
}

/** Visualizes the 3 extracted band envelopes with interactive scrubbing */
function BandWaveform({ presetId, signalBass, signalMids, signalTreble, signalGate = 0.05 }: { presetId: string; signalBass: boolean; signalMids: boolean; signalTreble: boolean; signalGate?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const presetRef = useRef<SignalPreset | null>(null);
  const animRef = useRef<number>(0);
  const dragging = useRef(false);

  useEffect(() => {
    if (!presetId) return;
    invoke<SignalPreset>("load_preset", { id: presetId })
      .then((p) => { presetRef.current = p; })
      .catch(() => {});
  }, [presetId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const obs = new ResizeObserver(resize);
    obs.observe(canvas);

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      drawBandEnvelopes(ctx, rect.width, rect.height, presetRef.current, { bass: signalBass, mids: signalMids, treble: signalTreble }, undefined, signalGate);
      animRef.current = requestAnimationFrame(draw);
    };
    animRef.current = requestAnimationFrame(draw);

    // Drag-to-scrub
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !presetRef.current) return;
      seekFromCanvas(e, canvas, presetRef.current.durationSecs);
    };
    const onUp = () => { dragging.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    return () => {
      cancelAnimationFrame(animRef.current);
      obs.disconnect();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [presetId, signalBass, signalMids, signalTreble, signalGate]);

  if (!presetId) return null;

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    dragging.current = true;
    const canvas = canvasRef.current;
    if (canvas && presetRef.current) seekFromCanvas(e, canvas, presetRef.current.durationSecs);
  };

  return (
    <canvas
      ref={canvasRef}
      className="w-full rounded border border-white/10 bg-white/5 cursor-crosshair"
      style={{ height: "80px" }}
      onMouseDown={handleMouseDown}
    />
  );
}

interface HookStatusCheck {
  label: string;
  ok: boolean;
  detail: string;
}

function HookStatus() {
  const [checks, setChecks] = useState<HookStatusCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<HookStatusCheck[]>("get_hook_status");
      setChecks(result);
    } catch (err) {
      console.error("Failed to get hook status:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const allOk = checks.length > 0 && checks.every((c) => c.ok);
  const installed = checks.find((c) => c.label === "Hook Events")?.ok ?? false;

  const handleInstall = async () => {
    setActing(true);
    try {
      await invoke("install_cue_hooks");
      await refresh();
    } catch (err) {
      console.error("Install failed:", err);
    } finally {
      setActing(false);
    }
  };

  const handleUninstall = async () => {
    setActing(true);
    try {
      await invoke("uninstall_cue_hooks");
      await refresh();
    } catch (err) {
      console.error("Uninstall failed:", err);
    } finally {
      setActing(false);
    }
  };

  return (
    <details className="rounded-lg bg-white/5 border border-white/10 px-3 py-2" open={!allOk}>
      <summary className="flex items-center gap-2 text-xs cursor-pointer hover:text-white/60 transition-colors select-none">
        <span className={`w-2 h-2 rounded-full shrink-0 ${loading ? "bg-white/20" : allOk ? "bg-green-400" : "bg-red-400"}`} />
        <span className="text-white/50">Installation Status</span>
        {!loading && !allOk && (
          <span className="text-[0.625rem] text-red-400/70 ml-auto">
            {checks.filter((c) => !c.ok).length} issue{checks.filter((c) => !c.ok).length !== 1 ? "s" : ""}
          </span>
        )}
      </summary>
      <div className="mt-2 space-y-1 pb-1">
        {checks.map((check) => (
          <div key={check.label} className="flex items-center gap-2 py-0.5">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${check.ok ? "bg-green-400/80" : "bg-red-400/80"}`} />
            <span className="text-[0.625rem] text-white/60 w-24 shrink-0">{check.label}</span>
            <span className={`text-[0.625rem] truncate ${check.ok ? "text-white/30" : "text-red-400/60"}`}>{check.detail}</span>
          </div>
        ))}
        <div className="flex items-center gap-2 mt-2 pt-1 border-t border-white/5">
          {!installed ? (
            <button
              onClick={handleInstall}
              disabled={acting}
              className="px-2.5 py-1 rounded text-[0.625rem] font-medium bg-green-500/20 hover:bg-green-500/30 text-green-400 transition-colors disabled:opacity-50"
            >
              {acting ? "Installing..." : "Install Hooks"}
            </button>
          ) : (
            <>
              <button
                onClick={handleInstall}
                disabled={acting}
                className="px-2.5 py-1 rounded text-[0.625rem] font-medium bg-white/10 hover:bg-white/15 text-white/50 transition-colors disabled:opacity-50"
              >
                {acting ? "Reinstalling..." : "Reinstall"}
              </button>
              <button
                onClick={handleUninstall}
                disabled={acting}
                className="px-2.5 py-1 rounded text-[0.625rem] font-medium bg-red-500/10 hover:bg-red-500/20 text-red-400/60 hover:text-red-400 transition-colors disabled:opacity-50"
              >
                Uninstall
              </button>
            </>
          )}
          <button
            onClick={refresh}
            disabled={acting}
            className="ml-auto text-[0.625rem] text-white/30 hover:text-white/60 transition-colors disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </div>
    </details>
  );
}

export function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const initialLoadRef = useRef(true);
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [extractProgress, setExtractProgress] = useState("");
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Load active preset on mount if preset mode
  useEffect(() => {
    if (!settings) return;
    const mode = settings.signalMode === "audio" ? "preset" : (settings.signalMode ?? "simulated");
    if (mode !== "preset" || isPresetLoaded() || !settings.activePresetId) return;
    invoke<SignalPreset>("load_preset", { id: settings.activePresetId })
      .then((preset) => loadPresetEngine(preset))
      .catch((err) => console.error("Failed to load preset:", err));
  }, [settings?.signalMode, settings?.activePresetId]);

  const loadSettings = useCallback(async () => {
    try {
      const s = await invoke<Settings>("get_settings");
      if (s.signalMode === "audio") s.signalMode = "preset";
      initialLoadRef.current = true;
      setSettings(s);
    } catch (err) {
      console.error("Failed to load settings:", err);
    }
  }, []);

  const loadPresets = useCallback(async () => {
    try {
      const list = await invoke<PresetSummary[]>("list_presets");
      setPresets(list);
    } catch (err) {
      console.error("Failed to load presets:", err);
    }
  }, []);

  useEffect(() => {
    loadSettings();
    loadPresets();
  }, [loadSettings, loadPresets]);

  // Auto-save: persist every settings change immediately
  useEffect(() => {
    if (!settings) return;
    // Skip the initial load — don't re-save what we just loaded
    if (initialLoadRef.current) {
      initialLoadRef.current = false;
      return;
    }
    invoke("update_settings", { newSettings: settings }).catch((err) =>
      console.error("Failed to save settings:", err),
    );
  }, [settings]);

  const handleUploadAndExtract = async (file: File) => {
    if (!settings) return;
    setExtracting(true);
    setExtractProgress("Decoding audio...");
    try {
      const name = file.name.replace(/\.[^/.]+$/, ""); // Strip extension
      setExtractProgress("Extracting frequency envelopes...");
      const preset = await extractPreset(file, name);

      setExtractProgress("Saving preset...");
      await invoke("save_preset", { preset });

      // Activate the new preset
      const updated = { ...settings, signalMode: "preset", activePresetId: preset.id };
      setSettings(updated);

      // Load into engine
      loadPresetEngine(preset);

      await loadPresets();
      setExtractProgress("");
    } catch (err) {
      console.error("Failed to extract preset:", err);
      setExtractProgress("Failed to extract — try a different file");
      setTimeout(() => setExtractProgress(""), 3000);
    } finally {
      setExtracting(false);
    }
  };

  const handleActivatePreset = async (presetId: string) => {
    if (!settings) return;
    const updated = { ...settings, signalMode: "preset", activePresetId: presetId };
    setSettings(updated);

    // Load into engine
    try {
      const preset = await invoke<SignalPreset>("load_preset", { id: presetId });
      loadPresetEngine(preset);
    } catch (err) {
      console.error("Failed to load preset:", err);
    }
  };

  const handleDeletePreset = async (presetId: string) => {
    try {
      await invoke("delete_preset", { id: presetId });
      // If active preset was deleted, clear it
      if (settings?.activePresetId === presetId) {
        setSettings({ ...settings, activePresetId: "" });
      }
      await loadPresets();
    } catch (err) {
      console.error("Failed to delete preset:", err);
    }
  };

  const handleStartRename = (preset: PresetSummary) => {
    setEditingPresetId(preset.id);
    setEditingName(preset.name);
    setTimeout(() => renameInputRef.current?.focus(), 50);
  };

  const handleFinishRename = async () => {
    if (!editingPresetId || !editingName.trim()) {
      setEditingPresetId(null);
      return;
    }
    try {
      await invoke("rename_preset", { id: editingPresetId, name: editingName.trim() });
      await loadPresets();
    } catch (err) {
      console.error("Failed to rename preset:", err);
    }
    setEditingPresetId(null);
  };

  const handleResetDefaults = () => {
    if (!settings) return;
    const defaults: Settings = {
      onboardingComplete: settings.onboardingComplete, // keep onboarding state
      permissionsEnabled: false,
      theme: "auto",
      titleAnimation: "ripple",
      animationSpeed: 3.5,
      randomAnimation: false,
      signalString: true,
      signalFrequency: 1.0,
      signalMode: "preset",
      signalAlpha: 0.7,
      signalAmplitude: 0.15,
      signalEcho: 1.75,
      signalGate: 0.05,
      signalBass: true,
      signalMids: true,
      signalTreble: true,
      activePresetId: settings.activePresetId, // preserve preset selection
      signalColorDark: "#ffffff",
      signalColorLight: "#000000",
      activeThemeId: "default",
      signalOffset: 0.5,
      signalEffect: "string",
      sandEnabled: true,
      sandIntensity: 1.51,
      sandDirection: -60,
      sandDensity: 2.0,
      sandSpeed: 0.26,
      sandGrainSize: 0.4,
      sandTurbulence: 0.9,
      sandAlpha: 0.7,
      fluxEnabled: true,
      fluxAlpha: 0.9,
      fluxIntensity: 1.5,
      fluxDensity: 1.0,
      fluxSpeed: 1.0,
      fluxLineLength: 0.55,
      fluxTurbulence: 1.0,
      auroraEnabled: true,
      auroraAlpha: 0.75,
      auroraSpeed: 0.55,
      cordRetractDelay: 0.2,
      cordDeployForce: 1.5,
      cordRetractForce: 1.5,
      stringSpread: 0.02,
      stringDeployAngle: -16,
      keyPressSpeed: 0.35,
      keyReleaseSpeed: 0.4,
      autoReorder: false,
      fontScale: 1.0,
      testMode: false,
      compactMode: false,
      slimMode: false,
      contextThreshold: "always",
      contextDisplay: "percent",
      lowPower: false,
      showToolPills: false,
      showCurrentTool: false,
      showConfigCounts: false,
      showToolCallComets: false,
      timerDisplay: "seconds",
      showInMenuBar: true,
      showInDock: true,
      startAtLogin: true,
      themeCustomizations: settings.themeCustomizations ?? {},
    };
    setSettings(defaults);
    // Apply theme immediately
    const win = window as unknown as Record<string, unknown>;
    if (typeof win.__applyTheme === "function") {
      (win.__applyTheme as (p: string) => void)("auto");
    }
  };

  if (!settings) {
    return (
      <div className="flex items-center justify-center p-8 text-white/50">
        Loading settings...
      </div>
    );
  }

  const signalMode = settings.signalMode ?? "simulated";
  const isPresetMode = signalMode === "preset";

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">Settings</h2>
        <button
          onClick={handleResetDefaults}
          className="px-2 py-1 rounded text-[0.625rem] text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors"
          title="Reset all settings to defaults (preserves presets)"
        >
          Reset Defaults
        </button>
      </div>

      {/* Theme */}
      <section className="rounded-lg bg-white/5 border border-white/10 px-3 py-1">
        <SettingRow label="Theme" description="Light, Dark, or follow system" onReset={(settings.theme ?? "auto") !== "auto" ? () => { setSettings({ ...settings, theme: "auto" }); const win = window as unknown as Record<string, unknown>; if (typeof win.__applyTheme === "function") (win.__applyTheme as (p: string) => void)("auto"); } : undefined}>
          <Select
            value={settings.theme ?? "auto"}
            options={[{ id: "auto", label: "Auto" }, { id: "light", label: "Light" }, { id: "dark", label: "Dark" }]}
            onChange={(v) => {
              setSettings({ ...settings, theme: v });
              // Apply immediately without needing save
              const win = window as unknown as Record<string, unknown>;
              if (typeof win.__applyTheme === "function") {
                (win.__applyTheme as (p: string) => void)(v);
              }
            }}
          />
        </SettingRow>
      </section>

      {/* Low Power */}
      <section className="rounded-lg bg-white/5 border border-white/10 px-3 py-1 divide-y divide-white/5">
        <SettingRow label="Low Power Mode" description="Force default theme, disable signal strings, sand, and blur effects">
          <Toggle checked={settings.lowPower ?? false} onChange={() => {
            const next = !(settings.lowPower ?? false);
            if (next) {
              // Force default theme
              const defaultTheme = SIGNAL_THEMES[0];
              applyThemeCssVars(defaultTheme);
              setSettings({
                ...settings,
                lowPower: true,
                activeThemeId: "default",
                signalColorDark: defaultTheme.colorDark,
                signalColorLight: defaultTheme.colorLight,
                signalAlpha: defaultTheme.alpha,
                signalAmplitude: defaultTheme.amplitude,
                signalEcho: defaultTheme.echo,
              });
              document.documentElement.setAttribute("data-low-power", "");
            } else {
              setSettings({ ...settings, lowPower: false });
              document.documentElement.removeAttribute("data-low-power");
            }
          }} label="Low power mode" />
        </SettingRow>
      </section>

      {/* Animation */}
      <section className="rounded-lg bg-white/5 border border-white/10 px-3 py-1 divide-y divide-white/5">
        <SettingRow label="Title Animation" description="Effect on working session titles" onReset={settings.titleAnimation !== "ripple" ? () => setSettings({ ...settings, titleAnimation: "ripple" }) : undefined}>
          <Select
            value={settings.titleAnimation}
            options={TITLE_ANIMATIONS.map((a) => ({ id: a.id, label: a.label }))}
            onChange={(v) => setSettings({ ...settings, titleAnimation: v })}
          />
        </SettingRow>
        <SettingRow label="Animation Speed" onReset={settings.animationSpeed !== 3.5 ? () => setSettings({ ...settings, animationSpeed: 3.5 }) : undefined}>
          <Select
            value={settings.animationSpeed}
            options={ANIMATION_SPEEDS.map((s) => ({ id: String(s.id), label: s.label }))}
            onChange={(v) => setSettings({ ...settings, animationSpeed: parseFloat(v) })}
          />
        </SettingRow>
        <SettingRow label="Random Delays" description="Per-character random timing instead of uniform wave" onReset={settings.randomAnimation ? () => setSettings({ ...settings, randomAnimation: false }) : undefined}>
          <Toggle checked={settings.randomAnimation} onChange={() => setSettings({ ...settings, randomAnimation: !settings.randomAnimation })} label="Random animation" />
        </SettingRow>
        <SettingRow label="Key Press" description="Speed of the press-down animation">
          <Slider value={settings.keyPressSpeed ?? 0.35} min={0.1} max={1.0} step={0.01} defaultValue={0.35} format={formatSec} onChange={(v) => setSettings({ ...settings, keyPressSpeed: v })} />
        </SettingRow>
        <SettingRow label="Key Release" description="Speed of the pop-up animation">
          <Slider value={settings.keyReleaseSpeed ?? 0.4} min={0.1} max={1.0} step={0.01} defaultValue={0.4} format={formatSec} onChange={(v) => setSettings({ ...settings, keyReleaseSpeed: v })} />
        </SettingRow>
      </section>

      {/* Display */}
      <section className="rounded-lg bg-white/5 border border-white/10 px-3 py-1 divide-y divide-white/5">
        <SettingRow label="Font Scale" description="Adjust text size across the entire app">
          <Slider value={settings.fontScale ?? 1.0} min={0.75} max={1.5} step={0.05} defaultValue={1.0} format={(v) => `${v.toFixed(2)}x`} onChange={(v) => { setSettings({ ...settings, fontScale: v }); document.documentElement.style.setProperty("--font-scale", String(v)); }} />
        </SettingRow>
        <SettingRow label="Compact Mode" description="Mini cards with just title, status, and animation" onReset={settings.compactMode ? () => setSettings({ ...settings, compactMode: false }) : undefined}>
          <Toggle checked={settings.compactMode ?? false} onChange={() => setSettings({ ...settings, compactMode: !(settings.compactMode ?? false) })} label="Compact mode" />
        </SettingRow>
        <SettingRow label="Context Bar" description="When to show the context usage bar" onReset={(settings.contextThreshold ?? "always") !== "always" ? () => setSettings({ ...settings, contextThreshold: "always" }) : undefined}>
          <Select value={settings.contextThreshold ?? "always"} options={[
            { id: "always", label: "Always Show" },
            { id: "never", label: "Never Show" },
            { id: "after200k", label: "When High (200k Opus / 120k other)" },
          ]} onChange={(v) => setSettings({ ...settings, contextThreshold: v })} />
        </SettingRow>
        <SettingRow label="Context Display" description="How to show context usage values" onReset={(settings.contextDisplay ?? "percent") !== "percent" ? () => setSettings({ ...settings, contextDisplay: "percent" }) : undefined}>
          <Select value={settings.contextDisplay ?? "percent"} options={[
            { id: "percent", label: "Percent" },
            { id: "tokens", label: "Tokens" },
            { id: "remaining", label: "Remaining" },
            { id: "both", label: "Both" },
            { id: "compact", label: "Compact" },
          ]} onChange={(v) => setSettings({ ...settings, contextDisplay: v })} />
        </SettingRow>
        <SettingRow label="Timer Display" description="How session duration is shown on cards" onReset={(settings.timerDisplay ?? "seconds") !== "seconds" ? () => setSettings({ ...settings, timerDisplay: "seconds" }) : undefined}>
          <Select value={settings.timerDisplay ?? "seconds"} options={[
            { id: "seconds", label: "Seconds" },
            { id: "minutes", label: "Minutes" },
            { id: "off", label: "Off" },
          ]} onChange={(v) => setSettings({ ...settings, timerDisplay: v })} />
        </SettingRow>
      </section>


      {/* Special Effects */}
      <section className="rounded-lg bg-white/5 border border-white/10 px-3 py-1 divide-y divide-white/5">
        <SettingRow label="Special Effects" description="Strings on working, sand on idle, flux streamlines on thinking" onReset={!settings.signalString ? () => setSettings({ ...settings, signalString: true }) : undefined}>
          <Toggle checked={settings.signalString} onChange={() => setSettings({ ...settings, signalString: !settings.signalString })} label="Special effects" />
        </SettingRow>

        {settings.signalString && (
          <>
            {/* ── String settings (active during working state) ── */}
            <div className="flex items-center gap-2 py-2.5 px-1">
              <span className="text-xs font-semibold text-white/70 uppercase tracking-wider">Strings</span>
              <span className="text-xs text-white/40">Working state</span>
            </div>

            <SettingRow label="Opacity" description="String transparency">
              <Slider value={settings.signalAlpha ?? 0.75} min={0.05} max={1.0} step={0.01} defaultValue={0.75} format={formatPct} isPct onChange={(v) => setSettings({ ...settings, signalAlpha: v })} />
            </SettingRow>

            <SettingRow label="Amplitude" description="String displacement intensity">
              <Slider value={settings.signalAmplitude ?? 0.10} min={0.01} max={1.0} step={0.01} defaultValue={0.10} format={formatMul} onChange={(v) => setSettings({ ...settings, signalAmplitude: v })} />
            </SettingRow>

            <SettingRow label="Echo" description="Trailing reverb lines behind the main string">
              <Slider value={settings.signalEcho ?? 1.50} min={0} max={2.0} step={0.01} defaultValue={1.50} format={formatPct} isPct onChange={(v) => setSettings({ ...settings, signalEcho: v })} />
            </SettingRow>

            <SettingRow label="Retract Delay" description="Seconds before strings retract after session stops">
              <Slider value={settings.cordRetractDelay ?? 0.2} min={0} max={2.0} step={0.1} defaultValue={0.2} format={(v) => `${v.toFixed(1)}s`} onChange={(v) => setSettings({ ...settings, cordRetractDelay: v })} />
            </SettingRow>
            <SettingRow label="Deploy Force" description="How forcefully strings launch when session starts working">
              <Slider value={settings.cordDeployForce ?? 1.5} min={0.2} max={3.0} step={0.01} defaultValue={1.5} format={formatMul} onChange={(v) => setSettings({ ...settings, cordDeployForce: v })} />
            </SettingRow>
            <SettingRow label="Retract Force" description="How hard the vacuum pulls the strings back">
              <Slider value={settings.cordRetractForce ?? 1.5} min={0.2} max={3.0} step={0.01} defaultValue={1.5} format={formatMul} onChange={(v) => setSettings({ ...settings, cordRetractForce: v })} />
            </SettingRow>
            <SettingRow label="Spread" description="Vertical separation between the three strings">
              <Slider value={settings.stringSpread ?? 0.02} min={0} max={0.5} step={0.01} defaultValue={0.02} format={formatMul} onChange={(v) => setSettings({ ...settings, stringSpread: v })} />
            </SettingRow>
            <SettingRow label="Deploy Angle" description="Tilt of working strings around the card center (negative = bottom-left → top-right)">
              <Slider value={settings.stringDeployAngle ?? -16} min={-90} max={90} step={1} defaultValue={-16} format={(v) => `${v.toFixed(0)}°`} onChange={(v) => setSettings({ ...settings, stringDeployAngle: v })} />
            </SettingRow>

            {/* ── Sand settings (active during idle state) ── */}
            <div className="flex items-center gap-2 py-2.5 px-1">
              <span className="text-xs font-semibold text-white/70 uppercase tracking-wider">Sand</span>
              <span className="text-xs text-white/40">Idle state</span>
            </div>

            <SettingRow label="Intensity" description="How strongly energy drives the sandstorm">
              <Slider value={settings.sandIntensity ?? 1.51} min={0.1} max={6.0} step={0.01} defaultValue={1.51} format={formatMul} onChange={(v) => setSettings({ ...settings, sandIntensity: v })} />
            </SettingRow>
            <SettingRow label="Direction" description="Wind direction in degrees (0 = left, 90 = up, 180 = right)">
              <Slider value={settings.sandDirection ?? 0} min={-180} max={180} step={1} defaultValue={0} format={(v) => `${v}°`} onChange={(v) => setSettings({ ...settings, sandDirection: v })} />
            </SettingRow>
            <SettingRow label="Density" description="How many sand grains spawn per frame">
              <Slider value={settings.sandDensity ?? 8.0} min={0.1} max={32.0} step={0.01} defaultValue={8.0} format={formatMul} onChange={(v) => setSettings({ ...settings, sandDensity: v })} />
            </SettingRow>
            <SettingRow label="Speed" description="How fast grains travel across the card">
              <Slider value={settings.sandSpeed ?? 3.0} min={0.1} max={6.0} step={0.01} defaultValue={3.0} format={formatMul} onChange={(v) => setSettings({ ...settings, sandSpeed: v })} />
            </SettingRow>
            <SettingRow label="Grain Size" description="Size of individual sand grains">
              <Slider value={settings.sandGrainSize ?? 0.5} min={0.05} max={0.95} step={0.01} defaultValue={0.5} format={formatMul} onChange={(v) => setSettings({ ...settings, sandGrainSize: v })} />
            </SettingRow>
            <SettingRow label="Turbulence" description="How chaotic the grain paths are (0 = straight, 1.2 = swirling)">
              <Slider value={settings.sandTurbulence ?? 0.4} min={0} max={1.2} step={0.01} defaultValue={0.4} format={formatMul} onChange={(v) => setSettings({ ...settings, sandTurbulence: v })} />
            </SettingRow>
            <SettingRow label="Opacity" description="Brightness of sand grains">
              <Slider value={settings.sandAlpha ?? 0.9} min={0.05} max={1.0} step={0.01} defaultValue={0.9} format={formatPct} isPct onChange={(v) => setSettings({ ...settings, sandAlpha: v })} />
            </SettingRow>

            {/* ── Flux settings (active during thinking state) ── */}
            <div className="flex items-center gap-2 py-2.5 px-1">
              <span className="text-xs font-semibold text-white/70 uppercase tracking-wider">Flux</span>
              <span className="text-xs text-white/40">Thinking state</span>
              <span className="ml-auto">
                <Toggle
                  checked={settings.fluxEnabled ?? true}
                  onChange={() => setSettings({ ...settings, fluxEnabled: !(settings.fluxEnabled ?? true) })}
                  label="Flux enabled"
                />
              </span>
            </div>

            {(settings.fluxEnabled ?? true) && (
              <>
                <SettingRow label="Opacity" description="Overall streamline transparency">
                  <Slider value={settings.fluxAlpha ?? 0.9} min={0.05} max={1.0} step={0.01} defaultValue={0.9} format={formatPct} isPct onChange={(v) => setSettings({ ...settings, fluxAlpha: v })} />
                </SettingRow>
                <SettingRow label="Audio Drive" description="How strongly audio energy speeds up the flow (lines stay fixed-length)">
                  <Slider value={settings.fluxIntensity ?? 1.5} min={0} max={6.0} step={0.01} defaultValue={1.5} format={formatMul} onChange={(v) => setSettings({ ...settings, fluxIntensity: v })} />
                </SettingRow>
                <SettingRow label="Density" description="Streamline count — higher packs more lines across the card">
                  <Slider value={settings.fluxDensity ?? 1.0} min={0.3} max={3.0} step={0.01} defaultValue={1.0} format={formatMul} onChange={(v) => setSettings({ ...settings, fluxDensity: v })} />
                </SettingRow>
                <SettingRow label="Base Speed" description="Field evolution rate when no audio is playing">
                  <Slider value={settings.fluxSpeed ?? 1.0} min={0.1} max={4.0} step={0.01} defaultValue={1.0} format={formatMul} onChange={(v) => setSettings({ ...settings, fluxSpeed: v })} />
                </SettingRow>
                <SettingRow label="Line Length" description="Fixed height of each streamline (multiplier on the base ~36px)">
                  <Slider value={settings.fluxLineLength ?? 0.55} min={0.2} max={2.0} step={0.01} defaultValue={0.55} format={formatMul} onChange={(v) => setSettings({ ...settings, fluxLineLength: v })} />
                </SettingRow>
                <SettingRow label="Turbulence" description="How many swirls fit across the card (0.3 = wide eddies, 3 = tight curls)">
                  <Slider value={settings.fluxTurbulence ?? 1.0} min={0.3} max={3.0} step={0.01} defaultValue={1.0} format={formatMul} onChange={(v) => setSettings({ ...settings, fluxTurbulence: v })} />
                </SettingRow>
              </>
            )}

            {/* ── Aurora settings (active during done state) ── */}
            <div className="flex items-center gap-2 py-2.5 px-1">
              <span className="text-xs font-semibold text-white/70 uppercase tracking-wider">Aurora</span>
              <span className="text-xs text-white/40">Done state</span>
              <span className="ml-auto">
                <Toggle
                  checked={settings.auroraEnabled ?? true}
                  onChange={() => setSettings({ ...settings, auroraEnabled: !(settings.auroraEnabled ?? true) })}
                  label="Aurora enabled"
                />
              </span>
            </div>

            {(settings.auroraEnabled ?? true) && (
              <>
                <SettingRow label="Opacity" description="Overall aurora wash transparency">
                  <Slider value={settings.auroraAlpha ?? 0.75} min={0.05} max={1.0} step={0.01} defaultValue={0.75} format={formatPct} isPct onChange={(v) => setSettings({ ...settings, auroraAlpha: v })} />
                </SettingRow>
                <SettingRow label="Speed" description="Time-evolution rate of the aurora flow">
                  <Slider value={settings.auroraSpeed ?? 0.55} min={0.1} max={4.0} step={0.01} defaultValue={0.55} format={formatMul} onChange={(v) => setSettings({ ...settings, auroraSpeed: v })} />
                </SettingRow>
              </>
            )}
          </>
        )}
      </section>

      {/* Audio Input */}
      {settings.signalString && (
      <section className="rounded-lg bg-white/5 border border-white/10 px-3 py-1 divide-y divide-white/5">
        <div className="py-2">
          <div className="text-[0.625rem] text-white/40 uppercase tracking-wider">Audio Input</div>
        </div>

        <SettingRow label="Mode" onReset={signalMode !== "preset" ? () => setSettings({ ...settings, signalMode: "preset" }) : undefined}>
                <Select
                  value={signalMode}
                  options={[
                    { id: "simulated", label: "Simulated" },
                    { id: "preset", label: "Preset" },
                  ]}
                  onChange={(v) => setSettings({ ...settings, signalMode: v })}
                />
              </SettingRow>


              <SettingRow label="Bands" description="Frequency bands used to drive the effect" onReset={(!settings.signalBass || !settings.signalMids || !settings.signalTreble) ? () => setSettings({ ...settings, signalBass: true, signalMids: true, signalTreble: true }) : undefined}>
                <div className="flex items-center gap-3">
                  {([["Bass", "signalBass"], ["Mids", "signalMids"], ["Treble", "signalTreble"]] as const).map(([label, key]) => (
                    <label key={key} className="flex items-center gap-1 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={settings[key] ?? true}
                        onChange={() => setSettings({ ...settings, [key]: !settings[key] })}
                        className="w-3 h-3 rounded accent-blue-500 cursor-pointer"
                      />
                      <span className="text-xs text-white/60">{label}</span>
                    </label>
                  ))}
                </div>
              </SettingRow>

              <SettingRow label="Offset" description="Randomize playback position per session">
                <Slider value={settings.signalOffset ?? 0.5} min={0} max={1.0} step={0.01} defaultValue={0.5} format={formatPct} isPct onChange={(v) => setSettings({ ...settings, signalOffset: v })} />
              </SettingRow>

              <SettingRow label="Gate" description="Noise floor threshold — clips quiet ambient noise">
                <Slider value={settings.signalGate ?? 0.05} min={0} max={0.5} step={0.01} defaultValue={0.05} format={formatPct} isPct onChange={(v) => { setSettings({ ...settings, signalGate: v }); setGateEngine(v); }} />
              </SettingRow>

              {!isPresetMode && (
                <SettingRow label="Frequency" description="Simulated string vibration speed">
                  <Slider value={settings.signalFrequency ?? 1.0} min={0.2} max={3.0} step={0.01} defaultValue={1.0} format={formatMul} onChange={(v) => setSettings({ ...settings, signalFrequency: v })} />
                </SettingRow>
              )}

              {isPresetMode && (
                <div className="space-y-2 pt-1">
                  {/* Upload */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="audio/wav,audio/mpeg,audio/mp3,audio/ogg,audio/opus,.wav,.mp3,.opus,.ogg"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleUploadAndExtract(file);
                      e.target.value = "";
                    }}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={extracting}
                      className="px-2 py-1 rounded text-[0.625rem] font-medium bg-white/10 hover:bg-white/20 text-white/60 hover:text-white transition-colors disabled:opacity-50"
                    >
                      {extracting ? "Extracting..." : "Upload Song"}
                    </button>
                    {extractProgress && (
                      <span className="text-[0.625rem] text-white/40">{extractProgress}</span>
                    )}
                    {!extractProgress && !extracting && (
                      <span className="text-[0.625rem] text-white/30">Upload to create a new preset</span>
                    )}
                  </div>

                  {/* Preset Library */}
                  {presets.length > 0 && (
                    <div className="space-y-1 pt-1">
                      <div className="text-[0.625rem] text-white/40 uppercase tracking-wider">Presets</div>
                      {presets.map((p) => {
                        const isActive = settings.activePresetId === p.id;
                        const isEditing = editingPresetId === p.id;

                        return (
                          <div
                            key={p.id}
                            className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${
                              isActive
                                ? "bg-blue-500/15 border border-blue-500/20"
                                : "bg-white/5 border border-transparent hover:bg-white/10"
                            }`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? "bg-blue-400" : "bg-transparent"}`} />

                            {isEditing ? (
                              <input
                                ref={renameInputRef}
                                value={editingName}
                                onChange={(e) => setEditingName(e.target.value)}
                                onBlur={handleFinishRename}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleFinishRename();
                                  if (e.key === "Escape") setEditingPresetId(null);
                                }}
                                className="flex-1 min-w-0 bg-transparent border-b border-blue-400/50 text-white/80 text-xs outline-none px-0 py-0"
                              />
                            ) : (
                              <button
                                onClick={() => handleStartRename(p)}
                                className="flex-1 min-w-0 text-left truncate text-white/70 hover:text-white/90 transition-colors"
                                title="Click to rename"
                              >
                                {p.name}
                              </button>
                            )}

                            <span className="text-[0.625rem] text-white/30 font-mono tabular-nums shrink-0">
                              {formatDuration(p.durationSecs)}
                            </span>

                            <span className="text-[0.625rem] text-white/20 shrink-0">
                              {formatDate(p.createdAt)}
                            </span>

                            {!isActive && (
                              <button
                                onClick={() => handleActivatePreset(p.id)}
                                className="text-[0.625rem] text-blue-400/60 hover:text-blue-400 transition-colors shrink-0"
                                title="Activate"
                              >
                                Use
                              </button>
                            )}

                            <button
                              onClick={() => handleDeletePreset(p.id)}
                              className="text-[0.625rem] text-red-400/40 hover:text-red-400 transition-colors shrink-0"
                              title="Delete preset"
                            >
                              &times;
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {presets.length === 0 && !extracting && (
                    <div className="text-[0.625rem] text-white/25 py-1">
                      No presets yet — upload a song to create one
                    </div>
                  )}

                  {/* Band envelope visualization */}
                  {settings.activePresetId && (
                    <div className="pt-2 space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="text-[0.625rem] text-white/40 uppercase tracking-wider">Band Envelopes</div>
                        <button
                          onClick={() => invoke("open_signal_settings")}
                          className="text-[0.625rem] text-white/30 hover:text-white/60 transition-colors"
                          title="Open in separate window"
                        >
                          ↗ Expand
                        </button>
                      </div>
                      <BandWaveform presetId={settings.activePresetId} signalBass={settings.signalBass ?? true} signalMids={settings.signalMids ?? true} signalTreble={settings.signalTreble ?? true} signalGate={settings.signalGate ?? 0.05} />
                    </div>
                  )}
                </div>
              )}
      </section>
      )}

      {/* App Behavior */}
      <section className="rounded-lg bg-white/5 border border-white/10 px-3 py-1 divide-y divide-white/5">
        <SettingRow label="Show in menu bar" description="Display the Cue tray icon in the menu bar" onReset={!(settings.showInMenuBar ?? true) ? () => setSettings({ ...settings, showInMenuBar: true }) : undefined}>
          <Toggle
            checked={settings.showInMenuBar ?? true}
            onChange={() => setSettings({ ...settings, showInMenuBar: !(settings.showInMenuBar ?? true) })}
            label="Show in menu bar"
          />
        </SettingRow>
        <SettingRow label="Show in Dock" description="Display the Cue icon in the macOS Dock" onReset={!(settings.showInDock ?? true) ? () => setSettings({ ...settings, showInDock: true }) : undefined}>
          <Toggle
            checked={settings.showInDock ?? true}
            onChange={() => setSettings({ ...settings, showInDock: !(settings.showInDock ?? true) })}
            label="Show in Dock"
          />
        </SettingRow>
        <SettingRow label="Start at login" description="Launch Cue automatically when you log in" onReset={!(settings.startAtLogin ?? true) ? () => setSettings({ ...settings, startAtLogin: true }) : undefined}>
          <Toggle
            checked={settings.startAtLogin ?? true}
            onChange={() => setSettings({ ...settings, startAtLogin: !(settings.startAtLogin ?? true) })}
            label="Start at login"
          />
        </SettingRow>
      </section>

      {/* Beta Features */}
      <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mt-2">Beta Features</h3>
      <section className="rounded-lg bg-white/5 border border-white/10 px-3 py-1 divide-y divide-white/5">
        <SettingRow label="Auto Reorder" description="Sort sessions by priority after 5s of inactivity" onReset={(settings.autoReorder ?? false) ? () => setSettings({ ...settings, autoReorder: false }) : undefined}>
          <Toggle
            checked={settings.autoReorder ?? false}
            onChange={() => setSettings({ ...settings, autoReorder: !(settings.autoReorder ?? false) })}
            label="Auto reorder"
          />
        </SettingRow>
        <SettingRow label="Permission Requests" description="Respond to Claude Code prompts from this dashboard (requires restart)" onReset={settings.permissionsEnabled ? () => setSettings({ ...settings, permissionsEnabled: false }) : undefined}>
          <Toggle
            checked={settings.permissionsEnabled}
            onChange={() => setSettings({ ...settings, permissionsEnabled: !settings.permissionsEnabled })}
            label="Permission requests"
          />
        </SettingRow>
        <SettingRow label="Sandbox Mode" description="Independent sandbox with simulated sessions to preview all animations and state transitions" onReset={(settings.testMode ?? false) ? () => setSettings({ ...settings, testMode: false }) : undefined}>
          <Toggle
            checked={settings.testMode ?? false}
            onChange={() => setSettings({ ...settings, testMode: !settings.testMode })}
            label="Sandbox mode"
          />
        </SettingRow>
        <SettingRow label="Tool Breakdown" description="Show per-tool usage pills in detail mode (Read 121, Bash 85, etc.)" onReset={(settings.showToolPills ?? false) ? () => setSettings({ ...settings, showToolPills: false }) : undefined}>
          <Toggle
            checked={settings.showToolPills ?? false}
            onChange={() => setSettings({ ...settings, showToolPills: !(settings.showToolPills ?? false) })}
            label="Tool breakdown"
          />
        </SettingRow>
        <SettingRow label="Current Tool" description="Show the running tool name in the session header" onReset={(settings.showCurrentTool ?? false) ? () => setSettings({ ...settings, showCurrentTool: false }) : undefined}>
          <Toggle
            checked={settings.showCurrentTool ?? false}
            onChange={() => setSettings({ ...settings, showCurrentTool: !(settings.showCurrentTool ?? false) })}
            label="Current tool"
          />
        </SettingRow>
        <SettingRow label="Config Counts" description="Show CLAUDE.md, rules, MCP server, and hooks counts per session" onReset={(settings.showConfigCounts ?? false) ? () => setSettings({ ...settings, showConfigCounts: false }) : undefined}>
          <Toggle
            checked={settings.showConfigCounts ?? false}
            onChange={() => setSettings({ ...settings, showConfigCounts: !(settings.showConfigCounts ?? false) })}
            label="Config counts"
          />
        </SettingRow>
        <SettingRow label="Tool Call Comets" description="Fire a thin white tracer across the strings on each tool call" onReset={(settings.showToolCallComets ?? false) ? () => setSettings({ ...settings, showToolCallComets: false }) : undefined}>
          <Toggle
            checked={settings.showToolCallComets ?? false}
            onChange={() => setSettings({ ...settings, showToolCallComets: !(settings.showToolCallComets ?? false) })}
            label="Tool call comets"
          />
        </SettingRow>
      </section>

      {/* Hook Status */}
      <HookStatus />

      {/* Reference (collapsed by default) */}
      <details className="rounded-lg bg-white/5 border border-white/10 px-3 py-2">
        <summary className="text-xs text-white/40 cursor-pointer hover:text-white/60 transition-colors select-none">
          Session Card Reference
        </summary>
        <div className="mt-2 space-y-2 text-[0.625rem] text-white/40 leading-relaxed pb-1">
          <div>
            <span className="text-white/50 font-medium">Row 1</span> &mdash; Status dot, title, state badge, branch, duration
          </div>
          <div>
            <span className="text-white/50 font-medium">Row 2</span> &mdash; Session ID, messages (user/total), input/output tokens, tool count, model, source
          </div>
          <div>
            <span className="text-white/50 font-medium">Row 3</span> &mdash; Top 6 tools with counts, cache hit rate
          </div>
          <div>
            <span className="text-white/50 font-medium">Row 4</span> &mdash; Context window usage bar (1M for Opus/Sonnet 4.6, 200K for older)
          </div>
        </div>
      </details>
    </div>
  );
}
