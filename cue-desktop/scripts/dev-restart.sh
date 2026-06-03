#!/usr/bin/env bash
# Rebuild the background (LaunchAgent) Cue correctly and restart it.
#
# Two traps this avoids, both of which silently break the menubar app:
#   1. dev-mode blank: a plain `cargo build` binary loads the Vite dev server
#      (localhost:1420) and paints blank white when run standalone. `tauri build`
#      (even --debug) embeds the frontend, so the window actually renders.
#   2. codesigning spawn failure: relinking invalidates the ad-hoc signature, so
#      arm64 macOS refuses to spawn it under launchd (OS_REASON_CODESIGNING).
#      Re-sign before restart.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "→ building build-mode debug binary (embedded frontend, no bundle)"
npm run tauri build -- --debug --no-bundle
echo "→ ad-hoc re-signing"
codesign --force --sign - src-tauri/target/debug/Cue
echo "→ restarting LaunchAgent"
launchctl kickstart -k "gui/$(id -u)/Cue"
echo "✓ Cue restarted (build-mode, signed)"
