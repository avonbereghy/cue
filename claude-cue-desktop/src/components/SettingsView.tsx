import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Settings, TITLE_ANIMATIONS, ANIMATION_SPEEDS } from "@/lib/types";

export function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [savedSettings, setSavedSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const s = await invoke<Settings>("get_settings");
      setSettings(s);
      setSavedSettings(s);
    } catch (err) {
      console.error("Failed to load settings:", err);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const togglePermissions = () => {
    if (!settings) return;
    setSettings({ ...settings, permissionsEnabled: !settings.permissionsEnabled });
  };

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

  const isDirty = settings && savedSettings &&
    JSON.stringify(settings) !== JSON.stringify(savedSettings);

  if (!settings) {
    return (
      <div className="flex items-center justify-center p-8 text-white/50">
        Loading settings...
      </div>
    );
  }

  return (
    <div className="p-6 space-y-8">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Settings</h2>
        {isDirty ? (
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Settings"}
          </button>
        ) : saved ? (
          <span className="px-4 py-2 rounded-lg text-sm font-medium bg-green-500/20 text-green-400">
            Saved
          </span>
        ) : null}
      </div>

      {/* Title Animation */}
      <section className="space-y-3">
        <label className="block text-sm font-medium text-white/70">Working Title Animation</label>
        <div className="flex rounded-lg overflow-hidden border border-white/10">
          {TITLE_ANIMATIONS.map((anim) => (
            <button
              key={anim.id}
              onClick={() => setSettings({ ...settings, titleAnimation: anim.id })}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors border-l border-white/10 first:border-l-0 ${
                settings.titleAnimation === anim.id
                  ? "bg-blue-500/20 text-blue-400 border-blue-500/30"
                  : "bg-white/5 text-white/50 hover:text-white/70 hover:bg-white/10"
              }`}
            >
              {anim.label}
            </button>
          ))}
        </div>

        {/* Animation Speed */}
        <div className="pt-2">
          <label className="block text-xs text-white/50 mb-2">Animation Speed</label>
          <div className="flex rounded-lg overflow-hidden border border-white/10">
            {ANIMATION_SPEEDS.map((speed) => (
              <button
                key={speed.id}
                onClick={() => setSettings({ ...settings, animationSpeed: speed.id })}
                className={`flex-1 px-3 py-2 text-xs font-medium transition-colors border-l border-white/10 first:border-l-0 ${
                  settings.animationSpeed === speed.id
                    ? "bg-blue-500/20 text-blue-400 border-blue-500/30"
                    : "bg-white/5 text-white/50 hover:text-white/70 hover:bg-white/10"
                }`}
              >
                {speed.label}
              </button>
            ))}
          </div>
        </div>

        {/* Random Animation Toggle */}
        <div className="flex items-center justify-between rounded-lg bg-white/5 border border-white/10 px-4 py-3 mt-2">
          <div>
            <div className="text-sm text-white">Random Animation</div>
            <div className="text-xs text-white/40 mt-0.5">
              Animate each character with a random delay instead of a uniform wave
            </div>
          </div>
          <button
            onClick={() => setSettings({ ...settings, randomAnimation: !settings.randomAnimation })}
            className={`relative ml-4 shrink-0 w-10 h-6 rounded-full transition-colors ${
              settings.randomAnimation ? "bg-blue-500" : "bg-white/20"
            }`}
            role="switch"
            aria-checked={settings.randomAnimation}
            aria-label="Toggle random animation"
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                settings.randomAnimation ? "translate-x-4" : ""
              }`}
            />
          </button>
        </div>
      </section>

      {/* Permissions */}
      <section className="space-y-3">
        <label className="block text-sm font-medium text-white/70">Permissions</label>
        <div className="flex items-center justify-between rounded-lg bg-white/5 border border-white/10 px-4 py-3">
          <div>
            <div className="text-sm text-white">Permission Requests (Beta)</div>
            <div className="text-xs text-white/40 mt-0.5">
              Show and respond to Claude Code permission prompts from this dashboard.
              Requires app restart to start/stop the permission server.
            </div>
          </div>
          <button
            onClick={togglePermissions}
            className={`relative ml-4 shrink-0 w-10 h-6 rounded-full transition-colors ${
              settings.permissionsEnabled ? "bg-green-500" : "bg-white/20"
            }`}
            role="switch"
            aria-checked={settings.permissionsEnabled}
            aria-label="Toggle permission requests"
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                settings.permissionsEnabled ? "translate-x-4" : ""
              }`}
            />
          </button>
        </div>
      </section>

      {/* Session Card Reference */}
      <section className="space-y-3">
        <label className="block text-sm font-medium text-white/70">Session Card Reference</label>
        <div className="rounded-lg bg-white/5 border border-white/10 px-4 py-3 space-y-3 text-xs text-white/50 leading-relaxed">
          <p className="text-white/70 font-medium text-sm">Each session card shows real-time data for an active Claude Code conversation:</p>

          <div className="space-y-2">
            <div className="font-medium text-white/60">Row 1 &mdash; Identity</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-white/40">Status dot</dt>
              <dd>Color-coded state: <span className="text-white">white</span> = working, <span className="text-yellow-400">yellow</span> = waiting for permission, <span className="text-red-500">red</span> = error, <span className="text-cyan-400">cyan</span> = subagent running, <span className="text-gray-400">dim</span> = idle, <span className="text-green-500">green</span> = done. Working and subagent dots blink.</dd>
              <dt className="text-white/40">Title</dt>
              <dd>Custom session title if set, otherwise the workspace folder name. Full path shown on hover.</dd>
              <dt className="text-white/40">State badge</dt>
              <dd>Current session state: Working, Waiting, Error, Subagent, Idle, or Done.</dd>
              <dt className="text-white/40">Branch</dt>
              <dd>Git branch of the workspace (if inside a git repo).</dd>
              <dt className="text-white/40">Duration</dt>
              <dd>Elapsed wall-clock time since the session started.</dd>
            </dl>
          </div>

          <div className="space-y-2">
            <div className="font-medium text-white/60">Row 2 &mdash; Metrics</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-white/40 font-mono">8f219441&hellip;</dt>
              <dd>Truncated session ID. Click to copy the full UUID.</dd>
              <dt className="text-white/40">&#128172; 19/26</dt>
              <dd>Messages &mdash; user messages / total messages (user + assistant). A single "turn" is one user message plus one assistant response.</dd>
              <dt className="text-white/40">&#8595; in</dt>
              <dd>Input tokens &mdash; total tokens sent to Claude across all messages, including system prompt, conversation history, and tool results. Grows with each turn as context accumulates.</dd>
              <dt className="text-white/40">&#8593; out</dt>
              <dd>Output tokens &mdash; total tokens generated by Claude (responses + tool calls). This is what counts toward rate limits.</dd>
              <dt className="text-white/40">&#128295; tools</dt>
              <dd>Total tool invocations (Read, Bash, Edit, Grep, etc.) across the entire session.</dd>
              <dt className="text-white/40">Model</dt>
              <dd>Which Claude model is being used (e.g. Opus 4.6, Sonnet 4.6, Haiku 4.5).</dd>
              <dt className="text-white/40">Source</dt>
              <dd>Where the session was launched from: VSCode, Cursor, iTerm, Terminal, Ghostty, etc.</dd>
            </dl>
          </div>

          <div className="space-y-2">
            <div className="font-medium text-white/60">Row 3 &mdash; Tools</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-white/40">Tool chips</dt>
              <dd>Top 6 most-used tools with invocation counts. "+N" shows how many additional tool types were used.</dd>
              <dt className="text-white/40">Cache %</dt>
              <dd>Prompt cache hit rate. Higher is better &mdash; means Claude is reusing cached context instead of re-processing it, which reduces latency and cost.</dd>
            </dl>
          </div>

          <div className="space-y-2">
            <div className="font-medium text-white/60">Row 4 &mdash; Context</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-white/40">Context bar</dt>
              <dd>How much of the model's context window is in use. The limit depends on the model: 1M tokens for Opus/Sonnet 4.6, 200K for older models. When this fills up, Claude Code starts compressing earlier messages.</dd>
            </dl>
          </div>
        </div>
      </section>
    </div>
  );
}
