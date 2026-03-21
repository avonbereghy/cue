import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Settings, TITLE_ANIMATIONS, ANIMATION_SPEEDS } from "@/lib/types";
import type { PresetSummary, SignalPreset } from "@/lib/types";
import { extractPreset } from "@/lib/audioExtractor";
import { loadPreset as loadPresetEngine, isLoaded as isPresetLoaded } from "@/lib/presetEngine";

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      onClick={onChange}
      className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${checked ? "bg-blue-500" : "bg-white/20"}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
    >
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${checked ? "translate-x-4" : ""}`} />
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

function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-xs text-white/70">{label}</div>
        {description && <div className="text-[10px] text-white/35 mt-0.5">{description}</div>}
      </div>
      <div className="shrink-0 flex items-center gap-2">{children}</div>
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
    <div className="flex items-center gap-1.5">
      {editing ? (
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={finishEdit}
          onKeyDown={(e) => { if (e.key === "Enter") finishEdit(); if (e.key === "Escape") setEditing(false); }}
          className="w-10 text-[10px] text-white/70 font-mono text-right bg-white/10 border border-white/20 rounded px-1 py-0 outline-none"
        />
      ) : (
        <button
          onClick={startEdit}
          className="text-[10px] text-white/30 font-mono w-10 text-right hover:text-white/60 transition-colors cursor-text"
          title="Click to edit"
        >
          {format(value)}
        </button>
      )}
      <input
        type="range" min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-20 h-1 rounded appearance-none cursor-pointer bg-white/10 accent-blue-500"
      />
      {value !== defaultValue && (
        <button
          onClick={() => onChange(defaultValue)}
          className="text-[9px] text-white/20 hover:text-white/50 transition-colors"
          title="Reset to default"
        >
          &circlearrowleft;
        </button>
      )}
    </div>
  );
}

function formatPct(v: number): string { return `${Math.round(v * 100)}%`; }
function formatMul(v: number): string { return `${v.toFixed(1)}x`; }

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [savedSettings, setSavedSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
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
      // Backward compat
      if (s.signalMode === "audio") s.signalMode = "preset";
      setSettings(s);
      setSavedSettings(s);
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

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await invoke("update_settings", { newSettings: settings });
      setSavedSettings(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error("Failed to save settings:", err);
    } finally {
      setSaving(false);
    }
  };

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
      await invoke("update_settings", { newSettings: updated });
      setSavedSettings(updated);

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
    await invoke("update_settings", { newSettings: updated });
    setSavedSettings(updated);

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
        const updated = { ...settings, activePresetId: "" };
        setSettings(updated);
        await invoke("update_settings", { newSettings: updated });
        setSavedSettings(updated);
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

  const handleResetDefaults = async () => {
    if (!settings) return;
    const defaults: Settings = {
      onboardingComplete: settings.onboardingComplete, // keep onboarding state
      permissionsEnabled: false,
      theme: "auto",
      titleAnimation: "flip",
      animationSpeed: 1.2,
      randomAnimation: false,
      signalString: true,
      signalFrequency: 1.0,
      signalMode: "preset",
      signalAlpha: 1.0,
      signalAmplitude: 1.0,
      signalEcho: 1.0,
      activePresetId: settings.activePresetId, // preserve preset selection
      testMode: false,
    };
    setSettings(defaults);
    try {
      await invoke("update_settings", { newSettings: defaults });
      setSavedSettings(defaults);
      // Apply theme immediately
      const win = window as unknown as Record<string, unknown>;
      if (typeof win.__applyTheme === "function") {
        (win.__applyTheme as (p: string) => void)("auto");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error("Failed to reset settings:", err);
    }
  };

  const isDirty = settings && savedSettings &&
    JSON.stringify(settings) !== JSON.stringify(savedSettings);

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
    <div className="p-4 space-y-4 max-w-2xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">Settings</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={handleResetDefaults}
            className="px-2 py-1 rounded text-[10px] text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors"
            title="Reset all settings to defaults (preserves presets)"
          >
            Reset Defaults
          </button>
          {isDirty ? (
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1 rounded text-xs font-medium bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          ) : saved ? (
            <span className="px-3 py-1 rounded text-xs font-medium bg-green-500/20 text-green-400">Saved</span>
          ) : null}
        </div>
      </div>

      {/* Theme */}
      <section className="rounded-lg bg-white/5 border border-white/10 px-3 py-1">
        <SettingRow label="Theme" description="Light, Dark, or follow system">
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

      {/* Animation */}
      <section className="rounded-lg bg-white/5 border border-white/10 px-3 py-1 divide-y divide-white/5">
        <SettingRow label="Title Animation" description="Effect on working session titles">
          <Select
            value={settings.titleAnimation}
            options={TITLE_ANIMATIONS.map((a) => ({ id: a.id, label: a.label }))}
            onChange={(v) => setSettings({ ...settings, titleAnimation: v })}
          />
        </SettingRow>
        <SettingRow label="Animation Speed">
          <Select
            value={settings.animationSpeed}
            options={ANIMATION_SPEEDS.map((s) => ({ id: String(s.id), label: s.label }))}
            onChange={(v) => setSettings({ ...settings, animationSpeed: parseFloat(v) })}
          />
        </SettingRow>
        <SettingRow label="Random Delays" description="Per-character random timing instead of uniform wave">
          <Toggle checked={settings.randomAnimation} onChange={() => setSettings({ ...settings, randomAnimation: !settings.randomAnimation })} label="Random animation" />
        </SettingRow>
      </section>

      {/* Signal String */}
      <section className="rounded-lg bg-white/5 border border-white/10 px-3 py-1 divide-y divide-white/5">
        <SettingRow label="Signal String" description="Animated separator reflecting session activity">
          <Toggle checked={settings.signalString} onChange={() => setSettings({ ...settings, signalString: !settings.signalString })} label="Signal string" />
        </SettingRow>

        {settings.signalString && (
          <>
            <SettingRow label="Mode">
              <Select
                value={signalMode}
                options={[{ id: "simulated", label: "Simulated" }, { id: "preset", label: "Preset" }]}
                onChange={(v) => setSettings({ ...settings, signalMode: v })}
              />
            </SettingRow>

            <SettingRow label="Opacity" description="String transparency">
              <Slider value={settings.signalAlpha ?? 1.0} min={0.05} max={1.0} step={0.05} defaultValue={1.0} format={formatPct} isPct onChange={(v) => setSettings({ ...settings, signalAlpha: v })} />
            </SettingRow>

            <SettingRow label="Amplitude" description="String displacement intensity">
              <Slider value={settings.signalAmplitude ?? 1.0} min={0.1} max={3.0} step={0.1} defaultValue={1.0} format={formatMul} onChange={(v) => setSettings({ ...settings, signalAmplitude: v })} />
            </SettingRow>

            <SettingRow label="Echo" description="Trailing reverb lines behind the main string">
              <Slider value={settings.signalEcho ?? 1.0} min={0} max={1.0} step={0.05} defaultValue={1.0} format={formatPct} isPct onChange={(v) => setSettings({ ...settings, signalEcho: v })} />
            </SettingRow>

            {!isPresetMode && (
              <SettingRow label="Frequency">
                <Slider value={settings.signalFrequency ?? 1.0} min={0.2} max={3.0} step={0.1} defaultValue={1.0} format={formatMul} onChange={(v) => setSettings({ ...settings, signalFrequency: v })} />
              </SettingRow>
            )}

            {isPresetMode && (
              <div className="py-2 space-y-2">
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
                    className="px-2 py-1 rounded text-[10px] font-medium bg-white/10 hover:bg-white/20 text-white/60 hover:text-white transition-colors disabled:opacity-50"
                  >
                    {extracting ? "Extracting..." : "Upload Song"}
                  </button>
                  {extractProgress && (
                    <span className="text-[10px] text-white/40">{extractProgress}</span>
                  )}
                  {!extractProgress && !extracting && (
                    <span className="text-[10px] text-white/30">Upload to create a new preset</span>
                  )}
                </div>

                {/* Preset Library */}
                {presets.length > 0 && (
                  <div className="space-y-1 pt-1">
                    <div className="text-[10px] text-white/40 uppercase tracking-wider">Presets</div>
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
                          {/* Active indicator */}
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? "bg-blue-400" : "bg-transparent"}`} />

                          {/* Name (editable) */}
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

                          {/* Duration */}
                          <span className="text-[10px] text-white/30 font-mono tabular-nums shrink-0">
                            {formatDuration(p.durationSecs)}
                          </span>

                          {/* Date */}
                          <span className="text-[10px] text-white/20 shrink-0">
                            {formatDate(p.createdAt)}
                          </span>

                          {/* Activate button */}
                          {!isActive && (
                            <button
                              onClick={() => handleActivatePreset(p.id)}
                              className="text-[10px] text-blue-400/60 hover:text-blue-400 transition-colors shrink-0"
                              title="Activate"
                            >
                              Use
                            </button>
                          )}

                          {/* Delete button */}
                          <button
                            onClick={() => handleDeletePreset(p.id)}
                            className="text-[10px] text-red-400/40 hover:text-red-400 transition-colors shrink-0"
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
                  <div className="text-[10px] text-white/25 py-1">
                    No presets yet — upload a song to create one
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* Permissions & Test Mode */}
      <section className="rounded-lg bg-white/5 border border-white/10 px-3 py-1 divide-y divide-white/5">
        <SettingRow label="Permission Requests" description="Respond to Claude Code prompts from this dashboard (requires restart)">
          <Toggle
            checked={settings.permissionsEnabled}
            onChange={() => setSettings({ ...settings, permissionsEnabled: !settings.permissionsEnabled })}
            label="Permission requests"
          />
        </SettingRow>
        <SettingRow label="Test Mode" description="Add a synthetic session to preview animations in real time">
          <Toggle
            checked={settings.testMode ?? false}
            onChange={() => setSettings({ ...settings, testMode: !settings.testMode })}
            label="Test mode"
          />
        </SettingRow>
      </section>

      {/* Reference (collapsed by default) */}
      <details className="rounded-lg bg-white/5 border border-white/10 px-3 py-2">
        <summary className="text-xs text-white/40 cursor-pointer hover:text-white/60 transition-colors select-none">
          Session Card Reference
        </summary>
        <div className="mt-2 space-y-2 text-[10px] text-white/40 leading-relaxed pb-1">
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
