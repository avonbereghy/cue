import React, { useCallback, useState } from "react";
import { openSession } from "@/lib/openSession";
import type { EnrichedSession, PermissionRequest, SubagentMetrics } from "@/lib/types";
import {
  isActiveState, contextRampRgb, rgbCss, permissionModeMeta,
  aggregateMetrics, branchStatus, contextDisplay, shortPath, splitSubagents,
} from "@/lib/sessionCardModel";
import { formatTokens, formatDuration, cleanPromptText, errorReason, formatModelName } from "@/lib/format";
import { DecisionBar } from "./DecisionBar";
import { CardExtras } from "./CardExtras";
import { SubagentDetail } from "./SubagentDetail";
import { PromptPopup } from "./PromptPopup";
import { orderSessions, duplicateTitleSet, type SkinViewProps } from "./skinView";
import { DismissButton } from "./DismissButton";
import { RestingDisclosure } from "./RestingDisclosure";

const ALIVE = new Set(["working", "subagent", "thinking", "compacting", "clearing"]);
const DIM = new Set(["idle", "done", "ended"]);
const EFFORT: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };
const STATE_WORD: Record<string, string> = {
  working: "working", subagent: "subagent", waiting: "awaiting you", thinking: "thinking",
  compacting: "compacting", clearing: "clearing", error: "error", done: "done", idle: "idle", ended: "ended",
};

/** Brass/amber lamplit state marks (solid fills — no gradient ids to collide). */
function StateMark({ state }: { state: string }) {
  switch (state) {
    case "working":
      return (
        <svg className="statemark" viewBox="0 0 26 26" aria-hidden>
          <ellipse cx="13" cy="13" rx="11" ry="11" fill="#e8a14a" opacity=".14" />
          <g className="flick">
            <path d="M13 4 C16 9 18 11 18 15 a5 5 0 0 1 -10 0 C8 11 11 9 13 4Z" fill="#e8a14a" />
            <path d="M13 9 C15 12 15.5 13 15.5 15 a2.5 2.5 0 0 1 -5 0 C10.5 13 11.5 12 13 9Z" fill="#fff4d6" />
          </g>
          <rect x="11" y="20" width="4" height="3" rx="1" fill="#7a6c56" />
        </svg>
      );
    case "subagent":
      return (
        <svg className="statemark" viewBox="0 0 26 26" aria-hidden>
          <ellipse cx="13" cy="13" rx="11" ry="11" fill="#c69a4e" opacity=".12" />
          <circle cx="13" cy="13" r="3.4" fill="#e9c074" />
          <line x1="13" y1="13" x2="5" y2="7" stroke="#c69a4e" strokeWidth="1" opacity=".5" />
          <line x1="13" y1="13" x2="21" y2="8" stroke="#c69a4e" strokeWidth="1" opacity=".5" />
          <circle cx="5" cy="7" r="2.4" fill="#e8a14a" />
          <circle cx="21" cy="8" r="2.4" fill="#e8a14a" />
        </svg>
      );
    case "waiting":
      return (
        <svg className="statemark" viewBox="0 0 26 26" aria-hidden>
          <ellipse cx="13" cy="13" rx="11" ry="11" fill="#f0c067" opacity=".16" />
          <path d="M13 5 a6 6 0 0 1 6 6 v5 l1.5 2 h-15 l1.5 -2 v-5 a6 6 0 0 1 6 -6Z" fill="#e9c074" />
          <circle cx="13" cy="4.5" r="1.3" fill="#f0c067" />
          <circle cx="13" cy="20.5" r="1.6" fill="#b3742f" />
        </svg>
      );
    case "thinking":
    case "compacting":
    case "clearing":
      return (
        <svg className="statemark" viewBox="0 0 26 26" aria-hidden>
          <ellipse cx="13" cy="13" rx="11" ry="11" fill="#e8a14a" opacity=".12" />
          <g className="think-ring"><circle cx="13" cy="13" r="7" fill="none" stroke="#e8a14a" strokeWidth="1.4" strokeDasharray="3 4" opacity=".8" /></g>
          <circle cx="13" cy="13" r="2.6" fill="#f0c067" />
        </svg>
      );
    case "error":
      return (
        <svg className="statemark" viewBox="0 0 26 26" aria-hidden>
          <ellipse cx="13" cy="13" rx="11" ry="11" fill="#c2552e" opacity=".15" />
          <circle cx="13" cy="13" r="8.5" fill="none" stroke="#c2552e" strokeWidth="1.6" />
          <line x1="9" y1="9" x2="17" y2="17" stroke="#e08a64" strokeWidth="2" strokeLinecap="round" />
          <line x1="17" y1="9" x2="9" y2="17" stroke="#e08a64" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "done":
      return (
        <svg className="statemark" viewBox="0 0 26 26" aria-hidden>
          <circle cx="13" cy="13" r="9.5" fill="#5e6e42" opacity=".25" />
          <circle cx="13" cy="13" r="8" fill="none" stroke="#9bab74" strokeWidth="1.4" opacity=".8" />
          <path d="M9 13.2 l2.8 2.8 L17.5 10" fill="none" stroke="#9bab74" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return (
        <svg className="statemark" viewBox="0 0 26 26" aria-hidden>
          <circle cx="13" cy="13" r="8.5" fill="none" stroke="#5a4c3a" strokeWidth="1.4" />
          <circle cx="13" cy="13" r="3" fill="#3a2f22" />
        </svg>
      );
  }
}

const BranchIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden><path d="M5 3.5a1.5 1.5 0 1 0-2 1.41V11.1a1.5 1.5 0 1 0 1 0V8.2a2.6 2.6 0 0 0 1.8.8h.7a1.5 1.5 0 1 0 0-1H6.6A1.6 1.6 0 0 1 5 6.4V4.9A1.5 1.5 0 0 0 5 3.5Z" fill="currentColor" /></svg>
);
const LampMark = () => (
  <svg className="lamp-mark" viewBox="0 0 30 34" fill="none" aria-hidden>
    <path d="M6 11 L24 11 L19 21 L11 21 Z" fill="#c69a4e" />
    <rect x="14" y="21" width="2" height="9" fill="#7a6c56" />
    <ellipse cx="15" cy="31.5" rx="7" ry="1.8" fill="#3a2d20" />
    <ellipse cx="15" cy="24" rx="11" ry="6" fill="#e8a14a" opacity=".22" />
  </svg>
);

interface NightCardProps {
  session: EnrichedSession;
  index: number;
  timerDisplay: string;
  permissionsEnabled: boolean;
  pending: PermissionRequest[];
  onApprove: (sessionId: string, requestId: string) => void;
  onDeny: (sessionId: string, requestId: string) => void;
  isDuplicate?: boolean;
  showConfigCounts?: boolean;
  showUsage?: boolean;
  /** Provided for live cards (renders the dismiss "X"); omitted for revived ones. */
  onDismiss?: (id: string) => void;
}

function NightCardBase({ session, index, timerDisplay, permissionsEnabled, pending, onApprove, onDeny, isDuplicate, showConfigCounts, showUsage, onDismiss }: NightCardProps) {
  const { info, metrics } = session;
  const state = info.state;
  const alive = ALIVE.has(state);
  const dim = DIM.has(state);
  const [copied, setCopied] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  // Which child-agent row is expanded to its quick-report (one per card).
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);

  const branch = branchStatus(session);
  const agg = aggregateMetrics(session);
  const { pct } = contextDisplay(session);
  const ramp = rgbCss(contextRampRgb(session.contextUsagePercent));
  const effortRank = session.effortLevel ? (EFFORT[session.effortLevel] ?? 0) : 0;
  const permMeta = permissionModeMeta(info.permissionMode, state);

  const teamName = info.teamName || metrics.teamName;
  const agentName = info.agentName || metrics.agentName;
  const subtitle = teamName ? `${agentName || "team agent"} · ${teamName}`
    : metrics.branchedFromSessionId ? `Branch from ${metrics.branchedFromSessionId.slice(0, 8)}` : null;

  const error = state === "error" ? errorReason(info.errorType, metrics.lastErrorMessage) : null;
  const waitSnippet = state === "waiting" ? (cleanPromptText(metrics.lastPrompt) || "Awaiting your approval") : null;
  const restSnippet = (state === "working" || state === "done")
    ? cleanPromptText(metrics.lastAssistantText) || cleanPromptText(metrics.lastPrompt) : null;
  const dupRaw = isDuplicate && !metrics.customTitle && !metrics.branchedFromSessionId
    ? (state !== "thinking" && metrics.lastAssistantText ? metrics.lastAssistantText : metrics.lastPrompt)
    : null;
  const dupText = cleanPromptText(dupRaw);
  const showDup = !!dupText && !restSnippet && !waitSnippet && !error;
  // The conversation/message detail — one source, shown as a one-line preview at
  // the FOOT of the card (tap to read in full), so a long prompt never pushes the
  // vitals out of view. cleanPromptText keeps the full text (it's also the popup
  // body); the preview is truncated with CSS.
  const convoText = waitSnippet ?? restSnippet ?? (showDup ? dupText : null);

  const allSubs = metrics.subagents ?? [];
  const { active: subActive, completed: subDone } = splitSubagents(allSubs);
  const showTps = alive && session.outputTokensPerSec > 0;
  const timer = timerDisplay === "off" ? null
    : timerDisplay === "minutes" ? formatDuration(session.durationSecs).slice(0, 5)
    : formatDuration(session.durationSecs);

  const copyId = useCallback(() => {
    if (!info.id || !navigator.clipboard) return;
    navigator.clipboard.writeText(info.id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {});
  }, [info.id]);
  const openWorkspace = useCallback(() => {
    openSession(session);
  }, [session]);
  const onCardClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, a, input, [role=button]")) return;
    openWorkspace();
  };

  const renderSub = (a: SubagentMetrics, i: number, kind: string) => {
    const toolUses = Object.values(a.toolCounts).reduce((x, y) => x + y, 0);
    const id = a.agentId || `${kind}-${i}`;
    const open = openAgentId === id;
    const toggle = (e: React.SyntheticEvent) => {
      e.stopPropagation();
      setOpenAgentId(open ? null : id);
    };
    const onKey = (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(e); }
    };
    return (
      <React.Fragment key={id}>
        <div className="sub" role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={onKey} style={{ cursor: "pointer" }}>
          <span className={`livedot ${a.isActive ? "" : "off"}`} />
          <div className="sub-body">
            <span className="sub-slug">{a.slug || a.agentId.slice(0, 8)}</span>
            <div className="sub-desc">{a.description}</div>
            <div className="sub-meta"><span>{formatTokens(a.inputTokens + a.outputTokens)} tok</span><span>{toolUses} tools</span>{formatModelName(a.model) !== "—" && <span title={a.model}>{formatModelName(a.model)}</span>}</div>
          </div>
          <span aria-hidden style={{ color: "var(--ink-faint)", fontSize: 11, alignSelf: "center" }}>{open ? "▾" : "▸"}</span>
        </div>
        {open && <SubagentDetail agent={a} palette={{ text: "var(--ink)", muted: "var(--ink-soft)", faint: "var(--ink-faint)", rule: "rgba(198,154,78,0.16)", mono: "var(--mono)", accent: "var(--ember)" }} />}
      </React.Fragment>
    );
  };

  return (
    <article className={`card s-${state} ${alive ? "alive" : ""} ${dim ? "dim" : ""}`} style={{ animationDelay: `${Math.min(index, 12) * 0.07}s` }} onClick={onCardClick} aria-label={`${STATE_WORD[state] ?? state}: ${session.displayTitle}`}>
      {onDismiss && <DismissButton sessionId={info.id} title={session.displayTitle} onDismiss={onDismiss} />}
      <span className="spine" />
      <div className="chead">
        <StateMark state={state} />
        <div className="titleblock">
          <h2 className="ctitle">{session.displayTitle}</h2>
          <span className="statelabel">{STATE_WORD[state] ?? state}</span>
          {subtitle && <div className="csub">{subtitle}</div>}
        </div>
        {timer && <div className="timer"><span className="lab">elapsed</span>{timer}</div>}
      </div>

      <DecisionBar session={session} pending={permissionsEnabled ? pending : []} onApprove={onApprove} onDeny={onDeny} />

      <div className="projline">
        <span className="proj">{session.workspaceName}</span>
        {branch && (
          <span className="branch"><BranchIcon /> {branch.branch}
            {branch.dirty && <span className="dirty" title="uncommitted changes"> *</span>}
            {branch.ahead > 0 && <span className="ahead" title="ahead"> ↑{branch.ahead}</span>}
            {branch.behind > 0 && <span className="behind" title="behind"> ↓{branch.behind}</span>}
          </span>
        )}
        <span className="path">{shortPath(info.workspace)}</span>
      </div>

      {error && <p className="quote err"><span className="err-head">it stopped here</span>{error}</p>}

      {session.todoTotal > 0 && (
        <div className="todos">
          <div className="todorow">
            <span className="todocount"><b>{session.todoCompleted}</b>/{session.todoTotal} steps</span>
            <span className="beads">{Array.from({ length: Math.min(session.todoTotal, 12) }, (_, i) => <span key={i} className={`bead ${i < session.todoCompleted ? "on" : ""}`} />)}</span>
          </div>
          {session.todoCurrent && <div className="todocur"><span className="arr">↳</span>{session.todoCurrent}</div>}
        </div>
      )}

      {allSubs.length > 0 && (
        <div className="subs">
          <div className="subs-lab">{allSubs.length} helpers at the bench</div>
          {subActive.map((a, i) => renderSub(a, i, "a"))}
          {subDone.length > 0 && (
            <details>
              <summary style={{ cursor: "pointer", fontSize: 10, letterSpacing: ".06em", color: "var(--ink-faint)", padding: "2px 0" }}>{subDone.length} returned to the shelf</summary>
              {subDone.map((a, i) => renderSub(a, i, "d"))}
            </details>
          )}
        </div>
      )}

      <div className="ctx">
        <div className="ctx-top">
          <span className="ctx-lab">context</span>
          <span className="ctx-val"><span className="ctx-pct" style={{ color: ramp }}>{pct}%</span> · {formatTokens(metrics.lastInputTokens)} / {formatTokens(session.contextLimit)}</span>
        </div>
        <div className="gauge"><span className="fill" style={{ width: `${pct}%`, background: ramp, color: ramp }} /></div>
      </div>

      <CardExtras session={session} showConfigCounts={!!showConfigCounts} showUsage={showUsage !== false} mono="var(--mono)" muted="var(--ink-soft)" faint="var(--ink-faint)" rule="rgba(198,154,78,0.16)" />

      <div className="idrow">
        {session.modelDisplayName !== "—" && <span className="chip model"><b>{session.modelDisplayName}</b>{session.provider && ` · ${session.provider}`}</span>}
        {session.effortLevel && (
          <span className="effort" title={`effort: ${session.effortLevel}`}>
            {[6, 8, 10, 12].map((h, i) => <span key={i} className={`efbar ${i < effortRank ? "on" : ""}`} style={{ height: h }} />)}
          </span>
        )}
        {permMeta && <span className={`perm-pill ${permMeta.tone}`} title={permMeta.title}>{permMeta.label}</span>}
        {session.sourceDisplay !== "—" && <span className="chip">{session.sourceDisplay}</span>}
        {info.id && <button className="sid" onClick={copyId} title={`Session id — click to copy: ${info.id}`}><span className="key">id</span> {info.id.slice(0, 8)}{copied && " ✓"}</button>}
      </div>

      <div className="metrics">
        {showTps
          ? <div className="metric tps"><span className="v">{session.outputTokensPerSec.toFixed(1)}/s</span><span className="k">tokens · sec</span></div>
          : <div className="metric"><span className="v">idle</span><span className="k">throughput</span></div>}
        <div className="metric"><span className="v">{agg.toolUses}</span><span className="k">tool calls</span></div>
        <div className="metric"><span className="v">{metrics.userMessageCount}/{metrics.messageCount}</span><span className="k">msgs you · total</span></div>
        <div className="metric"><span className="v">{formatTokens(agg.inputTokens)}</span><span className="k">input tok</span></div>
        <div className="metric"><span className="v">{formatTokens(agg.outputTokens)}</span><span className="k">output tok</span></div>
        <div className="metric"><span className="v">{metrics.messageCount}</span><span className="k">turns</span></div>
      </div>

      {convoText && (
        <button className="convo" onClick={(e) => { e.stopPropagation(); setPromptOpen(true); }} title="Read the full message">
          <span className="convo-mark">“</span><span className="convo-text">{convoText}</span>
        </button>
      )}

      {promptOpen && convoText && (
        <PromptPopup text={convoText} label={waitSnippet ? "Last prompt" : "Latest message"} onClose={() => setPromptOpen(false)} bg="#2c2218" border="rgba(198,154,78,0.3)" ink="#f3e7d2" muted="#a8967a" fontBody='"Fraunces", Georgia, serif' italic />
      )}
    </article>
  );
}
const NightCard = React.memo(NightCardBase);

export function NightView(props: SkinViewProps) {
  const { sessions, revivedSessions, permissionsEnabled, pendingBySession, approvePermission, denyPermission, timerDisplay, grouped, showConfigCounts, showUsage } = props;
  const total = sessions.length;
  const active = sessions.filter((s) => isActiveState(s.info.state)).length;
  const ordered = orderSessions(sessions, grouped);
  const dupSet = duplicateTitleSet(sessions);

  return (
    <div className="night-view flex flex-col flex-1 min-h-0">
      <div className="sessions-scroll night-scroll flex-1 overflow-y-auto min-h-0">
        <div className="night-inner">
          <header className="app-head">
            <div className="brand">
              <LampMark />
              <h1>Cue<span className="dot">.</span></h1>
              <span className="tag">the night study</span>
            </div>
            <div className="counts">
              <div className="big"><b>{total}</b> session{total === 1 ? "" : "s"} · <b>{active}</b> active</div>
              <div className="sub">at the workbench</div>
            </div>
          </header>

          <main className="grid">
            {total === 0 && revivedSessions.length === 0 && props.restingSessions.length === 0 && (
              <div className="night-empty">
                <LampMark />
                <div className="h">The study is quiet</div>
                <div className="p">Sessions light up here as Claude Code begins working.</div>
              </div>
            )}
            {ordered.map((session, idx) => (
              <NightCard
                key={session.info.id}
                session={session}
                index={idx}
                timerDisplay={timerDisplay}
                permissionsEnabled={permissionsEnabled}
                pending={pendingBySession[session.info.id] ?? []}
                onApprove={approvePermission}
                onDeny={denyPermission}
                isDuplicate={dupSet.has(session.displayTitle)}
                showConfigCounts={showConfigCounts}
                showUsage={showUsage}
                onDismiss={props.onDismiss}
              />
            ))}
          </main>

          <RestingDisclosure sessions={props.restingSessions} onRestore={props.onRestore} />

          {revivedSessions.length > 0 && (
            <section className="night-ended">
              <div className="night-ended-head">
                <span className="rule" /><span>Ended Sessions ({revivedSessions.length})</span><span className="rule" />
                <button className="clear" onClick={props.onClearAllRevived}>Clear all</button>
              </div>
              <div className="grid">
                {revivedSessions.map(({ session, revivedAt }) => {
                  const clicks = props.reviveClicks[session.info.id] ?? 0;
                  const remaining = props.reviveClicksRequired - clicks;
                  const label = clicks === 0 ? "Revive" : remaining === 1 ? "Confirm!" : `Revive (${clicks}/${props.reviveClicksRequired})`;
                  return (
                    <div key={session.info.id} style={{ position: "relative", minWidth: 0 }}>
                      <NightCard session={session} index={0} timerDisplay={timerDisplay} permissionsEnabled={false} pending={[]} onApprove={approvePermission} onDeny={denyPermission} showConfigCounts={showConfigCounts} showUsage={showUsage} />
                      <div className="revive-row">
                        <span className="age">ended {props.formatReviveElapsed(revivedAt)} ago</span>
                        <button className="revive" onClick={() => props.onReviveClick(session)}>{label}</button>
                        <button className="dismiss" onClick={() => props.onDismissRevived(session.info.id)}>Dismiss</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
