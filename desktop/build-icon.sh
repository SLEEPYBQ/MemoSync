#!/bin/sh
# Rebuilds the app icons from icon.svg (dark) and icon-light.svg. Needs macOS and rsvg-convert.
# icon.icns is what Finder shows; the two PNGs let the Dock follow the app's theme.
set -eu
cd "$(dirname "$0")"
set_dir="$(mktemp -d)/icon.iconset"
mkdir -p "$set_dir"
for size in 16 32 128 256 512; do
  rsvg-convert -w "$size" -h "$size" icon.svg -o "$set_dir/icon_${size}x${size}.png"
  rsvg-convert -w "$((size * 2))" -h "$((size * 2))" icon.svg -o "$set_dir/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$set_dir" -o icon.icns
rm -rf "$(dirname "$set_dir")"
rsvg-convert -w 1024 -h 1024 icon.svg -o icon-dark.png
rsvg-convert -w 1024 -h 1024 icon-light.svg -o icon-light.png
