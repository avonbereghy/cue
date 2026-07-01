"""Smoke tests for hooks/cue-statusline (bash statusline bridge).

cue-statusline is a bash script (Claude Code invokes it via shebang), so unlike
the Python cue-hook it can't be imported — we drive it through subprocess with a
synthetic rateLimits payload on stdin and assert *where* it writes
rate_limits.json.

The WSL branch is the whole point of FIX C: on WSL the Cue app runs natively on
Windows and reads %LOCALAPPDATA%\\Cue (i.e. /mnt/c/Users/<user>/AppData/Local/Cue
from inside WSL), which is exactly where cue-hook.get_status_dir() writes
sessions.json. Before FIX C the statusline had no WSL branch and dropped the
rate file in $XDG_DATA_HOME/cue that the Windows app never reads, so the rate
meter was permanently empty on WSL.

We exercise that branch through the CUE_STATUSLINE_PROC_VERSION /
CUE_STATUSLINE_WIN_USERS seams — which default to /proc/version and /mnt/c/Users
in production — so the detection heuristic itself (the one shared with cue-hook)
is what gets tested, just pointed at fixture paths.
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
STATUSLINE = REPO_ROOT / "hooks" / "cue-statusline"

PAYLOAD = json.dumps(
    {
        "rateLimits": {
            "fiveHour": {"used": 50, "limit": 100, "resetAt": "R5"},
            "sevenDay": {"used": 10, "limit": 100, "resetAt": "R7"},
        }
    }
)

# The bash statusline is POSIX-only; skip the whole module on native Windows.
pytestmark = pytest.mark.skipif(
    os.name == "nt", reason="cue-statusline is a POSIX bash script"
)


def _run(env_overrides):
    """Invoke cue-statusline with the payload on stdin under a controlled env.

    OSTYPE is forced to a Linux value so the WSL/XDG branch runs regardless of
    the OS running pytest (the suite runs on macOS and Ubuntu CI alike).
    """
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ.get("HOME", "/tmp"),
        "OSTYPE": "linux-gnu",
    }
    env.update(env_overrides)
    result = subprocess.run(
        ["bash", str(STATUSLINE)],
        input=PAYLOAD,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, f"statusline failed: {result.stderr}"
    return result


def test_wsl_single_profile_writes_to_windows_dir(tmp_path):
    # Fake a WSL host: /proc/version contains "microsoft" and exactly one real
    # Windows profile exists under the mount. The rate file must land in that
    # profile's AppData\Local\Cue (what the Windows-native Cue app reads).
    proc = tmp_path / "proc_version"
    proc.write_text("Linux version 5.15 Microsoft WSL2\n")
    win_users = tmp_path / "mnt_users"
    (win_users / "alice").mkdir(parents=True)
    xdg = tmp_path / "xdg"

    _run(
        {
            "CUE_STATUSLINE_PROC_VERSION": str(proc),
            "CUE_STATUSLINE_WIN_USERS": str(win_users),
            "XDG_DATA_HOME": str(xdg),
        }
    )

    win_file = win_users / "alice" / "AppData" / "Local" / "Cue" / "rate_limits.json"
    assert win_file.exists(), "WSL rate file must land in the Windows-side dir"
    assert not (
        xdg / "cue" / "rate_limits.json"
    ).exists(), "WSL path must not fall back to XDG when a profile is detected"

    data = json.loads(win_file.read_text())
    assert data["fiveHourPercent"] == 50
    assert data["sevenDayPercent"] == 10
    assert data["fiveHourResetAt"] == "R5"


def test_wsl_ambiguous_profiles_fall_back_to_xdg(tmp_path):
    # Two candidate profiles ⇒ cue-hook's detection returns None ⇒ statusline
    # falls back to XDG rather than guessing the wrong Windows user.
    proc = tmp_path / "proc_version"
    proc.write_text("Linux version 5.15 microsoft-standard-WSL2\n")
    win_users = tmp_path / "mnt_users"
    (win_users / "alice").mkdir(parents=True)
    (win_users / "bob").mkdir(parents=True)
    # System profiles must be ignored (so they don't inflate the count).
    (win_users / "Public").mkdir(parents=True)
    (win_users / "Default").mkdir(parents=True)
    xdg = tmp_path / "xdg"

    _run(
        {
            "CUE_STATUSLINE_PROC_VERSION": str(proc),
            "CUE_STATUSLINE_WIN_USERS": str(win_users),
            "XDG_DATA_HOME": str(xdg),
        }
    )

    assert (xdg / "cue" / "rate_limits.json").exists()
    assert not (
        win_users / "alice" / "AppData" / "Local" / "Cue" / "rate_limits.json"
    ).exists()


def test_wsl_ignores_system_profiles_for_single_match(tmp_path):
    # One real user plus the well-known system profiles ⇒ still a single
    # candidate, so detection succeeds (mirrors cue-hook's skip set).
    proc = tmp_path / "proc_version"
    proc.write_text("microsoft WSL2\n")
    win_users = tmp_path / "mnt_users"
    for name in ("alice", "Public", "Default", "Default User", "All Users"):
        (win_users / name).mkdir(parents=True)
    xdg = tmp_path / "xdg"

    _run(
        {
            "CUE_STATUSLINE_PROC_VERSION": str(proc),
            "CUE_STATUSLINE_WIN_USERS": str(win_users),
            "XDG_DATA_HOME": str(xdg),
        }
    )

    win_file = win_users / "alice" / "AppData" / "Local" / "Cue" / "rate_limits.json"
    assert win_file.exists(), "system profiles must not block single-user detection"


def test_non_wsl_linux_writes_to_xdg(tmp_path):
    # A plain Linux /proc/version (no "microsoft") ⇒ XDG, never the mount dir,
    # even though a /mnt/c/Users-style dir happens to exist.
    proc = tmp_path / "proc_version"
    proc.write_text("Linux version 6.1.0 generic-cloud\n")
    win_users = tmp_path / "mnt_users"
    (win_users / "alice").mkdir(parents=True)
    xdg = tmp_path / "xdg"

    _run(
        {
            "CUE_STATUSLINE_PROC_VERSION": str(proc),
            "CUE_STATUSLINE_WIN_USERS": str(win_users),
            "XDG_DATA_HOME": str(xdg),
        }
    )

    xdg_file = xdg / "cue" / "rate_limits.json"
    assert xdg_file.exists()
    assert not (
        win_users / "alice" / "AppData" / "Local" / "Cue" / "rate_limits.json"
    ).exists()

    data = json.loads(xdg_file.read_text())
    assert data["fiveHourPercent"] == 50
    assert data["sevenDayPercent"] == 10


# ─────────────────────────────────────────────────────────────────────
# FIX 7 — the Python fallback (used when jq is absent) must write atomically
# with os.replace (not os.rename, which raises on an existing target on
# Windows/msys) and must not leak its mkstemp temp file. We force the branch
# by pointing PATH at a curated bin dir that has everything the script needs
# EXCEPT jq.
# ─────────────────────────────────────────────────────────────────────

def test_python_fallback_writes_atomically_without_leaking_temp(tmp_path):
    fakebin = tmp_path / "bin"
    fakebin.mkdir()
    # Symlink the real tools the script needs, deliberately omitting jq so the
    # `command -v jq` probe fails and the Python fallback runs.
    needed = ["cat", "mkdir", "chmod", "grep", "python3", "mktemp", "rm", "mv"]
    for tool in needed:
        real = shutil.which(tool)
        if real:
            os.symlink(real, fakebin / tool)
    if not (fakebin / "python3").exists():
        pytest.skip("python3 not resolvable on PATH")
    if not (fakebin / "grep").exists() or not (fakebin / "cat").exists():
        pytest.skip("core tools not resolvable on PATH")

    real_bash = shutil.which("bash")
    assert real_bash, "bash is required to run the statusline"

    proc = tmp_path / "proc_version"
    proc.write_text("Linux version 6.1.0 generic-cloud\n")  # non-WSL
    win_users = tmp_path / "mnt_users"
    xdg = tmp_path / "xdg"

    env = {
        "PATH": str(fakebin),
        "HOME": str(tmp_path),
        "OSTYPE": "linux-gnu",
        "CUE_STATUSLINE_PROC_VERSION": str(proc),
        "CUE_STATUSLINE_WIN_USERS": str(win_users),
        "XDG_DATA_HOME": str(xdg),
    }
    result = subprocess.run(
        [real_bash, str(STATUSLINE)],
        input=PAYLOAD,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, f"fallback failed: {result.stderr}"

    out_dir = xdg / "cue"
    out_file = out_dir / "rate_limits.json"
    assert out_file.exists(), "the Python fallback must still write the rate file"
    data = json.loads(out_file.read_text())
    assert data["fiveHourPercent"] == 50
    assert data["sevenDayPercent"] == 10

    # No leaked mkstemp temp file — os.replace consumes it on success, and the
    # except-path unlinks it on failure.
    leftovers = [p.name for p in out_dir.iterdir() if p.name != "rate_limits.json"]
    assert leftovers == [], f"the fallback leaked a temp file: {leftovers}"
