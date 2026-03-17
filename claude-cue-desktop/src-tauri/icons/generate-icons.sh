#!/usr/bin/env bash
# generate-icons.sh — Generate app icons from icon.svg using ImageMagick
#
# Prerequisites: ImageMagick 7+ (magick) or ImageMagick 6 (convert)
# Usage: cd src-tauri/icons && ./generate-icons.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SVG="$SCRIPT_DIR/icon.svg"

if ! command -v magick &>/dev/null && ! command -v convert &>/dev/null; then
  echo "Error: ImageMagick is required. Install via:"
  echo "  macOS:  brew install imagemagick"
  echo "  Ubuntu: sudo apt install imagemagick"
  echo "  Windows: winget install ImageMagick.ImageMagick"
  exit 1
fi

# Use magick (v7) or fall back to convert (v6)
if command -v magick &>/dev/null; then
  CONVERT="magick"
else
  CONVERT="convert"
fi

echo "Generating icons from $SVG ..."

# PNG icons
$CONVERT "$SVG" -resize 32x32     "$SCRIPT_DIR/32x32.png"
$CONVERT "$SVG" -resize 128x128   "$SCRIPT_DIR/128x128.png"
$CONVERT "$SVG" -resize 256x256   "$SCRIPT_DIR/128x128@2x.png"

# Windows ICO (multi-size: 16, 32, 48, 256)
$CONVERT "$SVG" \
  \( -clone 0 -resize 16x16 \) \
  \( -clone 0 -resize 32x32 \) \
  \( -clone 0 -resize 48x48 \) \
  \( -clone 0 -resize 256x256 \) \
  -delete 0 \
  "$SCRIPT_DIR/icon.ico"

# macOS ICNS
# Note: For a proper .icns, use iconutil on macOS:
#   mkdir icon.iconset
#   sips -z 16 16     icon.png --out icon.iconset/icon_16x16.png
#   sips -z 32 32     icon.png --out icon.iconset/icon_16x16@2x.png
#   sips -z 128 128   icon.png --out icon.iconset/icon_128x128.png
#   sips -z 256 256   icon.png --out icon.iconset/icon_128x128@2x.png
#   sips -z 512 512   icon.png --out icon.iconset/icon_256x256@2x.png
#   iconutil -c icns icon.iconset -o icon.icns
#   rm -rf icon.iconset
#
# ImageMagick can also produce .icns but quality may vary:
if [[ "$(uname)" == "Darwin" ]]; then
  ICONSET="$SCRIPT_DIR/icon.iconset"
  mkdir -p "$ICONSET"
  $CONVERT "$SVG" -resize 16x16     "$ICONSET/icon_16x16.png"
  $CONVERT "$SVG" -resize 32x32     "$ICONSET/icon_16x16@2x.png"
  $CONVERT "$SVG" -resize 32x32     "$ICONSET/icon_32x32.png"
  $CONVERT "$SVG" -resize 64x64     "$ICONSET/icon_32x32@2x.png"
  $CONVERT "$SVG" -resize 128x128   "$ICONSET/icon_128x128.png"
  $CONVERT "$SVG" -resize 256x256   "$ICONSET/icon_128x128@2x.png"
  $CONVERT "$SVG" -resize 256x256   "$ICONSET/icon_256x256.png"
  $CONVERT "$SVG" -resize 512x512   "$ICONSET/icon_256x256@2x.png"
  $CONVERT "$SVG" -resize 512x512   "$ICONSET/icon_512x512.png"
  $CONVERT "$SVG" -resize 1024x1024 "$ICONSET/icon_512x512@2x.png"
  iconutil -c icns "$ICONSET" -o "$SCRIPT_DIR/icon.icns"
  rm -rf "$ICONSET"
  echo "Generated icon.icns via iconutil"
else
  echo "Skipping .icns generation (requires macOS iconutil)"
fi

echo "Done. Generated icons:"
ls -la "$SCRIPT_DIR"/*.png "$SCRIPT_DIR"/*.ico "$SCRIPT_DIR"/*.icns 2>/dev/null
