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
  /** Subprocess label if spawned by a known caller (e.g. "retenir"). */
  subprocess?: string;
  /** Team name if this session was spawned as a team agent. */
  teamName?: string;
  /** Agent name within the team (e.g. "code-reviewer"). */
  agentName?: string;
  /** PID of the owning Claude Code process — used by backend liveness check. */
  pid?: number;
  /** Most recent Claude Code permission mode seen by the hook.
   *  "default" | "plan" | "acceptEdits" | "bypassPermissions". */
  permissionMode?: string;
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
  /** Unix timestamp (seconds) of the first JSONL entry — agent start. */
  startedAt?: number | null;
  /** Unix timestamp (seconds) of the last JSONL entry. For active agents this
   *  is the most recent activity; for completed agents it's the end time. */
  endedAt?: number | null;
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
  lastPrompt?: string | null;
  /** Session ID extracted from the JSONL metadata header — used to verify the prompt belongs to this session */
  lastPromptSessionId?: string | null;
  /** First non-empty text block from the most recent assistant message.
   *  Used as a pill cue on idle/done cards that share a workspace. */
  lastAssistantText?: string | null;
  /** Team name from JSONL (team agent sessions) */
  teamName?: string | null;
  /** Agent name from JSONL (team agent sessions) */
  agentName?: string | null;
  /** Parent session ID when this session was forked via Claude Code's branch/fork feature.
   *  When set, UI renders "Branch from <id>" as the subtitle. */
  branchedFromSessionId?: string | null;
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
  totalDurationSecs: number;
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
  /** Current effort level ("low" | "medium" | "high" | "xhigh" | "max" | "auto" | future values).
   *  Passed through verbatim from Claude Code so new level names surface without a Cue update. */
  effortLevel?: string;
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
  /** Visual effect mode: "string" (waveform lines) or "sand" (blown grains) */
  signalEffect: string;
  sandEnabled: boolean;
  sandIntensity: number;
  sandDirection: number;
  sandDensity: number;
  sandSpeed: number;
  sandGrainSize: number;
  sandTurbulence: number;
  sandAlpha: number;
  /** Flux streamline effect (thinking state) */
  fluxEnabled: boolean;
  fluxAlpha: number;
  fluxIntensity: number;
  fluxDensity: number;
  fluxSpeed: number;
  fluxLineLength: number;
  fluxTurbulence: number;
  /** Aurora wash effect (done state) */
  auroraEnabled: boolean;
  auroraAlpha: number;
  auroraSpeed: number;
  cordRetractDelay: number;
  cordDeployForce: number;
  cordRetractForce: number;
  stringSpread: number;
  /** Deploy angle in degrees — tilt of working strings around card center */
  stringDeployAngle: number;
  keyPressSpeed: number;
  keyReleaseSpeed: number;
  autoReorder: boolean;
  fontScale: number;
  testMode: boolean;
  compactMode: boolean;
  slimMode: boolean;
  /** Context bar visibility: "always", "never", or "after200k" */
  contextThreshold: string;
  /** Context display mode: "percent", "tokens", "remaining", or "both" */
  contextDisplay: string;
  /** Low power mode: disables animations, signal strings, sand, backdrop-filter */
  lowPower: boolean;
  /** Beta: show per-tool usage pills in detail mode */
  showToolPills: boolean;
  /** Beta: show current running tool name in header */
  showCurrentTool: boolean;
  /** Beta: show config counts (CLAUDE.md, hooks, MCP) in detail mode */
  showConfigCounts: boolean;
  /** Show comet tracers on the strings whenever a tool call fires. Off by default. */
  showToolCallComets: boolean;
  /** Timer display: "minutes" (HH:MM), "seconds" (HH:MM:SS), or "off" */
  timerDisplay: string;
  /** Show the system tray icon in the menu bar. Default: true. */
  showInMenuBar: boolean;
  /** Menu bar icon style: "default" (dot grid) or "clock" (12-wedge clock). */
  menuBarStyle: string;
  /** Show the app in the macOS Dock / OS taskbar. Default: true. */
  showInDock: boolean;
  /** Launch Cue automatically at login. Default: true. */
  startAtLogin: boolean;
  /** Per-theme appearance customizations saved by the user, keyed by theme ID */
  themeCustomizations: Record<string, ThemeCustomization>;
}

export interface ThemeCustomization {
  signalColorDark: string;
  signalColorLight: string;
  signalAlpha: number;
  signalAmplitude: number;
  signalEcho: number;
  signalEffect: string;
  sandEnabled: boolean;
  sandIntensity: number;
  sandDirection: number;
  sandDensity: number;
  sandSpeed: number;
  sandGrainSize: number;
  sandTurbulence: number;
  sandAlpha: number;
  fluxEnabled?: boolean;
  fluxAlpha?: number;
  fluxIntensity?: number;
  fluxDensity?: number;
  fluxSpeed?: number;
  fluxLineLength?: number;
  fluxTurbulence?: number;
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
  /** Default visual effect for this theme: "string" or "sand" */
  signalEffect: string;
  sandEnabled: boolean;
  sandIntensity: number;
  sandDirection: number;
  sandDensity: number;
  sandSpeed: number;
  sandGrainSize: number;
  sandTurbulence: number;
  sandAlpha: number;
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

// Sand defaults per-theme: effect, enabled, intensity, direction, density, speed, grainSize, turbulence, alpha.
// Direction -60° → wind points down-left at a steeper angle; moderate
// turbulence gives the grain paths a swirling feel while still biased downward.
const SAND_OFF = { signalEffect: "string" as const, sandEnabled: false, sandIntensity: 1.51, sandDirection: -60, sandDensity: 2.0, sandSpeed: 0.26, sandGrainSize: 0.4, sandTurbulence: 0.9, sandAlpha: 0.7 };
const SAND_ON  = (overrides: Partial<typeof SAND_OFF> = {}) => ({ ...SAND_OFF, signalEffect: "string" as const, sandEnabled: true, ...overrides });

export const SIGNAL_THEMES: SignalTheme[] = [
  // --- Essentials ---
  { id: "default",  label: "Default",  accent: "#ffffff",
    colorDark: "#ffffff", colorLight: "#000000", alpha: 0.75, amplitude: 0.10, echo: 1.50,
    ...SAND_OFF,
    ...DARK_SURFACES, accentColor: "#3b82f6", accentBg: "rgba(59,130,246,0.15)" },
  { id: "minimal",  label: "Minimal",  accent: "#888888",
    colorDark: "#ffffff", colorLight: "#000000", alpha: 0.5, amplitude: 0.15, echo: 0.3,
    ...SAND_OFF,
    ...DARK_SURFACES, accentColor: "#9ca3af", accentBg: "rgba(156,163,175,0.12)" },
  // --- Vivid ---
  { id: "neon",     label: "Neon",     accent: "#00e5ff",
    colorDark: "#00e5ff", colorLight: "#0097a7", alpha: 0.75, amplitude: 0.4, echo: 1.8,
    ...SAND_ON(),
    appBg: "#060d10", appText: "#e0f7fa",
    cardFloatBg: "rgba(0,229,255,0.06)", cardFloatBorder: "rgba(0,229,255,0.15)",
    cardFloatShadow: "0 2px 8px rgba(0,0,0,0.4), 0 8px 24px rgba(0,229,255,0.08), 0 0 0 0.5px rgba(0,229,255,0.12)",
    cardPressBg: "rgba(0,229,255,0.02)", cardPressBorder: "rgba(0,229,255,0.06)",
    cardPressShadow: "inset 0 2px 8px rgba(0,0,0,0.7), inset 0 0 12px rgba(0,229,255,0.05)",
    surfaceBg: "rgba(0,229,255,0.04)", surfaceBorder: "rgba(0,229,255,0.12)",
    accentColor: "#00e5ff", accentBg: "rgba(0,229,255,0.15)" },
  { id: "ember",    label: "Ember",    accent: "#ffab00",
    colorDark: "#ffab00", colorLight: "#e65100", alpha: 0.75, amplitude: 0.3, echo: 1.2,
    ...SAND_ON(),
    appBg: "#100a04", appText: "#fff3e0",
    cardFloatBg: "rgba(255,171,0,0.05)", cardFloatBorder: "rgba(255,171,0,0.12)",
    cardFloatShadow: "0 2px 6px rgba(0,0,0,0.4), 0 6px 20px rgba(255,171,0,0.06), 0 0 0 0.5px rgba(255,171,0,0.10)",
    cardPressBg: "rgba(255,171,0,0.02)", cardPressBorder: "rgba(255,171,0,0.05)",
    cardPressShadow: "inset 0 2px 8px rgba(0,0,0,0.7), inset 0 0 12px rgba(255,171,0,0.04)",
    surfaceBg: "rgba(255,171,0,0.04)", surfaceBorder: "rgba(255,171,0,0.10)",
    accentColor: "#ffab00", accentBg: "rgba(255,171,0,0.15)" },
  { id: "pulse",    label: "Pulse",    accent: "#ff4081",
    colorDark: "#ff4081", colorLight: "#c2185b", alpha: 0.75, amplitude: 0.6, echo: 0.6,
    ...SAND_ON(),
    appBg: "#0e060a", appText: "#fce4ec",
    cardFloatBg: "rgba(255,64,129,0.05)", cardFloatBorder: "rgba(255,64,129,0.14)",
    cardFloatShadow: "0 2px 6px rgba(0,0,0,0.4), 0 6px 20px rgba(255,64,129,0.06), 0 0 0 0.5px rgba(255,64,129,0.10)",
    cardPressBg: "rgba(255,64,129,0.02)", cardPressBorder: "rgba(255,64,129,0.05)",
    cardPressShadow: "inset 0 2px 8px rgba(0,0,0,0.7), inset 0 0 12px rgba(255,64,129,0.04)",
    surfaceBg: "rgba(255,64,129,0.04)", surfaceBorder: "rgba(255,64,129,0.10)",
    accentColor: "#ff4081", accentBg: "rgba(255,64,129,0.15)" },
  { id: "aurora",   label: "Aurora",   accent: "#00e676",
    colorDark: "#00e676", colorLight: "#2e7d32", alpha: 0.75, amplitude: 0.35, echo: 2.0,
    ...SAND_ON(),
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
    ...SAND_ON(),
    appBg: "#0a060e", appText: "#ede7f6",
    cardFloatBg: "rgba(179,136,255,0.04)", cardFloatBorder: "rgba(179,136,255,0.10)",
    cardFloatShadow: "0 2px 6px rgba(0,0,0,0.4), 0 6px 20px rgba(179,136,255,0.05), 0 0 0 0.5px rgba(179,136,255,0.08)",
    cardPressBg: "rgba(179,136,255,0.01)", cardPressBorder: "rgba(179,136,255,0.04)",
    cardPressShadow: "inset 0 2px 8px rgba(0,0,0,0.7), inset 0 0 12px rgba(179,136,255,0.03)",
    surfaceBg: "rgba(179,136,255,0.03)", surfaceBorder: "rgba(179,136,255,0.08)",
    accentColor: "#b388ff", accentBg: "rgba(179,136,255,0.15)" },
  { id: "midnight", label: "Midnight", accent: "#448aff",
    colorDark: "#448aff", colorLight: "#1a237e", alpha: 0.75, amplitude: 0.3, echo: 1.8,
    ...SAND_ON(),
    appBg: "#060810", appText: "#e8eaf6",
    cardFloatBg: "rgba(68,138,255,0.05)", cardFloatBorder: "rgba(68,138,255,0.12)",
    cardFloatShadow: "0 2px 6px rgba(0,0,0,0.4), 0 6px 20px rgba(68,138,255,0.06), 0 0 0 0.5px rgba(68,138,255,0.10)",
    cardPressBg: "rgba(68,138,255,0.02)", cardPressBorder: "rgba(68,138,255,0.05)",
    cardPressShadow: "inset 0 2px 8px rgba(0,0,0,0.7), inset 0 0 12px rgba(68,138,255,0.04)",
    surfaceBg: "rgba(68,138,255,0.04)", surfaceBorder: "rgba(68,138,255,0.10)",
    accentColor: "#448aff", accentBg: "rgba(68,138,255,0.15)" },
  { id: "crimson",  label: "Crimson",  accent: "#ff1744",
    colorDark: "#ff1744", colorLight: "#b71c1c", alpha: 0.75, amplitude: 0.45, echo: 0.8,
    ...SAND_ON(),
    appBg: "#0e0406", appText: "#ffebee",
    cardFloatBg: "rgba(255,23,68,0.05)", cardFloatBorder: "rgba(255,23,68,0.14)",
    cardFloatShadow: "0 2px 6px rgba(0,0,0,0.4), 0 6px 20px rgba(255,23,68,0.06), 0 0 0 0.5px rgba(255,23,68,0.10)",
    cardPressBg: "rgba(255,23,68,0.02)", cardPressBorder: "rgba(255,23,68,0.05)",
    cardPressShadow: "inset 0 2px 8px rgba(0,0,0,0.7), inset 0 0 12px rgba(255,23,68,0.04)",
    surfaceBg: "rgba(255,23,68,0.04)", surfaceBorder: "rgba(255,23,68,0.10)",
    accentColor: "#ff1744", accentBg: "rgba(255,23,68,0.15)" },
  { id: "solar",    label: "Solar",    accent: "#ffd740",
    colorDark: "#ffd740", colorLight: "#f57f17", alpha: 0.75, amplitude: 0.35, echo: 1.4,
    ...SAND_ON(),
    appBg: "#0e0c04", appText: "#fffde7",
    cardFloatBg: "rgba(255,215,64,0.04)", cardFloatBorder: "rgba(255,215,64,0.12)",
    cardFloatShadow: "0 2px 6px rgba(0,0,0,0.4), 0 6px 20px rgba(255,215,64,0.06), 0 0 0 0.5px rgba(255,215,64,0.10)",
    cardPressBg: "rgba(255,215,64,0.01)", cardPressBorder: "rgba(255,215,64,0.04)",
    cardPressShadow: "inset 0 2px 8px rgba(0,0,0,0.7), inset 0 0 12px rgba(255,215,64,0.03)",
    surfaceBg: "rgba(255,215,64,0.03)", surfaceBorder: "rgba(255,215,64,0.10)",
    accentColor: "#ffd740", accentBg: "rgba(255,215,64,0.15)" },
  { id: "arctic",   label: "Arctic",   accent: "#b3e5fc",
    colorDark: "#b3e5fc", colorLight: "#01579b", alpha: 0.65, amplitude: 0.2, echo: 1.8,
    ...SAND_ON(),
    appBg: "#060a0e", appText: "#e1f5fe",
    cardFloatBg: "rgba(179,229,252,0.04)", cardFloatBorder: "rgba(179,229,252,0.10)",
    cardFloatShadow: "0 2px 6px rgba(0,0,0,0.4), 0 6px 20px rgba(179,229,252,0.05), 0 0 0 0.5px rgba(179,229,252,0.08)",
    cardPressBg: "rgba(179,229,252,0.01)", cardPressBorder: "rgba(179,229,252,0.04)",
    cardPressShadow: "inset 0 2px 8px rgba(0,0,0,0.7), inset 0 0 12px rgba(179,229,252,0.03)",
    surfaceBg: "rgba(179,229,252,0.03)", surfaceBorder: "rgba(179,229,252,0.08)",
    accentColor: "#b3e5fc", accentBg: "rgba(179,229,252,0.12)" },
  // --- Special ---
  { id: "glass",    label: "Glass", accent: "#c0c0c0",
    colorDark: "#ffffff", colorLight: "#333333", alpha: 0.35, amplitude: 0.18, echo: 1.2,
    ...SAND_OFF,
    appBg: "transparent", appText: "rgba(255,255,255,0.95)",
    cardFloatBg: "rgba(255,255,255,0.08)", cardFloatBorder: "rgba(255,255,255,0.25)",
    cardFloatShadow: "none",
    cardPressBg: "rgba(255,255,255,0.04)", cardPressBorder: "rgba(255,255,255,0.15)",
    cardPressShadow: "none",
    surfaceBg: "rgba(255,255,255,0.06)", surfaceBorder: "rgba(255,255,255,0.12)",
    accentColor: "#ffffff", accentBg: "rgba(255,255,255,0.12)" },
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

  if (isLight && theme.id !== "glass") {
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

  // Toggle glass mode attribute for CSS-only frosted effects
  const isGlass = theme.id === "glass";
  if (isGlass) {
    document.documentElement.setAttribute("data-glass", "");
  } else {
    document.documentElement.removeAttribute("data-glass");
  }

  // Note: native macOS vibrancy is toggled by the Rust update_settings
  // command when activeThemeId changes. Do NOT call set_vibrancy here —
  // it runs toggle_vibrancy on every settings save, which resets the
  // window theme and causes light/dark mode flicker.
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
  thinking: "text-orange-400",
  waiting: "text-yellow-400",
  error: "text-red-500",
  subagent: "text-[#7CC5FF]",
  compacting: "text-[#8B9FD4]",
  clearing: "text-[#C490B4]",
  idle: "text-amber-300",
  done: "text-green-500",
  ended: "text-red-400",
};

export const STATE_DOT_COLORS: Record<string, string> = {
  working: "bg-white/80",
  thinking: "bg-orange-400",
  waiting: "bg-yellow-400",
  error: "bg-red-500",
  subagent: "bg-[#9FD8FF]",
  compacting: "bg-[#9CAEE0]",
  clearing: "bg-[#D4A0C4]",
  idle: "bg-amber-300",
  done: "bg-green-500",
  ended: "bg-red-400",
};

export const STATE_BADGE_BG: Record<string, string> = {
  working: "bg-white/10 text-white/80",
  thinking: "bg-orange-400/20 text-orange-400",
  waiting: "bg-yellow-400/20 text-yellow-400",
  error: "bg-red-500/20 text-red-500",
  subagent: "bg-[#7CC5FF]/20 text-[#7CC5FF]",
  compacting: "bg-[#8B9FD4]/20 text-[#8B9FD4]",
  clearing: "bg-[#C490B4]/20 text-[#C490B4]",
  idle: "bg-amber-300/20 text-amber-300",
  done: "bg-green-500/20 text-green-500",
  ended: "bg-red-400/20 text-red-400",
};

/** Raw hex/rgba colors for inline styles (enables CSS transitions between states) */
export const STATE_HEX: Record<string, string> = {
  working: "rgba(255,255,255,0.8)",
  thinking: "#f6a560",
  waiting: "#facc15",
  error: "#ef4444",
  subagent: "#7CC5FF",
  compacting: "#8B9FD4",
  clearing: "#C490B4",
  idle: "#d4a574",
  done: "#22c55e",
  ended: "#f87171",
};

export const STATE_HEX_LIGHT: Record<string, string> = {
  working: "#374151",
  thinking: "#c2410c",
  waiting: "#b45309",
  error: "#b91c1c",
  subagent: "#2A8BD9",
  compacting: "#4A5FA0",
  clearing: "#8B4A70",
  idle: "#78716c",
  done: "#15803d",
  ended: "#b91c1c",
};

export const STATE_DOT_HEX: Record<string, string> = {
  working: "#e0e0e0",
  thinking: "#f6a560",
  waiting: "#facc15",
  error: "#ef4444",
  subagent: "#9FD8FF",
  compacting: "#9CAEE0",
  clearing: "#D4A0C4",
  idle: "#d4a574",
  done: "#22c55e",
  ended: "#f87171",
};

export const STATE_DOT_HEX_LIGHT: Record<string, string> = {
  working: "#374151",
  thinking: "#ea580c",
  waiting: "#b45309",
  error: "#dc2626",
  subagent: "#2A8BD9",
  compacting: "#4A5FA0",
  clearing: "#8B4A70",
  idle: "#a8a29e",
  done: "#16a34a",
  ended: "#dc2626",
};

export const STATE_BADGE_HEX: Record<string, { bg: string; text: string }> = {
  working:    { bg: "#2a2a2a", text: "rgba(255,255,255,0.85)" },
  thinking:   { bg: "#3d2a1a", text: "#f6a560" },
  waiting:    { bg: "#3d3410", text: "#facc15" },
  error:      { bg: "#3d1515", text: "#ef4444" },
  subagent:   { bg: "#153044", text: "#7CC5FF" },
  compacting: { bg: "#26293d", text: "#8B9FD4" },
  clearing:   { bg: "#3a2631", text: "#C490B4" },
  idle:       { bg: "#332921", text: "#d4a574" },
  done:       { bg: "#133d1f", text: "#22c55e" },
  ended:      { bg: "#3d1a1a", text: "#f87171" },
};

export const STATE_BADGE_HEX_LIGHT: Record<string, { bg: string; text: string }> = {
  working:    { bg: "#e5e7eb", text: "#374151" },
  thinking:   { bg: "#fde4cc", text: "#c2410c" },
  waiting:    { bg: "#fef3c7", text: "#b45309" },
  error:      { bg: "#fecaca", text: "#b91c1c" },
  subagent:   { bg: "#d1e9ff", text: "#2A8BD9" },
  compacting: { bg: "#dbe0f0", text: "#4A5FA0" },
  clearing:   { bg: "#f0d9e4", text: "#8B4A70" },
  idle:       { bg: "#e7e5e4", text: "#78716c" },
  done:       { bg: "#d1fae5", text: "#15803d" },
  ended:      { bg: "#fecaca", text: "#b91c1c" },
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
