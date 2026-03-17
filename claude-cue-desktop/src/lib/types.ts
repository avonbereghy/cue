// TypeScript interfaces mirroring Rust models (camelCase via serde)

export interface SessionInfo {
  id: string;
  workspace: string;
  /** One of: "working", "waiting", "error", "subagent", "idle", "done" */
  state: string;
  lastActivity: number;
  startedAt: number;
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
}

/** Serde serializes (i64, i64) tuples as [number, number] arrays */
export type ModelTokens = Record<string, [number, number]>;

export interface WindowMetrics {
  inputTokens: number;
  outputTokens: number;
  sessionCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCounts: Record<string, number>;
  modelTokens: ModelTokens;
}

export interface Settings {
  fiveHourTokenLimit: number;
  dailyTokenLimit: number;
  weeklyTokenLimit: number;
  planPreset: string;
  onboardingComplete: boolean;
  permissionsEnabled: boolean;
}

export interface EnvironmentInfo {
  platform: string;
  desktopEnv: string | null;
  wayland: boolean;
  hasAppindicator: boolean;
  wslDistros: string[];
  claudeCodeFound: boolean;
  claudeSettingsExists: boolean;
}

export interface PlanPreset {
  name: string;
  displayName: string;
  limits: { fiveHour: number; daily: number; weekly: number };
}

export const PLAN_PRESETS: PlanPreset[] = [
  { name: "Custom", displayName: "Custom", limits: { fiveHour: 0, daily: 0, weekly: 0 } },
  { name: "Pro", displayName: "Pro ($20/mo)", limits: { fiveHour: 500_000, daily: 2_000_000, weekly: 10_000_000 } },
  { name: "MaxStandard", displayName: "Max ($100/mo)", limits: { fiveHour: 2_000_000, daily: 8_000_000, weekly: 40_000_000 } },
  { name: "MaxPlus", displayName: "Max ($200/mo)", limits: { fiveHour: 4_000_000, daily: 16_000_000, weekly: 80_000_000 } },
];

export const USAGE_WINDOWS = ["Session (5hr)", "Today", "This Week"] as const;
export type UsageWindowName = (typeof USAGE_WINDOWS)[number];

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
