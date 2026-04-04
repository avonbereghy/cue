# Phase 2: System Tray + Icon Rendering

Read plans/cross_platform_final_plan.md for full context.

## Tasks

Spawn teammates:
- "icon-rendering" → create `src-tauri/src/tray.rs` ONLY (icon generation, exports public API)
- "tray-cli" → create `src-tauri/src/cli.rs` ONLY (CLI fallback mode)

After both teammates complete, the team lead integrates by modifying `main.rs` to wire up tray + CLI.

### Track A: Icon Rendering (`tray.rs`)
1. Port `renderDotGrid()` from `../Sources/main.swift` using `tiny-skia`
2. Render at a "native" size (e.g., 64x64) using the Swift layout constants: 7px dots, 3.5px h-spacing, 3px v-spacing, 2px padding, max 2 per column. Then scale down to target sizes.
3. Export a public function: `pub fn render_dot_grid(sessions: &[EnrichedSession], blink_on: bool, size: u32) -> Vec<u8>` returning RGBA PNG bytes.
4. Also export: `pub fn render_dot_grid_high_contrast(sessions: &[EnrichedSession], blink_on: bool, size: u32) -> Vec<u8>` — outlined circles with fill for light taskbars.
5. Draw filled circles with correct colors per state:
   - working: white, blink (alpha 1.0 ↔ 0.15)
   - waiting: yellow, no blink
   - error: red, no blink
   - subagent: cyan, blink (alpha 1.0 ↔ 0.15)
   - idle: white @ 35% alpha, no blink
   - done: green, no blink
6. No-session state: hollow white ring
7. Pre-generate icon cache: `pub struct IconCache` that stores common variants (0-8 sessions × 2 blink states) at startup. Regenerate only when session list changes.
8. Unit tests: verify PNG output is non-empty for 0, 1, 4, 8 sessions.

### Track B: CLI Fallback (`cli.rs`)
1. Parse CLI args: `--status` (JSON output), `--status --pretty` (human-readable)
2. Read `sessions.json` from `paths::sessions_json_path()`
3. For `--status`: serialize sessions as JSON to stdout, then exit
4. For `--status --pretty`: format as table with state icon, workspace (leaf name only), duration, tokens
5. Export: `pub fn try_run_cli() -> Option<()>` — returns `Some(())` if CLI mode was handled (app should exit), `None` if normal GUI mode
6. Unit tests: verify JSON output structure, verify pretty output contains expected fields

### Integration (team lead, after both tracks complete)
1. Add to `main.rs`: `mod tray; mod cli;`
2. At app start: call `cli::try_run_cli()` — if `Some`, exit immediately (no GUI)
3. Set up `TrayIconBuilder` with icon from `tray::render_dot_grid()`
4. Dynamic menu construction from `session_monitor` data:
   - Header: "Claude Code Sessions"
   - Per-session: state icon + workspace leaf name + elapsed time + token count
   - Separator
   - "Dashboard..." (accelerator: Ctrl+D)
   - "Settings..." (accelerator: Ctrl+,)
   - "Quit" (accelerator: Ctrl+Q)
5. Platform-specific click behavior:
   - Windows: left-click opens dashboard, right-click opens menu
   - Linux: left-click opens menu (standard StatusNotifierItem behavior)
6. Tooltip: "Cue — N sessions"
7. Blink timer: 0.5s interval, only active when `sessions.iter().any(|s| s.info.state == "working" || s.info.state == "subagent")`. Stop timer when no blinking sessions.

## Files to create
- `cue-desktop/src-tauri/src/tray.rs` (Track A)
- `cue-desktop/src-tauri/src/cli.rs` (Track B)

## Files to modify (integration only, after tracks complete)
- `cue-desktop/src-tauri/src/main.rs` — add `mod tray; mod cli;`, tray setup, blink timer, CLI check at startup

## Files NOT to touch
- Everything in `Sources/` and `hooks/`
- Phase 1 Rust modules (models, paths, security, jsonl_parser, etc.) — import and use, don't modify

## Verification
- `cargo test` — all tray and cli tests pass
- Tray icon visible and correctly colored on Windows 10/11 and Linux (GNOME+AppIndicator, KDE)
- Menu shows real session data with state icons, elapsed time, token counts
- Blink animation at 0.5s cadence for working/subagent states
- Blink timer stops when no blinking sessions exist (verify CPU drops to ~0%)
- `cue --status` outputs valid JSON with session data
- `cue --status --pretty` outputs readable table
- Dots legible at 16x16 and 32x32 pixel sizes
- High-contrast variant visible on light backgrounds
