/** Port of Swift Format enum */

export function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) {
    const k = count / 1000;
    return k === Math.floor(k) ? `${k}K` : `${k.toFixed(1)}K`;
  }
  const m = count / 1_000_000;
  return m === Math.floor(m) ? `${m}M` : `${m.toFixed(1)}M`;
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
  if (usd < 0.01) return "$0.00";
  return `$${usd.toFixed(2)}`;
}

/** Estimate cost from model_tokens map */
export function estimateCost(modelTokens: Record<string, [number, number]>): number {
  let cost = 0;
  for (const [model, [input, output]] of Object.entries(modelTokens)) {
    const pricing = modelPricing(model);
    cost += input * pricing.inputPerToken;
    cost += output * pricing.outputPerToken;
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

function modelPricing(model: string): { inputPerToken: number; outputPerToken: number } {
  const m = model.toLowerCase();
  if (m.includes("opus")) {
    return { inputPerToken: 15.0 / 1_000_000, outputPerToken: 75.0 / 1_000_000 };
  }
  if (m.includes("sonnet")) {
    return { inputPerToken: 3.0 / 1_000_000, outputPerToken: 15.0 / 1_000_000 };
  }
  if (m.includes("haiku")) {
    return { inputPerToken: 0.80 / 1_000_000, outputPerToken: 4.0 / 1_000_000 };
  }
  return { inputPerToken: 3.0 / 1_000_000, outputPerToken: 15.0 / 1_000_000 };
}
