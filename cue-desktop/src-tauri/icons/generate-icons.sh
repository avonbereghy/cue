#!/usr/bin/env bash
# generate-icons.sh — Generate app icons from icon.svg.
#
# Strategy: rasterize once at 1024 with rsvg-convert (much sharper SVG renderer
# than ImageMagick), then sips down-samples (Lanczos) for each size. Falls
# back to ImageMagick if rsvg-convert isn't installed.
#
# Prereqs (mac):  brew install librsvg imagemagick
#         (linux): apt install librsvg2-bin imagemagick

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SVG="$SCRIPT_DIR/icon.svg"

have() { command -v "$1" &>/dev/null; }

# Resolve renderer
if have rsvg-convert; then
  RENDER() { rsvg-convert -w "$1" -h "$1" "$SVG" -o "$2"; }
elif have magick; then
  RENDER() { magick -density 600 -background none "$SVG" -resize "${1}x${1}" "$2"; }
elif have convert; then
  RENDER() { convert -density 600 -background none "$SVG" -resize "${1}x${1}" "$2"; }
else
  echo "Error: install librsvg (rsvg-convert) or ImageMagick"; exit 1
fi

echo "Rendering master 1024 PNG ..."
MASTER="$SCRIPT_DIR/.master-1024.png"
RENDER 1024 "$MASTER"

# Down-sample helper. On macOS prefer sips (Lanczos, sharp). Fallback: re-render.
downsample() {
  local size="$1" out="$2"
  if [[ "$(uname)" == "Darwin" ]] && have sips; then
    sips -s format png -z "$size" "$size" "$MASTER" --out "$out" >/dev/null
  else
    RENDER "$size" "$out"
  fi
}

echo "Generating PNG icons ..."
downsample 32  "$SCRIPT_DIR/32x32.png"
downsample 128 "$SCRIPT_DIR/128x128.png"
downsample 256 "$SCRIPT_DIR/128x128@2x.png"

echo "Generating Windows ICO ..."
ICO_TMPDIR="$(mktemp -d)"
for s in 16 32 48 256; do downsample "$s" "$ICO_TMPDIR/icon-${s}.png"; done
if have magick; then
  magick "$ICO_TMPDIR"/icon-{16,32,48,256}.png "$SCRIPT_DIR/icon.ico"
elif have convert; then
  convert "$ICO_TMPDIR"/icon-{16,32,48,256}.png "$SCRIPT_DIR/icon.ico"
else
  # ICO assembly needs ImageMagick even when rsvg-convert rendered the PNGs.
  # Without this warning the script prints "Done." and leaves a stale/missing
  # icon.ico, and Windows builds ship the wrong icon with no signal.
  echo "WARNING: ImageMagick (magick/convert) not found — icon.ico was NOT regenerated." >&2
  echo "         Windows builds will use the existing icon.ico. Install ImageMagick to update it." >&2
fi
rm -rf "$ICO_TMPDIR"

if [[ "$(uname)" == "Darwin" ]]; then
  echo "Generating macOS ICNS via iconutil ..."
  ICONSET="$SCRIPT_DIR/icon.iconset"
  rm -rf "$ICONSET"; mkdir -p "$ICONSET"
  downsample 16   "$ICONSET/icon_16x16.png"
  downsample 32   "$ICONSET/icon_16x16@2x.png"
  downsample 32   "$ICONSET/icon_32x32.png"
  downsample 64   "$ICONSET/icon_32x32@2x.png"
  downsample 128  "$ICONSET/icon_128x128.png"
  downsample 256  "$ICONSET/icon_128x128@2x.png"
  downsample 256  "$ICONSET/icon_256x256.png"
  downsample 512  "$ICONSET/icon_256x256@2x.png"
  downsample 512  "$ICONSET/icon_512x512.png"
  downsample 1024 "$ICONSET/icon_512x512@2x.png"
  iconutil -c icns "$ICONSET" -o "$SCRIPT_DIR/icon.icns"
  rm -rf "$ICONSET"
fi

rm -f "$MASTER"
echo "Done. Outputs:"
ls -la "$SCRIPT_DIR"/*.png "$SCRIPT_DIR"/*.ico "$SCRIPT_DIR"/*.icns 2>/dev/null
