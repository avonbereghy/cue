# Phase 0: Pre-Requisite Hook Fixes

Read plans/cross_platform_final_plan.md for full context.

## Background
The existing `hooks/cue-hook` Python script has security gaps that must be fixed BEFORE any Tauri work begins. These fixes also make the hook cross-platform.

## Tasks
1. Replace `os.rename(tmp, STATUS_FILE)` with `os.replace(tmp, STATUS_FILE)` — atomic on all platforms
2. Add `f.flush(); os.fsync(f.fileno())` before the `os.replace()` call — prevents data loss on crash
3. Add `os.chmod(STATUS_FILE, 0o600)` after write (guarded by `sys.platform != "win32"`)
4. Add schema validation when reading existing `sessions.json` — verify `sessions` is a dict, each value has `id`, `workspace`, `state`, `lastActivity`, `startedAt` with correct types. Reject malformed data silently (write empty sessions dict).
5. Replace `import fcntl` / `fcntl.flock()` with platform-conditional locking:
   - Unix: `fcntl.flock()` (existing)
   - Windows: `msvcrt.locking()` — write a single byte `b"L"` to the lock file before locking (msvcrt requires the file to have content covering the locked range)
6. Add `get_status_dir()` function returning OS-appropriate path:
   - macOS: `~/Library/Application Support/Cue`
   - Windows: `%LOCALAPPDATA%\Cue`
   - Linux: `$XDG_DATA_HOME/cue` (default: `~/.local/share/cue`)
7. Add WSL detection and bridge path (`get_wsl_windows_status_dir()`) using filesystem inspection only — NO subprocess, NO cmd.exe
8. Replace hardcoded `STATUS_DIR` with `get_status_dir()` call

## Files to modify
- `hooks/cue-hook` — all changes in this single file

## Files NOT to touch
- Everything in `Sources/` (macOS Swift app)
- `Package.swift`
- `install.sh`

## Verification
- Run the hook manually on macOS: `echo '{}' | python3 hooks/cue-hook idle`
- Verify `sessions.json` has mode 0600: `stat -f '%Lp' ~/Library/Application\ Support/Claude\ Cue/sessions.json`
- Verify malformed JSON input is handled gracefully (write empty sessions)
- If on Windows/WSL: verify the hook writes to the correct path
