#!/usr/bin/env bash
# Local macOS sign + notarize pipeline. CI runs the same steps via tauri-action;
# this script is for one-off developer releases.
#
# Required environment:
#   APPLE_SIGNING_IDENTITY   "Developer ID Application: Foo Bar (TEAMID)"
#   APPLE_ID                 Apple ID email
#   APPLE_PASSWORD           app-specific password (notarytool)
#   APPLE_TEAM_ID            10-char team id
#   TAURI_SIGNING_PRIVATE_KEY
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD

set -euo pipefail

cd "$(dirname "$0")/.."

require() {
  if [[ -z "${!1:-}" ]]; then
    echo "error: \$$1 must be set" >&2
    exit 1
  fi
}

for var in APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID \
           TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD; do
  require "$var"
done

# Build universal binary (arm64 + x86_64).
echo "→ building universal release"
npm run tauri build -- --target universal-apple-darwin

BUNDLE_DIR="src-tauri/target/universal-apple-darwin/release/bundle"
APP_PATH=$(find "$BUNDLE_DIR/macos" -maxdepth 1 -name '*.app' -print -quit)
DMG_PATH=$(find "$BUNDLE_DIR/dmg"   -maxdepth 1 -name '*.dmg' -print -quit)

if [[ -z "$APP_PATH" || -z "$DMG_PATH" ]]; then
  echo "error: bundle output missing under $BUNDLE_DIR" >&2
  exit 1
fi

# Notarize the .dmg — Apple's stapler will pick up the contained .app too.
echo "→ submitting $DMG_PATH to notarytool"
xcrun notarytool submit "$DMG_PATH" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait

echo "→ stapling notarization ticket"
xcrun stapler staple "$DMG_PATH"
xcrun stapler staple "$APP_PATH"

echo "✓ signed + notarized:"
echo "  $APP_PATH"
echo "  $DMG_PATH"
