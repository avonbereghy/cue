//! Native-notification policy for session state transitions.
//!
//! The session monitor produces a fresh `EnrichedSession` list every ~1s. This
//! module diffs each session's state against the previous tick and decides
//! which transitions deserve an OS notification — the "a session needs you" and
//! "a long run finished" pings that pull the user back when the dashboard is
//! hidden in the tray (the whole point of a menu-bar monitor).
//!
//! Split into a pure decision (`decide`, fully unit-tested) plus a stateful
//! `Notifier` that owns the previous-state map, a per-session active-duration
//! memory, and a cached projection of user settings. Actually *firing* the
//! notification (I/O) happens in lib.rs's poll loop, which holds the Tauri
//! `AppHandle`; this module only decides *what* to fire and renders its text.
//!
//! Two invariants keep it quiet:
//!   * First sight of a session never fires — a transition needs a prior state.
//!     This is what stops a notification storm when Cue launches with sessions
//!     already mid-flight.
//!   * The "done" ping is gated on how long the turn actually ran. `duration_secs`
//!     is already 0 by the time a session reaches `done` (the monitor clears
//!     `active_since` on the terminal transition), so we remember the last
//!     active-tick duration and read it back when the terminal edge arrives.

use crate::models::{EnrichedSession, Settings};
use crate::session_monitor::LockSafe;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

/// States that represent real in-progress work. Only a transition *out of* one
/// of these (into `done`/`idle`) counts as "a turn finished" — so a `done`→`idle`
/// demote or a bare `idle` heartbeat can't fire a second ping.
const ACTIVE_WORK_STATES: [&str; 3] = ["working", "thinking", "subagent"];

/// User-facing notification preferences, projected from the full `Settings`.
/// Kept standalone so the decision logic doesn't depend on the giant Settings
/// type and tests can build it in one line.
#[derive(Debug, Clone, PartialEq)]
pub struct NotificationSettings {
    /// Master switch. When false, nothing fires regardless of the flags below.
    pub enabled: bool,
    /// Fire when a session becomes blocked on the user (→ `waiting`).
    pub notify_waiting: bool,
    /// Fire when a session enters the `error` state.
    pub notify_error: bool,
    /// Fire when a session finishes a turn (→ `done`/`idle`).
    pub notify_done: bool,
    /// Minimum active turn duration (seconds) before a "finished" ping fires.
    /// Only gates the done ping; waiting/error are immediate.
    pub done_min_secs: f64,
    /// Suppress the "finished" ping while the dashboard window is focused — if
    /// you're already looking at Cue, a card flipping to done is something you
    /// can see, so the banner is pure noise. Only gates `done`; a session that
    /// *needs you* or errors still pings even when the window is up. Defaults true.
    pub suppress_done_when_focused: bool,
    /// Fire a ping when a usage rate limit that had been reached clears, so you
    /// know paused sessions can resume. Defaults true.
    pub notify_rate_limit_reset: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        // Matches `Settings::default()` so the notifier behaves correctly during
        // the brief window before real settings are applied at startup.
        Self {
            enabled: true,
            notify_waiting: true,
            notify_error: true,
            notify_done: true,
            done_min_secs: 30.0,
            suppress_done_when_focused: true,
            notify_rate_limit_reset: true,
        }
    }
}

impl From<&Settings> for NotificationSettings {
    fn from(s: &Settings) -> Self {
        Self {
            enabled: s.notifications_enabled,
            notify_waiting: s.notify_waiting,
            notify_error: s.notify_error,
            notify_done: s.notify_done,
            done_min_secs: s.notify_done_min_secs,
            suppress_done_when_focused: s.suppress_done_when_focused,
            notify_rate_limit_reset: s.notify_rate_limit_reset,
        }
    }
}

/// Which kind of transition produced an event — drives the rendered copy and is
/// handy for logging/dedup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationKind {
    Waiting,
    Error,
    Done,
    /// A usage rate limit that had been reached has cleared — paused sessions
    /// can resume. A *global* signal, not tied to one session.
    RateLimitReset,
}

/// One notification ready to fire. `session_id` is retained so a future
/// click-to-focus handler can raise the right workspace window.
#[derive(Debug, Clone, PartialEq)]
pub struct NotificationEvent {
    pub session_id: String,
    pub title: String,
    pub body: String,
    pub kind: NotificationKind,
}

/// Pure transition decision. Returns the kind of notification a `prev → new`
/// state edge warrants, or `None` to stay silent. No I/O, no session data —
/// everything it needs is passed in, so the full truth table is unit-testable.
///
/// `turn_duration_secs` is the best-known active duration of the turn that just
/// ended; it only matters for the done gate.
fn decide(
    prev_state: Option<&str>,
    new_state: &str,
    turn_duration_secs: f64,
    settings: &NotificationSettings,
) -> Option<NotificationKind> {
    if !settings.enabled {
        return None;
    }
    // First sight of a session seeds state without firing.
    let prev = prev_state?;
    // No transition — steady state, nothing to announce.
    if prev == new_state {
        return None;
    }

    match new_state {
        "waiting" if settings.notify_waiting => Some(NotificationKind::Waiting),
        "error" if settings.notify_error => Some(NotificationKind::Error),
        "done" | "idle"
            if settings.notify_done
                && ACTIVE_WORK_STATES.contains(&prev)
                && turn_duration_secs >= settings.done_min_secs =>
        {
            Some(NotificationKind::Done)
        }
        _ => None,
    }
}

/// Render the user-facing title/body for a decided event from the session's
/// data. Kept separate from `decide` so the (stateless) copy can evolve without
/// touching the transition truth table.
fn build_event(s: &EnrichedSession, kind: NotificationKind, now: f64) -> NotificationEvent {
    use crate::summary_formatter::{last_line, last_question, strip_markdown, truncate};
    let label = session_label(s);
    let assistant = s.metrics.last_assistant_text.as_deref().unwrap_or("");

    let (title, body) = match kind {
        NotificationKind::Waiting => {
            // The point of "needs you" is the *ask* — the assistant's last
            // question (fall back to its last line), not the opening narration.
            let ask = last_question(assistant)
                .or_else(|| last_line(assistant))
                .map(|q| strip_markdown(&q))
                .filter(|q| !q.is_empty())
                .map(|q| truncate(&q, 120))
                .unwrap_or_else(|| "Waiting for your response".to_string());
            (format!("{} needs you", label), ask)
        }
        NotificationKind::Error => {
            let is_rate = s.info.error_type.as_deref() == Some("rate_limit");
            let title = if is_rate {
                format!("{} · rate limited", label)
            } else {
                format!("{} · error", label)
            };
            let body = if is_rate {
                // Prefer "when does it resume" over a bare "rate limited".
                rate_reset_hint(s, now).unwrap_or_else(|| "Rate limit reached".to_string())
            } else {
                first_nonempty([s.metrics.last_error_message.as_deref()])
                    .map(|m| truncate(&strip_markdown(m), 140))
                    .or_else(|| s.info.error_type.as_deref().map(humanize_error))
                    .unwrap_or_else(|| "Session hit an error".to_string())
            };
            (title, body)
        }
        NotificationKind::Done => {
            // The *result*, not the preamble: duration · todos · the conclusion.
            let mut bits: Vec<String> = Vec::new();
            if s.total_duration_secs >= 60.0 {
                bits.push(human_duration(s.total_duration_secs));
            }
            if s.todo_total > 0 {
                bits.push(format!("{}/{} todos", s.todo_completed, s.todo_total));
            }
            if let Some(outcome) = last_line(assistant)
                .map(|l| strip_markdown(&l))
                .filter(|l| !l.is_empty())
            {
                bits.push(truncate(&outcome, 100));
            }
            let body = if bits.is_empty() {
                "Finished".to_string()
            } else {
                bits.join(" · ")
            };
            (format!("{} — done", label), body)
        }
        NotificationKind::RateLimitReset => {
            // Global signal — no per-session detail; `s` is only a representative
            // for attribution and is otherwise ignored here.
            (
                "Rate limit cleared".to_string(),
                "Your usage limit reset — paused sessions can resume.".to_string(),
            )
        }
    };
    NotificationEvent {
        session_id: s.info.id.clone(),
        title,
        body,
        kind,
    }
}

/// Collapse several same-tick "finished" events into one summary ping listing
/// the session labels. The labels are recovered from each event's title, which
/// `build_event` formats as `"{label} — done"` (the `done_body_*` tests lock
/// that format, so this stays in sync).
fn coalesced_done_event(done: &[NotificationEvent]) -> NotificationEvent {
    use crate::summary_formatter::truncate;
    let labels: Vec<&str> = done
        .iter()
        .map(|e| e.title.strip_suffix(" — done").unwrap_or(e.title.as_str()))
        .collect();
    NotificationEvent {
        // No single session owns this summary; a future click-to-focus has no
        // one target, so leave it empty rather than pick arbitrarily.
        session_id: String::new(),
        title: format!("{} sessions finished", done.len()),
        body: truncate(&labels.join(", "), 140),
        kind: NotificationKind::Done,
    }
}

/// Compact human duration for a notification body ("45s", "21m", "1h 5m").
fn human_duration(secs: f64) -> String {
    let s = secs.max(0.0) as i64;
    if s < 60 {
        format!("{s}s")
    } else if s < 3600 {
        format!("{}m", s / 60)
    } else {
        format!("{}h {}m", s / 3600, (s % 3600) / 60)
    }
}

/// "Resumes in ~12m" from a rate-limit reset timestamp, or `None` if unknown.
fn rate_reset_hint(s: &EnrichedSession, now: f64) -> Option<String> {
    let rl = s.rate_limits.as_ref()?;
    let reset = rl.five_hour_reset_at.or(rl.seven_day_reset_at)?;
    let mins = ((reset - now) / 60.0).ceil() as i64;
    if mins <= 0 {
        Some("Resuming…".to_string())
    } else if mins < 60 {
        Some(format!("Resumes in ~{mins}m"))
    } else {
        Some(format!("Resumes in ~{}h {}m", mins / 60, mins % 60))
    }
}

/// A human title for the session: the agent/workspace label, with sane
/// fallbacks so the notification never reads as an empty string.
fn session_label(s: &EnrichedSession) -> String {
    for candidate in [s.display_title.as_str(), s.workspace_name.as_str()] {
        if !candidate.trim().is_empty() {
            return candidate.to_string();
        }
    }
    "Claude Code".to_string()
}

/// First trimmed-non-empty option in priority order.
fn first_nonempty<const N: usize>(opts: [Option<&str>; N]) -> Option<&str> {
    opts.into_iter().flatten().find(|s| !s.trim().is_empty())
}

/// Map a Claude Code `error_type` to a short human phrase for the body.
fn humanize_error(error_type: &str) -> String {
    match error_type {
        "rate_limit" => "Rate limit reached".to_string(),
        "billing_error" => "Billing problem".to_string(),
        "authentication_failed" => "Authentication failed".to_string(),
        other => {
            // Fallback: "some_error_code" → "Some error code".
            let mut s = other.replace('_', " ");
            if let Some(first) = s.get_mut(0..1) {
                first.make_ascii_uppercase();
            }
            s
        }
    }
}

/// macOS's built-in default alert sound. `mac-notification-sys` maps this *exact*
/// string to the system default; any other string is treated as a custom sound
/// name (and silently plays nothing if it isn't a real one), so it must be
/// spelled precisely — `"default"` would NOT work.
const DEFAULT_ALERT_SOUND: &str = "NSUserNotificationDefaultSoundName";

/// The system sound a notification of `kind` should play, or `None` for silent.
/// Only the pings that ask you to *act* — a session needs you, or one errored —
/// make a sound; the informational "finished" stays silent, so an audible cue
/// reliably means "you're needed," not "something wrapped up." (No priority or
/// interruption-level control exists on macOS desktop in tauri-plugin-notification
/// 2.x, so audible-vs-silent is the only register available.)
pub fn sound_name(kind: NotificationKind) -> Option<&'static str> {
    match kind {
        NotificationKind::Waiting | NotificationKind::Error => Some(DEFAULT_ALERT_SOUND),
        // "Finished" and "rate limit cleared" inform rather than interrupt.
        NotificationKind::Done | NotificationKind::RateLimitReset => None,
    }
}

/// Stateful notification engine. Owns the cross-tick memory needed to detect
/// transitions and gate the done ping. Cheap to call every poll: a handful of
/// `HashMap` lookups over the live session list.
pub struct Notifier {
    /// Last state we observed per session id. Absent ⇒ never seen ⇒ first sight.
    previous_states: Mutex<HashMap<String, String>>,
    /// Last `duration_secs` observed while a session was in an active work
    /// state, so the terminal transition can gate the done ping on turn length
    /// (by which point `duration_secs` itself has been reset to 0).
    active_durations: Mutex<HashMap<String, f64>>,
    /// Cached projection of user notification settings, refreshed by
    /// `update_settings` whenever the frontend saves.
    settings: Mutex<NotificationSettings>,
    /// Session ids whose next "→ waiting" ping should be skipped because the
    /// permission server already fired a specific "Permission needed" notification
    /// for the same block. One-shot: consumed when that waiting transition lands.
    waiting_suppress: Mutex<HashSet<String>>,
    /// Whether a usage rate limit was reached as of the last tick that carried
    /// rate-limit data. Global (the signal is not per-session). `None` until
    /// first observed, so the cleared edge can't fire on startup. Drives the
    /// "rate limit cleared" ping on a `Some(true) → false` transition.
    was_rate_limited: Mutex<Option<bool>>,
}

impl Default for Notifier {
    fn default() -> Self {
        Self::new()
    }
}

impl Notifier {
    pub fn new() -> Self {
        Self {
            previous_states: Mutex::new(HashMap::new()),
            active_durations: Mutex::new(HashMap::new()),
            settings: Mutex::new(NotificationSettings::default()),
            waiting_suppress: Mutex::new(HashSet::new()),
            was_rate_limited: Mutex::new(None),
        }
    }

    /// Replace the cached notification settings (called on every settings save).
    pub fn update_settings(&self, settings: NotificationSettings) {
        *self.settings.lock_safe() = settings;
    }

    /// Mark a session so its very next "→ waiting" ping is skipped. Called by the
    /// permission server right before it fires its own, more specific "Permission
    /// needed · <tool>" notification, so the user gets one ping, not two.
    pub fn suppress_next_waiting(&self, session_id: &str) {
        self.waiting_suppress
            .lock_safe()
            .insert(session_id.to_string());
    }

    /// Diff the current session list against the previous tick, assuming the
    /// dashboard is not focused (so every decided ping fires). Convenience over
    /// [`Self::diff_and_collect_with_focus`] for callers — and tests — that
    /// don't track window focus.
    #[cfg(test)]
    pub fn diff_and_collect(
        &self,
        sessions: &[EnrichedSession],
        now: f64,
    ) -> Vec<NotificationEvent> {
        self.diff_and_collect_with_focus(sessions, now, false)
    }

    /// Diff the current session list against the previous tick and return the
    /// notifications to fire. Updates all internal memory as a side effect, and
    /// forgets sessions that have dropped out of the list so the maps can't grow
    /// unbounded as sessions retire.
    ///
    /// `window_focused` is whether the dashboard window is up and frontmost. When
    /// it is, a "finished" ping is suppressed (you can see the card flip) unless
    /// the user has turned that off — but "needs you" and "error" still fire,
    /// since those can warrant attention even while you're looking at Cue.
    pub fn diff_and_collect_with_focus(
        &self,
        sessions: &[EnrichedSession],
        now: f64,
        window_focused: bool,
    ) -> Vec<NotificationEvent> {
        let settings = self.settings.lock_safe().clone();
        let mut prev = self.previous_states.lock_safe();
        let mut durations = self.active_durations.lock_safe();
        let mut suppress = self.waiting_suppress.lock_safe();
        let mut events = Vec::new();
        let mut seen: HashSet<&str> = HashSet::with_capacity(sessions.len());

        for s in sessions {
            let id = s.info.id.as_str();
            seen.insert(id);
            let new_state = s.info.state.as_str();

            // Remember how long this turn has been active so a later terminal
            // edge can gate the done ping. Recorded *before* deciding so the
            // terminal tick (new_state == done/idle) reads the prior value.
            if ACTIVE_WORK_STATES.contains(&new_state) {
                durations.insert(id.to_string(), s.duration_secs);
            }
            let turn_dur = durations.get(id).copied().unwrap_or(0.0);

            if let Some(kind) = decide(
                prev.get(id).map(String::as_str),
                new_state,
                turn_dur,
                &settings,
            ) {
                let suppressed = match kind {
                    // Skip a "→ waiting" ping the permission server already
                    // announced for this session (one-shot, consumed here).
                    NotificationKind::Waiting => suppress.remove(id),
                    // You're already looking at Cue — the card flipping to done
                    // is visible, so the banner is noise.
                    NotificationKind::Done => window_focused && settings.suppress_done_when_focused,
                    _ => false,
                };
                if !suppressed {
                    events.push(build_event(s, kind, now));
                }
            }

            // Once a turn has ended, drop its recorded duration so a later
            // idle/done heartbeat can't re-read a stale value.
            if matches!(new_state, "done" | "idle") {
                durations.remove(id);
            }
            prev.insert(id.to_string(), new_state.to_string());
        }

        prev.retain(|k, _| seen.contains(k.as_str()));
        durations.retain(|k, _| seen.contains(k.as_str()));
        suppress.retain(|k| seen.contains(k.as_str()));

        // Coalesce a burst: several sessions finishing in the same tick (a
        // fan-out of parallel runs completing together) shouldn't stack up a
        // column of banners — collapse them into one "N sessions finished"
        // summary. A single finish is left untouched so it keeps its rich body.
        if events
            .iter()
            .filter(|e| e.kind == NotificationKind::Done)
            .count()
            > 1
        {
            let done: Vec<NotificationEvent> = events
                .iter()
                .filter(|e| e.kind == NotificationKind::Done)
                .cloned()
                .collect();
            events.retain(|e| e.kind != NotificationKind::Done);
            events.push(coalesced_done_event(&done));
        }

        // Rate-limit reset is a *global* signal — the same RateLimitInfo is
        // cloned onto every session — so detect its reached→cleared edge once per
        // tick, not per session. Only sessions actually carrying rate-limit data
        // inform it; if none do this tick, leave the memory untouched so a limited
        // session merely dropping out of the list can't masquerade as a reset.
        // First observation seeds silently (the `None` start state).
        let observed = sessions
            .iter()
            .filter_map(|s| s.rate_limits.as_ref())
            .map(|rl| rl.limit_reached)
            .reduce(|a, b| a || b);
        if let Some(currently_limited) = observed {
            let mut was = self.was_rate_limited.lock_safe();
            let cleared = matches!(*was, Some(true)) && !currently_limited;
            if cleared && settings.enabled && settings.notify_rate_limit_reset {
                if let Some(rep) = sessions.iter().find(|s| s.rate_limits.is_some()) {
                    events.push(build_event(rep, NotificationKind::RateLimitReset, now));
                }
            }
            *was = Some(currently_limited);
        }

        events
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{SessionInfo, SessionMetrics, SupplementalData};

    fn settings_all_on() -> NotificationSettings {
        NotificationSettings {
            enabled: true,
            notify_waiting: true,
            notify_error: true,
            notify_done: true,
            done_min_secs: 30.0,
            suppress_done_when_focused: true,
            notify_rate_limit_reset: true,
        }
    }

    // --- decide(): the transition truth table -----------------------------

    #[test]
    fn first_sight_never_fires() {
        // No prior state ⇒ seed only, even into waiting/error.
        assert_eq!(decide(None, "waiting", 0.0, &settings_all_on()), None);
        assert_eq!(decide(None, "error", 0.0, &settings_all_on()), None);
        assert_eq!(decide(None, "done", 999.0, &settings_all_on()), None);
    }

    #[test]
    fn steady_state_never_fires() {
        assert_eq!(
            decide(Some("waiting"), "waiting", 0.0, &settings_all_on()),
            None
        );
        assert_eq!(
            decide(Some("working"), "working", 0.0, &settings_all_on()),
            None
        );
    }

    #[test]
    fn transition_into_waiting_fires() {
        assert_eq!(
            decide(Some("working"), "waiting", 0.0, &settings_all_on()),
            Some(NotificationKind::Waiting)
        );
        assert_eq!(
            decide(Some("thinking"), "waiting", 0.0, &settings_all_on()),
            Some(NotificationKind::Waiting)
        );
    }

    #[test]
    fn transition_into_error_fires() {
        assert_eq!(
            decide(Some("working"), "error", 0.0, &settings_all_on()),
            Some(NotificationKind::Error)
        );
    }

    #[test]
    fn done_fires_only_past_threshold_and_from_active() {
        // Long enough, from working ⇒ fire.
        assert_eq!(
            decide(Some("working"), "done", 45.0, &settings_all_on()),
            Some(NotificationKind::Done)
        );
        // Too short ⇒ silent.
        assert_eq!(
            decide(Some("working"), "done", 5.0, &settings_all_on()),
            None
        );
        // From a terminal/non-work state (done→idle demote) ⇒ silent even if
        // a stale long duration leaked in.
        assert_eq!(
            decide(Some("done"), "idle", 999.0, &settings_all_on()),
            None
        );
        // waiting→done is an answer landing instantly, not a long run ⇒ silent.
        assert_eq!(
            decide(Some("waiting"), "done", 999.0, &settings_all_on()),
            None
        );
    }

    #[test]
    fn working_to_idle_counts_as_finished() {
        // A turn that skips `done` and lands in `idle` still finished.
        assert_eq!(
            decide(Some("working"), "idle", 60.0, &settings_all_on()),
            Some(NotificationKind::Done)
        );
    }

    #[test]
    fn master_switch_silences_everything() {
        let off = NotificationSettings {
            enabled: false,
            ..settings_all_on()
        };
        assert_eq!(decide(Some("working"), "waiting", 0.0, &off), None);
        assert_eq!(decide(Some("working"), "error", 0.0, &off), None);
        assert_eq!(decide(Some("working"), "done", 999.0, &off), None);
    }

    #[test]
    fn per_event_toggles_are_independent() {
        let only_error = NotificationSettings {
            notify_waiting: false,
            notify_done: false,
            ..settings_all_on()
        };
        assert_eq!(decide(Some("working"), "waiting", 0.0, &only_error), None);
        assert_eq!(decide(Some("working"), "done", 99.0, &only_error), None);
        assert_eq!(
            decide(Some("working"), "error", 0.0, &only_error),
            Some(NotificationKind::Error)
        );
    }

    // --- build_event(): rendered copy -------------------------------------

    fn test_session(id: &str, workspace: &str, state: &str) -> SessionInfo {
        SessionInfo {
            id: id.to_string(),
            workspace: workspace.to_string(),
            state: state.to_string(),
            last_activity: 1000.0,
            started_at: 900.0,
            state_changed_at: None,
            source: None,
            hook_input_tokens: 0,
            hook_output_tokens: 0,
            hook_model: String::new(),
            active_subagents: 0,
            subprocess: None,
            team_name: None,
            agent_name: None,
            pid: None,
            permission_mode: None,
            error_type: None,
            pending_permission: None,
        }
    }

    fn enrich(info: SessionInfo, metrics: SessionMetrics) -> EnrichedSession {
        EnrichedSession::from_info_and_metrics(info, metrics, &SupplementalData::default())
    }

    #[test]
    fn waiting_body_uses_assistant_question_with_workspace_label() {
        let info = test_session("s1", "/Users/x/my-proj", "waiting");
        let metrics = SessionMetrics {
            last_assistant_text: Some("Which migration approach should I take?".to_string()),
            ..Default::default()
        };
        let ev = build_event(&enrich(info, metrics), NotificationKind::Waiting, 0.0);
        assert_eq!(ev.title, "my-proj needs you");
        assert!(ev.body.contains("migration approach"), "body: {}", ev.body);
        assert_eq!(ev.session_id, "s1");
    }

    #[test]
    fn waiting_body_falls_back_when_no_text() {
        let info = test_session("s1", "/Users/x/my-proj", "waiting");
        let ev = build_event(
            &enrich(info, SessionMetrics::default()),
            NotificationKind::Waiting,
            0.0,
        );
        assert_eq!(ev.body, "Waiting for your response");
    }

    #[test]
    fn error_title_distinguishes_rate_limit() {
        let mut info = test_session("s1", "/Users/x/my-proj", "error");
        info.error_type = Some("rate_limit".to_string());
        let ev = build_event(
            &enrich(info, SessionMetrics::default()),
            NotificationKind::Error,
            0.0,
        );
        assert_eq!(ev.title, "my-proj · rate limited");
        // No explicit message ⇒ humanized error_type.
        assert_eq!(ev.body, "Rate limit reached");
    }

    #[test]
    fn error_body_prefers_explicit_message() {
        let mut info = test_session("s1", "/Users/x/my-proj", "error");
        info.error_type = Some("billing_error".to_string());
        let metrics = SessionMetrics {
            last_error_message: Some("Your credit balance is too low".to_string()),
            ..Default::default()
        };
        let ev = build_event(&enrich(info, metrics), NotificationKind::Error, 0.0);
        assert_eq!(ev.title, "my-proj · error");
        assert!(ev.body.contains("credit balance"), "body: {}", ev.body);
    }

    #[test]
    fn done_body_uses_assistant_summary() {
        let info = test_session("s1", "/Users/x/my-proj", "done");
        let metrics = SessionMetrics {
            last_assistant_text: Some("All tests pass; pushed the fix.".to_string()),
            ..Default::default()
        };
        let ev = build_event(&enrich(info, metrics), NotificationKind::Done, 0.0);
        assert_eq!(ev.title, "my-proj — done");
        assert!(ev.body.contains("tests pass"), "body: {}", ev.body);
    }

    #[test]
    fn waiting_body_extracts_the_last_question() {
        // The ask is the point — not the opening narration, and no markdown.
        let info = test_session("s1", "/Users/x/proj", "waiting");
        let metrics = SessionMetrics {
            last_assistant_text: Some(
                "I mapped the schema. There are two options. **Which** migration approach should I take?"
                    .to_string(),
            ),
            ..Default::default()
        };
        let ev = build_event(&enrich(info, metrics), NotificationKind::Waiting, 0.0);
        assert_eq!(ev.body, "Which migration approach should I take?");
    }

    #[test]
    fn done_body_leads_with_duration_todos_and_outcome() {
        let info = test_session("s1", "/Users/x/proj", "done");
        let metrics = SessionMetrics {
            last_assistant_text: Some(
                "Wired it up.\nAll 214 tests green, ready for review.".to_string(),
            ),
            ..Default::default()
        };
        let mut e = enrich(info, metrics);
        e.total_duration_secs = 1260.0; // 21m
        e.todo_total = 8;
        e.todo_completed = 8;
        let ev = build_event(&e, NotificationKind::Done, 0.0);
        assert_eq!(ev.title, "proj — done");
        assert_eq!(
            ev.body,
            "21m · 8/8 todos · All 214 tests green, ready for review."
        );
    }

    #[test]
    fn rate_limited_body_shows_resume_time() {
        let mut info = test_session("s1", "/Users/x/proj", "error");
        info.error_type = Some("rate_limit".to_string());
        let mut e = enrich(info, SessionMetrics::default());
        e.rate_limits = Some(crate::models::RateLimitInfo {
            five_hour_percent: 100.0,
            seven_day_percent: 0.0,
            five_hour_reset_at: Some(720.0), // 12 min after now = 0
            seven_day_reset_at: None,
            limit_reached: true,
        });
        let ev = build_event(&e, NotificationKind::Error, 0.0);
        assert_eq!(ev.title, "proj · rate limited");
        assert_eq!(ev.body, "Resumes in ~12m");
    }

    // --- Notifier: stateful diffing ---------------------------------------

    fn enriched(id: &str, state: &str, duration_secs: f64) -> EnrichedSession {
        let mut e = enrich(
            test_session(id, "/Users/x/proj", state),
            SessionMetrics::default(),
        );
        e.duration_secs = duration_secs;
        e
    }

    /// A session carrying global rate-limit data with `limit_reached` as given.
    fn with_rate_limit(id: &str, state: &str, limit_reached: bool) -> EnrichedSession {
        let mut e = enriched(id, state, 0.0);
        e.rate_limits = Some(crate::models::RateLimitInfo {
            five_hour_percent: if limit_reached { 100.0 } else { 10.0 },
            seven_day_percent: 0.0,
            five_hour_reset_at: None,
            seven_day_reset_at: None,
            limit_reached,
        });
        e
    }

    fn count_kind(events: &[NotificationEvent], kind: NotificationKind) -> usize {
        events.iter().filter(|e| e.kind == kind).count()
    }

    #[test]
    fn first_poll_seeds_without_firing_then_transition_fires() {
        let n = Notifier::new();
        // Cue launches with a session already working ⇒ no storm.
        let events = n.diff_and_collect(&[enriched("s1", "working", 10.0)], 0.0);
        assert!(events.is_empty());
        // It keeps working (duration grows past the threshold) ⇒ still silent.
        let events = n.diff_and_collect(&[enriched("s1", "working", 40.0)], 0.0);
        assert!(events.is_empty());
        // Then it asks a question ⇒ one waiting ping.
        let events = n.diff_and_collect(&[enriched("s1", "waiting", 40.0)], 0.0);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, NotificationKind::Waiting);
    }

    #[test]
    fn done_ping_reads_last_active_duration_after_reset() {
        let n = Notifier::new();
        n.diff_and_collect(&[enriched("s1", "working", 5.0)], 0.0); // seed
                                                                    // Active long enough — duration captured on the working tick.
        n.diff_and_collect(&[enriched("s1", "working", 50.0)], 0.0);
        // Terminal tick: duration_secs has been reset to 0 by the monitor, but
        // the captured 50s should still gate the ping open.
        let events = n.diff_and_collect(&[enriched("s1", "done", 0.0)], 0.0);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, NotificationKind::Done);
        // A subsequent done→idle demote must not fire a second time.
        let events = n.diff_and_collect(&[enriched("s1", "idle", 0.0)], 0.0);
        assert!(events.is_empty());
    }

    #[test]
    fn short_turn_does_not_fire_done() {
        let n = Notifier::new();
        n.diff_and_collect(&[enriched("s1", "working", 3.0)], 0.0); // seed
        n.diff_and_collect(&[enriched("s1", "working", 8.0)], 0.0); // still short
        let events = n.diff_and_collect(&[enriched("s1", "done", 0.0)], 0.0);
        assert!(events.is_empty());
    }

    #[test]
    fn retired_session_is_forgotten() {
        let n = Notifier::new();
        n.diff_and_collect(&[enriched("s1", "working", 40.0)], 0.0);
        // s1 drops out of the list…
        n.diff_and_collect(&[], 0.0);
        assert!(n.previous_states.lock_safe().is_empty());
        assert!(n.active_durations.lock_safe().is_empty());
        // …and a brand-new session reusing the id is treated as first sight.
        let events = n.diff_and_collect(&[enriched("s1", "waiting", 0.0)], 0.0);
        assert!(events.is_empty());
    }

    #[test]
    fn sound_plays_only_for_the_act_now_pings() {
        // Needs-you and error interrupt → audible. Finished informs → silent.
        assert!(sound_name(NotificationKind::Waiting).is_some());
        assert!(sound_name(NotificationKind::Error).is_some());
        assert!(sound_name(NotificationKind::Done).is_none());
    }

    #[test]
    fn finished_ping_is_suppressed_while_dashboard_is_focused() {
        let n = Notifier::new();
        n.diff_and_collect(&[enriched("s1", "working", 5.0)], 0.0); // seed
        n.diff_and_collect(&[enriched("s1", "working", 50.0)], 0.0); // long enough
                                                                     // Window is up and frontmost — the done ping is noise; stay silent.
        let events = n.diff_and_collect_with_focus(&[enriched("s1", "done", 0.0)], 0.0, true);
        assert!(events.is_empty(), "done while focused should be suppressed");
        // The transition was still recorded: blurring later must NOT replay it.
        let events = n.diff_and_collect_with_focus(&[enriched("s1", "done", 0.0)], 0.0, false);
        assert!(
            events.is_empty(),
            "suppressed-while-focused done must not re-fire on blur"
        );
    }

    #[test]
    fn needs_you_still_fires_while_focused() {
        let n = Notifier::new();
        n.diff_and_collect(&[enriched("s1", "working", 10.0)], 0.0); // seed
                                                                     // A blocked session is worth a ping even when you're looking at Cue.
        let events = n.diff_and_collect_with_focus(&[enriched("s1", "waiting", 10.0)], 0.0, true);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, NotificationKind::Waiting);
    }

    #[test]
    fn finished_fires_while_focused_when_suppression_is_off() {
        let n = Notifier::new();
        n.update_settings(NotificationSettings {
            suppress_done_when_focused: false,
            ..settings_all_on()
        });
        n.diff_and_collect(&[enriched("s1", "working", 5.0)], 0.0); // seed
        n.diff_and_collect(&[enriched("s1", "working", 50.0)], 0.0);
        let events = n.diff_and_collect_with_focus(&[enriched("s1", "done", 0.0)], 0.0, true);
        assert_eq!(
            events.len(),
            1,
            "off switch lets finished fire even while focused"
        );
        assert_eq!(events[0].kind, NotificationKind::Done);
    }

    #[test]
    fn update_settings_takes_effect() {
        let n = Notifier::new();
        n.update_settings(NotificationSettings {
            enabled: false,
            ..settings_all_on()
        });
        n.diff_and_collect(&[enriched("s1", "working", 0.0)], 0.0); // seed
        let events = n.diff_and_collect(&[enriched("s1", "waiting", 0.0)], 0.0);
        assert!(events.is_empty(), "master switch off should silence");
    }

    #[test]
    fn permission_server_suppresses_the_generic_waiting_ping() {
        let n = Notifier::new();
        n.diff_and_collect(&[enriched("s1", "working", 10.0)], 0.0); // seed
                                                                     // Permission server fired its own specific "Permission needed" ping:
        n.suppress_next_waiting("s1");
        // The imminent → waiting transition must NOT double-fire.
        let events = n.diff_and_collect(&[enriched("s1", "waiting", 10.0)], 0.0);
        assert!(events.is_empty(), "suppressed waiting should stay silent");
        // One-shot: a later, un-suppressed wait fires normally.
        n.diff_and_collect(&[enriched("s1", "working", 10.0)], 0.0);
        let events = n.diff_and_collect(&[enriched("s1", "waiting", 10.0)], 0.0);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, NotificationKind::Waiting);
    }

    // --- rate-limit reset: the global cleared edge ------------------------

    #[test]
    fn rate_limit_reset_fires_on_the_cleared_edge() {
        let n = Notifier::new();
        // First observation is limited — seeds the global flag, fires nothing.
        let ev = n.diff_and_collect(&[with_rate_limit("s1", "working", true)], 0.0);
        assert_eq!(count_kind(&ev, NotificationKind::RateLimitReset), 0);
        // It clears — exactly one reset ping.
        let ev = n.diff_and_collect(&[with_rate_limit("s1", "working", false)], 0.0);
        assert_eq!(count_kind(&ev, NotificationKind::RateLimitReset), 1);
        // It stays clear — no repeat ping.
        let ev = n.diff_and_collect(&[with_rate_limit("s1", "working", false)], 0.0);
        assert_eq!(count_kind(&ev, NotificationKind::RateLimitReset), 0);
    }

    #[test]
    fn rate_limit_reset_seeds_silently_when_first_seen_clear() {
        let n = Notifier::new();
        // No prior "limited" observation ⇒ a clear reading must not fire.
        let ev = n.diff_and_collect(&[with_rate_limit("s1", "working", false)], 0.0);
        assert_eq!(count_kind(&ev, NotificationKind::RateLimitReset), 0);
    }

    #[test]
    fn rate_limit_reset_respects_its_toggle() {
        let n = Notifier::new();
        n.update_settings(NotificationSettings {
            notify_rate_limit_reset: false,
            ..settings_all_on()
        });
        n.diff_and_collect(&[with_rate_limit("s1", "working", true)], 0.0); // seed
        let ev = n.diff_and_collect(&[with_rate_limit("s1", "working", false)], 0.0);
        assert_eq!(count_kind(&ev, NotificationKind::RateLimitReset), 0);
    }

    #[test]
    fn a_limited_session_dropping_out_does_not_fake_a_reset() {
        let n = Notifier::new();
        n.diff_and_collect(&[with_rate_limit("s1", "working", true)], 0.0); // seed limited
                                                                            // The limited session vanishes — no rate-limit data this tick.
        let ev = n.diff_and_collect(&[], 0.0);
        assert_eq!(
            count_kind(&ev, NotificationKind::RateLimitReset),
            0,
            "a dropout is not a reset"
        );
        // A genuine clear reading later still fires (delayed, but correct).
        let ev = n.diff_and_collect(&[with_rate_limit("s2", "working", false)], 0.0);
        assert_eq!(count_kind(&ev, NotificationKind::RateLimitReset), 1);
    }

    // --- coalescing a burst of finishes -----------------------------------

    #[test]
    fn a_burst_of_finishes_in_one_tick_coalesces_into_one_ping() {
        let n = Notifier::new();
        // Three sessions active long enough to earn a done ping.
        n.diff_and_collect(
            &[
                enriched("s1", "working", 50.0),
                enriched("s2", "working", 50.0),
                enriched("s3", "working", 50.0),
            ],
            0.0,
        );
        // …all finish in the same tick.
        let ev = n.diff_and_collect(
            &[
                enriched("s1", "done", 0.0),
                enriched("s2", "done", 0.0),
                enriched("s3", "done", 0.0),
            ],
            0.0,
        );
        let done: Vec<&NotificationEvent> = ev
            .iter()
            .filter(|e| e.kind == NotificationKind::Done)
            .collect();
        assert_eq!(done.len(), 1, "three finishes collapse to one ping");
        assert_eq!(done[0].title, "3 sessions finished");
    }

    #[test]
    fn a_single_finish_keeps_its_own_ping() {
        let n = Notifier::new();
        n.diff_and_collect(&[enriched("s1", "working", 50.0)], 0.0);
        let ev = n.diff_and_collect(&[enriched("s1", "done", 0.0)], 0.0);
        assert_eq!(count_kind(&ev, NotificationKind::Done), 1);
        // Not the summary — the individual, richer "{label} — done".
        assert_eq!(ev[0].title, "proj — done");
    }
}
