import { useMemo } from "react";
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

/**
 * True if a session is a team-spawned child. A genuine TeamCreate agent has
 * BOTH a team name AND an agent name (the `@track-a-memory` / `@track-b-viz`
 * tag that identifies the specific agent within the team). Sessions with
 * only a team name are either the team lead itself — which is a parent, not
 * a child — or a stale artifact from earlier JSONL content; either way they
 * should render standalone, not as a branch.
 */
function isChildSession(s: EnrichedSession): boolean {
  const teamName = s.info.teamName || s.metrics.teamName;
  const agentName = s.info.agentName || s.metrics.agentName;
  return !!(teamName && agentName && agentName.trim().length > 0);
}

/**
 * Group sessions into families: parent + team-agent children.
 *
 * Only sessions with `teamName` are children. Matching to a parent:
 *   1. Find all non-child sessions whose workspace is an ancestor of the
 *      child's workspace (exact match or path prefix).
 *   2. If exactly one candidate → assign.
 *   3. If multiple → pick the candidate started most recently before the
 *      child (the session that plausibly spawned it). This replaces the
 *      older heuristic that required the parent to have `activeSubagents`
 *      incremented — TeamCreate does not increment that counter (only
 *      Task-tool SubagentStart does), so the old check caused team
 *      children to always fall through to standalone.
 *   4. If no candidate has `startedAt <= child.startedAt` → fall back to
 *      the candidate with the greatest `lastActivity`.
 * Orphans (no candidate at all) are shown standalone.
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

  // Index non-child sessions by workspace. Unlike the previous version,
  // we do NOT restrict by activeSubagents/hasSubagents — TeamCreate-spawned
  // children don't register on those counters, so the presence of a child
  // with teamName is itself the signal that grouping should happen.
  const parentsByWs = new Map<string, EnrichedSession[]>();
  for (const p of parents) {
    const list = parentsByWs.get(p.info.workspace) ?? [];
    list.push(p);
    parentsByWs.set(p.info.workspace, list);
  }

  const claimedChildren = new Set<string>();
  const familyMap = new Map<string, EnrichedSession[]>(); // parentId → children

  for (const child of children) {
    const cw = child.info.workspace;
    const candidates: EnrichedSession[] = [];
    for (const [pw, ps] of parentsByWs) {
      if (cw === pw || cw.startsWith(pw + "/")) {
        candidates.push(...ps);
      }
    }
    if (candidates.length === 0) continue;

    let chosen: EnrichedSession;
    if (candidates.length === 1) {
      chosen = candidates[0];
    } else {
      // Prefer parent started just before the child (most-recent predecessor).
      const childStart = child.info.startedAt ?? 0;
      const predecessors = candidates.filter((c) => (c.info.startedAt ?? 0) <= childStart);
      if (predecessors.length > 0) {
        chosen = predecessors.reduce((a, b) =>
          (a.info.startedAt ?? 0) >= (b.info.startedAt ?? 0) ? a : b
        );
      } else {
        // Fallback: most recently active candidate.
        chosen = candidates.reduce((a, b) =>
          (a.info.lastActivity ?? 0) >= (b.info.lastActivity ?? 0) ? a : b
        );
      }
    }

    claimedChildren.add(child.info.id);
    const existing = familyMap.get(chosen.info.id) ?? [];
    existing.push(child);
    familyMap.set(chosen.info.id, existing);
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
  // Families + duplicate-title set depend only on `sessions`. Recomputing
  // them on every tick (sessions update frequently) walks the list twice
  // and allocates maps/sets unnecessarily — memoize on the sessions ref.
  const families = useMemo(() => {
    const built = buildFamilies(sessions);
    return built.sort((a, b) => parentSortKey(a.parent) - parentSortKey(b.parent));
  }, [sessions]);

  const duplicateTitles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions) {
      counts.set(s.displayTitle, (counts.get(s.displayTitle) ?? 0) + 1);
    }
    return new Set(
      [...counts.entries()].filter(([, c]) => c > 1).map(([t]) => t)
    );
  }, [sessions]);

  const renderCard = (session: EnrichedSession, childOverride = false) => (
    <SessionCard
      {...cardSettings}
      session={session}
      isDuplicate={duplicateTitles.has(session.displayTitle)}
      // Force compact rendering for children — each team agent gets one
      // short row in the column instead of a full card. Override cycling
      // stays disabled; in branch view children are always compact.
      compactMode={childOverride ? true : cardSettings.compactMode}
      slimMode={childOverride ? false : cardSettings.slimMode}
      expandOverride={!childOverride && compactMode ? expandOverrides[session.info.id] : undefined}
      onExpandCycle={!childOverride && compactMode ? () => onExpandCycle(session.info.id) : undefined}
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

        // Parent on left (~45%), children stacked vertically on the right.
        // Each child renders in compact mode so multiple agents fit in the
        // height of one parent card without dominating the layout. Parent
        // gets less of the row so children have room for their title +
        // prompt-preview snippet without truncation.
        //
        // Parent state demotion: a thread cannot be "done" while its team
        // agents are still running — the parent has handed off control and
        // is really waiting on the team. Show it as idle in that case.
        const hasActiveChild = family.children.some((c) =>
          c.info.state === "working" ||
          c.info.state === "thinking" ||
          c.info.state === "subagent" ||
          c.info.state === "waiting"
        );
        const parentForRender =
          hasActiveChild && family.parent.info.state === "done"
            ? {
                ...family.parent,
                info: { ...family.parent.info, state: "idle" },
                stateDisplayName: "Idle",
                stateIcon: "○",
              }
            : family.parent;
        return (
          <div key={family.parent.info.id} className="flex items-stretch gap-2">
            <div className="w-[45%] shrink-0">
              {renderCard(parentForRender)}
            </div>
            {/* Connector line */}
            <div className="w-3 shrink-0 flex items-center">
              <div className="w-full h-px bg-white/15" />
            </div>
            {/* Children stacked vertically, each compact */}
            <div className="flex-1 min-w-0 flex flex-col gap-1.5 justify-center">
              {family.children.map((child) => (
                <div key={child.info.id} className="min-w-0">
                  {renderCard(child, true)}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
