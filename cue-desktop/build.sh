#!/usr/bin/env bash
# Build the Cue desktop release bundle and deploy it to ~/Applications.
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
DEST="$HOME/Applications"

echo ">> Building release bundle..."
npm run tauri build || echo "WARN: tauri build exited non-zero (expected: updater signing has no local private key)"

if [[ ! -d "${BUNDLE_DIR}/${APP_NAME}" ]]; then
  echo "ERROR: ${BUNDLE_DIR}/${APP_NAME} not found -- the bundle did not build. Aborting." >&2
  exit 1
fi

echo ">> Deploying to ${DEST}/${APP_NAME} ..."
mkdir -p "${DEST}"
rm -rf "${DEST:?}/${APP_NAME}"
cp -R "${BUNDLE_DIR}/${APP_NAME}" "${DEST}/"

echo "OK: deployed. Launch with: open \"${DEST}/${APP_NAME}\""
