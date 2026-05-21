"""Tests for the cue-hook Python script.

The hook is the canonical writer of sessions.json — every state the Rust
backend reasons about originates here. Coverage is organised by concern:

- session-id validation                  (F-security-001 hook side)
- non-destructive sessions.json validator (F-reliability-001)
- subagent counter behaviour              (F-correctness-001/002/004, F-tests-008)
- error-state preservation                (F-correctness-002, F-005)
- thinking-state propagation              (F-correctness-004)
- stateChangedAt in quick-write path      (F-correctness-006)
- stale-counter self-heal                 (F-reliability-004)
"""
import json
import os
import time
import pytest


# ─────────────────────────────────────────────────────────────────────
# Pure-function tests
# ─────────────────────────────────────────────────────────────────────

class TestSessionIdValidation:
    def test_accepts_uuid_shape(self, hook):
        assert hook._is_valid_session_id("579ecced-3a4b-4f02-8e9d-1d6c8a5e2b1f")
        assert hook._is_valid_session_id("abc_123-XYZ")

    def test_rejects_empty(self, hook):
        assert not hook._is_valid_session_id("")

    def test_rejects_oversized(self, hook):
        assert not hook._is_valid_session_id("a" * 129)

    def test_rejects_path_traversal(self, hook):
        assert not hook._is_valid_session_id("..")
        assert not hook._is_valid_session_id("../etc/passwd")
        assert not hook._is_valid_session_id("foo/../bar")

    def test_rejects_path_separators(self, hook):
        assert not hook._is_valid_session_id("foo/bar")
        assert not hook._is_valid_session_id("foo\\bar")
        assert not hook._is_valid_session_id("/etc/passwd")

    def test_rejects_control_chars(self, hook):
        assert not hook._is_valid_session_id("a\0b")
        assert not hook._is_valid_session_id("a\nb")
        assert not hook._is_valid_session_id("\x01abc")

    def test_rejects_non_string(self, hook):
        assert not hook._is_valid_session_id(None)
        assert not hook._is_valid_session_id(42)


class TestValidateSessionsPreserves:
    """The validator must not drop malformed entries — earlier versions
    did, which silently erased real sessions every time an unrelated
    session fired a hook."""

    def test_preserves_entry_missing_required_field(self, hook):
        # An entry missing `state` and `lastActivity` — earlier code
        # would have dropped it. We require it survives.
        sessions = {
            "abc": {"id": "abc", "workspace": "/Users/x/y"},
            "def": {"id": "def", "workspace": "/Users/x/z", "state": "working",
                    "lastActivity": 1.0, "startedAt": 1.0},
        }
        out = hook._validate_sessions({"sessions": sessions})
        assert "abc" in out["sessions"], "malformed entry must NOT be dropped"
        assert "def" in out["sessions"]

    def test_preserves_entry_with_wrong_field_type(self, hook):
        # state given as int instead of str — preserved (downstream code
        # uses .get() which tolerates the wrong shape).
        sessions = {"abc": {"id": "abc", "workspace": "/x", "state": 5,
                            "lastActivity": 1.0, "startedAt": 1.0}}
        out = hook._validate_sessions({"sessions": sessions})
        assert "abc" in out["sessions"]

    def test_drops_non_dict_top_level(self, hook):
        # Defensive: we only call it with a dict, but explicit is good.
        assert hook._validate_sessions("not-a-dict") == {"sessions": {}}
        assert hook._validate_sessions({"sessions": "not-a-dict"}) == {"sessions": {}}

    def test_drops_non_dict_entries(self, hook):
        # An entry that isn't a dict can't be safely .get()'d downstream.
        # These specific entries (list, string, None) ARE droppable.
        sessions = {"a": "string", "b": ["list"], "c": None,
                    "d": {"id": "d", "workspace": "/x", "state": "working",
                          "lastActivity": 1.0, "startedAt": 1.0}}
        out = hook._validate_sessions({"sessions": sessions})
        assert "d" in out["sessions"]
        assert "a" not in out["sessions"]
        assert "b" not in out["sessions"]
        assert "c" not in out["sessions"]

    def test_drops_entries_with_invalid_session_id_key(self, hook):
        # A session id key with `/` or `..` cannot safely be used as a
        # path component. Drop these — they can never produce a valid
        # downstream JSONL lookup anyway.
        sessions = {
            "../etc": {"id": "../etc", "workspace": "/x"},
            "valid-id": {"id": "valid-id", "workspace": "/x"},
        }
        out = hook._validate_sessions({"sessions": sessions})
        assert "valid-id" in out["sessions"]
        assert "../etc" not in out["sessions"]


class TestSubagentJsonlsActive:
    def _setup_subagents_dir(self, tmp_path, transcript_name="abc.jsonl"):
        # Replicate jsonl_parser.rs layout:
        # parent_dir/<stem>/subagents/*.jsonl
        transcript_path = tmp_path / transcript_name
        transcript_path.touch()
        stem = os.path.splitext(transcript_name)[0]
        subagents_dir = tmp_path / stem / "subagents"
        subagents_dir.mkdir(parents=True)
        return str(transcript_path), subagents_dir

    def test_returns_false_when_no_subagents_dir(self, hook, tmp_path):
        transcript = tmp_path / "abc.jsonl"
        transcript.touch()
        assert not hook._subagent_jsonls_active(str(transcript), time.time())

    def test_returns_false_when_no_transcript_path(self, hook):
        assert not hook._subagent_jsonls_active("", time.time())
        assert not hook._subagent_jsonls_active(None, time.time())

    def test_returns_true_when_fresh_jsonl_present(self, hook, tmp_path):
        transcript, subagents_dir = self._setup_subagents_dir(tmp_path)
        (subagents_dir / "agent1.jsonl").write_text("{}")
        # Just-created file → fresh.
        assert hook._subagent_jsonls_active(transcript, time.time())

    def test_returns_false_when_jsonl_stale_past_window(self, hook, tmp_path):
        transcript, subagents_dir = self._setup_subagents_dir(tmp_path)
        agent_file = subagents_dir / "agent1.jsonl"
        agent_file.write_text("{}")
        # Set mtime to 60s ago — window default is 30s.
        old = time.time() - 60
        os.utime(agent_file, (old, old))
        assert not hook._subagent_jsonls_active(transcript, time.time())

    def test_returns_true_if_any_jsonl_is_fresh(self, hook, tmp_path):
        transcript, subagents_dir = self._setup_subagents_dir(tmp_path)
        stale = subagents_dir / "old.jsonl"
        fresh = subagents_dir / "new.jsonl"
        stale.write_text("{}")
        fresh.write_text("{}")
        old = time.time() - 60
        os.utime(stale, (old, old))
        assert hook._subagent_jsonls_active(transcript, time.time())


class TestStaleSubagentSelfHeal:
    """`_maybe_clear_stale_subagent_counter` mutates `existing` in place."""

    def test_clears_counter_when_stale_and_no_jsonl(self, hook, tmp_path):
        existing = {"state": "subagent", "activeSubagents": 3,
                    "stateChangedAt": time.time() - 90}
        hook._maybe_clear_stale_subagent_counter(existing, str(tmp_path / "x.jsonl"), time.time())
        assert existing["activeSubagents"] == 0

    def test_does_not_clear_when_within_grace(self, hook, tmp_path):
        existing = {"state": "subagent", "activeSubagents": 3,
                    "stateChangedAt": time.time() - 30}  # within 60s grace
        hook._maybe_clear_stale_subagent_counter(existing, str(tmp_path / "x.jsonl"), time.time())
        assert existing["activeSubagents"] == 3

    def test_does_not_clear_when_not_subagent_state(self, hook, tmp_path):
        existing = {"state": "working", "activeSubagents": 3,
                    "stateChangedAt": time.time() - 90}
        hook._maybe_clear_stale_subagent_counter(existing, str(tmp_path / "x.jsonl"), time.time())
        assert existing["activeSubagents"] == 3

    def test_does_not_clear_when_jsonl_recently_active(self, hook, tmp_path):
        # Set up a fresh subagent JSONL — the self-heal must back off.
        transcript = tmp_path / "abc.jsonl"
        transcript.touch()
        subagents = tmp_path / "abc" / "subagents"
        subagents.mkdir(parents=True)
        (subagents / "agent.jsonl").write_text("{}")

        existing = {"state": "subagent", "activeSubagents": 3,
                    "stateChangedAt": time.time() - 90}
        hook._maybe_clear_stale_subagent_counter(existing, str(transcript), time.time())
        assert existing["activeSubagents"] == 3

    def test_does_not_clear_when_state_changed_at_missing(self, hook, tmp_path):
        existing = {"state": "subagent", "activeSubagents": 3}
        hook._maybe_clear_stale_subagent_counter(existing, str(tmp_path / "x.jsonl"), time.time())
        assert existing["activeSubagents"] == 3


# ─────────────────────────────────────────────────────────────────────
# End-to-end tests via main()
# ─────────────────────────────────────────────────────────────────────

def make_payload(session_id="abc123", cwd="/Users/x/proj", transcript="", **extras):
    """Build a minimal hook payload. `extras` overrides or supplements fields
    (hook_event_name, notification_type, source, error_type, tool_name,
    permission_mode, ...) so individual tests can mint payloads for any
    event without copy-pasting the boilerplate.
    """
    payload = {
        "session_id": session_id,
        "cwd": cwd,
        "transcript_path": transcript,
        "hook_event_name": "PostToolUse",
    }
    payload.update(extras)
    return payload


class TestSubagentCounter:
    """Counter increments/decrements and the clamp at zero."""

    def test_subagent_start_increments_counter(self, hook_env, invoke_hook):
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "working",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
            "activeSubagents": 0,
        }})
        invoke_hook("subagent", make_payload())
        entry = hook_env.read_sessions()["abc123"]
        assert entry["activeSubagents"] == 1
        assert entry["state"] == "subagent"

    def test_subagent_stop_decrements_counter(self, hook_env, invoke_hook):
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "subagent",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
            "activeSubagents": 2,
        }})
        invoke_hook("subagent_stop", make_payload())
        entry = hook_env.read_sessions()["abc123"]
        assert entry["activeSubagents"] == 1
        assert entry["state"] == "subagent"  # still positive

    def test_subagent_stop_clamps_at_zero(self, hook_env, invoke_hook):
        # Stop fires twice from a state of 1 — second call must NOT go negative.
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "subagent",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
            "activeSubagents": 1,
        }})
        invoke_hook("subagent_stop", make_payload())
        invoke_hook("subagent_stop", make_payload())
        entry = hook_env.read_sessions()["abc123"]
        assert entry["activeSubagents"] == 0

    def test_subagent_stop_without_prior_start_does_not_go_negative(self, hook_env, invoke_hook):
        # Crash-and-retry: stop fires without a matching start.
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "working",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
            "activeSubagents": 0,
        }})
        invoke_hook("subagent_stop", make_payload())
        entry = hook_env.read_sessions()["abc123"]
        assert entry["activeSubagents"] == 0


class TestWaitingNotClobbered:
    """`waiting` state must survive subagent counter activity (F-correctness-001)."""

    def test_subagent_stop_preserves_waiting_state(self, hook_env, invoke_hook):
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "waiting",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
            "activeSubagents": 2,
        }})
        invoke_hook("subagent_stop", make_payload())
        entry = hook_env.read_sessions()["abc123"]
        # The earlier-version bug: bare return → counter stuck at 2 forever.
        # Fix: counter decrements AND state stays "waiting".
        assert entry["activeSubagents"] == 1
        assert entry["state"] == "waiting"

    def test_subagent_stop_to_zero_preserves_waiting(self, hook_env, invoke_hook):
        # Last subagent stops while session is waiting on a permission prompt.
        # Old behaviour: returned early without writing → counter stuck.
        # New behaviour: persist counter=0, keep state=waiting.
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "waiting",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
            "activeSubagents": 1,
        }})
        invoke_hook("subagent_stop", make_payload())
        entry = hook_env.read_sessions()["abc123"]
        assert entry["activeSubagents"] == 0
        assert entry["state"] == "waiting"

    def test_done_does_not_clobber_waiting(self, hook_env, invoke_hook):
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "waiting",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
        }})
        invoke_hook("done", make_payload())
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "waiting"

    def test_idle_does_not_clobber_waiting(self, hook_env, invoke_hook):
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "waiting",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
        }})
        invoke_hook("idle", make_payload())
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "waiting"


class TestErrorNotClobbered:
    """`error` state must survive subagent counter activity AND done/idle
    overrides (F-correctness-002, F-005). CLAUDE.md explicitly says both
    `waiting` and `error` are NOT overridden by counter logic."""

    def test_subagent_start_does_not_clobber_error(self, hook_env, invoke_hook):
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "error",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
            "activeSubagents": 0,
        }})
        invoke_hook("subagent", make_payload())
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "error"
        assert entry["activeSubagents"] == 1

    def test_subagent_stop_preserves_error_state(self, hook_env, invoke_hook):
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "error",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
            "activeSubagents": 1,
        }})
        invoke_hook("subagent_stop", make_payload())
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "error"
        assert entry["activeSubagents"] == 0

    def test_done_does_not_clobber_error(self, hook_env, invoke_hook):
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "error",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
        }})
        invoke_hook("done", make_payload())
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "error"

    def test_idle_does_not_clobber_error(self, hook_env, invoke_hook):
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "error",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
        }})
        invoke_hook("idle", make_payload())
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "error"


class TestThinkingPropagates:
    """`thinking` must NOT be overridden by the subagent counter — the
    Rust thinking→working latch needs to observe `thinking` so the orange
    beat propagates and promotion happens on the first assistant text."""

    def test_thinking_propagates_through_active_subagents(self, hook_env, invoke_hook):
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "subagent",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
            "activeSubagents": 2,
        }})
        invoke_hook("thinking", make_payload())
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "thinking", "thinking must not be overridden to subagent"

    def test_working_still_overridden_to_subagent(self, hook_env, invoke_hook):
        # The working→subagent override IS still in effect — just not for thinking.
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "subagent",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
            "activeSubagents": 2,
        }})
        invoke_hook("working", make_payload())
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "subagent"


class TestStateChangedAtCarryForward:
    """stateChangedAt is reset on actual transitions but carried forward
    when the new event re-asserts the same state (poll_status uses it as
    the boundary for active-duration timers and turn-ended demotion)."""

    def test_carries_forward_on_same_state(self, hook_env, invoke_hook):
        original = time.time() - 50
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "working",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
            "stateChangedAt": original,
        }})
        invoke_hook("working", make_payload())
        entry = hook_env.read_sessions()["abc123"]
        assert entry["stateChangedAt"] == original

    def test_resets_on_actual_transition(self, hook_env, invoke_hook):
        prior = time.time() - 50
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "working",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
            "stateChangedAt": prior,
        }})
        invoke_hook("done", make_payload())
        entry = hook_env.read_sessions()["abc123"]
        assert entry["stateChangedAt"] > prior


class TestStaleCounterSelfHeal:
    """Once an entry has been pinned on `subagent` for >60s with no
    subagent JSONL activity, the next hook event must transition out
    cleanly (counter reset to 0)."""

    def test_stale_counter_reset_lets_working_transition(self, hook_env, invoke_hook):
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "subagent",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
            "stateChangedAt": time.time() - 120,
            "activeSubagents": 3,
        }})
        # transcript_path is empty → _subagent_jsonls_active is False →
        # self-heal fires → counter becomes 0 → working transitions.
        invoke_hook("working", make_payload())
        entry = hook_env.read_sessions()["abc123"]
        assert entry["activeSubagents"] == 0
        assert entry["state"] == "working"


class TestInvalidSessionId:
    """Malicious or typo'd session ids must not be persisted — they
    would later be joined into a file path on the Rust side."""

    def test_main_skips_write_for_invalid_id(self, hook_env, invoke_hook):
        # We can't easily get a path-traversal id through Claude Code's
        # hook_event_name path, but a payload with id="../etc" must NOT
        # land in sessions.json. The main() call returns before write.
        hook_env.write_sessions({})
        payload = make_payload(session_id="../etc/passwd")
        invoke_hook("working", payload)
        sessions = hook_env.read_sessions()
        assert "../etc/passwd" not in sessions

    def test_main_accepts_valid_uuid_id(self, hook_env, invoke_hook):
        payload = make_payload(session_id="579ecced-3a4b-4f02-8e9d-1d6c8a5e2b1f")
        invoke_hook("working", payload)
        sessions = hook_env.read_sessions()
        assert "579ecced-3a4b-4f02-8e9d-1d6c8a5e2b1f" in sessions


# ─────────────────────────────────────────────────────────────────────
# F-tests-101 — SessionEnd → state=ended (the `remove` action)
# ─────────────────────────────────────────────────────────────────────

class TestRemoveAction:
    """`remove` tombstones the existing session as state="ended" instead of
    deleting. The frontend filters ended sessions into a "revived" section;
    a regression here would make every SessionEnd silently erase the card."""

    def test_remove_tombstones_existing_session(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {
                "id": "abc123",
                "workspace": "/Users/x/proj",
                "state": "working",
                "lastActivity": 100.0,
                "startedAt": 50.0,
                "activeSubagents": 0,
                "pid": 9999,
            }
        })
        invoke_hook("remove", make_payload(session_id="abc123", hook_event_name="SessionEnd"))
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "ended"
        # PID, workspace must be preserved so the revive path can resume.
        assert entry["workspace"] == "/Users/x/proj"

    def test_remove_noop_when_session_absent(self, hook_env, invoke_hook):
        # No prior entry — remove should NOT create one (no phantom ended cards).
        hook_env.write_sessions({})
        invoke_hook("remove", make_payload(session_id="abc123", hook_event_name="SessionEnd"))
        assert "abc123" not in hook_env.read_sessions()

    def test_remove_preserves_workspace_and_subprocess(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {
                "id": "abc123",
                "workspace": "/Users/x/proj",
                "state": "subagent",
                "lastActivity": 100.0,
                "startedAt": 50.0,
                "activeSubagents": 3,
                "subprocess": "retenir",
            }
        })
        invoke_hook("remove", make_payload(session_id="abc123", hook_event_name="SessionEnd"))
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "ended"
        assert entry["workspace"] == "/Users/x/proj"
        # The remove path doesn't touch the entry beyond the state — counter
        # and subprocess label carry through, which the revive UI surfaces.
        assert entry.get("activeSubagents") == 3
        assert entry.get("subprocess") == "retenir"


# ─────────────────────────────────────────────────────────────────────
# F-state-coverage-001 — Notification subtype dispatch
# ─────────────────────────────────────────────────────────────────────

class TestNotificationSubtypes:
    """The hook installer maps Notification → "waiting". The hook itself
    filters out informational subtypes (auth_success / elicitation_complete /
    elicitation_response) so they don't paint the card yellow when no user
    action is required."""

    def test_permission_prompt_writes_waiting(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook(
            "waiting",
            make_payload(hook_event_name="Notification", notification_type="permission_prompt"),
        )
        assert hook_env.read_sessions()["abc123"]["state"] == "waiting"

    def test_idle_prompt_writes_waiting(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook(
            "waiting",
            make_payload(hook_event_name="Notification", notification_type="idle_prompt"),
        )
        assert hook_env.read_sessions()["abc123"]["state"] == "waiting"

    def test_elicitation_dialog_writes_waiting(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook(
            "waiting",
            make_payload(hook_event_name="Notification", notification_type="elicitation_dialog"),
        )
        assert hook_env.read_sessions()["abc123"]["state"] == "waiting"

    def test_auth_success_does_not_write(self, hook_env, invoke_hook):
        # Pre-seed a working state. An informational notification must not
        # disturb it — auth_success is purely observational.
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 100.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook(
            "waiting",
            make_payload(hook_event_name="Notification", notification_type="auth_success"),
        )
        assert hook_env.read_sessions()["abc123"]["state"] == "working"

    def test_elicitation_complete_does_not_write(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 100.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook(
            "waiting",
            make_payload(hook_event_name="Notification", notification_type="elicitation_complete"),
        )
        assert hook_env.read_sessions()["abc123"]["state"] == "working"

    def test_elicitation_response_does_not_write(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 100.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook(
            "waiting",
            make_payload(hook_event_name="Notification", notification_type="elicitation_response"),
        )
        assert hook_env.read_sessions()["abc123"]["state"] == "working"

    def test_unknown_notification_type_writes_waiting(self, hook_env, invoke_hook):
        # If Claude Code adds a new prompt subtype, defaulting to "waiting"
        # is safer than defaulting to no-write (a missed prompt is worse
        # than an extra one).
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook(
            "waiting",
            make_payload(hook_event_name="Notification", notification_type="future_unknown_type"),
        )
        assert hook_env.read_sessions()["abc123"]["state"] == "waiting"


# ─────────────────────────────────────────────────────────────────────
# F-state-coverage-002 — StopFailure persists errorType
# ─────────────────────────────────────────────────────────────────────

class TestStopFailure:
    """StopFailure events carry an `error_type` (rate_limit, billing_error,
    authentication_failed, etc.). The hook must persist it on the entry so
    the UI can distinguish "Claude got rate limited" from "the Bash tool
    failed"."""

    def test_stop_failure_persists_error_type(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook(
            "error",
            make_payload(hook_event_name="StopFailure", error_type="rate_limit"),
        )
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "error"
        assert entry["errorType"] == "rate_limit"

    def test_error_carries_forward_prior_error_type(self, hook_env, invoke_hook):
        # PostToolUseFailure doesn't carry error_type. If a prior StopFailure
        # set "rate_limit" and the next event is a PostToolUseFailure with no
        # error_type, the stored value carries forward.
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "error",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0,
                       "errorType": "rate_limit"}
        })
        invoke_hook(
            "error",
            make_payload(hook_event_name="PostToolUseFailure"),
        )
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "error"
        assert entry["errorType"] == "rate_limit"

    def test_transition_to_working_drops_error_type(self, hook_env, invoke_hook):
        # Recovery: errorType must NOT persist past the error state.
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "error",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0,
                       "errorType": "rate_limit"}
        })
        invoke_hook("working", make_payload())
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "working"
        assert "errorType" not in entry

    def test_invalid_error_type_field_is_ignored(self, hook_env, invoke_hook):
        # Hostile payload with non-string error_type must NOT crash and
        # must NOT land in the entry.
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook(
            "error",
            make_payload(hook_event_name="StopFailure", error_type={"hostile": "object"}),
        )
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "error"
        assert "errorType" not in entry


# ─────────────────────────────────────────────────────────────────────
# F-state-coverage-003 — PostCompact resolves compacting state
# ─────────────────────────────────────────────────────────────────────

class TestPostCompact:
    """PostCompact arrives after a clean compact and writes "working", which
    Cue's normal state pipeline carries forward (no special handling needed
    in the hook beyond the HOOK_EVENTS mapping)."""

    def test_post_compact_demotes_from_compacting(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "compacting",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook(
            "working",
            make_payload(hook_event_name="PostCompact", trigger="auto"),
        )
        assert hook_env.read_sessions()["abc123"]["state"] == "working"


# ─────────────────────────────────────────────────────────────────────
# F-correctness-003 — subagent_stop preserves compacting/clearing
# ─────────────────────────────────────────────────────────────────────

class TestSubagentStopPreservesTransient:
    """A subagent finishing mid-/compact must NOT flash the card to working
    or idle. The hook's subagent_stop branch preserves compacting/clearing
    in addition to waiting/error."""

    def test_subagent_stop_preserves_compacting(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "compacting",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 1}
        })
        invoke_hook("subagent_stop", make_payload(hook_event_name="SubagentStop"))
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "compacting"
        assert entry["activeSubagents"] == 0  # counter decremented

    def test_subagent_stop_preserves_clearing(self, hook_env, invoke_hook):
        # `clearing` is a state Rust no longer treats specially after Track 2,
        # but the hook's preservation guard still applies symmetrically with
        # other transient states so an external producer can't be silently
        # clobbered.
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "clearing",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 1}
        })
        invoke_hook("subagent_stop", make_payload(hook_event_name="SubagentStop"))
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "clearing"
        assert entry["activeSubagents"] == 0


# ─────────────────────────────────────────────────────────────────────
# F-reliability-009 — pendingPermission sticky marker
# ─────────────────────────────────────────────────────────────────────

class TestPendingPermissionMarker:
    """While a PermissionRequest's HTTP forward is in flight, concurrent
    hook events from parallel tool calls must NOT overwrite the "waiting"
    state. The marker is set by _quick_state_write and respected by the
    main write path of OTHER events; cleared only by the resolving
    PermissionRequest's own main-write."""

    def test_concurrent_post_tool_use_preserves_waiting(self, hook_env, invoke_hook):
        # Simulate the race: PermissionRequest quick-wrote waiting+marker;
        # before the HTTP returns, PostToolUse for a parallel tool fires.
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "waiting",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0,
                       "pendingPermission": True}
        })
        invoke_hook("working", make_payload(hook_event_name="PostToolUse"))
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "waiting", "PostToolUse must not clobber waiting while marker set"
        assert entry["pendingPermission"] is True, "marker must persist until resolving event"

    def test_concurrent_thinking_preserves_waiting(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "waiting",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0,
                       "pendingPermission": True}
        })
        invoke_hook("thinking", make_payload(hook_event_name="UserPromptSubmit"))
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "waiting"
        assert entry["pendingPermission"] is True

    def test_error_overrides_marker(self, hook_env, invoke_hook):
        # PostToolUseFailure during the permission wait must still surface —
        # the user needs to know a tool errored even while staring at a prompt.
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "waiting",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0,
                       "pendingPermission": True}
        })
        invoke_hook("error", make_payload(hook_event_name="PostToolUseFailure"))
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "error"

    def test_resolving_waiting_clears_marker(self, hook_env, invoke_hook):
        # The PermissionRequest's main-write (action=waiting, event=PermissionRequest)
        # is the resolving event — HTTP must have returned for us to reach it.
        # Marker clears.
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "waiting",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0,
                       "pendingPermission": True}
        })
        invoke_hook(
            "waiting",
            make_payload(hook_event_name="PermissionRequest"),
        )
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "waiting"
        # Marker cleared — the resolving event proves the HTTP returned.
        assert "pendingPermission" not in entry


# ─────────────────────────────────────────────────────────────────────
# F-tests-105 — error transitions from working/idle/thinking
# ─────────────────────────────────────────────────────────────────────

class TestErrorTransitions:
    """`error` must transition cleanly from working/idle/thinking. Previously
    only the preservation arm (TestErrorNotClobbered) was tested; a regression
    that no-op'd the error action would still pass every existing test."""

    def test_error_from_working(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook("error", make_payload(hook_event_name="PostToolUseFailure"))
        assert hook_env.read_sessions()["abc123"]["state"] == "error"

    def test_error_from_idle(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "idle",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook("error", make_payload(hook_event_name="PostToolUseFailure"))
        assert hook_env.read_sessions()["abc123"]["state"] == "error"

    def test_error_from_thinking(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "thinking",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook("error", make_payload(hook_event_name="PostToolUseFailure"))
        assert hook_env.read_sessions()["abc123"]["state"] == "error"

    def test_error_resets_state_changed_at(self, hook_env, invoke_hook):
        # Transition from working → error is a state change; stateChangedAt
        # must update (not carry forward).
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0,
                       "stateChangedAt": 100.0}
        })
        invoke_hook("error", make_payload(hook_event_name="PostToolUseFailure"))
        entry = hook_env.read_sessions()["abc123"]
        assert entry["stateChangedAt"] != 100.0


# ─────────────────────────────────────────────────────────────────────
# F-tests-110 — sessions.json corruption recovery (.corrupt-<ts> rename)
# ─────────────────────────────────────────────────────────────────────

class TestCorruptionRecovery:
    """When sessions.json fails to parse the hook renames it aside as
    {STATUS_FILE}.corrupt-<ts> and starts fresh, so a single bad write
    can't permanently break the dashboard."""

    def test_invalid_json_renames_to_corrupt_suffix(self, hook_env, invoke_hook):
        import os as _os
        # Write garbage that json.load will choke on.
        with open(hook_env.file, "w", encoding="utf-8") as f:
            f.write("{not valid json[")
        invoke_hook("working", make_payload())
        # Original status file is now valid JSON (with the new entry).
        sessions = hook_env.read_sessions()
        assert "abc123" in sessions
        # A .corrupt-<ts> file should exist alongside.
        corrupt_files = [
            name for name in _os.listdir(hook_env.dir)
            if name.startswith("sessions.json.corrupt-")
        ]
        assert len(corrupt_files) == 1, f"expected exactly one .corrupt file, got {corrupt_files}"

    def test_file_not_found_does_not_trigger_rename(self, hook_env, invoke_hook):
        import os as _os
        # No prior sessions.json — the hook should start fresh WITHOUT
        # leaving a .corrupt sidecar (that path is for parse errors only).
        invoke_hook("working", make_payload())
        corrupt_files = [
            name for name in _os.listdir(hook_env.dir)
            if name.startswith("sessions.json.corrupt-")
        ]
        assert corrupt_files == []

    def test_unicode_decode_error_triggers_rename(self, hook_env, invoke_hook):
        import os as _os
        # Non-UTF-8 bytes also count as corruption.
        with open(hook_env.file, "wb") as f:
            f.write(b"\xff\xfe\xfd")
        invoke_hook("working", make_payload())
        assert "abc123" in hook_env.read_sessions()
        corrupt_files = [
            name for name in _os.listdir(hook_env.dir)
            if name.startswith("sessions.json.corrupt-")
        ]
        assert len(corrupt_files) == 1


# ─────────────────────────────────────────────────────────────────────
# F-tests-111 — main-path stale-waiting guard
# ─────────────────────────────────────────────────────────────────────

class TestStaleWaitingGuard:
    """A slow PermissionRequest HTTP can complete after a faster event
    already moved state to working. The main write path skips waiting
    writes when existing.lastActivity > hook_start_time."""

    def test_waiting_skipped_when_newer_activity_exists(self, hook_env, invoke_hook):
        # Pre-seed lastActivity in the future so the guard fires.
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": time.time() + 60.0,  # newer than hook_start_time
                       "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook("waiting", make_payload(hook_event_name="PermissionRequest"))
        # State must NOT have been moved back to waiting.
        assert hook_env.read_sessions()["abc123"]["state"] == "working"

    def test_waiting_applies_when_no_newer_activity(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": time.time() - 60.0,  # older than hook_start_time
                       "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook("waiting", make_payload(hook_event_name="PermissionRequest"))
        assert hook_env.read_sessions()["abc123"]["state"] == "waiting"


# ─────────────────────────────────────────────────────────────────────
# F-tests-107 — permission_mode propagation
# ─────────────────────────────────────────────────────────────────────

class TestPermissionMode:
    """permission_mode (snake_case) and permissionMode (camelCase) both
    flow through, carrying forward when absent from a later event."""

    def test_snake_case_persisted(self, hook_env, invoke_hook):
        hook_env.write_sessions({})
        invoke_hook("working", make_payload(permission_mode="bypassPermissions"))
        entry = hook_env.read_sessions()["abc123"]
        assert entry.get("permissionMode") == "bypassPermissions"

    def test_camel_case_persisted(self, hook_env, invoke_hook):
        hook_env.write_sessions({})
        invoke_hook("working", make_payload(permissionMode="plan"))
        entry = hook_env.read_sessions()["abc123"]
        assert entry.get("permissionMode") == "plan"

    def test_mode_carries_forward_when_absent_from_payload(self, hook_env, invoke_hook):
        # First event sets it; second event (e.g., Stop) omits it.
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0,
                       "permissionMode": "acceptEdits"}
        })
        invoke_hook("idle", make_payload(hook_event_name="Stop"))
        entry = hook_env.read_sessions()["abc123"]
        assert entry.get("permissionMode") == "acceptEdits"

    def test_invalid_type_treated_as_none(self, hook_env, invoke_hook):
        # Hostile payload with non-string permission_mode must NOT crash.
        hook_env.write_sessions({})
        invoke_hook("working", make_payload(permission_mode={"hostile": True}))
        entry = hook_env.read_sessions()["abc123"]
        assert "permissionMode" not in entry


# ─────────────────────────────────────────────────────────────────────
# F-tests-109 — workspace pinned across cwd changes
# ─────────────────────────────────────────────────────────────────────

class TestWorkspacePinning:
    """`workspace` is pinned via existing.get("workspace", workspace) to
    prevent the card title flipping when tools cd into subdirs. The pin
    is what the dedup key uses; flipping it would also break Rust JSONL
    path resolution."""

    def test_first_event_seeds_workspace_from_cwd(self, hook_env, invoke_hook):
        hook_env.write_sessions({})
        invoke_hook("working", make_payload(cwd="/Users/x/proj"))
        assert hook_env.read_sessions()["abc123"]["workspace"] == "/Users/x/proj"

    def test_subsequent_event_keeps_original_workspace(self, hook_env, invoke_hook):
        # First event seeds /Users/x/proj; second event arrives with a different
        # cwd (Bash cd'd somewhere) — workspace must NOT flip.
        hook_env.write_sessions({})
        invoke_hook("working", make_payload(cwd="/Users/x/proj"))
        invoke_hook("working", make_payload(cwd="/tmp/transient"))
        assert hook_env.read_sessions()["abc123"]["workspace"] == "/Users/x/proj"

    def test_remove_preserves_workspace(self, hook_env, invoke_hook):
        # Cross-ref TestRemoveAction — tombstoning keeps workspace.
        hook_env.write_sessions({})
        invoke_hook("working", make_payload(cwd="/Users/x/proj"))
        invoke_hook("remove", make_payload(cwd="/different", hook_event_name="SessionEnd"))
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "ended"
        assert entry["workspace"] == "/Users/x/proj"
