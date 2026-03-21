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
  activePresetId: string;
  testMode: boolean;
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
  working: "text-white",
  waiting: "text-yellow-400",
  error: "text-red-500",
  subagent: "text-cyan-400",
  idle: "text-gray-500",
  done: "text-green-500",
};

export const STATE_DOT_COLORS: Record<string, string> = {
  working: "bg-white",
  waiting: "bg-yellow-400",
  error: "bg-red-500",
  subagent: "bg-cyan-400",
  idle: "bg-gray-500",
  done: "bg-green-500",
};

export const STATE_BADGE_BG: Record<string, string> = {
  working: "bg-white/20 text-white",
  waiting: "bg-yellow-400/20 text-yellow-400",
  error: "bg-red-500/20 text-red-500",
  subagent: "bg-cyan-400/20 text-cyan-400",
  idle: "bg-gray-500/20 text-gray-500",
  done: "bg-green-500/20 text-green-500",
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
