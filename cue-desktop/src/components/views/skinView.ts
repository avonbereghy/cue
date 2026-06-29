// Shared props contract for the alternative dashboard "Look" views (Almanac,
// Night Study, Studio Paper). SessionsTab prepares all of this once and hands
// the same bundle to whichever skin is active, so parity stays uniform.

import type { EnrichedSession, PermissionRequest } from "@/lib/types";

export interface RevivedEntry {
  session: EnrichedSession;
  revivedAt: number;
}

export interface SkinViewProps {
  /** Active sessions + team children, already sorted (instrument's order). */
  sessions: EnrichedSession[];
  revivedSessions: RevivedEntry[];
  /** Sessions tucked into the recoverable "Resting" group — auto-hidden after
   *  sitting idle, or manually dismissed. Shown in a collapsed disclosure, one
   *  click to restore. */
  restingSessions: EnrichedSession[];
  permissionsEnabled: boolean;
  pendingBySession: Record<string, PermissionRequest[]>;
  approvePermission: (sessionId: string, requestId: string) => void;
  denyPermission: (sessionId: string, requestId: string) => void;
  timerDisplay: string;
  /** Beta setting — show the Claude config-counts row (CLAUDE.md / rules / MCP / hooks). */
  showConfigCounts: boolean;
  /** dashboardLayout === "grouped" — cluster a project's agents together. */
  grouped: boolean;
  reviveClicks: Record<string, number>;
  reviveClicksRequired: number;
  onReviveClick: (s: EnrichedSession) => void;
  onDismissRevived: (id: string) => void;
  onClearAllRevived: () => void;
  /** Tuck a live session into the Resting group (card "X"). */
  onDismiss: (id: string) => void;
  /** Bring a resting session back into the main view ("restore"). */
  onRestore: (id: string) => void;
  formatReviveElapsed: (revivedAt: number) => string;
}

/** Titles that appear on more than one session — used to show a disambiguating
 *  prompt snippet on those cards (mirrors the instrument card's isDuplicate). */
export function duplicateTitleSet(sessions: EnrichedSession[]): Set<string> {
  const counts = new Map<string, number>();
  for (const s of sessions) counts.set(s.displayTitle, (counts.get(s.displayTitle) ?? 0) + 1);
  return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([t]) => t));
}

/** Group-by-project ordering shared by the skins (stable, preserves first-seen
 *  project order). Returns the input untouched when not grouping. */
export function orderSessions(sessions: EnrichedSession[], grouped: boolean): EnrichedSession[] {
  if (!grouped) return sessions;
  const byWs = new Map<string, EnrichedSession[]>();
  for (const s of sessions) {
    const arr = byWs.get(s.info.workspace);
    if (arr) arr.push(s);
    else byWs.set(s.info.workspace, [s]);
  }
  return Array.from(byWs.values()).flat();
}
