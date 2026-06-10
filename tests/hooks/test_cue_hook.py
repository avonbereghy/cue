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

    # Minimal agent transcripts for tail-state liveness. A finished agent's
    # last assistant entry carries stop_reason=end_turn; a running agent's
    # tail is still mid-turn (tool_use / no assistant yet).
    _FINISHED = (
        '{"type":"assistant","timestamp":1.0,"message":'
        '{"content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}}\n'
    )
    _RUNNING = (
        '{"type":"assistant","timestamp":1.0,"message":'
        '{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}],'
        '"stop_reason":"tool_use"}}\n'
    )

    def test_quiet_but_unfinished_jsonl_is_still_active(self, hook, tmp_path):
        # Real agent batches show 71-167s silent gaps inside long tool calls.
        # A quiet file whose tail has NOT reached end_turn must count as
        # active (the old pure-mtime check zeroed live counters here).
        transcript, subagents_dir = self._setup_subagents_dir(tmp_path)
        agent_file = subagents_dir / "agent1.jsonl"
        agent_file.write_text(self._RUNNING)
        old = time.time() - 120
        os.utime(agent_file, (old, old))
        assert hook._subagent_jsonls_active(transcript, time.time())

    def test_returns_false_when_quiet_jsonl_tail_finished(self, hook, tmp_path):
        transcript, subagents_dir = self._setup_subagents_dir(tmp_path)
        agent_file = subagents_dir / "agent1.jsonl"
        agent_file.write_text(self._FINISHED)
        old = time.time() - 60
        os.utime(agent_file, (old, old))
        assert not hook._subagent_jsonls_active(transcript, time.time())

    def test_returns_false_past_crash_backstop(self, hook, tmp_path):
        # Unfinished tail but silent past the 10-min backstop → agent died.
        transcript, subagents_dir = self._setup_subagents_dir(tmp_path)
        agent_file = subagents_dir / "agent1.jsonl"
        agent_file.write_text(self._RUNNING)
        old = time.time() - 700
        os.utime(agent_file, (old, old))
        assert not hook._subagent_jsonls_active(transcript, time.time())

    def test_returns_true_if_any_jsonl_is_fresh(self, hook, tmp_path):
        transcript, subagents_dir = self._setup_subagents_dir(tmp_path)
        stale = subagents_dir / "old.jsonl"
        fresh = subagents_dir / "new.jsonl"
        stale.write_text(self._FINISHED)
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

    def test_clears_leaked_counter_under_waiting_or_error(self, hook, tmp_path):
        # F-correctness-001: a SubagentStart that fired while the card was in
        # `waiting`/`error` increments activeSubagents but preserves that
        # user-attention state. If the SubagentStop is then missed, the heal
        # must STILL clear the stale counter — keying on the leaked counter, not
        # on state == "subagent" — or the next working/idle/done transition gets
        # pinned back to a false "subagent". (Previously this asserted the buggy
        # state-gated behavior that left the counter leaked.)
        for state in ("waiting", "error", "working"):
            existing = {"state": state, "activeSubagents": 3,
                        "stateChangedAt": time.time() - 90}
            hook._maybe_clear_stale_subagent_counter(
                existing, str(tmp_path / "x.jsonl"), time.time())
            assert existing["activeSubagents"] == 0, \
                f"stale leaked counter must clear under state={state!r}"

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


class TestPermissionRequestSeedsWaiting:
    """PermissionRequest fires only when a consent dialog is actually shown
    (verified live: auto-allowed tools produce no PermissionRequest), so it
    seeds `waiting` immediately instead of riding the ~6s-delayed
    Notification(permission_prompt) (audit F5)."""

    def test_permission_request_writes_waiting(self, hook_env, invoke_hook):
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "working",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
            "activeSubagents": 0,
        }})
        invoke_hook("waiting", make_payload(
            hook_event_name="PermissionRequest", tool_name="Bash",
            permission_mode="default"))
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "waiting"
        assert entry["permissionMode"] == "default"

    def test_permission_request_does_not_downgrade_error(self, hook_env, invoke_hook):
        # _quick_state_write's error stickiness must hold for this seed too.
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "error",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
            "activeSubagents": 0, "errorType": "rate_limit",
        }})
        invoke_hook("waiting", make_payload(
            hook_event_name="PermissionRequest", tool_name="Bash"))
        assert hook_env.read_sessions()["abc123"]["state"] == "error"


class TestLastToolWasAskQuestion:
    """Stop's waiting fast-path must fire only for UNANSWERED questions
    (audit F4 — it previously re-minted waiting after the answer landed)."""

    _ASK = (
        '{"type":"assistant","timestamp":1.0,"message":{"content":'
        '[{"type":"tool_use","id":"toolu_q1","name":"AskUserQuestion","input":{}}],'
        '"stop_reason":"tool_use"}}\n'
    )
    _ANSWER = (
        '{"type":"user","timestamp":2.0,"message":{"role":"user","content":'
        '[{"type":"tool_result","tool_use_id":"toolu_q1","content":"picked A"}]}}\n'
    )
    _TEXT_REPLY = (
        '{"type":"assistant","timestamp":3.0,"message":{"content":'
        '[{"type":"text","text":"Got it"}],"stop_reason":"end_turn"}}\n'
    )

    def test_unanswered_question_is_waiting(self, hook, tmp_path):
        t = tmp_path / "t.jsonl"
        t.write_text(self._ASK)
        assert hook._last_tool_was_ask_question(str(t))

    def test_answered_question_is_not_waiting(self, hook, tmp_path):
        # The write-lag case captured live: last assistant in the file is
        # still the question, but its tool_result is present → answered.
        t = tmp_path / "t.jsonl"
        t.write_text(self._ASK + self._ANSWER)
        assert not hook._last_tool_was_ask_question(str(t))

    def test_answered_question_with_final_text_is_not_waiting(self, hook, tmp_path):
        t = tmp_path / "t.jsonl"
        t.write_text(self._ASK + self._ANSWER + self._TEXT_REPLY)
        assert not hook._last_tool_was_ask_question(str(t))

    def test_no_assistant_entries(self, hook, tmp_path):
        t = tmp_path / "t.jsonl"
        t.write_text('{"type":"user","timestamp":1.0,"message":{"content":"hi"}}\n')
        assert not hook._last_tool_was_ask_question(str(t))


class TestPostCompactTrigger:
    """PostCompact maps by `trigger`: manual /compact between turns must land
    idle (audit F3 — it previously pinned a false 'working' for 5 minutes),
    while auto compaction mid-turn keeps working."""

    def _seed(self, hook_env, state="compacting"):
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": state,
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
            "activeSubagents": 0,
        }})

    def test_manual_compact_lands_idle(self, hook_env, invoke_hook):
        self._seed(hook_env)
        invoke_hook("working", make_payload(
            hook_event_name="PostCompact", trigger="manual"))
        assert hook_env.read_sessions()["abc123"]["state"] == "idle"

    def test_auto_compact_keeps_working(self, hook_env, invoke_hook):
        self._seed(hook_env)
        invoke_hook("working", make_payload(
            hook_event_name="PostCompact", trigger="auto"))
        assert hook_env.read_sessions()["abc123"]["state"] == "working"

    def test_missing_trigger_keeps_working(self, hook_env, invoke_hook):
        # Older Claude Code without the trigger field: keep the mid-turn-safe
        # mapping rather than risk demoting an auto-compaction.
        self._seed(hook_env)
        invoke_hook("working", make_payload(hook_event_name="PostCompact"))
        assert hook_env.read_sessions()["abc123"]["state"] == "working"


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
    """Notification subtypes are handled in two groups:

    - The two dialog subtypes write `waiting` eagerly so the card flips at
      dialog-open without waiting on the 1 Hz Rust re-parse. Both are backed
      by a JSONL signal Rust uses to demote, so neither pins forever:
      `elicitation_dialog` accompanies an AskUserQuestion / ExitPlanMode
      tool_use (tracked by `awaiting_user_prompt`), and `permission_prompt`
      parks a real tool_use unresolved at the transcript tail (tracked by
      `pending_tool_use`; the Rust resolver demotes the instant it clears).

    - The other four subtypes (`idle_prompt`, `auth_success`,
      `elicitation_complete`, `elicitation_response`, `future_unknown_type`)
      are not amber needs-you blocks — `idle_prompt` is just idle (Stop→idle
      covers it) and the rest are informational. They early-return."""

    def test_permission_prompt_writes_waiting(self, hook_env, invoke_hook):
        # The most common block — a tool needs consent ("Allow Bash?"). The
        # dialog parks a real tool_use unresolved at the transcript tail, so
        # the Rust resolver holds `waiting` while `pending_tool_use` is set and
        # demotes the instant it clears. Regression guard for the dual-source
        # refactor that dropped this and showed the card as `working`.
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook(
            "waiting",
            make_payload(hook_event_name="Notification", notification_type="permission_prompt"),
        )
        assert hook_env.read_sessions()["abc123"]["state"] == "waiting"

    def test_idle_prompt_does_not_change_state(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook(
            "waiting",
            make_payload(hook_event_name="Notification", notification_type="idle_prompt"),
        )
        assert hook_env.read_sessions()["abc123"]["state"] == "working"

    def test_elicitation_dialog_writes_waiting(self, hook_env, invoke_hook):
        # AskUserQuestion / ExitPlanMode dialog opening — eager hook write
        # so the card flips immediately. Rust will demote once the matching
        # tool_result lands in the JSONL.
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

    def test_unknown_notification_type_does_not_write(self, hook_env, invoke_hook):
        # Unknown subtypes early-return because we can't tell whether they
        # have a JSONL signal Rust can use to demote — the safe default is to
        # not pin the card.
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook(
            "waiting",
            make_payload(hook_event_name="Notification", notification_type="future_unknown_type"),
        )
        assert hook_env.read_sessions()["abc123"]["state"] == "working"


class TestPreToolUsePromptingTools:
    """PreToolUse for the prompting tools (AskUserQuestion / ExitPlanMode)
    promotes the card to `waiting` so it flips at dialog-open. This is
    redundant with the Notification(elicitation_dialog) eager write — kept
    because Claude Code versions vary in which (or both) of these fire."""

    def test_pretooluse_ask_user_question_writes_waiting(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook(
            "working",
            make_payload(hook_event_name="PreToolUse", tool_name="AskUserQuestion"),
        )
        assert hook_env.read_sessions()["abc123"]["state"] == "waiting"

    def test_pretooluse_exit_plan_mode_writes_waiting(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook(
            "working",
            make_payload(hook_event_name="PreToolUse", tool_name="ExitPlanMode"),
        )
        assert hook_env.read_sessions()["abc123"]["state"] == "waiting"

    def test_pretooluse_other_tool_stays_working(self, hook_env, invoke_hook):
        # Regression guard: only the two named prompting tools promote.
        # A Bash PreToolUse must NOT flip the card to waiting.
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "thinking",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook(
            "working",
            make_payload(hook_event_name="PreToolUse", tool_name="Bash"),
        )
        assert hook_env.read_sessions()["abc123"]["state"] == "working"


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
# PermissionRequest no longer changes state
# ─────────────────────────────────────────────────────────────────────

class TestPermissionRequestNoStateChange:
    """PermissionRequest seeds `waiting` (audit F5) — it fires only when a
    consent dialog is actually shown (verified live: auto-allowed tools
    produce no PermissionRequest), so the seed can't pin on auto-approvals.
    The Rust resolver demotes it exactly like the Notification seed: holds
    while the gated tool_use is pending, releases on approve/deny/interrupt.

    Legacy `pendingPermission` is deprecated: not written, and any value on
    existing entries is dropped by the next hook flush (no carry-forward)."""

    def test_permission_request_seeds_waiting(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook("waiting", make_payload(hook_event_name="PermissionRequest"))
        assert hook_env.read_sessions()["abc123"]["state"] == "waiting"

    def test_legacy_pending_permission_is_dropped_by_next_event(self, hook_env, invoke_hook):
        # Legacy entries from before this refactor may carry pendingPermission.
        # Any subsequent hook flushes a rebuilt entry that does not include it.
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0,
                       "pendingPermission": True}
        })
        invoke_hook("working", make_payload(hook_event_name="PostToolUse"))
        entry = hook_env.read_sessions()["abc123"]
        assert "pendingPermission" not in entry, "deprecated field must be dropped"

    def test_error_during_in_flight_permission_still_surfaces(self, hook_env, invoke_hook):
        # PostToolUseFailure during what was previously a stuck-waiting session
        # still cleanly transitions to error — no special marker handling needed.
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook("error", make_payload(hook_event_name="PostToolUseFailure"))
        assert hook_env.read_sessions()["abc123"]["state"] == "error"


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
    """The PermissionRequest waiting seed honors _quick_state_write's
    stale-write guard: a session whose lastActivity is NEWER than the hook's
    start time was already updated by a faster hook — don't overwrite."""

    def test_permission_request_yields_to_newer_write(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": time.time() + 60.0,
                       "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook("waiting", make_payload(hook_event_name="PermissionRequest"))
        assert hook_env.read_sessions()["abc123"]["state"] == "working"

    def test_permission_request_seeds_waiting_over_older_activity(self, hook_env, invoke_hook):
        # Normal case: the dialog is open and nothing newer has written —
        # the seed lands (audit F5; pre-F5 this event was state-neutral and
        # the card showed 'working' for the first ~6s of every dialog).
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": time.time() - 60.0,
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


# ─────────────────────────────────────────────────────────────────────
# F-correctness-002: the waiting fast-path must not clobber an error card
# ─────────────────────────────────────────────────────────────────────

class TestQuickWritePreservesError:
    """`_quick_state_write` (the eager `waiting` seed) bypasses the main write
    path's guards. It must still honor error stickiness — a permission/
    elicitation Notification on a session that hit a StopFailure must NOT
    downgrade the red error card to yellow `waiting` or drop `errorType`."""

    def test_permission_prompt_does_not_clobber_error(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "error",
                       "errorType": "rate_limit", "lastActivity": 0.0,
                       "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook(
            "waiting",
            make_payload(hook_event_name="Notification", notification_type="permission_prompt"),
        )
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "error", "error must outrank a waiting seed"
        assert entry["errorType"] == "rate_limit", "errorType must not be dropped"

    def test_elicitation_dialog_does_not_clobber_error(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "error",
                       "errorType": "billing_error", "lastActivity": 0.0,
                       "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook(
            "waiting",
            make_payload(hook_event_name="Notification", notification_type="elicitation_dialog"),
        )
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "error"
        assert entry["errorType"] == "billing_error"


# ─────────────────────────────────────────────────────────────────────
# F-protocol-002: tail reads must find the last assistant line past the window
# ─────────────────────────────────────────────────────────────────────

class TestTailReadWindow:
    """The bounded tail reads (`_read_last_tokens` / `_read_last_assistant`)
    must locate the last assistant line even when it sits far from EOF behind a
    wall of trailing non-assistant rows — the doubling window expands up to the
    1 MiB cap instead of silently returning {}/None."""

    def test_finds_last_assistant_beyond_initial_window(self, hook, tmp_path):
        path = tmp_path / "t.jsonl"
        asst = json.dumps({"type": "assistant", "message": {
            "model": "claude-opus-4-8",
            "usage": {"input_tokens": 100, "output_tokens": 7,
                      "cache_read_input_tokens": 50}}})
        # ~120 KiB of trailing non-assistant lines (each ~1 KiB) — well past the
        # 64 KiB initial window but within the 1 MiB cap.
        filler = json.dumps({"type": "system", "pad": "x" * 1000})
        path.write_text("\n".join([asst] + [filler] * 120))

        toks = hook._read_last_tokens(str(path))
        assert toks.get("model") == "claude-opus-4-8"
        assert toks.get("inputTokens") == 157   # 100 + 50 + 7
        assert toks.get("outputTokens") == 7
        assert hook._read_last_assistant(str(path)) is not None

    def test_returns_empty_when_no_assistant_within_cap(self, hook, tmp_path):
        path = tmp_path / "t.jsonl"
        filler = json.dumps({"type": "system", "pad": "x" * 1000})
        path.write_text("\n".join([filler] * 50))
        assert hook._read_last_tokens(str(path)) == {}
        assert hook._read_last_assistant(str(path)) is None


# ─────────────────────────────────────────────────────────────────────
# F-reliability-001: a lock-acquisition failure must not crash the hook
# ─────────────────────────────────────────────────────────────────────

class TestLockFailureDegradesGracefully:
    def test_main_drops_update_without_raising_when_lock_fails(
            self, hook_env, invoke_hook, monkeypatch, hook):
        # Seed a card, force the main-path lock to raise (Unix 2s flock timeout /
        # Windows 2s deadline), fire a PostToolUse: main() must return cleanly
        # (no uncaught traceback to Claude Code) and leave the card untouched —
        # the update is dropped, not half-written.
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "waiting",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })

        def boom(_lockfile):
            raise OSError("flock timeout")

        monkeypatch.setattr(hook, "_lock", boom)
        invoke_hook("working", make_payload(hook_event_name="PostToolUse"))  # must not raise
        assert hook_env.read_sessions()["abc123"]["state"] == "waiting"
