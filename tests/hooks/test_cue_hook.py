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


class TestSessionsGc:
    """_gc_sessions prunes ended tombstones >7d old and enforces the entry
    cap on terminal states, never touching active states or keep_id."""

    def _entry(self, state, age_secs, now):
        return {"id": "x", "workspace": "/x", "state": state,
                "lastActivity": now - age_secs, "startedAt": now - age_secs,
                "activeSubagents": 0}

    def test_prunes_old_ended_keeps_recent(self, hook):
        now = 1_000_000.0
        sessions = {
            "old-ended": self._entry("ended", 8 * 86400, now),
            "new-ended": self._entry("ended", 3600, now),
            "old-idle": self._entry("idle", 8 * 86400, now),
        }
        hook._gc_sessions(sessions, now)
        assert "old-ended" not in sessions
        assert "new-ended" in sessions
        assert "old-idle" in sessions  # 7d rule is ended-only

    def test_keeps_recent_active_and_keep_id(self, hook):
        # Active entries within the horizon are never pruned, and keep_id is
        # protected even when it's an old `ended` tombstone.
        now = 1_000_000.0
        sessions = {
            "live-working": self._entry("working", 3600, now),  # 1h old
            "current": self._entry("ended", 30 * 86400, now),   # old, but keep_id
        }
        hook._gc_sessions(sessions, now, keep_id="current")
        assert "live-working" in sessions
        assert "current" in sessions

    def test_prunes_crashed_active_past_horizon(self, hook):
        # FIX #6: a session killed with kill -9 keeps its non-terminal state
        # forever. Age it out once it's been idle past the 14-day horizon, so
        # sessions.json can't regain unbounded growth. Terminal rules never
        # reaped these before.
        now = 1_000_000.0
        sessions = {
            "crashed": self._entry("working", 15 * 86400, now),   # >14d, dead
            "recent": self._entry("working", 2 * 86400, now),     # <14d, kept
            "current": self._entry("working", 20 * 86400, now),   # keep_id wins
        }
        hook._gc_sessions(sessions, now, keep_id="current")
        assert "crashed" not in sessions
        assert "recent" in sessions
        assert "current" in sessions

    def test_cap_falls_back_to_oldest_any_state(self, hook):
        # A flood of still-recent stuck-active entries (younger than the horizon)
        # must not pin the file above the cap: once terminal eviction is
        # exhausted, the cap pass evicts oldest-of-any-state.
        now = 1_000_000.0
        cap = hook._GC_MAX_ENTRIES
        sessions = {
            f"w{i}": self._entry("working", i, now) for i in range(cap + 10)
        }
        hook._gc_sessions(sessions, now)
        assert len(sessions) == cap
        # No terminal entries exist, so the fallback evicts the oldest active
        # ones: largest-age (largest i) go first, newest survive.
        assert "w0" in sessions
        assert f"w{cap + 9}" not in sessions

    def test_entry_cap_evicts_oldest_terminal(self, hook):
        now = 1_000_000.0
        cap = hook._GC_MAX_ENTRIES
        sessions = {
            f"s{i}": self._entry("idle", i, now) for i in range(cap + 10)
        }
        hook._gc_sessions(sessions, now)
        assert len(sessions) == cap
        # Oldest (largest age) evicted first.
        assert "s0" in sessions
        assert f"s{cap + 9}" not in sessions

    def test_main_write_path_runs_gc(self, hook_env, invoke_hook):
        now = time.time()
        stale = {"id": "ghost1", "workspace": "/x", "state": "ended",
                 "lastActivity": now - 9 * 86400, "startedAt": now - 9 * 86400,
                 "activeSubagents": 0}
        hook_env.write_sessions({"ghost1": stale})
        invoke_hook("working", make_payload())
        sessions = hook_env.read_sessions()
        assert "ghost1" not in sessions
        assert "abc123" in sessions


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


class TestForwardPermissionProof:
    """FIX #3 — mutual-HMAC handshake with the permission server.

    The hook keys HMAC-SHA256 with the per-launch token (never sent on the
    wire): it signs "req:"+nonce to authenticate the request, and it MUST
    verify the server's "resp:"+nonce proof BEFORE emitting a decision. A
    process that couldn't read the 0600 token file can't produce the proof,
    so a missing/invalid proof must yield None → Claude Code falls back to its
    native permission prompt (mirroring the 504/timeout path)."""

    TOKEN = "deadbeefcafef00d0011223344556677"
    ALLOW_BODY = json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {"behavior": "allow"},
        }
    })

    def _install(self, hook, monkeypatch, proof_fn, body=None):
        """Patch the token read + urlopen. `proof_fn(nonce)` returns the
        X-Cue-Proof header value the fake server sends (or None to omit it).
        Returns a dict the test can inspect for the captured request headers."""
        import email.message
        import urllib.request

        monkeypatch.setattr(hook, "_read_permission_token", lambda: self.TOKEN)
        captured = {}
        resp_body = self.ALLOW_BODY if body is None else body

        class FakeResp:
            def __init__(self, proof):
                self.headers = email.message.Message()
                if proof is not None:
                    self.headers["X-Cue-Proof"] = proof
                self._body = resp_body

            def read(self):
                return self._body.encode("utf-8")

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def fake_urlopen(req, timeout=None):
            # urllib capitalizes header keys: "X-Cue-Nonce" -> "X-cue-nonce".
            nonce = req.get_header("X-cue-nonce")
            captured["nonce"] = nonce
            captured["auth"] = req.get_header("X-cue-auth")
            captured["token_header"] = req.get_header("X-cue-token")
            return FakeResp(proof_fn(nonce))

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
        return captured

    def _valid_proof(self, nonce):
        import hashlib
        import hmac
        return hmac.new(
            self.TOKEN.encode("utf-8"),
            b"resp:" + nonce.encode("ascii"),
            hashlib.sha256,
        ).hexdigest()

    def test_valid_proof_returns_decision(self, hook, monkeypatch):
        captured = self._install(hook, monkeypatch, self._valid_proof)
        decision = hook._forward_permission_request({"tool_name": "Bash"}, "sess-1")
        assert decision is not None
        assert decision["hookSpecificOutput"]["decision"]["behavior"] == "allow"
        # The request authenticated via nonce+HMAC and did NOT leak the raw token.
        assert captured["nonce"] and captured["token_header"] is None
        import hashlib
        import hmac
        expected_auth = hmac.new(
            self.TOKEN.encode("utf-8"),
            b"req:" + captured["nonce"].encode("ascii"),
            hashlib.sha256,
        ).hexdigest()
        assert captured["auth"] == expected_auth

    def test_wrong_proof_rejected(self, hook, monkeypatch):
        # A forger who can't key HMAC with the real token sends a bad proof.
        self._install(hook, monkeypatch, lambda nonce: "00" * 32)
        decision = hook._forward_permission_request({"tool_name": "Bash"}, "sess-1")
        assert decision is None

    def test_missing_proof_rejected(self, hook, monkeypatch):
        # No X-Cue-Proof header at all → untrusted → no decision emitted.
        self._install(hook, monkeypatch, lambda nonce: None)
        decision = hook._forward_permission_request({"tool_name": "Bash"}, "sess-1")
        assert decision is None

    def test_no_token_does_not_forward(self, hook, monkeypatch):
        # Without the token file the hook must not talk to :3002 at all.
        monkeypatch.setattr(hook, "_read_permission_token", lambda: None)
        called = {"n": 0}
        import urllib.request

        def boom(*a, **k):
            called["n"] += 1
            raise AssertionError("must not open a connection without a token")

        monkeypatch.setattr(urllib.request, "urlopen", boom)
        assert hook._forward_permission_request({"tool_name": "Bash"}, "sess-1") is None
        assert called["n"] == 0


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


class TestActiveSubagentsCoercion:
    """FIX #M1: a non-int activeSubagents (string from a manual edit / version
    skew) must not TypeError the stale-counter check or the counter arithmetic
    — that would crash the hook on every event and permanently wedge the
    session. The value is coerced to a non-negative int defensively."""

    def test_coerces_common_shapes(self, hook):
        assert hook._active_subagents({"activeSubagents": 3}) == 3
        assert hook._active_subagents({"activeSubagents": "2"}) == 2
        assert hook._active_subagents({"activeSubagents": 2.9}) == 2
        assert hook._active_subagents({"activeSubagents": -5}) == 0  # clamped
        assert hook._active_subagents({"activeSubagents": None}) == 0
        assert hook._active_subagents({"activeSubagents": "garbage"}) == 0
        assert hook._active_subagents({"activeSubagents": True}) == 0  # bool → 0
        assert hook._active_subagents({}) == 0  # missing → 0

    def test_string_counter_does_not_wedge_session(self, hook_env, invoke_hook):
        # A stored string counter previously crashed `active_subs += 1`. The
        # event must now process normally and persist a clean int counter.
        hook_env.write_sessions({"abc123": {
            "id": "abc123", "workspace": "/Users/x/proj", "state": "working",
            "lastActivity": time.time() - 5, "startedAt": time.time() - 100,
            "activeSubagents": "1",  # non-int from a manual edit
        }})
        invoke_hook("subagent", make_payload())
        entry = hook_env.read_sessions()["abc123"]
        assert entry["activeSubagents"] == 2
        assert isinstance(entry["activeSubagents"], int)
        assert entry["state"] == "subagent"


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
                "subprocess": "orchestrator",
            }
        })
        invoke_hook("remove", make_payload(session_id="abc123", hook_event_name="SessionEnd"))
        entry = hook_env.read_sessions()["abc123"]
        assert entry["state"] == "ended"
        assert entry["workspace"] == "/Users/x/proj"
        # The remove path doesn't touch the entry beyond the state — counter
        # and subprocess label carry through, which the revive UI surfaces.
        assert entry.get("activeSubagents") == 3
        assert entry.get("subprocess") == "orchestrator"


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
        # A PostToolUseFailure must not clobber a real error that's already
        # showing: if a prior StopFailure set "rate_limit", a benign tool
        # failure leaves the error in place and carries the errorType forward
        # (it does NOT downgrade the live rate_limit card to working).
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

    def test_tool_failure_does_not_create_sticky_error(self, hook_env, invoke_hook):
        # Regression (the 55-min stuck "Error" on an idle subprocess card): a
        # PostToolUseFailure from a non-error state (a routine recoverable tool
        # error like "read the file first") is ongoing work, NOT a session
        # error. It must land `working` so the turn's Stop→idle isn't blocked.
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook("error", make_payload(hook_event_name="PostToolUseFailure"))
        assert hook_env.read_sessions()["abc123"]["state"] == "working"

    def test_tool_failure_then_stop_demotes_to_idle(self, hook_env, invoke_hook):
        # End-to-end of the bug: a tool fails mid-turn, the turn then finishes.
        # The card must end on `idle`, not pinned red. (Before the fix the
        # PostToolUseFailure minted `error`, which blocked Stop→idle.)
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook("error", make_payload(hook_event_name="PostToolUseFailure"))
        invoke_hook("idle", make_payload(hook_event_name="Stop"))
        assert hook_env.read_sessions()["abc123"]["state"] == "idle"

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
        # A StopFailure (real turn-level failure) during what was previously a
        # stuck-waiting session still cleanly transitions to error — no special
        # marker handling needed. (Tool-level PostToolUseFailure is covered
        # separately; it intentionally does NOT surface a session error.)
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook("error", make_payload(hook_event_name="StopFailure"))
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
        invoke_hook("error", make_payload(hook_event_name="StopFailure"))
        assert hook_env.read_sessions()["abc123"]["state"] == "error"

    def test_error_from_idle(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "idle",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook("error", make_payload(hook_event_name="StopFailure"))
        assert hook_env.read_sessions()["abc123"]["state"] == "error"

    def test_error_from_thinking(self, hook_env, invoke_hook):
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "thinking",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}
        })
        invoke_hook("error", make_payload(hook_event_name="StopFailure"))
        assert hook_env.read_sessions()["abc123"]["state"] == "error"

    def test_error_resets_state_changed_at(self, hook_env, invoke_hook):
        # Transition from working → error is a state change; stateChangedAt
        # must update (not carry forward).
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0,
                       "stateChangedAt": 100.0}
        })
        invoke_hook("error", make_payload(hook_event_name="StopFailure"))
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


# ─────────────────────────────────────────────────────────────────────
# Entry-point fail-safe: run_safe() must never let a traceback reach the
# user's Claude Code session. A few ops in main() (makedirs, opening the
# lock file, the permission stdout write) run outside the inner guards, so
# the entry point is the backstop. Only CUE_HOOK_DEBUG reveals the error.
# ─────────────────────────────────────────────────────────────────────

class TestEntryPointFailSafe:
    def test_swallows_unexpected_exception(self, hook, monkeypatch):
        def boom():
            raise RuntimeError("boom")
        monkeypatch.setattr(hook, "main", boom)
        hook.run_safe()  # must not raise

    def test_swallows_broken_pipe(self, hook, monkeypatch):
        def boom():
            raise BrokenPipeError()
        monkeypatch.setattr(hook, "main", boom)
        # Stub the devnull redirect so it can't clobber the test runner's real
        # stdout (sys.stdout.fileno() is a live fd when capsys isn't active).
        monkeypatch.setattr(hook.os, "open", lambda *a, **k: -1)
        monkeypatch.setattr(hook.os, "dup2", lambda *a, **k: None)
        hook.run_safe()  # must not raise

    def test_silent_without_debug(self, hook, monkeypatch, capsys):
        def boom():
            raise RuntimeError("secret-detail")
        monkeypatch.setattr(hook, "main", boom)
        monkeypatch.delenv("CUE_HOOK_DEBUG", raising=False)
        hook.run_safe()
        captured = capsys.readouterr()
        assert captured.err == ""
        assert "secret-detail" not in captured.out

    def test_prints_traceback_with_debug(self, hook, monkeypatch, capsys):
        def boom():
            raise RuntimeError("diag-marker")
        monkeypatch.setattr(hook, "main", boom)
        monkeypatch.setenv("CUE_HOOK_DEBUG", "1")
        hook.run_safe()
        assert "diag-marker" in capsys.readouterr().err


# ─────────────────────────────────────────────────────────────────────
# Corrupt-file recovery: a malformed sessions.json must be renamed aside,
# never silently wiped (which would erase every other tracked session).
# Both write paths share _read_status_or_recover so they can't drift.
# ─────────────────────────────────────────────────────────────────────

class TestCorruptFileRecovery:
    @staticmethod
    def _corrupt_files(hook_env):
        import glob
        return glob.glob(hook_env.file + ".corrupt-*")

    def test_helper_renames_corrupt_aside(self, hook, hook_env):
        from pathlib import Path
        Path(hook_env.file).write_text("{not valid json")
        out = hook._read_status_or_recover()
        assert out == {"sessions": {}}
        corrupt = self._corrupt_files(hook_env)
        assert len(corrupt) == 1, "corrupt file must be renamed aside, not discarded"
        assert "not valid json" in Path(corrupt[0]).read_text()

    def test_helper_missing_file_resets_clean(self, hook, hook_env):
        if os.path.exists(hook_env.file):
            os.unlink(hook_env.file)
        assert hook._read_status_or_recover() == {"sessions": {}}
        assert self._corrupt_files(hook_env) == []

    def test_helper_passthrough_valid(self, hook, hook_env):
        hook_env.write_sessions({"a": {"id": "a"}})
        out = hook._read_status_or_recover()
        assert out["sessions"]["a"]["id"] == "a"
        assert self._corrupt_files(hook_env) == []

    def test_fast_path_preserves_corrupt_file(self, hook, hook_env):
        # Regression: the fast path used to reset a corrupt file to {} with no
        # copy. It must now preserve it AND still write the new session.
        from pathlib import Path
        Path(hook_env.file).write_text("garbage{{{")
        hook._quick_state_write("sess1", "/w", "cli", None, None, time.time())
        assert len(self._corrupt_files(hook_env)) == 1
        assert "sess1" in hook_env.read_sessions()


# ─────────────────────────────────────────────────────────────────────
# CLAUDE_CONFIG_DIR support: Cue must monitor the right transcripts even
# when a user relocates ~/.claude via Claude Code's CLAUDE_CONFIG_DIR env
# var. `_claude_config_dir()` is the single resolution point and must stay
# in lockstep with claude_config_dir() in src-tauri/src/paths.rs.
# ─────────────────────────────────────────────────────────────────────

class TestClaudeConfigDir:
    @staticmethod
    def _expected(base):
        return os.path.realpath(os.path.expanduser(base))

    def test_defaults_to_dot_claude_when_unset(self, hook, monkeypatch):
        monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
        assert hook._claude_config_dir() == self._expected("~/.claude")

    def test_blank_override_falls_back(self, hook, monkeypatch):
        for blank in ("", "   "):
            monkeypatch.setenv("CLAUDE_CONFIG_DIR", blank)
            assert hook._claude_config_dir() == self._expected("~/.claude")

    def test_honors_absolute_override(self, hook, monkeypatch):
        monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/custom/claude-home")
        assert hook._claude_config_dir() == self._expected("/custom/claude-home")

    def test_expands_leading_tilde(self, hook, monkeypatch):
        monkeypatch.setenv("CLAUDE_CONFIG_DIR", "~/alt-claude")
        assert hook._claude_config_dir() == self._expected("~/alt-claude")

    def test_transcript_under_relocated_dir_passes_validation(
        self, hook, monkeypatch, tmp_path
    ):
        # Regression for the hardcoded-~/.claude bug: a transcript living under
        # a relocated config dir must satisfy the same prefix check main() uses
        # (`resolved.startswith(claude_home + os.sep)`).
        cfg = tmp_path / "relocated-claude"
        proj = cfg / "projects" / "ws"
        proj.mkdir(parents=True)
        transcript = proj / "sess.jsonl"
        transcript.write_text("{}\n")
        monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(cfg))

        claude_home = hook._claude_config_dir()
        resolved = os.path.realpath(str(transcript))
        assert resolved.startswith(claude_home + os.sep)


# ─────────────────────────────────────────────────────────────────────
# Launcher-source detection (VS Code / terminals / Claude desktop app)
# ─────────────────────────────────────────────────────────────────────

# A real-world macOS `ps -A -o pid=,ppid=,comm=` excerpt: a hook (5000)
# descends from `claude` (4000) → a Claude desktop helper (77131) → the
# Claude.app main process (77120) → launchd (1). `comm` is the full exec
# path and helper names carry spaces ("Claude Helper (Renderer)").
_PS_CLAUDE_DESKTOP = (
    "    1     0 /sbin/launchd\n"
    "77120     1 /Applications/Claude.app/Contents/MacOS/Claude\n"
    "77131 77120 /Applications/Claude.app/Contents/Frameworks/"
    "Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)\n"
    " 4000 77131 /opt/homebrew/bin/node\n"
    " 5000  4000 /usr/bin/python3\n"
)

# The VS Code extension's bundled CLI lives at
# ".../anthropic.claude-code-<ver>/.../native-binary/claude" — its path
# contains "claude" but never "Claude.app", so it must NOT be matched.
_PS_VSCODE_CLAUDE_CLI = (
    "    1     0 /sbin/launchd\n"
    " 7924     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron\n"
    " 9745  7924 /Users/x/.vscode/extensions/anthropic.claude-code-2.1.195-"
    "darwin-arm64/resources/native-binary/claude\n"
    "10069  9745 node\n"
    " 5000 10069 /usr/bin/python3\n"
)

_PS_TERMINAL = (
    "    1     0 /sbin/launchd\n"
    " 3000     1 /Applications/iTerm.app/Contents/MacOS/iTerm2\n"
    " 4000  3000 -zsh\n"
    " 5000  4000 /usr/bin/python3\n"
)


class TestProcChainHasClaudeApp:
    """Pure ancestry parser — no subprocess, exercised against captured tables."""

    def test_detects_claude_desktop_ancestor(self, hook):
        assert hook._proc_chain_has_claude_app(_PS_CLAUDE_DESKTOP, 5000)

    def test_matches_through_helper_with_spaces_in_path(self, hook):
        # Starting at the helper itself (77131) — its path has spaces and the
        # ".app" component must still be found after split(None, 2).
        assert hook._proc_chain_has_claude_app(_PS_CLAUDE_DESKTOP, 77131)

    def test_vscode_extension_cli_is_not_claude_desktop(self, hook):
        # The critical false-positive guard: "anthropic.claude-code/.../claude"
        # and "Visual Studio Code.app" must not be read as the Claude desktop app.
        assert not hook._proc_chain_has_claude_app(_PS_VSCODE_CLAUDE_CLI, 5000)

    def test_plain_terminal_is_not_claude_desktop(self, hook):
        assert not hook._proc_chain_has_claude_app(_PS_TERMINAL, 5000)

    def test_start_pid_absent_from_table(self, hook):
        assert not hook._proc_chain_has_claude_app(_PS_CLAUDE_DESKTOP, 99999)

    def test_cyclic_table_terminates(self, hook):
        # A→B→A must break on the visited-set, not spin forever.
        cyclic = " 100  200 /a\n 200  100 /b\n"
        assert not hook._proc_chain_has_claude_app(cyclic, 100)

    def test_self_parent_terminates(self, hook):
        assert not hook._proc_chain_has_claude_app(" 100  100 /a\n", 100)

    def test_malformed_lines_are_skipped_but_match_still_found(self, hook):
        malformed = (
            "garbage with no numbers\n"
            "abc def /not-a-pid\n"
            " 100\n"  # too few fields
            " 5000  100 /usr/bin/python3\n"
            " 100     1 /Applications/Claude.app/Contents/MacOS/Claude\n"
        )
        assert hook._proc_chain_has_claude_app(malformed, 5000)

    def test_empty_output(self, hook):
        assert not hook._proc_chain_has_claude_app("", 5000)


class TestDetectSource:
    """`_detect_source` is the cheap env-only verdict; empty TERM_PROGRAM → None.

    It must NEVER spawn the ancestry walk — that is deferred to
    `_resolve_source` so a long-lived transcript-less session doesn't run `ps`
    on every event. Every case here installs a fail-loud `_is_claude_desktop`.
    """

    def _clear_term(self, monkeypatch):
        # The suite may itself run inside VS Code/iTerm; strip the signals so
        # each case starts from a known-empty launcher environment.
        monkeypatch.delenv("TERM_PROGRAM", raising=False)
        monkeypatch.delenv("VSCODE_PID", raising=False)

    def _no_walk(self, hook, monkeypatch):
        monkeypatch.setattr(
            hook, "_is_claude_desktop",
            lambda: pytest.fail("_detect_source must not walk process ancestry"),
        )

    def test_vscode_via_term_program(self, hook, monkeypatch):
        self._clear_term(monkeypatch)
        self._no_walk(hook, monkeypatch)
        monkeypatch.setenv("TERM_PROGRAM", "vscode")
        assert hook._detect_source() == "vscode"

    def test_vscode_via_vscode_pid(self, hook, monkeypatch):
        self._clear_term(monkeypatch)
        self._no_walk(hook, monkeypatch)
        monkeypatch.setenv("VSCODE_PID", "12345")
        assert hook._detect_source() == "vscode"

    def test_iterm(self, hook, monkeypatch):
        self._clear_term(monkeypatch)
        self._no_walk(hook, monkeypatch)
        monkeypatch.setenv("TERM_PROGRAM", "iTerm.app")
        assert hook._detect_source() == "iterm"

    def test_apple_terminal(self, hook, monkeypatch):
        self._clear_term(monkeypatch)
        self._no_walk(hook, monkeypatch)
        monkeypatch.setenv("TERM_PROGRAM", "Apple_Terminal")
        assert hook._detect_source() == "terminal"

    def test_no_term_program_returns_none_without_walking(self, hook, monkeypatch):
        # Empty TERM_PROGRAM is "undetermined": return None and do NOT spawn ps.
        self._clear_term(monkeypatch)
        self._no_walk(hook, monkeypatch)
        assert hook._detect_source() is None


class TestResolveSource:
    """`_resolve_source` settles the source and gates the one-time ancestry walk."""

    def test_stored_value_wins_without_walking(self, hook, monkeypatch):
        # A session already carrying a source must never re-walk ancestry — this
        # is what makes the walk at-most-once-per-session.
        monkeypatch.setattr(
            hook, "_is_claude_desktop",
            lambda: pytest.fail("walked despite a stored source"),
        )
        assert hook._resolve_source("claude-desktop", None) == "claude-desktop"
        assert hook._resolve_source("vscode", None) == "vscode"
        assert hook._resolve_source("iterm", "iterm") == "iterm"

    def test_env_verdict_wins_when_unstored(self, hook, monkeypatch):
        monkeypatch.setattr(
            hook, "_is_claude_desktop",
            lambda: pytest.fail("walked despite an env verdict"),
        )
        assert hook._resolve_source(None, "vscode") == "vscode"

    def test_walks_only_when_undetermined_and_unstored(self, hook, monkeypatch):
        monkeypatch.setattr(hook, "_is_claude_desktop", lambda: True)
        assert hook._resolve_source(None, None) == "claude-desktop"

    def test_unknown_when_undetermined_and_not_desktop(self, hook, monkeypatch):
        monkeypatch.setattr(hook, "_is_claude_desktop", lambda: False)
        assert hook._resolve_source(None, None) == "unknown"


class TestShouldIgnoreSession:
    """`_should_ignore_session` hides SDK/headless jobs — but never the desktop app.

    The contradiction: the blanket CLAUDE_CODE_ENTRYPOINT="sdk-*" skip would
    also suppress transcript-less Claude-desktop sessions, which the Rust
    poller deliberately keeps alive off the hook stream alone. So a
    resolved_source of "claude-desktop" is exempt from the SDK skip.
    """

    def _clear(self, monkeypatch):
        monkeypatch.delenv("CUE_SKIP", raising=False)
        monkeypatch.delenv("CLAUDE_CODE_ENTRYPOINT", raising=False)

    def test_interactive_cli_not_ignored(self, hook, monkeypatch):
        self._clear(monkeypatch)
        monkeypatch.setenv("CLAUDE_CODE_ENTRYPOINT", "cli")
        assert hook._should_ignore_session({}, "iterm") is False

    def test_cue_skip_env_ignores(self, hook, monkeypatch):
        self._clear(monkeypatch)
        monkeypatch.setenv("CUE_SKIP", "1")
        assert hook._should_ignore_session({}, "iterm") is True

    def test_sdk_headless_job_ignored(self, hook, monkeypatch):
        self._clear(monkeypatch)
        monkeypatch.setenv("CLAUDE_CODE_ENTRYPOINT", "sdk-py")
        # A genuine headless SDK job (unknown/terminal source) is suppressed.
        assert hook._should_ignore_session({}, "unknown") is True
        assert hook._should_ignore_session({}, None) is True

    def test_sdk_desktop_session_not_ignored(self, hook, monkeypatch):
        # The exemption: the desktop app can drive Claude Code via the SDK
        # entrypoint, yet its (transcript-less) sessions must stay visible.
        self._clear(monkeypatch)
        monkeypatch.setenv("CLAUDE_CODE_ENTRYPOINT", "sdk-cli")
        assert hook._should_ignore_session({}, "claude-desktop") is False


class TestSourceWriteThrough:
    """End-to-end: main()'s write path resolves + persists the launcher source."""

    def _clear_term(self, monkeypatch):
        monkeypatch.delenv("TERM_PROGRAM", raising=False)
        monkeypatch.delenv("VSCODE_PID", raising=False)

    def test_fresh_vscode_session_persists_vscode(self, hook, hook_env, invoke_hook, monkeypatch):
        self._clear_term(monkeypatch)
        monkeypatch.setenv("TERM_PROGRAM", "vscode")
        monkeypatch.setattr(
            hook, "_is_claude_desktop",
            lambda: pytest.fail("walked ancestry for a TERM_PROGRAM=vscode session"),
        )
        invoke_hook("working", make_payload(session_id="s-vscode"))
        assert hook_env.read_sessions()["s-vscode"]["source"] == "vscode"

    def test_fresh_desktop_session_persists_claude_desktop(self, hook, hook_env, invoke_hook, monkeypatch):
        self._clear_term(monkeypatch)
        monkeypatch.setattr(hook, "_is_claude_desktop", lambda: True)
        invoke_hook("working", make_payload(session_id="s-desk"))
        assert hook_env.read_sessions()["s-desk"]["source"] == "claude-desktop"

    def test_stored_source_preserved_without_rewalking(self, hook, hook_env, invoke_hook, monkeypatch):
        # The optimization, end to end: a session already carrying a source must
        # keep it on later events AND must not pay the `ps` walk again.
        now = time.time()
        hook_env.write_sessions({
            "s-keep": {"id": "s-keep", "workspace": "/Users/x/proj",
                       "state": "working", "source": "claude-desktop",
                       "lastActivity": now, "startedAt": now, "activeSubagents": 0},
        })
        self._clear_term(monkeypatch)
        monkeypatch.setattr(
            hook, "_is_claude_desktop",
            lambda: pytest.fail("re-walked ancestry for a session with a stored source"),
        )
        invoke_hook("working", make_payload(session_id="s-keep"))
        assert hook_env.read_sessions()["s-keep"]["source"] == "claude-desktop"


class TestIsClaudeDesktopWrapper:
    """The subprocess wrapper degrades to False on any failure."""

    def test_returns_false_when_ps_missing(self, hook, monkeypatch):
        def _boom(*a, **k):
            raise FileNotFoundError("ps")

        monkeypatch.setattr(hook.subprocess, "run", _boom)
        assert hook._is_claude_desktop() is False

    def test_returns_false_on_timeout(self, hook, monkeypatch):
        def _timeout(*a, **k):
            raise hook.subprocess.TimeoutExpired(cmd="ps", timeout=2)

        monkeypatch.setattr(hook.subprocess, "run", _timeout)
        assert hook._is_claude_desktop() is False

    def test_returns_false_on_nonzero_exit(self, hook, monkeypatch):
        class _R:
            returncode = 1
            stdout = ""

        monkeypatch.setattr(hook.subprocess, "run", lambda *a, **k: _R())
        assert hook._is_claude_desktop() is False

    def test_parses_stdout_on_success(self, hook, monkeypatch):
        class _R:
            returncode = 0
            # Make the hook's own pid an ancestor-of-Claude.app so the parse
            # path returns True deterministically regardless of the real tree.
            stdout = " {pid}     1 /Applications/Claude.app/Contents/MacOS/Claude\n".format(
                pid=os.getpid()
            )

        monkeypatch.setattr(hook.subprocess, "run", lambda *a, **k: _R())
        assert hook._is_claude_desktop() is True


# ─────────────────────────────────────────────────────────────────────
# Wave 3 / L1 — _read_status_or_recover must NOT silently reset on an
# unexpected read error (EACCES/EIO): the file is presumed intact, so
# resetting to {} and writing it back under lock would wipe every OTHER
# session. It re-raises to drop this event instead.
# ─────────────────────────────────────────────────────────────────────

class TestReadStatusUnexpectedOSError:
    @staticmethod
    def _corrupt_files(hook_env):
        import glob
        return glob.glob(hook_env.file + ".corrupt-*")

    def test_helper_reraises_on_eacces(self, hook, hook_env, monkeypatch):
        # A valid, present file that momentarily can't be read must re-raise —
        # not return an empty map that a later locked write would persist.
        hook_env.write_sessions(
            {"other": {"id": "other", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}}
        )

        def _boom(*a, **k):
            raise PermissionError(13, "Permission denied")

        monkeypatch.setattr(hook, "open", _boom, raising=False)
        with pytest.raises(OSError):
            hook._read_status_or_recover()
        # No forensic sidecar: the rename-aside path is for parse errors only.
        assert self._corrupt_files(hook_env) == []

    def test_main_preserves_other_sessions_on_read_eacces(
            self, hook, hook_env, invoke_hook, monkeypatch):
        # End to end: a transient EACCES on the sessions.json read drops the
        # event (main re-raises up to run_safe) WITHOUT clobbering the file —
        # the pre-existing 'other' entry survives intact.
        hook_env.write_sessions(
            {"other": {"id": "other", "workspace": "/x", "state": "working",
                       "lastActivity": 0.0, "startedAt": 0.0, "activeSubagents": 0}}
        )
        import builtins
        real_open = builtins.open

        def selective(path, *a, **k):
            # Only the sessions.json READ fails; the lock-file open still works.
            if isinstance(path, str) and path == hook_env.file:
                raise PermissionError(13, "Permission denied")
            return real_open(path, *a, **k)

        monkeypatch.setattr(hook, "open", selective, raising=False)
        with pytest.raises(OSError):
            invoke_hook("working", make_payload(session_id="abc123"))
        # Patch reverts at test teardown, but read_sessions uses pathlib, not
        # hook.open, so we can read the file back right now.
        sessions = hook_env.read_sessions()
        assert "other" in sessions, "a transient read error must not wipe other sessions"
        assert sessions["other"]["state"] == "working"
        assert "abc123" not in sessions, "the errored event must be dropped, not written"

    def test_missing_file_still_resets_clean(self, hook, hook_env):
        # Regression guard: FileNotFoundError (a subclass of OSError) must keep
        # its clean-reset behaviour and NOT be caught by the new re-raise.
        if os.path.exists(hook_env.file):
            os.unlink(hook_env.file)
        assert hook._read_status_or_recover() == {"sessions": {}}


# ─────────────────────────────────────────────────────────────────────
# Wave 3 / L2 — the MAIN locked write must not let a `waiting` rebuild
# clobber a live `error` card (the done/idle guard covered only those two
# actions; a PreToolUse promotion to `waiting` bypassed it).
# ─────────────────────────────────────────────────────────────────────

class TestWaitingDoesNotClobberErrorMainPath:
    def _seed_error(self, hook_env):
        now = time.time()
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "error",
                       "errorType": "rate_limit", "lastActivity": now,
                       "startedAt": now, "stateChangedAt": now, "activeSubagents": 0},
        })

    def test_direct_waiting_action_preserves_error(self, hook_env, invoke_hook):
        # A bare `waiting` action on an error card must be a no-op on the main
        # locked path, keeping state=error and errorType intact.
        self._seed_error(hook_env)
        invoke_hook("waiting", make_payload(session_id="abc123",
                                            hook_event_name="PostToolUse"))
        s = hook_env.read_sessions()["abc123"]
        assert s["state"] == "error"
        assert s["errorType"] == "rate_limit"

    def test_pretooluse_askquestion_preserves_error(self, hook_env, invoke_hook):
        # The realistic path: PreToolUse(AskUserQuestion) promotes action to
        # `waiting`; neither the quick seed nor the main write may downgrade
        # the red error card to yellow waiting.
        self._seed_error(hook_env)
        invoke_hook("working", make_payload(
            session_id="abc123", hook_event_name="PreToolUse",
            tool_name="AskUserQuestion"))
        s = hook_env.read_sessions()["abc123"]
        assert s["state"] == "error"
        assert s["errorType"] == "rate_limit"

    def test_waiting_still_lands_when_not_error(self, hook_env, invoke_hook):
        # Guard must not over-reach: a `waiting` action on a non-error card
        # still writes waiting.
        now = time.time()
        hook_env.write_sessions({
            "abc123": {"id": "abc123", "workspace": "/x", "state": "working",
                       "lastActivity": now, "startedAt": now, "activeSubagents": 0},
        })
        invoke_hook("waiting", make_payload(session_id="abc123",
                                            hook_event_name="PostToolUse"))
        assert hook_env.read_sessions()["abc123"]["state"] == "waiting"


# ─────────────────────────────────────────────────────────────────────
# Wave 3 / L3 — the workspace (cwd) must be sanitized to valid UTF-8
# before it lands in sessions.json. A lone surrogate (\udcXX from a
# non-UTF-8 Linux path) is accepted by Python's json but REJECTED by
# serde_json on the Rust side, bricking the whole file permanently.
# ─────────────────────────────────────────────────────────────────────

class TestWorkspaceUtf8Sanitize:
    def test_helper_strips_lone_surrogate(self, hook):
        out = hook._sanitize_workspace("/Users/x/pro\udce9ject")
        out.encode("utf-8")  # must not raise — no lone surrogate remains
        assert "\udce9" not in out

    def test_helper_non_string_falls_back_to_empty(self, hook):
        assert hook._sanitize_workspace(None) == ""
        assert hook._sanitize_workspace(1234) == ""
        assert hook._sanitize_workspace(["/x"]) == ""

    def test_helper_passes_clean_utf8_unchanged(self, hook):
        assert hook._sanitize_workspace("/Users/x/proj") == "/Users/x/proj"
        # Legitimate non-ASCII UTF-8 survives.
        assert hook._sanitize_workspace("/Users/x/café") == "/Users/x/café"

    def test_written_file_has_no_lone_surrogate(self, hook_env, invoke_hook):
        from pathlib import Path
        bad = "/Users/x/pro\udce9ject"
        invoke_hook("working", make_payload(session_id="abc123", cwd=bad))
        # The bytes on disk must decode cleanly as UTF-8 (serde-safe) and carry
        # no escaped lone surrogate.
        raw = Path(hook_env.file).read_bytes()
        text = raw.decode("utf-8")  # raises if a lone surrogate escaped
        assert "\\udce9" not in text
        ws = hook_env.read_sessions()["abc123"]["workspace"]
        ws.encode("utf-8")  # round-trips as valid UTF-8


# ─────────────────────────────────────────────────────────────────────
# Wave 3 / L4 — the launcher-source resolution (incl. the up-to-2s `ps`
# ancestry walk) must run BEFORE the flock is taken, never inside the
# critical section where it would starve concurrent hooks. Once-per-
# session caching is preserved via an unlocked stored-source peek.
# ─────────────────────────────────────────────────────────────────────

class TestSourceResolvedOutsideLock:
    def _clear_term(self, monkeypatch):
        monkeypatch.delenv("TERM_PROGRAM", raising=False)
        monkeypatch.delenv("VSCODE_PID", raising=False)

    def test_peek_returns_stored_source(self, hook, hook_env):
        hook_env.write_sessions({"s1": {"id": "s1", "source": "vscode"}})
        assert hook._peek_stored_source("s1") == "vscode"

    def test_peek_none_when_missing(self, hook, hook_env):
        if os.path.exists(hook_env.file):
            os.unlink(hook_env.file)
        assert hook._peek_stored_source("s1") is None

    def test_peek_none_when_no_such_session(self, hook, hook_env):
        hook_env.write_sessions({"s1": {"id": "s1", "source": "vscode"}})
        assert hook._peek_stored_source("other") is None

    def test_peek_none_on_corrupt(self, hook, hook_env):
        from pathlib import Path
        Path(hook_env.file).write_text("{not json")
        # Best-effort: corruption is the locked path's job; peek just yields None.
        assert hook._peek_stored_source("s1") is None

    def test_resolve_unlocked_env_verdict_skips_walk(self, hook, monkeypatch):
        monkeypatch.setattr(
            hook, "_is_claude_desktop",
            lambda: pytest.fail("walked ancestry despite an env verdict"),
        )
        monkeypatch.setattr(
            hook, "_peek_stored_source",
            lambda sid: pytest.fail("peeked despite an env verdict"),
        )
        assert hook._resolve_source_unlocked("s1", "vscode") == "vscode"

    def test_resolve_unlocked_stored_wins_no_walk(self, hook, hook_env, monkeypatch):
        hook_env.write_sessions({"s1": {"id": "s1", "source": "iterm"}})
        monkeypatch.setattr(
            hook, "_is_claude_desktop",
            lambda: pytest.fail("re-walked ancestry despite a stored source"),
        )
        assert hook._resolve_source_unlocked("s1", None) == "iterm"

    def test_resolve_unlocked_walks_when_undetermined(self, hook, hook_env, monkeypatch):
        if os.path.exists(hook_env.file):
            os.unlink(hook_env.file)
        monkeypatch.setattr(hook, "_is_claude_desktop", lambda: True)
        assert hook._resolve_source_unlocked("s1", None) == "claude-desktop"

    def test_ancestry_walk_runs_before_lock_is_held(
            self, hook, hook_env, invoke_hook, monkeypatch):
        # The whole point of the hoist: prove `ps` runs before flock acquisition.
        self._clear_term(monkeypatch)
        calls = []

        def _walk():
            calls.append("ps")
            return True

        real_lock = hook._lock

        def _traced_lock(lock_file):
            calls.append("lock")
            return real_lock(lock_file)

        monkeypatch.setattr(hook, "_is_claude_desktop", _walk)
        monkeypatch.setattr(hook, "_lock", _traced_lock)
        invoke_hook("working", make_payload(session_id="s-order"))
        assert "ps" in calls and "lock" in calls
        assert calls.index("ps") < calls.index("lock"), (
            "the ps ancestry walk must run before the flock is acquired"
        )
        assert hook_env.read_sessions()["s-order"]["source"] == "claude-desktop"


# ─────────────────────────────────────────────────────────────────────
# Wave 3 / L5 — orphaned `*.json.tmp` files (from hooks SIGKILLed between
# mkstemp and os.replace) are swept inside the locked write once they age
# past the 1h horizon; fresh temps and non-temp files are never touched.
# ─────────────────────────────────────────────────────────────────────

class TestOrphanTmpSweep:
    @staticmethod
    def _mk(dir_, name, age_secs):
        path = os.path.join(dir_, name)
        with open(path, "w") as f:
            f.write("x")
        t = time.time() - age_secs
        os.utime(path, (t, t))
        return path

    def test_sweeps_stale_tmp(self, hook, hook_env):
        stale = self._mk(hook_env.dir, "tmpABCDEF.json.tmp", 7200)
        hook._sweep_orphan_tmps(time.time())
        assert not os.path.exists(stale)

    def test_keeps_fresh_tmp(self, hook, hook_env):
        # A temp a live hook created moments ago (about to os.replace) survives.
        fresh = self._mk(hook_env.dir, "tmpFRESH1.json.tmp", 5)
        hook._sweep_orphan_tmps(time.time())
        assert os.path.exists(fresh)

    def test_ignores_non_tmp_files(self, hook, hook_env):
        # sessions.json and .corrupt sidecars must never be swept, even when old.
        keep = self._mk(hook_env.dir, "sessions.json", 999999)
        corrupt = self._mk(hook_env.dir, "sessions.json.corrupt-123", 999999)
        hook._sweep_orphan_tmps(time.time())
        assert os.path.exists(keep)
        assert os.path.exists(corrupt)

    def test_missing_dir_is_noop(self, hook, monkeypatch, tmp_path):
        monkeypatch.setattr(hook, "STATUS_DIR", str(tmp_path / "does-not-exist"))
        hook._sweep_orphan_tmps(time.time())  # must not raise

    def test_main_write_sweeps_orphan_tmp(self, hook_env, invoke_hook, hook):
        # End to end: a normal locked write sweeps a stale orphan tmp.
        stale = self._mk(hook_env.dir, "tmpORPHAN1.json.tmp", 7200)
        invoke_hook("working", make_payload(session_id="abc123"))
        assert not os.path.exists(stale)
        # The real write still succeeded.
        assert "abc123" in hook_env.read_sessions()
