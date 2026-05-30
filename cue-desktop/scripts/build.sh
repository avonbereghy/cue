#!/usr/bin/env bash
# Local release build → ~/Applications/Cue.app
#
# Unsigned, native-arch (aarch64 on Apple Silicon). For signed/notarized
# distribution releases, use scripts/build-and-notarize.sh instead.

set -euo pipefail

cd "$(dirname "$0")/.."

ARCH=$(uname -m)
case "$ARCH" in
  arm64)  TARGET="aarch64-apple-darwin" ;;
  x86_64) TARGET="x86_64-apple-darwin" ;;
  *) echo "error: unsupported arch $ARCH" >&2; exit 1 ;;
esac

DEST="$HOME/Applications/Cue.app"

# Refuse to overwrite a running app — macOS will let the build succeed but
# the user will be running the stale copy until they relaunch.
if pgrep -fx "$DEST/Contents/MacOS/cue-desktop" >/dev/null 2>&1; then
  echo "error: Cue.app is running — quit it before rebuilding" >&2
  exit 1
fi

echo "→ building $TARGET release"
npm run tauri build -- --target "$TARGET"

SRC="src-tauri/target/$TARGET/release/bundle/macos/Cue.app"
if [[ ! -d "$SRC" ]]; then
  echo "error: bundle missing at $SRC" >&2
  exit 1
fi

echo "→ deploying to $DEST"
mkdir -p "$HOME/Applications"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"

# Strip the quarantine bit so a freshly-copied unsigned build launches
# without the Gatekeeper "downloaded from the internet" warning.
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

echo "✓ installed $DEST"
