#!/usr/bin/env bash
# Build the Cue desktop release bundle and deploy it to /Applications.
#
# The Tauri updater is configured with a public key, so `tauri build` attempts
# to sign the updater artifact (Cue.app.tar.gz) at the very end. The private key
# lives only in CI secrets, so locally that final step errors with:
#
#   Error A public key has been found, but no private key. Make sure to set
#   TAURI_SIGNING_PRIVATE_KEY environment variable.
#
# This is expected and harmless: the .app and .dmg are fully built BEFORE that
# step runs (look for "Finished N bundles at: ..."). We therefore tolerate the
# non-zero exit and deploy the bundle that was produced.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

APP_NAME="Cue.app"
BUNDLE_DIR="src-tauri/target/release/bundle/macos"
# /Applications is the macOS-standard install location and matches where end
# users drag the DMG. It's group-writable by admins (no sudo needed on a
# typical admin account); we fall back to sudo only if it isn't writable.
DEST="/Applications"

echo ">> Building release bundle..."
# Capture the build output so we can distinguish the EXPECTED failure (updater
# signing has no local private key, which happens AFTER the bundles are built)
# from a REAL failure (compile error, etc.) that never produced a fresh bundle.
# Without this, `|| echo WARN` swallows every non-zero exit and we'd redeploy a
# stale bundle left over from a previous successful build.
BUILD_LOG="$(mktemp)"
trap 'rm -f "$BUILD_LOG"' EXIT
npm run tauri build 2>&1 | tee "$BUILD_LOG" || echo "WARN: tauri build exited non-zero (expected only if it's the updater-signing step)"

# Tauri prints "Finished N bundles at: ..." once the .app/.dmg are written, which
# is BEFORE the updater-signing step that fails locally. No marker => the build
# died before bundling and there is no fresh bundle to deploy.
if ! grep -q "Finished .* bundles at:" "$BUILD_LOG"; then
  echo "ERROR: build did not reach the bundling step (no 'Finished N bundles' marker)." >&2
  echo "       Refusing to deploy a possibly-stale bundle. Aborting." >&2
  exit 1
fi

if [[ ! -d "${BUNDLE_DIR}/${APP_NAME}" ]]; then
  echo "ERROR: ${BUNDLE_DIR}/${APP_NAME} not found -- the bundle did not build. Aborting." >&2
  exit 1
fi

echo ">> Deploying to ${DEST}/${APP_NAME} ..."
if [ -w "${DEST}" ]; then
  rm -rf "${DEST:?}/${APP_NAME}"
  cp -R "${BUNDLE_DIR}/${APP_NAME}" "${DEST}/"
else
  echo "   (${DEST} not writable — using sudo; you may be prompted for your password)"
  sudo rm -rf "${DEST:?}/${APP_NAME}"
  sudo cp -R "${BUNDLE_DIR}/${APP_NAME}" "${DEST}/"
fi

echo "OK: deployed. Launch with: open \"${DEST}/${APP_NAME}\""
