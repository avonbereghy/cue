# Cross-Platform Final Plan — Security & Architecture Review

> Reviewer posture: Senior security engineer, skeptical architect.
> Date: 2026-03-16

---

## Findings

### 1. CRITICAL — WSL bridge calls `cmd.exe` with unsanitized environment variable

Section 8.4 runs `subprocess.check_output(["cmd.exe", "/c", "echo", "%USERNAME%"])` from within the Python hook. This contradicts Section 1 ("The hook does not execute any external commands — no `subprocess`, no `os.system`"). More importantly:

- The `%USERNAME%` is expanded by `cmd.exe`, not Python. A user whose Windows username contains special characters (spaces, `&`, `^`) could cause unexpected shell behavior.
- This introduces a child process execution path in a hook that explicitly promises zero subprocess calls. The security invariant in Section 1 is violated.
- Any process that can modify the `USERNAME` environment variable before the hook runs can redirect where `sessions.json` is written (path injection to arbitrary `/mnt/c/Users/ATTACKER/...`).

**Fix**: Use `os.environ.get("WSLENV")` detection combined with reading `/proc/mounts` or `/etc/wsl.conf` to derive the Windows user home without spawning `cmd.exe`. Or read the Windows-side `USERPROFILE` via `wslpath` or `/mnt/c/Users/` directory listing.

---

### 2. CRITICAL — Existing hook uses `os.rename()`, not `os.replace()`, and lacks `0600` permissions

The actual `hooks/cue-hook` file (line 82) uses `os.rename(tmp, STATUS_FILE)`, not `os.replace()`. On Windows, `os.rename()` raises an error if the target exists. The plan says to change this (Section 8.3), but the plan is describing future work as if it's already a security property. The hook also lacks the `os.chmod(STATUS_FILE, 0o600)` call described in Section 8.5.

Additionally, `tempfile.mkstemp()` creates files with mode `0600` on Unix by default, but the final `os.rename()` target inherits no explicit permission setting. After rename, the file could be world-readable if the directory's umask is permissive.

**Fix**: These are implementation tasks, not plan bugs per se, but the plan should flag the *existing* hook as insecure on its current codebase and mark these as Phase 0 / prerequisite fixes.

---

### 3. CRITICAL — `sessions.json` treated as trusted in the hook but untrusted in the app

Section 12.1 says "the app treats `sessions.json` as untrusted input — all fields are validated." Good. But the hook itself (Section 8, actual code) does `json.load()` on the existing `sessions.json` and then writes back a modified version without validating the structure. If another process (or a prior bug) writes malformed data into `sessions.json`, the hook will crash or propagate corrupted data. Since the hook runs inside Claude Code's process tree, a crash could affect the user's session.

**Fix**: The hook should validate the schema it reads (at minimum: `sessions` key is a dict, each value has required fields with correct types) before merging and writing back.

---

### 4. CRITICAL — Tauri WebView DevTools accessible by default in dev builds; no mention of disabling in production

Tauri v2 enables WebView DevTools in debug builds. If a release build is accidentally compiled in debug mode, or if the plan doesn't explicitly set `"devtools": false` in `tauri.conf.json` for release, users' session data (workspace paths, token counts, session IDs) is inspectable via right-click > Inspect. On shared machines or screen-sharing, this is a data leak.

**Fix**: Explicitly state in the plan that `tauri.conf.json` must set `"devtools": false` for release builds. Add a CI check that release artifacts have devtools disabled.

---

### 5. CRITICAL — No `fsync` on the actual hook's temp file before rename

Section 1 promises "fsync the temporary file" before rename. The actual hook code (`os.fdopen(fd, "w")` + `json.dump` + `os.rename`) never calls `f.flush()` or `os.fsync(fd)`. On a crash or power loss, the renamed file could be zero-length or partial. The plan describes this as already-in-place security, but it's not implemented.

**Fix**: Mark as a mandatory pre-Phase-1 fix. Add `f.flush(); os.fsync(f.fileno())` before the rename.

---

### 6. IMPORTANT — Lock file persists after crash; no stale lock detection

The hook uses `fcntl.flock()` with a separate `sessions.lock` file. If the hook process is killed (SIGKILL) while holding the lock, `fcntl.flock()` automatically releases on file descriptor close — so this is actually fine on Unix. However, the Windows replacement (`msvcrt.locking`) locks a *byte range*, and the code in Section 8.1 locks only 1 byte (`msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)`). If the file is empty, this may fail or behave unexpectedly on some Windows versions. The locking semantics between Unix `flock` and Windows `msvcrt.locking` are fundamentally different and not interchangeable.

**Fix**: Use `msvcrt.locking` on a non-empty sentinel file, or use `win32file.LockFileEx` via ctypes for proper Windows file locking. Test the 1-byte lock on an empty file.

---

### 7. IMPORTANT — Workspace paths leak to tray menu, tooltips, and CLI output

The tray menu (Section 6.3) shows workspace names like "WebApp", "MLPipeline". The `--status` CLI outputs JSON with full workspace paths. `EnrichedSession` contains the full `workspace` path (e.g., `/home/user/secret-client-project/`). This leaks directory names to:

- The system tray tooltip (visible to shoulder-surfers and screen recordings)
- The CLI JSON output (could be piped to logs or monitoring)
- The dashboard UI (visible in screen shares)

For a tool that prioritizes data security, exposing workspace paths — which often contain client names, project codenames, or organizational structure — is a real concern.

**Fix**: Consider showing only the leaf directory name by default, with full path available on hover/click. Add a "privacy mode" or "redact paths" setting. At minimum, document this as a known exposure.

---

### 8. IMPORTANT — No plan for cleaning up temp files on write failure

Section 1 describes atomic writes with temp-file-then-rename. The hook code has a `try/except` that calls `os.unlink(tmp)` on failure. But the Rust `security.rs` `atomic_write()` function is only described as a signature — no error-handling detail. If the Rust side crashes between creating the temp file and renaming it, orphaned `.json.tmp.*` files accumulate in the data directory.

**Fix**: The Rust backend should clean up stale `.tmp` files on startup. Define a naming convention and max age for temp files.

---

### 9. IMPORTANT — `tauri-plugin-store` writes settings as world-readable JSON

`tauri-plugin-store` writes to a JSON file but does not set restrictive file permissions. The plan says `security.rs` enforces `0600` on `sessions.json` and `settings.json`, but `tauri-plugin-store` manages its own file I/O — the app doesn't control how the plugin writes to disk. Unless the plugin is patched or wrapped, settings (which include plan type — a billing signal) are written with default permissions.

**Fix**: Either (a) wrap `tauri-plugin-store` writes with a post-write permission fix, (b) use a custom settings implementation that uses `security.rs::atomic_write()`, or (c) verify that `tauri-plugin-store` respects custom paths and hook into its write lifecycle.

---

### 10. IMPORTANT — Contradiction: "lightweight" / "~5 MB binary" vs. actual dependency weight

The plan claims ~5 MB binary (Section 2). But the dependency list includes `tauri` v2, `tokio`, `serde`, `serde_json`, `tiny-skia`, `chrono`, plus the tray/store/window-state plugins. A Tauri v2 release binary with these crates typically lands at 8-15 MB on Windows (MSI installer much larger). On Linux, the AppImage will be 30-80 MB because it bundles WebKit2GTK. The "~5 MB" claim is misleading and will disappoint users who chose Tauri specifically for small binaries.

**Fix**: Benchmark an actual Tauri v2 hello-world with these deps. Update the plan with realistic binary sizes per platform. AppImage size should be explicitly called out.

---

### 11. IMPORTANT — Scope creep: Onboarding wizard, CLI fallback, GNOME extension detection

For V1, the plan includes:

- A multi-step onboarding wizard with environment detection, WSL detection, GNOME AppIndicator checking, plan picker, and hook auto-configuration (Section 9)
- A `--status` CLI mode with `--pretty` formatting (Section 6.4)
- GNOME extension installation guidance (Section 9)
- Full accessibility pass with NVDA/Orca testing (Section 10/Phase 6)
- High contrast mode with outlined tray dots (Section 10)

The onboarding wizard alone is a significant UI with multiple detection codepaths (WSL, GNOME, native Windows). This is easily 2-3 weeks of work with testing. The CLI fallback is a separate interface that needs its own testing matrix.

**Cut candidates**: Defer onboarding wizard to V1.1 (use a simple settings page instead). Defer CLI fallback. Defer GNOME extension detection (just document it). Keep accessibility but scope it to keyboard nav + basic ARIA, defer NVDA/Orca formal testing.

---

### 12. IMPORTANT — The hardest thing is being underestimated: JSONL parser fidelity

The plan treats JSONL parsing as a straightforward port (Phase 1, lumped in with other modules). In reality, this is the hardest and most fragile part of the entire system. The JSONL format is:

- Undocumented and owned by Anthropic, subject to change without notice
- Contains multiple timestamp formats (Unix float, ISO 8601)
- Has nested structures (`message.usage.*`, tool use arrays)
- Has evolved over Claude Code versions (fields added/removed)
- Is the sole source of truth for token counts — the core value proposition

Getting this wrong means wrong token counts, which means wrong progress bars, which means users get rate-limited unexpectedly. The plan acknowledges this in Section 12.4 (token tracking accuracy) but still treats the parser as a Phase 1 task on par with `paths.rs`.

**Fix**: The JSONL parser should have its own dedicated testing phase with real-world JSONL files from multiple Claude Code versions. Build a corpus of edge cases. This is the foundation everything else depends on — if it's wrong, the app is useless.

---

### 13. IMPORTANT — No crash dump / panic handler strategy

The plan says nothing about what happens when the Rust backend panics or the app crashes. Default Tauri behavior may write crash info to stderr or a system log. On macOS, crash reports go to `~/Library/Logs/DiagnosticReports/` and can contain stack traces with file paths, session data from memory, and environment variables.

On Windows, WER (Windows Error Reporting) can capture minidumps that include heap memory — which would contain deserialized `sessions.json` content, workspace paths, and token counts.

**Fix**: Set a custom panic handler that avoids leaking session data. Disable WER minidumps for the process on Windows (`SetErrorMode`). On Linux, set the core dump size to 0 (`setrlimit`). Document this in the security section.

---

### 14. IMPORTANT — Missing dependency: WebKit2GTK on Linux

The plan lists Linux packages as AppImage and .deb (Section 4). Tauri v2 on Linux requires WebKit2GTK, which is:

- Not installed by default on minimal/server Ubuntu installations
- Version-sensitive (Tauri v2 requires WebKit2GTK 4.1+)
- A ~50 MB dependency chain

The plan doesn't mention this as a prerequisite or describe how the .deb package will declare it as a dependency. Users on minimal Linux installs will get a cryptic runtime error.

**Fix**: Add WebKit2GTK as an explicit runtime dependency. Document it in installation instructions. The .deb must declare it in `Depends:`. The AppImage should note that it still requires WebKit2GTK (AppImage does NOT bundle it for Tauri apps by default).

---

### 15. IMPORTANT — Timeline: 6 phases is optimistic by ~2x

Phase-by-phase reality check:

| Phase | Plan implies | Realistic estimate | Why |
|-------|-------------|-------------------|-----|
| 1: Foundation | 1-2 weeks | 2-3 weeks | Porting Swift logic to Rust with full tests is not trivial; JSONL parser alone is 1 week |
| 2: System Tray | 1 week | 2-3 weeks | tiny-skia rendering, DPI handling, cross-platform tray quirks, blink timer |
| 3: Dashboard | 1-2 weeks | 2-3 weeks | Faithful visual port from SwiftUI to React, responsive layout, dark/light themes |
| 4: Settings + Hook + Onboarding | 1-2 weeks | 3-4 weeks | Three parallel tracks, WSL bridge testing, GNOME detection, onboarding wizard |
| 5: Packaging | 1 week | 2-3 weeks | CI matrix for 4+ targets, installer testing on clean VMs, icon generation |
| 6: Accessibility | 1 week | 2-3 weeks | Screen reader testing is slow, fixes cascade, requires actual Windows/Linux hardware |

**Total**: Plan implicitly suggests ~6-10 weeks. Realistic: 14-20 weeks for a solo developer, 8-12 weeks for a pair.

---

### 16. MINOR — Contradiction: macOS paths in settings vs. sessions

Section 1 data paths table shows:
- Sessions: `~/Library/Application Support/Claude Cue/sessions.json`
- Settings: `~/Library/Application Support/com.claude-cue.app/settings.json`

These are in *different* directories on macOS (`Claude Cue` vs `com.claude-cue.app`). This is inconsistent — either use the app bundle ID convention for both, or the display name for both. Having two different conventions for the same app creates confusion during debugging and backup.

---

### 17. MINOR — `chrono` crate is a heavy dependency for date parsing

The plan includes `chrono` for ISO 8601 parsing. The `time` crate is lighter and covers the same use case. `chrono` pulls in significant code and has had past security advisories (RUSTSEC-2020-0159 for local time UB). For an app that explicitly runs `cargo audit`, this is a known friction point.

**Fix**: Consider `time` crate or `jiff` instead. Or pin a `chrono` version known to be clean.

---

### 18. MINOR — No mention of Tauri's default IPC security model

Tauri v2 uses a capability-based permission system for IPC between the frontend and backend. The plan doesn't mention configuring `capabilities` in `tauri.conf.json`. By default, Tauri v2 grants *no* capabilities — the frontend can't call any commands until permissions are explicitly declared. But if over-permissioned (e.g., granting `core:default` or `shell:allow-execute`), the WebView could be used as an attack vector if a frontend dependency is compromised.

**Fix**: Explicitly define minimal Tauri capabilities in the plan. Only `event:default`, `window:default`, and custom command permissions. No shell, no HTTP, no filesystem access from the frontend.

---

### 19. MINOR — Plan C risk: Token accuracy has no mitigation path

Section 12.4 identifies token tracking accuracy as a medium risk and suggests adding a disclaimer. But the plan provides no mechanism for calibration, no way to detect drift, and no fallback when estimates diverge from reality. If Anthropic changes their counting methodology or the JSONL format, the app silently becomes wrong.

**Fix**: Add a "last known rate limit event" detector — when a JSONL entry indicates a rate limit was hit, compare the app's estimate against the actual window. This gives a ground-truth calibration signal.

---

### 20. MINOR — Tray icon blink timer (0.5s) will cause unnecessary CPU wakes

A 0.5s blink timer that toggles icon alpha and re-renders via tiny-skia means the app wakes the CPU every 500ms even when the user isn't looking. On laptops, this prevents deep sleep states and wastes battery. Multiply by the number of blinking sessions.

**Fix**: Only run the blink timer when at least one session is in a blinking state. Stop the timer when all sessions are non-blinking. Use the OS compositor's animation support if available instead of re-rendering the entire icon.

---

### 21. MINOR — No file size cap on `sessions.json` or JSONL reads

The plan has no mention of maximum file sizes. If a bug in the hook (or a malicious actor) writes a 500 MB `sessions.json`, the app will attempt to `json::from_str()` the entire thing into memory. Similarly, JSONL conversation logs can grow very large for long sessions.

**Fix**: Set a maximum file size for `sessions.json` (e.g., 1 MB — more than enough for hundreds of sessions). For JSONL, read only the last N bytes or last N lines, not the entire file. The Swift app likely already has this problem; fix it in the Rust port.

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 5 |
| IMPORTANT | 10 |
| MINOR | 6 |

The plan is thorough on paper but has a gap between its *stated* security properties and what's *actually implemented* (findings 1-5). The security section reads like a spec, but the existing hook code doesn't match it. The WSL bridge (finding 1) directly violates the "no subprocess" invariant. The JSONL parser (finding 12) is the riskiest piece and is being treated as routine. Timeline (finding 15) is optimistic by roughly 2x.

The most dangerous pattern: the plan repeatedly describes security properties in the present tense ("the hook does not execute any external commands") that are aspirational, not actual. This creates a false sense of security during implementation — developers will assume these properties already hold when they don't.

**Top 3 actions before writing any Tauri code**:

1. Fix the existing hook: add `fsync`, `os.replace()`, `os.chmod(0o600)`, input validation.
2. Build and test the JSONL parser in isolation with a real-world corpus before anything else.
3. Resolve the WSL bridge design without `subprocess` — this is a security-critical path.
