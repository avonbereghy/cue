import { SessionCard, type SessionCardProps } from "./SessionCard";
import type { EnrichedSession } from "../lib/types";

/** Props forwarded to every SessionCard (signal, sand, display settings). */
export type CardSettings = Omit<SessionCardProps, "session" | "isDuplicate" | "expandOverride" | "onExpandCycle">;

interface BranchViewProps {
  sessions: EnrichedSession[];
  cardSettings: CardSettings;
  compactMode: boolean;
  expandOverrides: Record<string, number>;
  onExpandCycle: (id: string) => void;
}

interface SessionFamily {
  parent: EnrichedSession;
  children: EnrichedSession[];
}

/** True if a session is a team-spawned child (has teamName from hook or JSONL). */
function isChildSession(s: EnrichedSession): boolean {
  return !!(s.info.teamName || s.metrics.teamName);
}

/**
 * Group sessions into families: parent + team-agent children.
 * Only sessions with `teamName` are children. A child is matched to a parent
 * only when exactly ONE parent in that workspace has activeSubagents > 0 —
 * if multiple parents share a workspace (common: user runs two sessions in
 * the same repo) the match is ambiguous and children are shown standalone.
 * Orphaned children (no matching parent) are also shown standalone.
 */
function buildFamilies(sessions: EnrichedSession[]): SessionFamily[] {
  const parents: EnrichedSession[] = [];
  const children: EnrichedSession[] = [];

  for (const s of sessions) {
    if (isChildSession(s)) {
      children.push(s);
    } else {
      parents.push(s);
    }
  }

  // Index: workspace → parents with active subagents in that workspace.
  // We only group when exactly one parent claims a workspace — ambiguity
  // means we can't reliably assign children.
  const activeParentsByWs = new Map<string, EnrichedSession[]>();
  for (const p of parents) {
    if ((p.info.activeSubagents ?? 0) > 0 || p.hasSubagents) {
      const list = activeParentsByWs.get(p.info.workspace) ?? [];
      list.push(p);
      activeParentsByWs.set(p.info.workspace, list);
    }
  }

  const claimedChildren = new Set<string>();
  const familyMap = new Map<string, EnrichedSession[]>(); // parentId → children

  for (const child of children) {
    const cw = child.info.workspace;
    // Find candidate parents: child workspace equals or is under parent workspace
    let candidates: EnrichedSession[] = [];
    for (const [pw, ps] of activeParentsByWs) {
      if (cw === pw || cw.startsWith(pw + "/")) {
        candidates.push(...ps);
      }
    }
    // Only assign if exactly one candidate — otherwise ambiguous
    if (candidates.length === 1) {
      const parentId = candidates[0].info.id;
      claimedChildren.add(child.info.id);
      const existing = familyMap.get(parentId) ?? [];
      existing.push(child);
      familyMap.set(parentId, existing);
    }
  }

  const families: SessionFamily[] = [];
  for (const parent of parents) {
    families.push({ parent, children: familyMap.get(parent.info.id) ?? [] });
  }

  // Orphaned children (ambiguous or no matching parent) — show standalone
  for (const c of children) {
    if (!claimedChildren.has(c.info.id)) {
      families.push({ parent: c, children: [] });
    }
  }

  return families;
}

/** Sort priority: active states first (by duration desc), then inactive. */
function parentSortKey(s: EnrichedSession): number {
  const active = ["working", "thinking", "waiting", "error", "subagent"];
  if (active.includes(s.info.state)) return -(s.durationSecs ?? 0); // negative = longest first
  if (s.info.state === "done" || s.info.state === "compacting") return 1_000_000;
  return 2_000_000; // idle, ended, clearing
}

export function BranchView({ sessions, cardSettings, compactMode, expandOverrides, onExpandCycle }: BranchViewProps) {
  const families = buildFamilies(sessions);
  // Sort families by parent state: active (longest first) > done > idle
  families.sort((a, b) => parentSortKey(a.parent) - parentSortKey(b.parent));

  // Check which displayTitles appear more than once
  const titleCounts = new Map<string, number>();
  for (const s of sessions) {
    titleCounts.set(s.displayTitle, (titleCounts.get(s.displayTitle) ?? 0) + 1);
  }
  const duplicateTitles = new Set(
    [...titleCounts.entries()].filter(([, count]) => count > 1).map(([title]) => title)
  );

  const renderCard = (session: EnrichedSession) => (
    <SessionCard
      {...cardSettings}
      session={session}
      isDuplicate={duplicateTitles.has(session.displayTitle)}
      expandOverride={compactMode ? expandOverrides[session.info.id] : undefined}
      onExpandCycle={compactMode ? () => onExpandCycle(session.info.id) : undefined}
    />
  );

  return (
    <div className="flex-1 overflow-auto p-4 pb-12 space-y-3">
      {families.map((family) => {
        const n = family.children.length;
        if (n === 0) {
          // Standalone — full width
          return (
            <div key={family.parent.info.id}>
              {renderCard(family.parent)}
            </div>
          );
        }

        // Parent on left (~45%), children share right side in a single row
        return (
          <div key={family.parent.info.id} className="flex items-stretch gap-2">
            <div className="w-[45%] shrink-0">
              {renderCard(family.parent)}
            </div>
            {/* Connector line */}
            <div className="w-3 shrink-0 flex items-center">
              <div className="w-full h-px bg-white/15" />
            </div>
            {/* Children in a single row, equally divided */}
            <div className="flex-1 min-w-0 flex gap-2">
              {family.children.map((child) => (
                <div key={child.info.id} className="min-w-0" style={{ flex: `1 1 ${100 / n}%` }}>
                  {renderCard(child)}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
