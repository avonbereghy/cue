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

def make_payload(session_id="abc123", cwd="/Users/x/proj", transcript=""):
    return {
        "session_id": session_id,
        "cwd": cwd,
        "transcript_path": transcript,
        "hook_event_name": "PostToolUse",
    }


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
