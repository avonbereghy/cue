import type { EnrichedSession } from "@/lib/types";
import { cacheBreakdown, configCountsTotal, rateLimitColor } from "@/lib/sessionCardModel";
import { formatTokens } from "@/lib/format";

// Quiet "reference detail" footer shared by all skin cards: the ≥85% cache
// breakdown, statusline rate-limit bars, and the (beta) config-counts row.
// Palette comes in as CSS-var strings so it adopts whichever look it renders in.
export interface CardExtrasProps {
  session: EnrichedSession;
  showConfigCounts: boolean;
  mono: string;
  muted: string;
  faint: string;
  rule: string;
}

export function CardExtras({ session, showConfigCounts, mono, muted, faint, rule }: CardExtrasProps) {
  const cache = cacheBreakdown(session);
  const rl = session.rateLimits;
  const showRl = !!rl && (rl.fiveHourPercent > 0 || rl.sevenDayPercent > 0);
  const cfg = session.configCounts;
  const showCfg = showConfigCounts && !!cfg && configCountsTotal(session) > 0;
  if (!cache.show && !showRl && !showCfg) return null;

  const bar = (label: string, pct: number) => {
    const fill = rateLimitColor(pct) ?? muted;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 16, color: faint, flex: "0 0 auto" }}>{label}</span>
        <div style={{ flex: "1 1 auto", height: 3, borderRadius: 2, background: rule, overflow: "hidden", minWidth: 36 }}>
          <div style={{ width: `${Math.min(pct, 100)}%`, height: "100%", background: fill, opacity: 0.85 }} />
        </div>
        <span style={{ color: muted, fontVariantNumeric: "tabular-nums", flex: "0 0 auto" }}>{Math.round(pct)}%</span>
      </div>
    );
  };

  return (
    <div style={{ position: "relative", zIndex: 1, marginTop: 10, paddingTop: 8, borderTop: `1px solid ${rule}`, fontFamily: mono, fontSize: 10, lineHeight: 1.6, color: faint, display: "flex", flexDirection: "column", gap: 6 }}>
      {cache.show && (
        <div>
          <span style={{ color: muted }}>Tokens</span> {formatTokens(cache.input)} input · {formatTokens(cache.cacheRead)} cache read · {formatTokens(cache.cacheWrite)} cache write
        </div>
      )}
      {showRl && rl && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {rl.fiveHourPercent > 0 && bar("5h", rl.fiveHourPercent)}
          {rl.sevenDayPercent > 0 && bar("7d", rl.sevenDayPercent)}
          {rl.limitReached && <span style={{ color: "#ef4444" }}>Limit reached</span>}
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
