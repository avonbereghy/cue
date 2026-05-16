"""Pytest fixtures for the cue-hook test suite.

The hook script has no .py extension (it's invoked directly by Claude Code
via shebang), so we import it via importlib.util and expose it as a
module-scoped fixture. All filesystem state is redirected to a per-test
tempdir so the suite never touches the real ~/Library/Application Support/Cue
or $XDG_DATA_HOME/cue dirs.
"""
import importlib.util
import json
import os
import sys
from importlib.machinery import SourceFileLoader
from io import BytesIO
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
HOOK_PATH = REPO_ROOT / "hooks" / "cue-hook"


def _load_hook_module():
    """Load hooks/cue-hook as a Python module. The script's import-time
    code captures STATUS_DIR / STATUS_FILE / LOCK_FILE from get_status_dir(),
    so we capture the module once and patch those globals per test.

    The hook has no .py extension (Claude Code invokes it via shebang),
    so spec_from_file_location can't auto-detect a loader — we supply
    SourceFileLoader explicitly.
    """
    loader = SourceFileLoader("cue_hook", str(HOOK_PATH))
    spec = importlib.util.spec_from_loader("cue_hook", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


@pytest.fixture(scope="session")
def hook():
    """The cue-hook module, loaded once per pytest session."""
    return _load_hook_module()


@pytest.fixture
def hook_env(tmp_path, monkeypatch, hook):
    """Redirect the hook's filesystem state into a per-test tempdir.

    Patches the module-level STATUS_DIR, STATUS_FILE, LOCK_FILE globals,
    and makes the dir up-front so the hook doesn't have to. Returns the
    paths as a small namespace for tests to read/write directly.
    """
    status_dir = tmp_path / "cue-status"
    status_dir.mkdir()
    status_file = status_dir / "sessions.json"
    lock_file = status_dir / "sessions.lock"

    monkeypatch.setattr(hook, "STATUS_DIR", str(status_dir))
    monkeypatch.setattr(hook, "STATUS_FILE", str(status_file))
    monkeypatch.setattr(hook, "LOCK_FILE", str(lock_file))

    class Env:
        dir = str(status_dir)
        file = str(status_file)
        lock = str(lock_file)

        def write_sessions(self, sessions_dict):
            status_file.write_text(json.dumps({"sessions": sessions_dict}))

        def read_sessions(self):
            if not status_file.exists():
                return {}
            return json.loads(status_file.read_text())["sessions"]

    return Env()


@pytest.fixture
def invoke_hook(hook_env, monkeypatch, hook):
    """Invoke the hook's main() with a synthetic argv + stdin payload.

    Returns a callable: `invoke_hook(action, payload_dict)`. The fixture
    handles JSON-encoding the payload, replacing sys.stdin.buffer with
    a BytesIO, and resetting sys.argv. The caller can inspect
    `hook_env.read_sessions()` afterwards.
    """

    def _invoke(action, payload):
        raw = json.dumps(payload).encode("utf-8")

        class FakeStdin:
            buffer = BytesIO(raw)
            # main() reads bytes via stdin.buffer.read; the BytesIO above
            # is enough for the read path. Other attributes are unused.

        monkeypatch.setattr(sys, "argv", ["cue-hook", action])
        monkeypatch.setattr(sys, "stdin", FakeStdin())
        # stdout is captured by pytest's capsys/capfd if needed; the
        # hook only writes to stdout for PermissionRequest forwarding,
        # which our test payloads don't exercise.
        hook.main()

    return _invoke
