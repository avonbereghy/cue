import React, { useCallback, useState } from "react";
import { openSession } from "@/lib/openSession";
import type { EnrichedSession, PermissionRequest, SubagentMetrics } from "@/lib/types";
import {
  isActiveState, contextRampRgb, rgbCss, permissionModeMeta,
  aggregateMetrics, branchStatus, contextDisplay, splitSubagents,
} from "@/lib/sessionCardModel";
import { formatTokens, formatDuration, cleanPromptText, errorReason, formatModelName } from "@/lib/format";
import { DecisionBar } from "./DecisionBar";
import { CardExtras } from "./CardExtras";
import { PromptPopup } from "./PromptPopup";
import { orderSessions, duplicateTitleSet, type SkinViewProps } from "./skinView";
import { DismissButton } from "./DismissButton";
import { RestingDisclosure } from "./RestingDisclosure";

const ALIVE = new Set(["working", "subagent", "thinking", "compacting", "clearing"]);
const EFFORT_LABEL: Record<string, string> = { low: "low", medium: "medium", high: "high", xhigh: "x-high", max: "max" };
const STATE_LABEL: Record<string, string> = {
  working: "Working", subagent: "Subagents", waiting: "Needs you", thinking: "Thinking",
  compacting: "Compacting", clearing: "Clearing", error: "Failed", done: "Done", idle: "Idle", ended: "Ended",
};

function StateMark({ state }: { state: string }) {
  switch (state) {
    case "working":
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1.2 9.6 7H2.4L6 1.2Z" fill="currentColor" /><circle cx="6" cy="9.4" r="1.4" fill="currentColor" /></svg>;
    case "subagent":
      return <svg width="13" height="12" viewBox="0 0 13 12" fill="none"><circle cx="2.2" cy="3" r="1.6" fill="currentColor" /><circle cx="2.2" cy="9" r="1.6" fill="currentColor" /><circle cx="10.6" cy="6" r="1.6" fill="currentColor" /><path d="M3.6 3.4 9.4 5.6M3.6 8.6 9.4 6.4" stroke="currentColor" strokeWidth="1.1" /></svg>;
    case "waiting":
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1.4c2 0 3.3 1.5 3.3 3.6 0 2.1.6 2.8 1.1 3.3H1.6c.5-.5 1.1-1.2 1.1-3.3C2.7 2.9 4 1.4 6 1.4Z" fill="currentColor" /><path d="M4.6 9.4a1.4 1.4 0 0 0 2.8 0" stroke="currentColor" strokeWidth="1.1" fill="none" /></svg>;
    case "thinking":
    case "compacting":
    case "clearing":
      return <span className="think-dots" style={{ letterSpacing: 1 }}><span>•</span><span>•</span><span>•</span></span>;
    case "error":
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;
    case "done":
      return <svg width="13" height="12" viewBox="0 0 13 12" fill="none"><path d="M2 6.4 5 9.2 11 2.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    default:
      return <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8.6 7.6A4 4 0 1 1 5 2.2a3.1 3.1 0 0 0 3.6 5.4Z" fill="currentColor" /></svg>;
  }
}

const BranchIcon = () => (
  <svg width="11" height="12" viewBox="0 0 11 12" fill="none"><circle cx="2.4" cy="2.6" r="1.5" stroke="currentColor" strokeWidth="1.1" /><circle cx="2.4" cy="9.4" r="1.5" stroke="currentColor" strokeWidth="1.1" /><circle cx="8.4" cy="4.4" r="1.5" stroke="currentColor" strokeWidth="1.1" /><path d="M2.4 4.1v3.8M2.4 6.6c0-1.4 1.2-2.2 6-2.2" stroke="currentColor" strokeWidth="1.1" /></svg>
);
const WaxSeal = () => (
  <svg className="wax" viewBox="0 0 48 48" aria-hidden>
    <path fill="#9c6a2f" d="M24 3c3 2 6 1 8 3s1 5 3 7 5 1 6 4-2 5-1 8 2 5 0 7-5 1-7 3-2 5-5 6-5-1-8-1-5 2-8 1-3-4-5-6-5-1-6-4 2-5 1-8-2-5 0-7 5-1 7-3 2-5 5-6 7 1 10-1Z" />
    <circle cx="24" cy="24" r="13" fill="#83531f" />
    <circle cx="24" cy="24" r="13" fill="none" stroke="#6b431a" strokeWidth="1" strokeDasharray="2 2" />
    <path d="M17 24.5 22 29.5 31.5 18" stroke="#f1d9af" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Deterministic ±0.55° tilt per card so the board reads hand-placed. */
function rot(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `${(((h % 110) - 55) / 100).toFixed(2)}deg`;
}

interface StudioCardProps {
  session: EnrichedSession;
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

function StudioCardBase({ session, timerDisplay, permissionsEnabled, pending, onApprove, onDeny, isDuplicate, showConfigCounts, showUsage, onDismiss }: StudioCardProps) {
  const { info, metrics } = session;
  const state = info.state;
  const [copied, setCopied] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);

  const branch = branchStatus(session);
  const agg = aggregateMetrics(session);
  const { pct } = contextDisplay(session);
  const ramp = rgbCss(contextRampRgb(session.contextUsagePercent));
  const permMeta = permissionModeMeta(info.permissionMode, state);
  const showTps = ALIVE.has(state) && session.outputTokensPerSec > 0;
  const timer = timerDisplay === "off" ? null
    : timerDisplay === "minutes" ? formatDuration(session.durationSecs).slice(0, 5)
    : formatDuration(session.durationSecs);

  const teamName = info.teamName || metrics.teamName;
  const agentName = info.agentName || metrics.agentName;
  const subtitle = teamName ? `${agentName || "team agent"} · ${teamName}`
    : metrics.branchedFromSessionId ? `Branch from ${metrics.branchedFromSessionId.slice(0, 8)}` : null;

  const error = state === "error" ? errorReason(info.errorType, metrics.lastErrorMessage) : null;
  const waitSnippet = state === "waiting" ? (cleanPromptText(metrics.lastPrompt) || "Awaiting your OK.") : null;
  const restSnippet = (state !== "waiting" && state !== "error")
    ? cleanPromptText(metrics.lastAssistantText) || cleanPromptText(metrics.lastPrompt) : null;

  const allSubs = metrics.subagents ?? [];
  const { active: subActive, completed: subDone } = splitSubagents(allSubs);
  const todoFrac = session.todoTotal > 0 ? session.todoCompleted / session.todoTotal : 0;
  const dupRaw = isDuplicate && !metrics.customTitle && !metrics.branchedFromSessionId
    ? (state !== "thinking" && metrics.lastAssistantText ? metrics.lastAssistantText : metrics.lastPrompt)
    : null;
  const dupText = cleanPromptText(dupRaw);
  const showDup = !!dupText && !restSnippet && !waitSnippet && !error;
  // The conversation/message detail — one source, shown as a one-line preview at
  // the FOOT of the card (tap to read in full) so a long prompt never buries the
  // vitals above it.
  const convoText = waitSnippet ?? restSnippet ?? (showDup ? dupText : null);

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

  const renderSub = (a: SubagentMetrics, i: number) => {
    const toolUses = Object.values(a.toolCounts).reduce((x, y) => x + y, 0);
    return (
      <div className="sub" key={a.agentId || i}>
        <span className={`livedot ${a.isActive ? "" : "off"}`} />
        <div className="sub-body">
          <span className="slug">{a.slug || a.agentId.slice(0, 8)}</span>
          <div className="desc">{a.description}</div>
          <div className="smeta">{formatTokens(a.inputTokens + a.outputTokens)} tok · {toolUses} tools{formatModelName(a.model) !== "—" ? ` · ${formatModelName(a.model)}` : ""}</div>
        </div>
      </div>
    );
  };

  return (
    <article className={`card s-${state}`} style={{ "--rot": rot(info.id) } as React.CSSProperties} onClick={onCardClick} aria-label={`${STATE_LABEL[state] ?? state}: ${session.displayTitle}`}>
      {onDismiss && <DismissButton sessionId={info.id} title={session.displayTitle} onDismiss={onDismiss} />}
      <span className="spine" />
      {state === "waiting" && <div className="needtab"><span className="ping" />Needs you</div>}
      {state === "done" && <WaxSeal />}

      <div className="card-head">
        <span className="stamp"><span className="mark"><StateMark state={state} /></span>{STATE_LABEL[state] ?? state}</span>
        {timer && <div className="timer">{timer}<small>elapsed</small></div>}
      </div>

      <DecisionBar session={session} pending={permissionsEnabled ? pending : []} onApprove={onApprove} onDeny={onDeny} />

      <h2 className="title">{session.displayTitle}</h2>
      {subtitle && <div className="csub">{subtitle}</div>}

      <div className="loc">
        <span className="proj">{session.workspaceName}</span>
        {branch && <><span className="sep">·</span>
          <span className="branch"><BranchIcon /> {branch.branch}
            {branch.dirty && <span className="dirty" title="uncommitted changes">∗</span>}
            {branch.ahead > 0 && <span className="ahead" title="ahead">↑{branch.ahead}</span>}
            {branch.behind > 0 && <span className="behind" title="behind">↓{branch.behind}</span>}
          </span></>}
      </div>

      {error && <div className="errnote"><span className="lbl">Reason</span>{error}</div>}

      {allSubs.length > 0 && (
        <div className="subs">
          <div className="subs-lbl">{allSubs.length} child agents</div>
          {subActive.map((a, i) => renderSub(a, i))}
          {subDone.length > 0 && (
            <details>
              <summary style={{ cursor: "pointer", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--ink-faint)", padding: "2px 0" }}>{subDone.length} returned</summary>
              {subDone.map((a, i) => renderSub(a, i))}
            </details>
          )}
        </div>
      )}

      {session.todoTotal > 0 && (
        <div className="todos">
          <div className="todos-bar"><i style={{ width: `${Math.round(todoFrac * 100)}%` }} /></div>
          <div className="todos-meta">
            <span className="num">{session.todoCompleted} / {session.todoTotal} tasks</span>
            <span className="cur">{session.todoCurrent || (session.todoCompleted === session.todoTotal ? "all complete" : "")}</span>
          </div>
        </div>
      )}

      <div className="ctx">
        <div className="ctx-top">
          <span className="pct">{pct}%<span className="lab">context</span></span>
          <span className="tok">{formatTokens(metrics.lastInputTokens)} / {formatTokens(session.contextLimit)}</span>
        </div>
        <div className="ctx-bar"><i style={{ width: `${pct}%`, background: ramp }} /></div>
      </div>

      <div className="metrics">
        {showTps && <span className="m"><span className="v">{session.outputTokensPerSec.toFixed(1)}</span><span className="k">tok/s</span></span>}
        <span className="m"><span className="v">{formatTokens(agg.inputTokens)}</span><span className="k">in</span></span>
        <span className="m"><span className="v">{formatTokens(agg.outputTokens)}</span><span className="k">out</span></span>
        <span className="m"><span className="v">{agg.toolUses}</span><span className="k">tools</span></span>
        <span className="m"><span className="v">{metrics.userMessageCount}/{metrics.messageCount}</span><span className="k">msgs</span></span>
      </div>

      <CardExtras session={session} showConfigCounts={!!showConfigCounts} showUsage={showUsage !== false} mono="var(--mono)" muted="var(--ink-soft)" faint="var(--ink-faint)" rule="var(--paper-edge)" />

      <div className="footrow">
        <div className="chips">
          {session.modelDisplayName !== "—" && <span className="chip">{session.modelDisplayName}{session.effortLevel && <> · <span className="eff">{EFFORT_LABEL[session.effortLevel] ?? session.effortLevel}</span></>}</span>}
          {permMeta && <span className={`perm-pill ${permMeta.tone}`} title={permMeta.title}>{permMeta.label}</span>}
          {session.sourceDisplay !== "—" && <span className="chip src">{session.sourceDisplay}</span>}
        </div>
        {info.id && <button className="sid" onClick={copyId} title={`Session id — click to copy: ${info.id}`}>{info.id.slice(0, 8)}{copied && " ✓"}</button>}
      </div>

      {convoText && (
        <button className="convo" onClick={(e) => { e.stopPropagation(); setPromptOpen(true); }} title="Read the full message">
          <span className="convo-mark">“</span><span className="convo-text">{convoText}</span>
        </button>
      )}

      {promptOpen && convoText && (
        <PromptPopup text={convoText} label={waitSnippet ? "Last prompt" : "Latest message"} onClose={() => setPromptOpen(false)} bg="#f7f0e4" border="rgba(96,72,42,0.28)" ink="#2b2620" muted="#8a8070" fontBody='"Spectral", Georgia, serif' italic />
      )}
    </article>
  );
}
const StudioCard = React.memo(StudioCardBase);

export function StudioView(props: SkinViewProps) {
  const { sessions, revivedSessions, permissionsEnabled, pendingBySession, approvePermission, denyPermission, timerDisplay, grouped, showConfigCounts, showUsage } = props;
  const total = sessions.length;
  const active = sessions.filter((s) => isActiveState(s.info.state)).length;
  const ordered = orderSessions(sessions, grouped);
  const dupSet = duplicateTitleSet(sessions);

  const cardProps = (session: EnrichedSession, withPerms: boolean) => ({
    session,
    timerDisplay,
    permissionsEnabled: withPerms && permissionsEnabled,
    pending: withPerms ? (pendingBySession[session.info.id] ?? []) : [],
    onApprove: approvePermission,
    onDeny: denyPermission,
    isDuplicate: withPerms ? dupSet.has(session.displayTitle) : false,
    showConfigCounts,
    showUsage,
    onDismiss: withPerms ? props.onDismiss : undefined,
  });

  return (
    <div className="studio-view flex flex-col flex-1 min-h-0">
      <div className="sessions-scroll studio-scroll flex-1 overflow-y-auto min-h-0">
        <div className="studio-inner">
          <header className="masthead">
            <div className="brand">
              <span className="wordmark">Cue<span className="dot">.</span></span>
              <span className="tagline">a quiet ledger of working hands</span>
            </div>
            <div className="ledger-stamp">
              <div className="count"><span className="pulse-dot" /><b>{total}</b> session{total === 1 ? "" : "s"} · <b>{active}</b> active</div>
              <div className="sub">desk view · second monitor</div>
            </div>
          </header>

          <main className="board" aria-label="session board">
            {total === 0 && revivedSessions.length === 0 && props.restingSessions.length === 0 && (
              <div className="studio-empty">
                <div className="h">A clear desk</div>
                <div className="p">Cards are laid out here as Claude Code sessions begin.</div>
              </div>
            )}
            {ordered.map((session) => (
              <StudioCard key={session.info.id} {...cardProps(session, true)} />
            ))}
          </main>

          <RestingDisclosure sessions={props.restingSessions} onRestore={props.onRestore} />

          {revivedSessions.length > 0 && (
            <section className="studio-ended">
              <div className="studio-ended-head">
                <span className="rule" /><span>Ended Sessions ({revivedSessions.length})</span><span className="rule" />
                <button className="clear" onClick={props.onClearAllRevived}>Clear all</button>
              </div>
              <div className="board">
                {revivedSessions.map(({ session, revivedAt }) => {
                  const clicks = props.reviveClicks[session.info.id] ?? 0;
                  const remaining = props.reviveClicksRequired - clicks;
                  const label = clicks === 0 ? "Revive" : remaining === 1 ? "Confirm!" : `Revive (${clicks}/${props.reviveClicksRequired})`;
                  return (
                    <div key={session.info.id} style={{ position: "relative" }}>
                      <StudioCard {...cardProps(session, false)} />
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

          <footer className="colophon">
            Set in <b>Fraunces</b> &amp; <b>Spectral</b>, with <b>IBM&nbsp;Plex&nbsp;Mono</b> for the figures. &nbsp;—&nbsp; printed on warm paper.
          </footer>
        </div>
      </div>
    </div>
  );
}
