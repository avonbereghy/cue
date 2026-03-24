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
  vineBorder: boolean;
  compactMode: boolean;
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
  working: "rgba(255,255,255,0.8)",
  waiting: "#facc15",
  error: "#ef4444",
  subagent: "#60a5fa",
  idle: "#6b7280",
  done: "#22c55e",
  ended: "#f87171",
};

export const STATE_DOT_HEX_LIGHT: Record<string, string> = {
  working: "rgba(0,0,0,0.7)",
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
