// TypeScript interfaces mirroring Rust models (camelCase via serde)

export interface SessionInfo {
  id: string;
  workspace: string;
  /** One of: "working", "waiting", "error", "subagent", "idle", "done" */
  state: string;
  lastActivity: number;
  startedAt: number;
  /** Client that launched the session: "vscode", "cursor", "iterm", "terminal", etc. */
  source?: string;
  /** Number of currently active subagents (from hook). */
  activeSubagents?: number;
}

export interface SubagentMetrics {
  agentId: string;
  description: string;
  slug: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  model: string;
  toolCounts: Record<string, number>;
  messageCount: number;
  /** True if the subagent's JSONL was modified within the last 60s */
  isActive: boolean;
}

export interface TodoItem {
  content: string;
  /** One of: "pending", "in_progress", "completed" */
  status: string;
}

export interface RateLimitInfo {
  fiveHourPercent: number;
  sevenDayPercent: number;
  fiveHourResetAt: number | null;
  sevenDayResetAt: number | null;
  limitReached: boolean;
}

export interface GitStatusInfo {
  dirty: boolean;
  ahead: number;
  behind: number;
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
}

export interface ConfigCounts {
  claudeMdCount: number;
  rulesCount: number;
  mcpServers: number;
  hooksCount: number;
}

export interface SystemMemory {
  totalMb: number;
  usedMb: number;
  usagePercent: number;
}

export interface SessionMetrics {
  messageCount: number;
  userMessageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  model: string;
  lastInputTokens: number;
  customTitle: string | null;
  gitBranch: string | null;
  toolCounts: Record<string, number>;
  subagents: SubagentMetrics[];
  runningToolName?: string;
  runningToolTarget?: string;
  todoItems: TodoItem[];
}

/** Pre-computed by Rust backend (EnrichedSession includes derived fields) */
export interface EnrichedSession {
  info: SessionInfo;
  metrics: SessionMetrics;
  workspaceName: string;
  displayTitle: string;
  stateIcon: string;
  stateDisplayName: string;
  durationSecs: number;
  contextLimit: number;
  contextUsagePercent: number;
  modelDisplayName: string;
  /** Human-readable source label (e.g. "VSCode", "iTerm", "Terminal") */
  sourceDisplay: string;
  /** Whether this session has active or completed subagents */
  hasSubagents: boolean;
  /** Git status for the workspace */
  gitStatus?: GitStatusInfo;
  /** Claude config file counts */
  configCounts?: ConfigCounts;
  /** Rate limit information from statusline bridge */
  rateLimits?: RateLimitInfo;
  /** Provider: "Bedrock", "Vertex", "API", or "" */
  provider: string;
  /** Output tokens per second */
  outputTokensPerSec: number;
  /** Currently running tool name */
  runningToolName?: string;
  /** Target of the running tool */
  runningToolTarget?: string;
  /** Todo items from the session */
  todoItems: TodoItem[];
  /** Number of completed todos */
  todoCompleted: number;
  /** Total number of todos */
  todoTotal: number;
  /** Current in-progress todo content (truncated) */
  todoCurrent?: string;
  /** System memory information */
  systemMemory: SystemMemory;
  /** Claude Code version */
  claudeVersion?: string;
}

export interface Settings {
  onboardingComplete: boolean;
  permissionsEnabled: boolean;
  theme: string;
  titleAnimation: string;
  animationSpeed: number;
  randomAnimation: boolean;
  signalString: boolean;
  signalFrequency: number;
  signalMode: string;
  signalAlpha: number;
  signalAmplitude: number;
  signalEcho: number;
  signalGate: number;
  signalBass: boolean;
  signalMids: boolean;
  signalTreble: boolean;
  activePresetId: string;
  signalColorDark: string;
  signalColorLight: string;
  activeThemeId: string;
  signalOffset: number;
  particleEnabled: boolean;
  particleSpeed: number;
  particleRate: number;
  particleSparks: number;
  particleAlpha: number;
  cordRetractDelay: number;
  cordDeployForce: number;
  cordRetractForce: number;
  keyPressSpeed: number;
  keyReleaseSpeed: number;
  autoReorder: boolean;
  fontScale: number;
  testMode: boolean;
  compactMode: boolean;
  slimMode: boolean;
  contextThreshold: boolean;
  /** Context display mode: "percent", "tokens", "remaining", or "both" */
  contextDisplay: string;
}

export interface SignalPreset {
  id: string;
  name: string;
  createdAt: number;
  durationSecs: number;
  sampleRate: number;
  bands: {
    bass: number[];
    mids: number[];
    treble: number[];
  };
}

export interface PresetSummary {
  id: string;
  name: string;
  createdAt: number;
  durationSecs: number;
}

// ---------------------------------------------------------------------------
// Signal Themes — unified color + behavior presets
// ---------------------------------------------------------------------------
export interface SignalTheme {
  id: string;
  label: string;
  /** Accent dot color shown in the theme selector */
  accent: string;
  // --- Signal string ---
  colorDark: string;
  colorLight: string;
  alpha: number;
  amplitude: number;
  echo: number;
  particleEnabled: boolean;
  particleSpeed: number;
  particleRate: number;
  particleSparks: number;
  particleAlpha: number;
  // --- UI surfaces ---
  appBg: string;
  appText: string;
  cardFloatBg: string;
  cardFloatBorder: string;
  cardFloatShadow: string;
  cardPressBg: string;
  cardPressBorder: string;
  cardPressShadow: string;
  surfaceBg: string;
  surfaceBorder: string;
  accentColor: string;
  accentBg: string;
}

// Shared surface defaults
const DARK_SURFACES = {
  appBg: "#0e0e0e",
  appText: "#fff",
  cardFloatBg: "rgba(255,255,255,0.07)",
  cardFloatBorder: "rgba(255,255,255,0.10)",
  cardFloatShadow: "0 2px 6px rgba(0,0,0,0.35), 0 8px 24px rgba(0,0,0,0.25), 0 0 0 0.5px rgba(255,255,255,0.08)",
  cardPressBg: "rgba(255,255,255,0.01)",
  cardPressBorder: "rgba(255,255,255,0.03)",
  cardPressShadow: "inset 0 2px 8px rgba(0,0,0,0.6), inset 0 1px 3px rgba(0,0,0,0.4), 0 0 1px rgba(255,255,255,0.05)",
  surfaceBg: "rgba(255,255,255,0.05)",
  surfaceBorder: "rgba(255,255,255,0.10)",
};

export const SIGNAL_THEMES: SignalTheme[] = [
  // --- Essentials ---
  { id: "default",  label: "Default",  accent: "#ffffff",
    colorDark: "#ffffff", colorLight: "#000000", alpha: 0.75, amplitude: 0.25, echo: 1.0,
    particleEnabled: false,  particleSpeed: 1.0, particleRate: 1.0, particleSparks: 3, particleAlpha: 1.0,
    ...DARK_SURFACES, accentColor: "#3b82f6", accentBg: "rgba(59,130,246,0.15)" },
  { id: "minimal",  label: "Minimal",  accent: "#888888",
    colorDark: "#ffffff", colorLight: "#000000", alpha: 0.5, amplitude: 0.15, echo: 0.3,
    particleEnabled: false, particleSpeed: 1.0, particleRate: 0.3, particleSparks: 0, particleAlpha: 0.5,
    ...DARK_SURFACES, accentColor: "#9ca3af", accentBg: "rgba(156,163,175,0.12)" },
  // --- Vivid ---
  { id: "neon",     label: "Neon",     accent: "#00e5ff",
    colorDark: "#00e5ff", colorLight: "#0097a7", alpha: 0.75, amplitude: 0.4, echo: 1.8,
    particleEnabled: true,  particleSpeed: 1.5, particleRate: 2.0, particleSparks: 5, particleAlpha: 0.9,
    appBg: "#060d10", appText: "#e0f7fa",
    cardFloatBg: "rgba(0,229,255,0.06)", cardFloatBorder: "rgba(0,229,255,0.15)",
    cardFloatShadow: "0 2px 8px rgba(0,0,0,0.4), 0 8px 24px rgba(0,229,255,0.08), 0 0 0 0.5px rgba(0,229,255,0.12)",
    cardPressBg: "rgba(0,229,255,0.02)", cardPressBorder: "rgba(0,229,255,0.06)",
    cardPressShadow: "inset 0 2px 8px rgba(0,0,0,0.7), inset 0 0 12px rgba(0,229,255,0.05)",
    surfaceBg: "rgba(0,229,255,0.04)", surfaceBorder: "rgba(0,229,255,0.12)",
    accentColor: "#00e5ff", accentBg: "rgba(0,229,255,0.15)" },
  { id: "ember",    label: "Ember",    accent: "#ffab00",
    colorDark: "#ffab00", colorLight: "#e65100", alpha: 0.75, amplitude: 0.3, echo: 1.2,
    particleEnabled: true,  particleSpeed: 0.7, particleRate: 3.0, particleSparks: 4, particleAlpha: 0.8,
    appBg: "#100a04", appText: "#fff3e0",
    cardFloatBg: "rgba(255,171,0,0.05)", cardFloatBorder: "rgba(255,171,0,0.12)",
    cardFloatShadow: "0 2px 6px rgba(0,0,0,0.4), 0 6px 20px rgba(255,171,0,0.06), 0 0 0 0.5px rgba(255,171,0,0.10)",
    cardPressBg: "rgba(255,171,0,0.02)", cardPressBorder: "rgba(255,171,0,0.05)",
    cardPressShadow: "inset 0 2px 8px rgba(0,0,0,0.7), inset 0 0 12px rgba(255,171,0,0.04)",
    surfaceBg: "rgba(255,171,0,0.04)", surfaceBorder: "rgba(255,171,0,0.10)",
    accentColor: "#ffab00", accentBg: "rgba(255,171,0,0.15)" },
  { id: "pulse",    label: "Pulse",    accent: "#ff4081",
    colorDark: "#ff4081", colorLight: "#c2185b", alpha: 0.75, amplitude: 0.6, echo: 0.6,
    particleEnabled: true,  particleSpeed: 2.5, particleRate: 1.5, particleSparks: 6, particleAlpha: 1.0,
    appBg: "#0e060a", appText: "#fce4ec",
    cardFloatBg: "rgba(255,64,129,0.05)", cardFloatBorder: "rgba(255,64,129,0.14)",
    cardFloatShadow: "0 2px 6px rgba(0,0,0,0.4), 0 6px 20px rgba(255,64,129,0.06), 0 0 0 0.5px rgba(255,64,129,0.10)",
    cardPressBg: "rgba(255,64,129,0.02)", cardPressBorder: "rgba(255,64,129,0.05)",
    cardPressShadow: "inset 0 2px 8px rgba(0,0,0,0.7), inset 0 0 12px rgba(255,64,129,0.04)",
    surfaceBg: "rgba(255,64,129,0.04)", surfaceBorder: "rgba(255,64,129,0.10)",
    accentColor: "#ff4081", accentBg: "rgba(255,64,129,0.15)" },
  { id: "aurora",   label: "Aurora",   accent: "#00e676",
    colorDark: "#00e676", colorLight: "#2e7d32", alpha: 0.75, amplitude: 0.35, echo: 2.0,
    particleEnabled: true,  particleSpeed: 0.8, particleRate: 1.2, particleSparks: 2, particleAlpha: 0.7,
    appBg: "#040e08", appText: "#e8f5e9",
    cardFloatBg: "rgba(0,230,118,0.05)", cardFloatBorder: "rgba(0,230,118,0.12)",
    cardFloatShadow: "0 2px 6px rgba(0,0,0,0.4), 0 6px 20px rgba(0,230,118,0.06), 0 0 0 0.5px rgba(0,230,118,0.10)",
    cardPressBg: "rgba(0,230,118,0.02)", cardPressBorder: "rgba(0,230,118,0.05)",
    cardPressShadow: "inset 0 2px 8px rgba(0,0,0,0.7), inset 0 0 12px rgba(0,230,118,0.04)",
    surfaceBg: "rgba(0,230,118,0.04)", surfaceBorder: "rgba(0,230,118,0.10)",
    accentColor: "#00e676", accentBg: "rgba(0,230,118,0.15)" },
  // --- Mood ---
  { id: "ghost",    label: "Ghost",    accent: "#b388ff",
    colorDark: "#b388ff", colorLight: "#7b1fa2", alpha: 0.65, amplitude: 0.5, echo: 2.5,
    particleEnabled: true,  particleSpeed: 0.5, particleRate: 0.5, particleSparks: 0, particleAlpha: 0.4,
    appBg: "#0a060e", appText: "#ede7f6",
    cardFloatBg: "rgba(179,136,255,0.04)", cardFloatBorder: "rgba(179,136,255,0.10)",
    cardFloatShadow: "0 2px 6px rgba(0,0,0,0.4), 0 6px 20px rgba(179,136,255,0.05), 0 0 0 0.5px rgba(179,136,255,0.08)",
    cardPressBg: "rgba(179,136,255,0.01)", cardPressBorder: "rgba(179,136,255,0.04)",
    cardPressShadow: "inset 0 2px 8px rgba(0,0,0,0.7), inset 0 0 12px rgba(179,136,255,0.03)",
    surfaceBg: "rgba(179,136,255,0.03)", surfaceBorder: "rgba(179,136,255,0.08)",
    accentColor: "#b388ff", accentBg: "rgba(179,136,255,0.15)" },
  { id: "midnight", label: "Midnight", accent: "#448aff",
    colorDark: "#448aff", colorLight: "#1a237e", alpha: 0.75, amplitude: 0.3, echo: 1.8,
    particleEnabled: true,  particleSpeed: 0.6, particleRate: 0.8, particleSparks: 2, particleAlpha: 0.6,
    appBg: "#060810", appText: "#e8eaf6",
    cardFloatBg: "rgba(68,138,255,0.05)", cardFloatBorder: "rgba(68,138,255,0.12)",
    cardFloatShadow: "0 2px 6px rgba(0,0,0,0.4), 0 6px 20px rgba(68,138,255,0.06), 0 0 0 0.5px rgba(68,138,255,0.10)",
    cardPressBg: "rgba(68,138,255,0.02)", cardPressBorder: "rgba(68,138,255,0.05)",
    cardPressShadow: "inset 0 2px 8px rgba(0,0,0,0.7), inset 0 0 12px rgba(68,138,255,0.04)",
    surfaceBg: "rgba(68,138,255,0.04)", surfaceBorder: "rgba(68,138,255,0.10)",
    accentColor: "#448aff", accentBg: "rgba(68,138,255,0.15)" },
  { id: "crimson",  label: "Crimson",  accent: "#ff1744",
    colorDark: "#ff1744", colorLight: "#b71c1c", alpha: 0.75, amplitude: 0.45, echo: 0.8,
    particleEnabled: true,  particleSpeed: 1.8, particleRate: 2.5, particleSparks: 4, particleAlpha: 0.9,
    appBg: "#0e0406", appText: "#ffebee",
    cardFloatBg: "rgba(255,23,68,0.05)", cardFloatBorder: "rgba(255,23,68,0.14)",
    cardFloatShadow: "0 2px 6px rgba(0,0,0,0.4), 0 6px 20px rgba(255,23,68,0.06), 0 0 0 0.5px rgba(255,23,68,0.10)",
    cardPressBg: "rgba(255,23,68,0.02)", cardPressBorder: "rgba(255,23,68,0.05)",
    cardPressShadow: "inset 0 2px 8px rgba(0,0,0,0.7), inset 0 0 12px rgba(255,23,68,0.04)",
    surfaceBg: "rgba(255,23,68,0.04)", surfaceBorder: "rgba(255,23,68,0.10)",
    accentColor: "#ff1744", accentBg: "rgba(255,23,68,0.15)" },
  { id: "solar",    label: "Solar",    accent: "#ffd740",
    colorDark: "#ffd740", colorLight: "#f57f17", alpha: 0.75, amplitude: 0.35, echo: 1.4,
    particleEnabled: true,  particleSpeed: 1.2, particleRate: 1.8, particleSparks: 3, particleAlpha: 0.85,
    appBg: "#0e0c04", appText: "#fffde7",
    cardFloatBg: "rgba(255,215,64,0.04)", cardFloatBorder: "rgba(255,215,64,0.12)",
    cardFloatShadow: "0 2px 6px rgba(0,0,0,0.4), 0 6px 20px rgba(255,215,64,0.06), 0 0 0 0.5px rgba(255,215,64,0.10)",
    cardPressBg: "rgba(255,215,64,0.01)", cardPressBorder: "rgba(255,215,64,0.04)",
    cardPressShadow: "inset 0 2px 8px rgba(0,0,0,0.7), inset 0 0 12px rgba(255,215,64,0.03)",
    surfaceBg: "rgba(255,215,64,0.03)", surfaceBorder: "rgba(255,215,64,0.10)",
    accentColor: "#ffd740", accentBg: "rgba(255,215,64,0.15)" },
  { id: "arctic",   label: "Arctic",   accent: "#b3e5fc",
    colorDark: "#b3e5fc", colorLight: "#01579b", alpha: 0.65, amplitude: 0.2, echo: 1.8,
    particleEnabled: true,  particleSpeed: 0.4, particleRate: 0.6, particleSparks: 1, particleAlpha: 0.5,
    appBg: "#060a0e", appText: "#e1f5fe",
    cardFloatBg: "rgba(179,229,252,0.04)", cardFloatBorder: "rgba(179,229,252,0.10)",
    cardFloatShadow: "0 2px 6px rgba(0,0,0,0.4), 0 6px 20px rgba(179,229,252,0.05), 0 0 0 0.5px rgba(179,229,252,0.08)",
    cardPressBg: "rgba(179,229,252,0.01)", cardPressBorder: "rgba(179,229,252,0.04)",
    cardPressShadow: "inset 0 2px 8px rgba(0,0,0,0.7), inset 0 0 12px rgba(179,229,252,0.03)",
    surfaceBg: "rgba(179,229,252,0.03)", surfaceBorder: "rgba(179,229,252,0.08)",
    accentColor: "#b3e5fc", accentBg: "rgba(179,229,252,0.12)" },
];

/** Parse a hex color like "#ff4081" into [r, g, b]. */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Apply a theme's UI surface colors as CSS custom properties on :root.
 *  Card shadows are NOT applied here — they are handled by CSS light/dark
 *  mode rules so the correct shadow intensity is always used.
 *  In light mode, derives a tinted background from the theme accent. */
export function applyThemeCssVars(theme: SignalTheme) {
  const s = document.documentElement.style;
  const isLight = document.documentElement.getAttribute("data-theme") === "light";

  if (isLight) {
    // Derive light-mode colors from the theme accent
    const [r, g, b] = hexToRgb(theme.accent);
    // Tinted white background (very subtle accent wash)
    s.setProperty("--app-bg", `rgb(${Math.round(245 + r * 0.04)}, ${Math.round(245 + g * 0.04)}, ${Math.round(245 + b * 0.04)})`);
    s.setProperty("--app-text", "#1a1a1a");
    s.setProperty("--card-float-bg", `rgba(255,255,255,0.97)`);
    s.setProperty("--card-float-border", `rgba(${r},${g},${b},0.12)`);
    s.setProperty("--card-press-bg", `rgba(${r},${g},${b},0.04)`);
    s.setProperty("--card-press-border", `rgba(${r},${g},${b},0.10)`);
    s.setProperty("--surface-bg", `rgba(${r},${g},${b},0.06)`);
    s.setProperty("--surface-border", `rgba(${r},${g},${b},0.10)`);
  } else {
    s.setProperty("--app-bg", theme.appBg);
    s.setProperty("--app-text", theme.appText);
    s.setProperty("--card-float-bg", theme.cardFloatBg);
    s.setProperty("--card-float-border", theme.cardFloatBorder);
    s.setProperty("--card-press-bg", theme.cardPressBg);
    s.setProperty("--card-press-border", theme.cardPressBorder);
    s.setProperty("--surface-bg", theme.surfaceBg);
    s.setProperty("--surface-border", theme.surfaceBorder);
  }
  s.setProperty("--accent", theme.accentColor);
  s.setProperty("--accent-bg", theme.accentBg);
}

export const TITLE_ANIMATIONS = [
  { id: "flip", label: "Rotate Flip" },
  { id: "ripple", label: "Ripple" },
  { id: "shine", label: "Shine" },
  { id: "glow", label: "Pulse Glow" },
  { id: "bounce", label: "Bounce" },
  { id: "none", label: "None" },
] as const;

export const ANIMATION_SPEEDS = [
  { id: 0.4, label: "Fast" },
  { id: 0.8, label: "Medium" },
  { id: 1.2, label: "Normal" },
  { id: 2.0, label: "Slow" },
  { id: 3.5, label: "Glacial" },
] as const;

export interface EnvironmentInfo {
  platform: string;
  desktopEnv: string | null;
  wayland: boolean;
  hasAppindicator: boolean;
  wslDistros: string[];
  claudeCodeFound: boolean;
  claudeSettingsExists: boolean;
}

/** State colors matching macOS app */
export const STATE_COLORS: Record<string, string> = {
  working: "text-white/80",
  waiting: "text-yellow-400",
  error: "text-red-500",
  subagent: "text-blue-400",
  idle: "text-gray-500",
  done: "text-green-500",
  ended: "text-red-400",
};

export const STATE_DOT_COLORS: Record<string, string> = {
  working: "bg-white/80",
  waiting: "bg-yellow-400",
  error: "bg-red-500",
  subagent: "bg-blue-400",
  idle: "bg-gray-500",
  done: "bg-green-500",
  ended: "bg-red-400",
};

export const STATE_BADGE_BG: Record<string, string> = {
  working: "bg-white/10 text-white/80",
  waiting: "bg-yellow-400/20 text-yellow-400",
  error: "bg-red-500/20 text-red-500",
  subagent: "bg-blue-400/20 text-blue-400",
  idle: "bg-gray-500/20 text-gray-500",
  done: "bg-green-500/20 text-green-500",
  ended: "bg-red-400/20 text-red-400",
};

/** Raw hex/rgba colors for inline styles (enables CSS transitions between states) */
export const STATE_HEX: Record<string, string> = {
  working: "rgba(255,255,255,0.8)",
  waiting: "#facc15",
  error: "#ef4444",
  subagent: "#60a5fa",
  idle: "#6b7280",
  done: "#22c55e",
  ended: "#f87171",
};

export const STATE_HEX_LIGHT: Record<string, string> = {
  working: "rgba(0,0,0,0.85)",
  waiting: "#a16207",
  error: "#dc2626",
  subagent: "#2563eb",
  idle: "#4b5563",
  done: "#16a34a",
  ended: "#dc2626",
};

export const STATE_DOT_HEX: Record<string, string> = {
  working: "#e0e0e0",
  waiting: "#facc15",
  error: "#ef4444",
  subagent: "#60a5fa",
  idle: "#6b7280",
  done: "#22c55e",
  ended: "#f87171",
};

export const STATE_DOT_HEX_LIGHT: Record<string, string> = {
  working: "#1a1a1a",
  waiting: "#ca8a04",
  error: "#dc2626",
  subagent: "#2563eb",
  idle: "#6b7280",
  done: "#16a34a",
  ended: "#dc2626",
};

export const STATE_BADGE_HEX: Record<string, { bg: string; text: string }> = {
  working: { bg: "rgba(255,255,255,0.1)", text: "rgba(255,255,255,0.8)" },
  waiting: { bg: "rgba(250,204,21,0.2)", text: "#facc15" },
  error: { bg: "rgba(239,68,68,0.2)", text: "#ef4444" },
  subagent: { bg: "rgba(96,165,250,0.2)", text: "#60a5fa" },
  idle: { bg: "rgba(107,114,128,0.2)", text: "#6b7280" },
  done: { bg: "rgba(34,197,94,0.2)", text: "#22c55e" },
  ended: { bg: "rgba(248,113,113,0.2)", text: "#f87171" },
};

export const STATE_BADGE_HEX_LIGHT: Record<string, { bg: string; text: string }> = {
  working: { bg: "rgba(0,0,0,0.08)", text: "rgba(0,0,0,0.85)" },
  waiting: { bg: "rgba(202,138,4,0.15)", text: "#a16207" },
  error: { bg: "rgba(220,38,38,0.12)", text: "#dc2626" },
  subagent: { bg: "rgba(37,99,235,0.12)", text: "#2563eb" },
  idle: { bg: "rgba(75,85,99,0.12)", text: "#4b5563" },
  done: { bg: "rgba(22,163,74,0.12)", text: "#16a34a" },
  ended: { bg: "rgba(220,38,38,0.12)", text: "#dc2626" },
};

// ---------------------------------------------------------------------------
// Permission Request types (for HTTP hook integration)
// ---------------------------------------------------------------------------

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  summary: string;
  hookEventName: string;
  receivedAt: number;
}

export type PermissionDecisionType = "allow" | "deny";

export interface PermissionLogEntry {
  timestamp: number;
  sessionId: string;
  toolName: string;
  toolInputSummary: string;
  decision: string;
}
