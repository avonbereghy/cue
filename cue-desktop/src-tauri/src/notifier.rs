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
fn build_event(s: &EnrichedSession, kind: NotificationKind) -> NotificationEvent {
    let label = session_label(s);
    let (title, body) = match kind {
        NotificationKind::Waiting => {
            let body = first_nonempty([s.metrics.last_assistant_text.as_deref()])
                .map(|t| crate::summary_formatter::truncate(t, 140))
                .unwrap_or_else(|| "Waiting for your response".to_string());
            (format!("{} needs you", label), body)
        }
        NotificationKind::Error => {
            let title = match s.info.error_type.as_deref() {
                Some("rate_limit") => format!("{} · rate limited", label),
                _ => format!("{} · error", label),
            };
            let body = first_nonempty([s.metrics.last_error_message.as_deref()])
                .map(|m| crate::summary_formatter::truncate(m, 140))
                .or_else(|| s.info.error_type.as_deref().map(humanize_error))
                .unwrap_or_else(|| "Session hit an error".to_string());
            (title, body)
        }
        NotificationKind::Done => {
            let body = first_nonempty([s.metrics.last_assistant_text.as_deref()])
                .map(|t| crate::summary_formatter::truncate(t, 140))
                .unwrap_or_else(|| "Finished".to_string());
            (format!("{} finished", label), body)
        }
    };
    NotificationEvent {
        session_id: s.info.id.clone(),
        title,
        body,
        kind,
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
        }
    }

    /// Replace the cached notification settings (called on every settings save).
    pub fn update_settings(&self, settings: NotificationSettings) {
        *self.settings.lock_safe() = settings;
    }

    /// Diff the current session list against the previous tick and return the
    /// notifications to fire. Updates all internal memory as a side effect, and
    /// forgets sessions that have dropped out of the list so the maps can't grow
    /// unbounded as sessions retire.
    pub fn diff_and_collect(&self, sessions: &[EnrichedSession]) -> Vec<NotificationEvent> {
        let settings = self.settings.lock_safe().clone();
        let mut prev = self.previous_states.lock_safe();
        let mut durations = self.active_durations.lock_safe();
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
                events.push(build_event(s, kind));
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
        let ev = build_event(&enrich(info, metrics), NotificationKind::Waiting);
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
        let ev = build_event(&enrich(info, metrics), NotificationKind::Error);
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
        let ev = build_event(&enrich(info, metrics), NotificationKind::Done);
        assert_eq!(ev.title, "my-proj finished");
        assert!(ev.body.contains("tests pass"), "body: {}", ev.body);
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

    #[test]
    fn first_poll_seeds_without_firing_then_transition_fires() {
        let n = Notifier::new();
        // Cue launches with a session already working ⇒ no storm.
        let events = n.diff_and_collect(&[enriched("s1", "working", 10.0)]);
        assert!(events.is_empty());
        // It keeps working (duration grows past the threshold) ⇒ still silent.
        let events = n.diff_and_collect(&[enriched("s1", "working", 40.0)]);
        assert!(events.is_empty());
        // Then it asks a question ⇒ one waiting ping.
        let events = n.diff_and_collect(&[enriched("s1", "waiting", 40.0)]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, NotificationKind::Waiting);
    }

    #[test]
    fn done_ping_reads_last_active_duration_after_reset() {
        let n = Notifier::new();
        n.diff_and_collect(&[enriched("s1", "working", 5.0)]); // seed
                                                               // Active long enough — duration captured on the working tick.
        n.diff_and_collect(&[enriched("s1", "working", 50.0)]);
        // Terminal tick: duration_secs has been reset to 0 by the monitor, but
        // the captured 50s should still gate the ping open.
        let events = n.diff_and_collect(&[enriched("s1", "done", 0.0)]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, NotificationKind::Done);
        // A subsequent done→idle demote must not fire a second time.
        let events = n.diff_and_collect(&[enriched("s1", "idle", 0.0)]);
        assert!(events.is_empty());
    }

    #[test]
    fn short_turn_does_not_fire_done() {
        let n = Notifier::new();
        n.diff_and_collect(&[enriched("s1", "working", 3.0)]); // seed
        n.diff_and_collect(&[enriched("s1", "working", 8.0)]); // still short
        let events = n.diff_and_collect(&[enriched("s1", "done", 0.0)]);
        assert!(events.is_empty());
    }

    #[test]
    fn retired_session_is_forgotten() {
        let n = Notifier::new();
        n.diff_and_collect(&[enriched("s1", "working", 40.0)]);
        // s1 drops out of the list…
        n.diff_and_collect(&[]);
        assert!(n.previous_states.lock_safe().is_empty());
        assert!(n.active_durations.lock_safe().is_empty());
        // …and a brand-new session reusing the id is treated as first sight.
        let events = n.diff_and_collect(&[enriched("s1", "waiting", 0.0)]);
        assert!(events.is_empty());
    }

    #[test]
    fn update_settings_takes_effect() {
        let n = Notifier::new();
        n.update_settings(NotificationSettings {
            enabled: false,
            ..settings_all_on()
        });
        n.diff_and_collect(&[enriched("s1", "working", 0.0)]); // seed
        let events = n.diff_and_collect(&[enriched("s1", "waiting", 0.0)]);
        assert!(events.is_empty(), "master switch off should silence");
    }
}
