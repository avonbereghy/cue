import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePageVisible } from "@/hooks/usePageVisible";
import type { SignalPreset, Settings } from "@/lib/types";
import { loadPreset as loadPresetEngine, isPlaying as isPresetPlaying, getCurrentTime as getPresetTime, getDuration as getPresetDuration, togglePlayPause, seek as presetSeek, isLoaded as isPresetLoaded, setGate } from "@/lib/presetEngine";
import { DEFAULT_PRESET } from "@/lib/defaultPreset";
import { drawBandEnvelopes } from "./SettingsView";
import { decodeFile, extractFromPcm, type DecodedPcm } from "@/lib/audioExtractor";
import { processPcm, DEFAULT_EDIT_PARAMS, type EditParams } from "@/lib/audioEditor";

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function SignalSettingsPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const presetRef = useRef<SignalPreset | null>(null);
  const dragging = useRef(false);
  const [loaded, setLoaded] = useState(false);
  // Bumped only on discrete transport events (play/pause) to reconcile the
  // play/pause icon + duration. The continuously-advancing time label is
  // updated out-of-band via currentTimeRef so playback no longer forces a
  // full-tree re-render every animation frame.
  const [, setTick] = useState(0);
  const currentTimeRef = useRef<HTMLSpanElement>(null);
  const pageVisible = usePageVisible();

  // Settings state
  const [mode, setMode] = useState("preset");
  const [alpha, setAlpha] = useState(0.7);
  const [amplitude, setAmplitude] = useState(0.20);
  const [echo, setEcho] = useState(1.75);
  const [gateVal, setGateVal] = useState(0.05);
  const [frequency, setFrequency] = useState(1.0);
  const [bass, setBass] = useState(true);
  const [mids, setMids] = useState(true);
  const [treble, setTreble] = useState(true);
  const [presetName, setPresetName] = useState("");

  // ── Source Editor ────────────────────────────────────────────────
  // Dev-only PCM editor: load an audio file, tweak crop/smooth/clip/gain/
  // normalize/fade params, preview the resulting band envelopes live, and
  // save as a baked preset. The decoded PCM is held in a ref so we re-extract
  // on every param change without re-decoding.
  const [editorOpen, setEditorOpen] = useState(false);
  const [sourceFileName, setSourceFileName] = useState<string>("");
  const [decoding, setDecoding] = useState(false);
  const [decodeError, setDecodeError] = useState<string>("");
  const decodedRef = useRef<DecodedPcm | null>(null);
  const [editParams, setEditParams] = useState<EditParams>(DEFAULT_EDIT_PARAMS);
  const [editPreviewName, setEditPreviewName] = useState<string>("");
  const [editingPreset, setEditingPreset] = useState<SignalPreset | null>(null);
  const [extractingEdit, setExtractingEdit] = useState(false);
  const editTimerRef = useRef<number | null>(null);
  const sourceDuration = decodedRef.current?.duration ?? 0;
  const cropDuration = useMemo(() => {
    const start = editParams.cropInSecs;
    const end = editParams.cropOutSecs > start ? editParams.cropOutSecs : sourceDuration;
    return Math.max(0, end - start);
  }, [editParams.cropInSecs, editParams.cropOutSecs, sourceDuration]);

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
      setAlpha(s.signalAlpha ?? 0.7);
      setAmplitude(s.signalAmplitude ?? 0.15);
      setEcho(s.signalEcho ?? 1.75);
      const g = s.signalGate ?? 0.05;
      setGateVal(g);
      setGate(g);
      setFrequency(s.signalFrequency ?? 1.0);
      setBass(s.signalBass ?? true);
      setMids(s.signalMids ?? true);
      setTreble(s.signalTreble ?? true);
      const loadDefault = () => {
        presetRef.current = DEFAULT_PRESET;
        setLoaded(true);
        if (!isPresetLoaded()) loadPresetEngine(DEFAULT_PRESET);
      };
      if (s.activePresetId) {
        invoke<SignalPreset>("load_preset", { id: s.activePresetId }).then((p) => {
          presetRef.current = p;
          setPresetName(p.name);
          setLoaded(true);
          if (!isPresetLoaded()) loadPresetEngine(p);
        }).catch(loadDefault);
      } else {
        loadDefault();
      }
    });
  }, []);

  // Transport time label — advanced via direct textContent instead of a
  // per-frame React re-render of the whole settings window. The label is m:ss,
  // so ~4fps is more than enough; gated on playback + page visibility so it
  // costs nothing while paused or backgrounded.
  const playing = isPresetPlaying();
  useEffect(() => {
    if (!playing || !pageVisible) return;
    const update = () => {
      const el = currentTimeRef.current;
      if (el) el.textContent = formatTime(getPresetTime());
    };
    update();
    const id = window.setInterval(update, 250);
    return () => window.clearInterval(id);
  }, [playing, pageVisible]);

  const handleSourceFile = useCallback(async (file: File) => {
    setDecoding(true);
    setDecodeError("");
    try {
      const decoded = await decodeFile(file);
      decodedRef.current = decoded;
      const baseName = file.name.replace(/\.[^/.]+$/, "");
      setSourceFileName(file.name);
      setEditPreviewName(baseName);
      setEditParams({ ...DEFAULT_EDIT_PARAMS, cropOutSecs: decoded.duration });
    } catch (err) {
      console.error("Failed to decode audio:", err);
      setDecodeError("Failed to decode — try a different file");
      decodedRef.current = null;
      setSourceFileName("");
    } finally {
      setDecoding(false);
    }
  }, []);

  // Live re-extract when edit params change (debounced).
  useEffect(() => {
    if (!decodedRef.current) {
      setEditingPreset(null);
      return;
    }
    if (editTimerRef.current !== null) window.clearTimeout(editTimerRef.current);
    editTimerRef.current = window.setTimeout(() => {
      const decoded = decodedRef.current;
      if (!decoded) return;
      setExtractingEdit(true);
      try {
        const processed = processPcm(decoded.mono, decoded.sampleRate, editParams);
        const preview = extractFromPcm(processed, decoded.sampleRate, editPreviewName || "preview");
        setEditingPreset(preview);
      } catch (err) {
        console.error("Live extraction failed:", err);
      } finally {
        setExtractingEdit(false);
      }
    }, 120);
    return () => {
      if (editTimerRef.current !== null) window.clearTimeout(editTimerRef.current);
    };
  }, [editParams, editPreviewName]);

  const handleSaveEditedPreset = useCallback(async () => {
    if (!decodedRef.current || !editingPreset) return;
    const name = editPreviewName.trim() || "Edited preset";
    const finalPreset: SignalPreset = { ...editingPreset, name };
    try {
      await invoke("save_preset", { preset: finalPreset });
      const next = await invoke<Settings>("get_settings");
      await invoke("update_settings", {
        newSettings: { ...next, signalMode: "preset", activePresetId: finalPreset.id },
      });
      presetRef.current = finalPreset;
      setPresetName(finalPreset.name);
      loadPresetEngine(finalPreset);
      // Drop editor state once saved
      decodedRef.current = null;
      setSourceFileName("");
      setEditingPreset(null);
      setEditParams(DEFAULT_EDIT_PARAMS);
      setEditorOpen(false);
    } catch (err) {
      console.error("Failed to save edited preset:", err);
      setDecodeError("Failed to save — see console");
    }
  }, [editingPreset, editPreviewName]);

  const handleDiscardEdits = useCallback(() => {
    decodedRef.current = null;
    setSourceFileName("");
    setEditingPreset(null);
    setEditParams(DEFAULT_EDIT_PARAMS);
    setDecodeError("");
  }, []);

  // Canvas rendering + scrub
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;

    // This canvas is static — it renders the band envelopes + fixed time
    // gridlines, with no moving playhead. So it only needs to repaint on
    // resize and on the state changes in this effect's deps, NOT every
    // animation frame. Drawing it in a permanent rAF loop was pure waste.
    const draw = () => {
      const preset = editingPreset ?? presetRef.current;
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;

      drawBandEnvelopes(ctx, w, h, preset, { bass, mids, treble }, undefined, gateVal);

      if (preset && preset.durationSecs > 0 && !editingPreset) {
        const isDark = document.documentElement.getAttribute("data-theme") !== "light";
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
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Resizing the backing store clears it — repaint at the new size.
      draw();
    };
    resize();
    const obs = new ResizeObserver(resize);
    obs.observe(canvas);

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
      obs.disconnect();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [loaded, bass, mids, treble, gateVal, editingPreset]);

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (editingPreset) return; // no playback engine for live previews
    dragging.current = true;
    if (presetRef.current) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      presetSeek(ratio * presetRef.current.durationSecs);
    }
  };

  const duration = getPresetDuration();

  const sliderClass = "flex-1 h-1 rounded appearance-none cursor-pointer bg-white/10 accent-blue-500";

  return (
    <div className="flex flex-col h-screen select-none overflow-hidden">
      {/* Controls */}
      <div className="px-4 py-3 space-y-2 border-b border-white/10 shrink-0 overflow-y-auto">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-white/70">Signal Settings</span>
          {presetName && <span className="text-[0.625rem] text-white/30">{presetName}</span>}
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
          <span className="text-[0.625rem] text-white/30 font-mono w-8 text-right shrink-0">{Math.round(alpha * 100)}%</span>
          <input type="range" min={0.05} max={1.0} step={0.01} value={alpha}
            onChange={(e) => { const v = parseFloat(e.target.value); setAlpha(v); updateSetting({ signalAlpha: v }); }}
            className={sliderClass}
          />
        </div>

        {/* Amplitude */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-white/70 w-16 shrink-0">Amplitude</span>
          <span className="text-[0.625rem] text-white/30 font-mono w-8 text-right shrink-0">{amplitude.toFixed(2)}x</span>
          <input type="range" min={0.01} max={1.0} step={0.01} value={amplitude}
            onChange={(e) => { const v = parseFloat(e.target.value); setAmplitude(v); updateSetting({ signalAmplitude: v }); }}
            className={sliderClass}
          />
        </div>

        {/* Echo */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-white/70 w-16 shrink-0">Echo</span>
          <span className="text-[0.625rem] text-white/30 font-mono w-8 text-right shrink-0">{Math.round(echo * 50)}%</span>
          <input type="range" min={0} max={2.0} step={0.01} value={echo}
            onChange={(e) => { const v = parseFloat(e.target.value); setEcho(v); updateSetting({ signalEcho: v }); }}
            className={sliderClass}
          />
        </div>

        {/* Gate */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-white/70 w-16 shrink-0">Gate</span>
          <span className="text-[0.625rem] text-white/30 font-mono w-8 text-right shrink-0">{Math.round(gateVal * 100)}%</span>
          <input type="range" min={0} max={0.5} step={0.01} value={gateVal}
            onChange={(e) => { const v = parseFloat(e.target.value); setGateVal(v); setGate(v); updateSetting({ signalGate: v }); }}
            className={sliderClass}
          />
        </div>

        {/* Frequency (simulated only) */}
        {mode !== "preset" && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/70 w-16 shrink-0">Frequency</span>
            <span className="text-[0.625rem] text-white/30 font-mono w-8 text-right shrink-0">{frequency.toFixed(2)}x</span>
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
              <span className="text-[0.625rem] text-white/50">{label}</span>
            </label>
          ))}
        </div>

        {/* Source Editor (dev) */}
        <div className="pt-2 border-t border-white/10">
          <button
            onClick={() => setEditorOpen(o => !o)}
            className="flex items-center gap-1 text-[0.625rem] uppercase tracking-wider text-white/40 hover:text-white/70 transition-colors"
          >
            <span>{editorOpen ? "▾" : "▸"}</span>
            <span>Source Editor</span>
            {editingPreset && <span className="ml-1 text-amber-400/60">• unsaved</span>}
            {extractingEdit && <span className="ml-1 text-white/30">extracting…</span>}
          </button>

          {editorOpen && (
            <div className="pt-2 space-y-2">
              <SourceEditorBody
                sourceFileName={sourceFileName}
                decoding={decoding}
                decodeError={decodeError}
                editingPreset={editingPreset}
                editParams={editParams}
                setEditParams={setEditParams}
                editPreviewName={editPreviewName}
                setEditPreviewName={setEditPreviewName}
                sourceDuration={sourceDuration}
                cropDuration={cropDuration}
                onPickFile={handleSourceFile}
                onSave={handleSaveEditedPreset}
                onDiscard={handleDiscardEdits}
                sliderClass={sliderClass}
              />
            </div>
          )}
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
          onClick={() => { togglePlayPause(); setTick(t => t + 1); }}
          className="w-6 h-6 flex items-center justify-center rounded bg-white/10 hover:bg-white/20 text-white/60 hover:text-white transition-colors text-xs"
          title={playing ? "Pause" : "Play"}
        >
          {playing ? "⏸" : "▶"}
        </button>
        <span ref={currentTimeRef} className="text-[0.625rem] text-white/40 font-mono w-10 shrink-0">{formatTime(getPresetTime())}</span>
        <span className="text-[0.625rem] text-white/20">/</span>
        <span className="text-[0.625rem] text-white/40 font-mono w-10 shrink-0">{formatTime(duration)}</span>
      </div>
    </div>
  );
}

interface SourceEditorBodyProps {
  sourceFileName: string;
  decoding: boolean;
  decodeError: string;
  editingPreset: SignalPreset | null;
  editParams: EditParams;
  setEditParams: (next: EditParams | ((p: EditParams) => EditParams)) => void;
  editPreviewName: string;
  setEditPreviewName: (n: string) => void;
  sourceDuration: number;
  cropDuration: number;
  onPickFile: (file: File) => void;
  onSave: () => void;
  onDiscard: () => void;
  sliderClass: string;
}

function SourceEditorBody({
  sourceFileName, decoding, decodeError, editingPreset, editParams, setEditParams,
  editPreviewName, setEditPreviewName, sourceDuration, cropDuration,
  onPickFile, onSave, onDiscard, sliderClass,
}: SourceEditorBodyProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const update = (patch: Partial<EditParams>) => setEditParams(p => ({ ...p, ...patch }));

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="audio/wav,audio/mpeg,audio/mp3,audio/ogg,audio/opus,.wav,.mp3,.opus,.ogg"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPickFile(f);
          e.target.value = "";
        }}
      />

      <div className="flex items-center gap-2">
        <button
          onClick={() => fileRef.current?.click()}
          disabled={decoding}
          className="px-2 py-1 rounded text-[0.625rem] font-medium bg-white/10 hover:bg-white/20 text-white/60 hover:text-white transition-colors disabled:opacity-50"
        >
          {decoding ? "Decoding…" : sourceFileName ? "Replace Source" : "Load Audio"}
        </button>
        {sourceFileName && (
          <span className="text-[0.625rem] text-white/40 truncate" title={sourceFileName}>
            {sourceFileName}
          </span>
        )}
        {!sourceFileName && !decoding && (
          <span className="text-[0.625rem] text-white/30">Decode → tweak → save</span>
        )}
      </div>

      {decodeError && (
        <div className="text-[0.625rem] text-red-400/80">{decodeError}</div>
      )}

      {sourceDuration > 0 && (
        <>
          {/* Crop in */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/70 w-16 shrink-0">Crop In</span>
            <span className="text-[0.625rem] text-white/30 font-mono w-12 text-right shrink-0">
              {editParams.cropInSecs.toFixed(2)}s
            </span>
            <input type="range" min={0} max={sourceDuration} step={0.01} value={editParams.cropInSecs}
              onChange={(e) => {
                const v = Math.min(parseFloat(e.target.value), editParams.cropOutSecs - 0.05);
                update({ cropInSecs: Math.max(0, v) });
              }}
              className={sliderClass}
            />
          </div>

          {/* Crop out */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/70 w-16 shrink-0">Crop Out</span>
            <span className="text-[0.625rem] text-white/30 font-mono w-12 text-right shrink-0">
              {editParams.cropOutSecs.toFixed(2)}s
            </span>
            <input type="range" min={0} max={sourceDuration} step={0.01} value={editParams.cropOutSecs}
              onChange={(e) => {
                const v = Math.max(parseFloat(e.target.value), editParams.cropInSecs + 0.05);
                update({ cropOutSecs: Math.min(sourceDuration, v) });
              }}
              className={sliderClass}
            />
          </div>

          {/* Smooth (low-pass) */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/70 w-16 shrink-0">Smooth</span>
            <span className="text-[0.625rem] text-white/30 font-mono w-12 text-right shrink-0">
              {editParams.smoothCutoffHz === 0 ? "off" : `${Math.round(editParams.smoothCutoffHz)}Hz`}
            </span>
            <input type="range" min={0} max={8000} step={50} value={editParams.smoothCutoffHz}
              onChange={(e) => update({ smoothCutoffHz: parseFloat(e.target.value) })}
              className={sliderClass}
            />
          </div>

          {/* Fade in */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/70 w-16 shrink-0">Fade In</span>
            <span className="text-[0.625rem] text-white/30 font-mono w-12 text-right shrink-0">
              {editParams.fadeInSecs.toFixed(2)}s
            </span>
            <input type="range" min={0} max={Math.max(0.01, cropDuration / 2)} step={0.01} value={Math.min(editParams.fadeInSecs, cropDuration / 2)}
              onChange={(e) => update({ fadeInSecs: parseFloat(e.target.value) })}
              className={sliderClass}
            />
          </div>

          {/* Fade out */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/70 w-16 shrink-0">Fade Out</span>
            <span className="text-[0.625rem] text-white/30 font-mono w-12 text-right shrink-0">
              {editParams.fadeOutSecs.toFixed(2)}s
            </span>
            <input type="range" min={0} max={Math.max(0.01, cropDuration / 2)} step={0.01} value={Math.min(editParams.fadeOutSecs, cropDuration / 2)}
              onChange={(e) => update({ fadeOutSecs: parseFloat(e.target.value) })}
              className={sliderClass}
            />
          </div>

          {/* Gain */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/70 w-16 shrink-0">Gain</span>
            <span className="text-[0.625rem] text-white/30 font-mono w-12 text-right shrink-0">
              {editParams.gain.toFixed(2)}x
            </span>
            <input type="range" min={0.1} max={4.0} step={0.05} value={editParams.gain}
              onChange={(e) => update({ gain: parseFloat(e.target.value) })}
              className={sliderClass}
            />
          </div>

          {/* Clip ceiling */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/70 w-16 shrink-0">Clip</span>
            <span className="text-[0.625rem] text-white/30 font-mono w-12 text-right shrink-0">
              {editParams.clipCeiling >= 1 ? "off" : editParams.clipCeiling.toFixed(2)}
            </span>
            <input type="range" min={0.05} max={1.0} step={0.01} value={editParams.clipCeiling}
              onChange={(e) => update({ clipCeiling: parseFloat(e.target.value) })}
              className={sliderClass}
            />
          </div>

          {/* Normalize */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/70 w-16 shrink-0">Normalize</span>
            <label className="flex items-center gap-1 cursor-pointer select-none">
              <input type="checkbox" checked={editParams.normalize}
                onChange={(e) => update({ normalize: e.target.checked })}
                className="w-3 h-3 rounded accent-blue-500 cursor-pointer"
              />
              <span className="text-[0.625rem] text-white/50">Peak → 1.0 (post-clip)</span>
            </label>
          </div>

          {/* Name + actions */}
          <div className="flex items-center gap-2 pt-1">
            <span className="text-xs text-white/70 w-16 shrink-0">Name</span>
            <input
              type="text"
              value={editPreviewName}
              onChange={(e) => setEditPreviewName(e.target.value)}
              spellCheck={false}
              className="flex-1 px-2 py-1 rounded bg-white/10 border border-white/10 text-xs text-white/80 outline-none focus:border-white/25"
              placeholder="Preset name"
            />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={onSave}
              disabled={!editingPreset || !editPreviewName.trim()}
              className="px-2 py-1 rounded text-[0.625rem] font-medium bg-blue-500/20 hover:bg-blue-500/30 text-blue-200 transition-colors disabled:opacity-40"
            >
              Save Preset
            </button>
            <button
              onClick={onDiscard}
              className="px-2 py-1 rounded text-[0.625rem] font-medium bg-white/10 hover:bg-white/20 text-white/60 hover:text-white transition-colors"
            >
              Discard
            </button>
            <button
              onClick={() => setEditParams(() => ({ ...DEFAULT_EDIT_PARAMS, cropOutSecs: sourceDuration }))}
              className="px-2 py-1 rounded text-[0.625rem] font-medium bg-white/5 hover:bg-white/15 text-white/40 hover:text-white/70 transition-colors"
              title="Reset all edit params"
            >
              Reset
            </button>
          </div>
        </>
      )}
    </>
  );
}
