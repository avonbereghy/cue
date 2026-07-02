import type { EnrichedSession } from "@/lib/types";
import { cacheBreakdown, configCountsTotal, usageSummary, usageDisplayStrings } from "@/lib/sessionCardModel";
import { formatTokens } from "@/lib/format";

// Quiet "reference detail" footer shared by all skin cards: the per-session
// usage line (est. cost · tokens · cache efficiency), the ≥85% cache breakdown,
// and the (beta) config-counts row. Account-wide 5h/weekly rate limits are
// shown once in the header/tray UsageStatus strip, not repeated per card.
// Palette comes in as CSS-var strings so it adopts whichever look it renders in.
export interface CardExtrasProps {
  session: EnrichedSession;
  showConfigCounts: boolean;
  showUsage: boolean;
  mono: string;
  muted: string;
  faint: string;
  rule: string;
}

export function CardExtras({ session, showConfigCounts, showUsage, mono, muted, faint, rule }: CardExtrasProps) {
  const cache = cacheBreakdown(session);
  const usage = usageSummary(session);
  const usageStrings = showUsage && usage.hasData ? usageDisplayStrings(usage) : null;
  const cfg = session.configCounts;
  const showCfg = showConfigCounts && !!cfg && configCountsTotal(session) > 0;
  if (!usageStrings && !cache.show && !showCfg) return null;

  return (
    <div style={{ position: "relative", zIndex: 1, marginTop: 10, paddingTop: 8, borderTop: `1px solid ${rule}`, fontFamily: mono, fontSize: 10, lineHeight: 1.6, color: faint, display: "flex", flexDirection: "column", gap: 6 }}>
      {usageStrings && (
        <div title={usageStrings.tooltip}>
          <span style={{ color: muted }}>Usage</span> {usageStrings.cost} · {usageStrings.tokens}
          {usageStrings.cached && ` · ${usageStrings.cached}`}
        </div>
      )}
      {cache.show && (
        <div>
          <span style={{ color: muted }}>Tokens</span> {formatTokens(cache.input)} input · {formatTokens(cache.cacheRead)} cache read · {formatTokens(cache.cacheWrite)} cache write
        </div>
      )}
      {showCfg && cfg && (
        <div>
          {[
            cfg.claudeMdCount > 0 ? `${cfg.claudeMdCount} CLAUDE.md` : null,
            cfg.rulesCount > 0 ? `${cfg.rulesCount} rules` : null,
            cfg.mcpServers > 0 ? `${cfg.mcpServers} MCP` : null,
            cfg.hooksCount > 0 ? `${cfg.hooksCount} hooks` : null,
          ].filter(Boolean).join(" · ")}
        </div>
      )}
    </div>
  );
}
