import { useState, useCallback } from "react";
import { emitTo } from "@tauri-apps/api/event";

export type KeyAnimation =
  | "tap"
  | "all-press"
  | "all-release"
  | "random-keys"
  | "wave-left"
  | "wave-right"
  | "alternating"
  | "cascade-down"
  | "heartbeat"
  | "connect"
  | "disconnect";

interface KeyDef {
  id: KeyAnimation;
  label: string;
  icon: string;
}

const KEYS: KeyDef[] = [
  { id: "tap",          label: "Tap",         icon: "⏎" },
  { id: "all-press",    label: "All Down",    icon: "⬇" },
  { id: "all-release",  label: "All Up",      icon: "⬆" },
  { id: "random-keys",  label: "Random",      icon: "⚄" },
  { id: "wave-left",    label: "Wave →",      icon: "〜" },
  { id: "wave-right",   label: "Wave ←",      icon: "〜" },
  { id: "alternating",  label: "Alternate",   icon: "◑" },
  { id: "cascade-down", label: "Cascade",     icon: "▽" },
  { id: "heartbeat",    label: "Heartbeat",   icon: "♥" },
  { id: "connect",      label: "Connect",     icon: "🔌" },
  { id: "disconnect",   label: "Disconnect",  icon: "⏏" },
];

/** Standalone window page for the keyboard */
export function KeyboardPage() {
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const fireAnimation = useCallback((id: KeyAnimation) => {
    setActiveKey(id);
    emitTo("main", "keyboard-animation", { animation: id });
    setTimeout(() => setActiveKey(null), 300);
  }, []);

  return (
    <div className="h-screen flex flex-col keyboard-panel" data-tauri-drag-region>
      {/* Title bar — draggable */}
      <div className="flex items-center px-3 py-1.5 border-b keyboard-panel-border" data-tauri-drag-region>
        <span className="text-[0.625rem] keyboard-panel-dim uppercase tracking-wider" data-tauri-drag-region>Keyboard</span>
      </div>

      {/* Button Grid */}
      <div className="flex-1 grid grid-cols-3 gap-1.5 p-2.5 content-center">
        {KEYS.map((key) => (
          <button
            key={key.id}
            onClick={() => fireAnimation(key.id)}
            className={`keyboard-key flex flex-col items-center justify-center h-14 rounded-lg transition-all duration-100 cursor-pointer ${
              activeKey === key.id ? "keyboard-key--active scale-95" : "active:scale-95"
            }`}
            title={key.label}
          >
            <span className="text-base leading-none">{key.icon}</span>
            <span className="text-[0.5rem] keyboard-panel-dim mt-1">{key.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
