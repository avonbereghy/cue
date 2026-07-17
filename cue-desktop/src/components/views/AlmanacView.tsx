import React, { useCallback, useState } from "react";
import { openSession } from "@/lib/openSession";
import type { EnrichedSession, PermissionRequest, SubagentMetrics } from "@/lib/types";
import {
  isActiveState, STATE_DISPLAY_NAME, contextRampRgb, rgbCss,
  permissionModeMeta, aggregateMetrics, branchStatus, contextDisplay, splitSubagents,
} from "@/lib/sessionCardModel";
import { formatTokens, formatDuration, cleanPromptText, errorReason, formatModelName } from "@/lib/format";
import { DecisionBar } from "./DecisionBar";
import { CardExtras } from "./CardExtras";
import { SubagentDetail } from "./SubagentDetail";
import { PromptPopup } from "./PromptPopup";
import { orderSessions, duplicateTitleSet, type SkinViewProps } from "./skinView";
import { DismissButton } from "./DismissButton";
import { RestingDisclosure } from "./RestingDisclosure";

// ── State vocabulary: register word, ink, and whether it reads as "alive" ──
interface StateMeta { word: string; ink: string; alive: boolean }
const ST: Record<string, StateMeta> = {
  working:    { word: "AT WORK",    ink: "var(--ink-blue)",   alive: true },
  subagent:   { word: "DELEGATED",  ink: "var(--ink-teal)",   alive: true },
  waiting:    { word: "NEEDS YOU",  ink: "var(--ink-amber)",  alive: false },
  thinking:   { word: "PONDERING",  ink: "var(--ink-violet)", alive: true },
  compacting: { word: "COMPACTING", ink: "var(--ink-violet)", alive: true },
  clearing:   { word: "CLEARING",   ink: "var(--ink-violet)", alive: true },
  error:      { word: "SNAGGED",    ink: "var(--ink-red)",    alive: false },
  done:       { word: "COMPLETE",   ink: "var(--ink-green)",  alive: false },
  idle:       { word: "AT REST",    ink: "var(--ink-ghost)",  alive: false },
  ended:      { word: "ENDED",      ink: "var(--ink-red)",    alive: false },
};
const stMeta = (state: string): StateMeta => ST[state] ?? { word: (STATE_DISPLAY_NAME[state] ?? state).toUpperCase(), ink: "var(--ink-soft)", alive: isActiveState(state) };

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const roman = (n: number): string => ROMAN[n] ?? String(n);
const EFFORT_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };

/** Hand-stroked marginal glyph per state. Color comes from the wrapper's
 *  currentColor; "pulse" group breathes for alive states (see almanac.css). */
function StateGlyph({ state }: { state: string }) {
  const base = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const inner = (() => {
    switch (state) {
      case "working":
        return <g className="pulse" {...base}><path d="M5 19c5-1 9-5 12-13" /><path d="M9 15l-2 4 4-2" /><path d="M17 6c1.5-1 3-1 3-1s0 1.5-1 3" /></g>;
      case "subagent":
        return <g className="pulse" {...base}><circle cx="6" cy="12" r="2.2" /><circle cx="18" cy="6" r="2" /><circle cx="18" cy="18" r="2" /><path d="M8 11l8-4M8 13l8 4" /></g>;
      case "thinking":
      case "compacting":
      case "clearing":
        return <g className="pulse" {...base}><circle cx="12" cy="12" r="8" /><path d="M12 12l4-4" /><path d="M12 4v2M12 18v2M4 12h2M18 12h2" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /></g>;
      case "waiting":
        return <><g {...base}><path d="M6 3v18" /><path d="M6 4h12l-3 4 3 4H6" /></g><g {...base} strokeWidth={2.1}><path d="M10.5 9.5v2.5" /><circle cx="10.5" cy="14.4" r="0.4" fill="currentColor" /></g></>;
      case "error":
      case "ended":
        return <><g {...base}><path d="M4 12h6l1-3 2 6 1-3h6" /></g><g {...base} strokeWidth={2}><path d="M17 5l3 3M20 5l-3 3" /></g></>;
      case "done":
        return <><g {...base}><path d="M5 13l4 4 9-11" /></g><g {...base} strokeWidth={1.2} opacity={0.6}><path d="M3 12c0-3 1-5 2-6M21 12c0 3-1 5-2 6" /></g></>;
      default: // idle — anchor at rest
        return <g {...base}><circle cx="12" cy="5" r="2" /><path d="M12 7v12" /><path d="M7 12h10" /><path d="M5 14c0 3 3 5 7 5s7-2 7-5" /></g>;
    }
  })();
  return <svg viewBox="0 0 24 24">{inner}</svg>;
}

const BranchGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="8" r="2.4" /><path d="M6 8.4v7.2M8.4 6h4.2A4 4 0 0 1 18 10v0" /></svg>
);
const SourceGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M8 10l3 2-3 2M13 14h4" /></svg>
);
const ClockGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);

interface AlmanacCardProps {
  session: EnrichedSession;
  index: number;
  timerDisplay: string;
  permissionsEnabled: boolean;
  pending: PermissionRequest[];
  onApprove: (sessionId: string, requestId: string) => void;
  onDeny: (sessionId: string, requestId: string) => void;
  revived?: boolean;
  isDuplicate?: boolean;
  showConfigCounts?: boolean;
  showUsage?: boolean;
  /** Provided for live cards (renders the dismiss "X"); omitted for revived ones. */
  onDismiss?: (id: string) => void;
}

function AlmanacCardBase({ session, index, timerDisplay, permissionsEnabled, pending, onApprove, onDeny, revived, isDuplicate, showConfigCounts, showUsage, onDismiss }: AlmanacCardProps) {
  const { info, metrics } = session;
  const state = info.state;
  const meta = stMeta(state);
  const [copied, setCopied] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  // Which child-agent row is expanded to its quick-report (one per card).
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);

  const tilt = ((index % 3) - 1) * 0.22;
  const delay = `${(0.06 * Math.min(index, 12)).toFixed(2)}s`;

  const branch = branchStatus(session);
  const agg = aggregateMetrics(session);
  const { pct, tokens } = contextDisplay(session);
  const ctxInk = session.contextUsagePercent < 0.5 ? "var(--ink-green)" : session.contextUsagePercent < 0.75 ? "var(--ink-amber)" : "var(--ink-red)";
  const ctxFill = rgbCss(contextRampRgb(session.contextUsagePercent));

  const effortRank = session.effortLevel ? (EFFORT_RANK[session.effortLevel] ?? 0) : 0;
  const effortLabel = session.effortLevel === "xhigh" ? "x-high" : session.effortLevel;
  const permMeta = permissionModeMeta(info.permissionMode, state);

  const showRate = meta.alive && session.outputTokensPerSec > 0;
  const timer = timerDisplay === "off" ? null
    : timerDisplay === "minutes" ? formatDuration(session.durationSecs).slice(0, 5)
    : formatDuration(session.durationSecs);

  // Subtitle: team agent or branched-from parent.
  const teamName = info.teamName || metrics.teamName;
  const agentName = info.agentName || metrics.agentName;
  const branchedFrom = metrics.branchedFromSessionId;
  const subtitle = teamName ? `${agentName || "team agent"} · ${teamName}`
    : branchedFrom ? `Branch from ${branchedFrom.slice(0, 8)}`
    : null;

  const subs = metrics.subagents ?? [];
  const { active: subActive, completed: subDone } = splitSubagents(subs);
  const error = state === "error" ? errorReason(info.errorType, metrics.lastErrorMessage) : null;
  const waitSnippet = state === "waiting" ? (cleanPromptText(metrics.lastPrompt) || "Awaiting your approval") : null;
  const restSnippet = (state === "working" || state === "done")
    ? cleanPromptText(metrics.lastAssistantText) || cleanPromptText(metrics.lastPrompt)
    : null;
  // Disambiguating snippet for same-named sessions (only when no other body line shows).
  const dupRaw = isDuplicate && !metrics.customTitle && !metrics.branchedFromSessionId
    ? (state !== "thinking" && metrics.lastAssistantText ? metrics.lastAssistantText : metrics.lastPrompt)
    : null;
  const dupText = cleanPromptText(dupRaw);
  const showDup = !!dupText && !restSnippet && !waitSnippet && !error;
  // The conversation/message detail — one source, shown as a one-line preview at
  // the FOOT of the card (tap to read in full) so a long prompt never buries the
  // vitals above it.
  const convoText = waitSnippet ?? restSnippet ?? (showDup ? dupText : null);

  const todoTotal = session.todoTotal;
  const todoDone = session.todoCompleted;

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
          <span className={`slug ${a.isActive ? "" : "muted"}`}>{a.isActive && <span className="livedot" />}{a.slug || a.agentId.slice(0, 8)}</span>
          <span className="desc">{a.description}</span>
          <span className="nums">{formatModelName(a.model) !== "—" ? `${formatModelName(a.model)} · ` : ""}{formatTokens(a.inputTokens + a.outputTokens)} · {toolUses}t <span aria-hidden style={{ color: "var(--ink-faint)" }}>{open ? "▾" : "▸"}</span></span>
        </div>
        {open && <SubagentDetail agent={a} palette={{ text: "var(--ink)", muted: "var(--ink-soft)", faint: "var(--ink-faint)", rule: "var(--rule)", mono: "var(--mono)", accent: "var(--ink-teal)" }} />}
      </React.Fragment>
    );
  };

  return (
    <article
      className={`entry ${meta.alive ? "alive" : ""}`}
      data-state={state}
      style={{ "--tilt": `${tilt}deg`, "--delay": delay, cursor: "pointer" } as React.CSSProperties}
      onClick={onCardClick}
      aria-label={`${meta.word}: ${session.displayTitle}`}
    >
      {onDismiss && <DismissButton sessionId={info.id} title={session.displayTitle} onDismiss={onDismiss} />}
      <span className="entry-no">No. {revived ? "—" : roman(index + 1)}</span>

      <div className="entry-head">
        <span className="glyph" style={{ color: meta.ink }}><StateGlyph state={state} /></span>
        <div className="head-text">
          <h2 className="entry-title">{session.displayTitle}</h2>
          <div className="entry-where">
            <span className="proj">{session.workspaceName}</span>
            {branch && (
              <span className="branch"><BranchGlyph />{branch.branch}</span>
            )}
            {branch?.dirty && <span className="dirty" title="uncommitted changes">✻</span>}
            {(branch?.ahead ?? 0) > 0 && <span className="ahead" title="ahead of remote">↑{branch!.ahead}</span>}
            {(branch?.behind ?? 0) > 0 && <span className="behind" title="behind remote">↓{branch!.behind}</span>}
          </div>
        </div>
        <span className="state-stamp" style={{ color: meta.ink }}>{meta.word}</span>
      </div>

      <DecisionBar session={session} pending={permissionsEnabled ? pending : []} onApprove={onApprove} onDeny={onDeny} />

      {subtitle && <div className="entry-sub">{subtitle}</div>}

      <div className="meta-row">
        {session.modelDisplayName !== "—" && (
          <span><span className="lab">model</span> {session.modelDisplayName}{session.provider && <span className="lab"> ({session.provider})</span>}</span>
        )}
        {session.effortLevel && (
          <span><span className="lab">effort</span> {effortLabel}{" "}
            <span className="effort-pips" aria-hidden>
              {[1, 2, 3, 4].map((k) => <i key={k} className={k <= effortRank ? "on" : ""} />)}
            </span>
          </span>
        )}
        {permMeta && <span className={`perm-pill ${permMeta.tone}`} title={permMeta.title}>{permMeta.label}</span>}
        {timer && <span className="timer"><ClockGlyph />{timer}</span>}
      </div>

      {error && (
        <div className="callout callout--error"><span className="ttl">⚑ Snag in the field</span>{error}</div>
      )}

      {subs.length > 0 && (
        <div className="subs">
          <div className="subs-h">⌥ Dispatched parties · {subs.length}</div>
          {subActive.map((a, i) => renderSub(a, i, "a"))}
          {subDone.length > 0 && (
            <details>
              <summary style={{ cursor: "pointer", fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-faint)", padding: "4px 0" }}>{subDone.length} returned</summary>
              {subDone.map((a, i) => renderSub(a, i, "d"))}
            </details>
          )}
        </div>
      )}

      <div className="ctx">
        <div className="ctx-top">
          <span>Context Used</span>
          <span><span className="pct" style={{ color: ctxInk }}>{pct}%</span>&nbsp;<span className="frac">{tokens}</span></span>
        </div>
        <div className="ctx-bar">
          <div className="ctx-fill" style={{ "--w": session.contextUsagePercent, background: `linear-gradient(90deg, var(--ink-green), ${ctxFill})` } as React.CSSProperties} />
        </div>
      </div>

      <div className="stats">
        {showRate
          ? <div className="stat alive"><span className="k">Pace</span><span className="v">{session.outputTokensPerSec.toFixed(1)}<small> tok/s</small></span></div>
          : <div className="stat"><span className="k">Pace</span><span className="v" style={{ color: "var(--ink-ghost)" }}>— idle —</span></div>}
        <div className="stat"><span className="k">In / Out</span><span className="v">{formatTokens(agg.inputTokens)}<small> / {formatTokens(agg.outputTokens)}</small></span></div>
        <div className="stat"><span className="k">Tools</span><span className="v">{agg.toolUses}</span></div>
        <div className="stat"><span className="k">Messages</span><span className="v">{metrics.userMessageCount}<small> / {metrics.messageCount}</small></span></div>
        <div className="stat" style={{ gridColumn: "span 2" }}><span className="k">Output drafted</span><span className="v">{formatTokens(agg.outputTokens)}<small> tokens written</small></span></div>
      </div>

      <CardExtras session={session} showConfigCounts={!!showConfigCounts} showUsage={showUsage !== false} mono="var(--mono)" muted="var(--ink-soft)" faint="var(--ink-faint)" rule="var(--rule)" />

      <div className="entry-foot">
        {session.sourceDisplay !== "—" && <span className="src"><SourceGlyph /> {session.sourceDisplay}</span>}
        {info.id && (
          <button className="id" onClick={copyId} title={`Session id — click to copy: ${info.id}`}>id <b>{info.id.slice(0, 8)}</b>{copied && " ✓"}</button>
        )}
        {todoTotal > 0 ? (
          <span className="todos">✓ {todoDone}/{todoTotal}
            <span className="todo-track">{Array.from({ length: Math.min(todoTotal, 12) }, (_, k) => <i key={k} className={k < todoDone ? "done" : ""} />)}</span>
            {session.todoCurrent && <span className="todo-cur">↳ now: {session.todoCurrent}</span>}
          </span>
        ) : (
          <span className="todos" style={{ color: "var(--ink-ghost)" }}>— no checklist —</span>
        )}
      </div>

      {convoText && (
        <button className="convo" onClick={(e) => { e.stopPropagation(); setPromptOpen(true); }} title="Read the full message">
          <span className="convo-mark">“</span><span className="convo-text">{convoText}</span>
        </button>
      )}

      {promptOpen && convoText && (
        <PromptPopup text={convoText} label={waitSnippet ? "Last prompt" : "Latest message"} onClose={() => setPromptOpen(false)} bg="#efe6cf" border="rgba(120,90,50,0.3)" ink="#2b2118" muted="#8a7758" fontBody='"Spectral", Georgia, serif' italic />
      )}
    </article>
  );
}
const AlmanacCard = React.memo(AlmanacCardBase);

const MONTH_ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
function stampDate(): string {
  const d = new Date();
  return `${d.getDate()}·${MONTH_ROMAN[d.getMonth() + 1]}·${String(d.getFullYear()).slice(-2)}`;
}

export function AlmanacView(props: SkinViewProps) {
  const { sessions, revivedSessions, permissionsEnabled, pendingBySession, approvePermission, denyPermission, timerDisplay, grouped, showConfigCounts, showUsage } = props;

  const total = sessions.length;
  const active = sessions.filter((s) => isActiveState(s.info.state)).length;
  const ordered = orderSessions(sessions, grouped);
  const dupSet = duplicateTitleSet(sessions);

  return (
    <div className="almanac-view flex flex-col flex-1 min-h-0">
      <div className="sessions-scroll almanac-scroll flex-1 overflow-y-auto min-h-0">
        <div className="almanac-inner">
          <header className="masthead">
            <div className="datestamp" aria-hidden><span className="k">LOGGED</span><span className="d">{stampDate()}</span></div>
            <p className="eyebrow">A Naturalist's Register of Working Agents</p>
            <h1>The Field&nbsp;Log<span className="amp"> &amp; </span>Almanac</h1>
            <div className="subline">
              <span>Observations recorded in the field.</span>
              <span className="sep">·</span>
              <span className="tally"><span className="live-dot" /><b>{total}</b> session{total === 1 ? "" : "s"} logged &nbsp;·&nbsp; <b>{active}</b> presently astir</span>
            </div>
          </header>

          <main className="ledger">
            {total === 0 && revivedSessions.length === 0 && props.restingSessions.length === 0 && (
              <div className="alm-empty">
                <div className="mark">❧</div>
                <div className="h">The register is empty</div>
                <div className="p">Entries appear here as Claude Code sessions begin.</div>
              </div>
            )}

            {ordered.map((session, idx) => (
              <AlmanacCard
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
            <section className="alm-ended">
              <div className="alm-ended-head">
                <span className="rule" />
                <span>Ended Sessions ({revivedSessions.length})</span>
                <span className="rule" />
                <button className="clear" onClick={props.onClearAllRevived}>Clear all</button>
              </div>
              <div className="ledger">
                {revivedSessions.map(({ session, revivedAt }) => {
                  const clicks = props.reviveClicks[session.info.id] ?? 0;
                  const remaining = props.reviveClicksRequired - clicks;
                  const label = clicks === 0 ? "Revive" : remaining === 1 ? "Confirm!" : `Revive (${clicks}/${props.reviveClicksRequired})`;
                  return (
                    <div key={session.info.id} style={{ position: "relative", minWidth: 0 }}>
                      <AlmanacCard
                        session={session}
                        index={0}
                        timerDisplay={timerDisplay}
                        permissionsEnabled={false}
                        pending={[]}
                        onApprove={approvePermission}
                        onDeny={denyPermission}
                        showConfigCounts={showConfigCounts}
                        showUsage={showUsage}
                        revived
                      />
                      <div className="alm-revive-row">
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
            <span className="orn">❧ &nbsp; ✦ &nbsp; ❧</span>
            Kept faithfully, entry by entry · No detail too small for the margin.
          </footer>
        </div>
      </div>
    </div>
  );
}
