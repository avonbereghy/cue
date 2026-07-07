/** Port of Swift Format enum */

export function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  // Boundaries are set just below each 1000× mark so a value that would round
  // UP to "1000.0K" (e.g. 999_950) rolls into the next unit as "1.0M" instead.
  if (count < 999_950) {
    const k = count / 1000;
    return k === Math.floor(k) ? `${k}K` : `${k.toFixed(1)}K`;
  }
  if (count < 999_950_000) {
    const m = count / 1_000_000;
    return m === Math.floor(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  const b = count / 1_000_000_000;
  return b === Math.floor(b) ? `${b}B` : `${b.toFixed(1)}B`;
}

export function formatDuration(secs: number): string {
  const total = Math.max(0, Math.floor(secs));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Clock-style HH:MM:SS for a Unix timestamp (seconds). */
export function formatClockTime(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/** Compact elapsed between two Unix timestamps: "12s" / "2m14s" / "1h03m". */
export function formatElapsedCompact(startSecs: number, endSecs: number): string {
  const total = Math.max(0, Math.floor(endSecs - startSecs));
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  const s = total % 60;
  if (mins < 60) return `${mins}m${String(s).padStart(2, "0")}s`;
  const hrs = Math.floor(mins / 60);
  const m = mins % 60;
  return `${hrs}h${String(m).padStart(2, "0")}m`;
}

export function formatCost(usd: number): string {
  if (usd <= 0) return "$0.00";
  // Non-zero-but-tiny must not read as free — a cheap turn is "<$0.01", not "$0.00".
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Month the hardcoded price table was last verified. Shown in the est.-cost
 *  tooltip so a stale table stays honest — Cue makes no network calls, so
 *  prices can only be updated by shipping a new build. */
export const PRICE_TABLE_ASOF = "2026-07";

/** A model's token usage split into the four billable buckets. */
export interface ModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Estimate cost (USD) from a per-model usage map. Cache-aware: cache reads and
 * writes are billed at their own tiers (0.1× and 1.25× the fresh-input rate),
 * so a heavily-cached session — where reads dwarf fresh input — isn't wildly
 * over-counted the way a flat input rate would. Approximate by construction:
 * hardcoded prices (see PRICE_TABLE_ASOF), no 1M-context request premium.
 */
export function estimateCost(modelUsage: Record<string, ModelUsage>): number {
  let cost = 0;
  for (const [model, u] of Object.entries(modelUsage)) {
    const p = modelPricing(model);
    cost += u.input * p.inputPerToken;
    cost += u.output * p.outputPerToken;
    cost += u.cacheRead * p.cacheReadPerToken;
    cost += u.cacheWrite * p.cacheWritePerToken;
  }
  return cost;
}

export function formatModelName(model: string): string {
  if (model === "unknown" || !model) return "\u2014";
  const cleaned = model.replace("claude-", "");
  const parts = cleaned.split("-");
  if (parts.length >= 3) {
    const modelName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    const version = parts.slice(1).join(".");
    return `${modelName} ${version}`;
  }
  return model;
}

/**
 * Strip Claude Code slash-command wrapper tags from a prompt-like string.
 * Claude Code represents slash commands in JSONL user messages as:
 *   <command-message>name</command-message>
 *   <command-name>/name</command-name>
 *   <command-args>args...</command-args>
 * Collapses the wrapper to a single readable line: "/name args..." when
 * tags are detected, otherwise returns the input unchanged. Runs on every
 * display site (the snippet pill, tray preview, popup) as a belt-and-
 * suspenders defense — the backend also strips, but this guarantees the
 * tags never survive to the UI even if the backend pipeline changes.
 */
export function cleanPromptText(text: string | null | undefined): string {
  if (!text) return "";
  if (!text.includes("<command-")) return text;
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim() ?? "";
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? "";
  const collapsed = [name, args].filter(Boolean).join(" ").trim();
  if (collapsed) return collapsed;
  return text.replace(/<\/?command-(?:message|name|args)>/g, "").replace(/\s+/g, " ").trim();
}

const ERROR_TYPE_LABELS: Record<string, string> = {
  rate_limit: "Rate limited",
  billing_error: "Billing problem",
  authentication_failed: "Authentication failed",
  oauth_org_not_allowed: "Org not allowed",
  server_error: "Server error",
  model_not_found: "Model unavailable",
  max_output_tokens: "Hit max output length",
  invalid_request: "Invalid request",
  overloaded: "Service overloaded",
};

/**
 * Human-readable reason for an error-state session. Prefers the actual error
 * message captured from the transcript; otherwise falls back to a friendly
 * label for the error category, then the raw category. Returns null when
 * there's nothing to show, so callers can decide whether to render anything.
 */
export function errorReason(
  errorType?: string | null,
  message?: string | null,
): string | null {
  const msg = message?.trim();
  if (msg) return msg;
  if (errorType) return ERROR_TYPE_LABELS[errorType] ?? errorType.replace(/_/g, " ");
  return null;
}

// --- Per-project color accents -------------------------------------------
// A muted accent color per project (keyed on the workspace path). Same project
// → same color; different projects spread maximally far apart so they read as
// distinct at a glance. Hues are confined to windows that can NEVER collide
// with a status color (working/thinking/waiting/error/subagent/compacting/
// clearing/done) or the rate-limit bars — so the left-edge accent and the
// state color stay separate channels. Colors are assigned by order of first
// appearance and are stable for the lifetime of the session.
const ACCENT_HUE_WINDOWS: [number, number][] = [
  [70, 118], // chartreuse → lime (clear of yellow ~50, green ~142)
  [160, 196], // teal → cyan (clear of green ~142, subagent ~205)
  [250, 278], // indigo → violet (clear of periwinkle ~228, rate-limit magenta ~292)
  [330, 352], // rose (clear of clearing ~315, error ~0)
];
const ACCENT_SPAN = ACCENT_HUE_WINDOWS.reduce((sum, [lo, hi]) => sum + (hi - lo), 0);
// Golden-ratio conjugate: an additive recurrence that equidistributes
// sequential indices, so the Nth project lands as far as possible from the rest.
const GOLDEN_RATIO_CONJ = 0.618033988749895;

// Map a position in [0, ACCENT_SPAN) into the concatenated safe hue windows.
function accentSpanToHue(pos: number): number {
  let p = ((pos % ACCENT_SPAN) + ACCENT_SPAN) % ACCENT_SPAN;
  for (const [lo, hi] of ACCENT_HUE_WINDOWS) {
    const width = hi - lo;
    if (p < width) return lo + p;
    p -= width;
  }
  return ACCENT_HUE_WINDOWS[0][0]; // unreachable: p < ACCENT_SPAN by construction
}

const accentIndex = new Map<string, number>();
const accentCache = new Map<string, string>();

export function getProjectAccent(workspace: string, isDark: boolean): string {
  const key = `${workspace}|${isDark ? "d" : "l"}`;
  const cached = accentCache.get(key);
  if (cached) return cached;
  let idx = accentIndex.get(workspace);
  if (idx === undefined) {
    idx = accentIndex.size;
    accentIndex.set(workspace, idx);
  }
  const hue = Math.round(accentSpanToHue(idx * GOLDEN_RATIO_CONJ * ACCENT_SPAN));
  const color = isDark ? `hsl(${hue}, 38%, 62%)` : `hsl(${hue}, 46%, 42%)`;
  accentCache.set(key, color);
  return color;
}

// Test-only: reset the per-session accent assignment.
export function __resetProjectAccents(): void {
  accentIndex.clear();
  accentCache.clear();
}

export interface ModelPricing {
  inputPerToken: number;
  outputPerToken: number;
  cacheReadPerToken: number;
  cacheWritePerToken: number;
}

/** Per-token USD pricing for a model. Base input/output rates are per family;
 *  the cache tiers follow Anthropic's standard multipliers off the base input
 *  rate (read = 0.1×, 5-minute write = 1.25×). Prices are approximate and
 *  hardcoded — see PRICE_TABLE_ASOF. Unknown models fall back to Sonnet-tier. */
function modelPricing(model: string): ModelPricing {
  const m = model.toLowerCase();
  const tier = (inputPerMTok: number, outputPerMTok: number): ModelPricing => {
    const inputPerToken = inputPerMTok / 1_000_000;
    return {
      inputPerToken,
      outputPerToken: outputPerMTok / 1_000_000,
      cacheReadPerToken: inputPerToken * 0.1,
      cacheWritePerToken: inputPerToken * 1.25,
    };
  };
  if (m.includes("opus")) return tier(15.0, 75.0);
  if (m.includes("sonnet")) return tier(3.0, 15.0);
  if (m.includes("haiku")) return tier(0.8, 4.0);
  return tier(3.0, 15.0); // unknown / new family → Sonnet-tier estimate
}
