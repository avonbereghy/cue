import { useRef, useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SignalPreset, Settings } from "@/lib/types";
import { loadPreset as loadPresetEngine, isPlaying as isPresetPlaying, getCurrentTime as getPresetTime, getDuration as getPresetDuration, togglePlayPause, seek as presetSeek, isLoaded as isPresetLoaded, setGate } from "@/lib/presetEngine";
import { drawBandEnvelopes } from "./SettingsView";

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function SignalSettingsPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const presetRef = useRef<SignalPreset | null>(null);
  const dragging = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [, setTick] = useState(0);

  // Settings state
  const [mode, setMode] = useState("preset");
  const [alpha, setAlpha] = useState(0.25);
  const [amplitude, setAmplitude] = useState(0.25);
  const [echo, setEcho] = useState(1.0);
  const [gateVal, setGateVal] = useState(0.05);
  const [frequency, setFrequency] = useState(1.0);
  const [bass, setBass] = useState(true);
  const [mids, setMids] = useState(true);
  const [treble, setTreble] = useState(true);
  const [presetName, setPresetName] = useState("");

  const updateSetting = useCallback((patch: Partial<Settings>) => {
    invoke<Settings>("get_settings").then((s) => {
      invoke("update_settings", { newSettings: { ...s, ...patch } });
    });
  }, []);

  // Load settings + preset on mount
  useEffect(() => {
    invoke<Settings>("get_settings").then((s) => {
      const m = s.signalMode === "audio" ? "preset" : (s.signalMode ?? "simulated");
      setMode(m);
      setAlpha(s.signalAlpha ?? 0.25);
      setAmplitude(s.signalAmplitude ?? 0.25);
      setEcho(s.signalEcho ?? 1.0);
      const g = s.signalGate ?? 0.05;
      setGateVal(g);
      setGate(g);
      setFrequency(s.signalFrequency ?? 1.0);
      setBass(s.signalBass ?? true);
      setMids(s.signalMids ?? true);
      setTreble(s.signalTreble ?? true);
      if (s.activePresetId) {
        invoke<SignalPreset>("load_preset", { id: s.activePresetId }).then((p) => {
          presetRef.current = p;
          setPresetName(p.name);
          setLoaded(true);
          if (!isPresetLoaded()) loadPresetEngine(p);
        });
      }
    });
  }, []);

  // Tick for transport
  useEffect(() => {
    let id: number;
    const tick = () => { setTick(t => t + 1); id = requestAnimationFrame(tick); };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);

  // Canvas rendering + scrub
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
      const preset = presetRef.current;
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;

      drawBandEnvelopes(ctx, w, h, preset, { bass, mids, treble }, undefined, gateVal);

      if (preset && preset.durationSecs > 0) {
        const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        const step = preset.durationSecs > 120 ? 30 : 10;
        ctx.fillStyle = isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.2)";
        ctx.font = "9px system-ui";
        ctx.textAlign = "center";
        for (let t = step; t < preset.durationSecs; t += step) {
          const px = (t / preset.durationSecs) * w;
          ctx.fillText(formatTime(t), px, h - 3);
          ctx.beginPath();
          ctx.moveTo(px, 0);
          ctx.lineTo(px, h);
          ctx.strokeStyle = isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.06)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      animRef.current = requestAnimationFrame(draw);
    };
    animRef.current = requestAnimationFrame(draw);

    const seekAt = (e: MouseEvent) => {
      if (!presetRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      presetSeek(ratio * presetRef.current.durationSecs);
    };
    const onMove = (e: MouseEvent) => { if (dragging.current) seekAt(e); };
    const onUp = () => { dragging.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    return () => {
      cancelAnimationFrame(animRef.current);
      obs.disconnect();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [loaded, bass, mids, treble, gateVal]);

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    dragging.current = true;
    if (presetRef.current) {
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      presetSeek(ratio * presetRef.current.durationSecs);
    }
  };

  const playing = isPresetPlaying();
  const time = getPresetTime();
  const duration = getPresetDuration();

  const sliderClass = "flex-1 h-1 rounded appearance-none cursor-pointer bg-white/10 accent-blue-500";

  return (
    <div className="flex flex-col h-screen select-none overflow-hidden">
      {/* Controls */}
      <div className="px-4 py-3 space-y-2 border-b border-white/10 shrink-0 overflow-y-auto">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-white/70">Signal Settings</span>
          {presetName && <span className="text-[10px] text-white/30">{presetName}</span>}
        </div>

        {/* Mode */}
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs text-white/70">Mode</span>
          <select
            value={mode}
            onChange={(e) => { setMode(e.target.value); updateSetting({ signalMode: e.target.value }); }}
            className="bg-white/10 border border-white/10 rounded px-2 py-1 text-xs text-white/70 outline-none cursor-pointer"
          >
            <option value="simulated">Simulated</option>
            <option value="preset">Preset</option>
          </select>
        </div>

        {/* Opacity */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-white/70 w-16 shrink-0">Opacity</span>
          <span className="text-[10px] text-white/30 font-mono w-8 text-right shrink-0">{Math.round(alpha * 100)}%</span>
          <input type="range" min={0.05} max={1.0} step={0.01} value={alpha}
            onChange={(e) => { const v = parseFloat(e.target.value); setAlpha(v); updateSetting({ signalAlpha: v }); }}
            className={sliderClass}
          />
        </div>

        {/* Amplitude */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-white/70 w-16 shrink-0">Amplitude</span>
          <span className="text-[10px] text-white/30 font-mono w-8 text-right shrink-0">{amplitude.toFixed(2)}x</span>
          <input type="range" min={0.01} max={1.0} step={0.01} value={amplitude}
            onChange={(e) => { const v = parseFloat(e.target.value); setAmplitude(v); updateSetting({ signalAmplitude: v }); }}
            className={sliderClass}
          />
        </div>

        {/* Echo */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-white/70 w-16 shrink-0">Echo</span>
          <span className="text-[10px] text-white/30 font-mono w-8 text-right shrink-0">{Math.round(echo * 50)}%</span>
          <input type="range" min={0} max={2.0} step={0.01} value={echo}
            onChange={(e) => { const v = parseFloat(e.target.value); setEcho(v); updateSetting({ signalEcho: v }); }}
            className={sliderClass}
          />
        </div>

        {/* Gate */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-white/70 w-16 shrink-0">Gate</span>
          <span className="text-[10px] text-white/30 font-mono w-8 text-right shrink-0">{Math.round(gateVal * 100)}%</span>
          <input type="range" min={0} max={0.5} step={0.01} value={gateVal}
            onChange={(e) => { const v = parseFloat(e.target.value); setGateVal(v); setGate(v); updateSetting({ signalGate: v }); }}
            className={sliderClass}
          />
        </div>

        {/* Frequency (simulated only) */}
        {mode !== "preset" && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/70 w-16 shrink-0">Frequency</span>
            <span className="text-[10px] text-white/30 font-mono w-8 text-right shrink-0">{frequency.toFixed(2)}x</span>
            <input type="range" min={0.2} max={3.0} step={0.01} value={frequency}
              onChange={(e) => { const v = parseFloat(e.target.value); setFrequency(v); updateSetting({ signalFrequency: v }); }}
              className={sliderClass}
            />
          </div>
        )}

        {/* Bands */}
        <div className="flex items-center gap-3">
          <span className="text-xs text-white/70 w-16 shrink-0">Bands</span>
          {([["Bass", bass, setBass, "signalBass"], ["Mids", mids, setMids, "signalMids"], ["Treble", treble, setTreble, "signalTreble"]] as const).map(([label, val, setter, key]) => (
            <label key={key} className="flex items-center gap-1 cursor-pointer select-none">
              <input type="checkbox" checked={val}
                onChange={() => { const nv = !val; (setter as (v: boolean) => void)(nv); updateSetting({ [key]: nv }); }}
                className="w-3 h-3 rounded accent-blue-500 cursor-pointer"
              />
              <span className="text-[10px] text-white/50">{label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Band envelopes canvas (scrubable) */}
      <canvas
        ref={canvasRef}
        className="flex-1 w-full cursor-crosshair min-h-0"
        onMouseDown={handleCanvasMouseDown}
      />

      {/* Transport */}
      <div className="flex items-center gap-3 px-4 py-2 border-t border-white/10 shrink-0">
        <button
          onClick={togglePlayPause}
          className="w-6 h-6 flex items-center justify-center rounded bg-white/10 hover:bg-white/20 text-white/60 hover:text-white transition-colors text-xs"
          title={playing ? "Pause" : "Play"}
        >
          {playing ? "⏸" : "▶"}
        </button>
        <span className="text-[10px] text-white/40 font-mono w-10 shrink-0">{formatTime(time)}</span>
        <span className="text-[10px] text-white/20">/</span>
        <span className="text-[10px] text-white/40 font-mono w-10 shrink-0">{formatTime(duration)}</span>
      </div>
    </div>
  );
}
