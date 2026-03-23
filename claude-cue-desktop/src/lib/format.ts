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
