# Phase 5: Packaging, Installers, CI/CD

Read plans/cross_platform_final_plan.md for full context.

## Background
`tauri.conf.json` was created in Phase 1 with the app identifier and basic config. This phase updates the bundle section and creates CI/CD workflows.

## Tasks
1. Update `tauri.conf.json` bundle section:
   - Windows: MSI + NSIS targets, publisher name, description
   - Linux: AppImage + .deb targets, `.desktop` file metadata (Name, Comment, Categories: "Development;Utility;", StartupWMClass)
   - .deb `Depends:` must include `libwebkit2gtk-4.1-0` (WebKit2GTK runtime dependency)
   - VERIFY: `"devtools": false` in release profile (already set in Phase 1, but double-check)
2. Generate app icons for all platforms:
   - Use the dot grid concept from `generate-icon.swift` — dark rounded square background + colored dot grid
   - Windows: `icon.ico` containing 256×256, 128×128, 64×64, 48×48, 32×32, 16×16 sizes
   - Linux: `icon.png` at 32×32, 128×128, 256×256, 512×512 + `icon.svg` if feasible
   - Place in `src-tauri/icons/`
3. Create `.github/workflows/release.yml`:
   - Trigger: tag push matching `v*` (e.g., `v1.0.0`)
   - Build matrix:
     - `windows-latest` → produces MSI + NSIS .exe
     - `ubuntu-22.04` → produces AppImage + .deb
   - Use `tauri-apps/tauri-action@v0` for builds
   - Post-build: generate SHA-256 checksums for all artifacts
   - Create GitHub Release with all artifacts + checksums attached
   - Release body: changelog from tag annotation or CHANGELOG.md
4. Create `.github/workflows/ci.yml`:
   - Trigger: PR and push to `main`
   - Steps:
     - `cargo test` (Rust unit tests)
     - `cargo audit` (vulnerability check)
     - `cargo clippy -- -D warnings` (lint)
     - `npm audit` (frontend vulnerability check)
     - `npm run build` (TypeScript compilation)
     - Verify `devtools` is false: `grep -q '"devtools": false' src-tauri/tauri.conf.json`
   - Matrix: ubuntu-22.04 (Linux) + windows-latest (Windows)
   - Install WebKit2GTK on Linux runner: `sudo apt-get install -y libwebkit2gtk-4.1-dev`
5. Create `INSTALL.md` in `cue-desktop/`:
   - Windows: download MSI from Releases, run installer, follow onboarding wizard
   - Linux AppImage: download, `chmod +x ClaudeCue.AppImage`, run. Note: GNOME users need AppIndicator extension for tray icon.
   - Linux .deb: `sudo dpkg -i cue-desktop_*.deb` (auto-installs WebKit2GTK dependency)
   - Prerequisites: Python 3 (for hook script), Claude Code installed

## Files to create
- `.github/workflows/release.yml`
- `.github/workflows/ci.yml`
- `cue-desktop/src-tauri/icons/icon.ico`
- `cue-desktop/src-tauri/icons/icon.png` (multiple sizes)
- `cue-desktop/INSTALL.md`

## Files to modify
- `cue-desktop/src-tauri/tauri.conf.json` — update bundle section only (do not change capabilities, commands, or other config)

## Files NOT to touch
- Everything in `Sources/` and `hooks/`
- Rust source files in `src-tauri/src/` (no code changes this phase)
- React component files in `src/` (no code changes this phase)

## Verification
- `npm run tauri build` produces MSI on Windows, AppImage + .deb on Linux
- Clean install on fresh Windows 10 VM: app launches, tray icon appears, onboarding wizard shows
- Clean install on fresh Windows 11 VM: same
- Clean install on fresh Ubuntu 22.04 VM (with WebKit2GTK): app launches, tray icon appears
- Clean install on fresh Ubuntu 24.04 VM: same
- .deb package correctly declares WebKit2GTK dependency
- `cargo audit` and `npm audit` pass in CI
- CI rejects if `devtools` is not `false` in release config
- Release artifacts include SHA-256 checksums
- Uninstall is clean (no leftover files except `~/.config/cue/` user data)
- GitHub Actions workflow runs successfully on both matrix targets
