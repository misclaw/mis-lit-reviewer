#!/usr/bin/env bash
# Builds build/Paper Trails.app: compiles main.swift, renders the icon from
# icon.svg, assembles the bundle, and ad-hoc signs it. Requires the Xcode
# command-line tools (swiftc, sips, iconutil, codesign, qlmanage).
set -euo pipefail
cd "$(dirname "$0")"

APP="build/Paper Trails.app"
rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "· compiling main.swift"
swiftc -O main.swift -o "$APP/Contents/MacOS/PaperTrails"

echo "· rendering icon"
rm -f icon.svg.png
qlmanage -t -s 1024 -o . icon.svg >/dev/null
ICONSET=build/AppIcon.iconset
mkdir -p "$ICONSET"
for sz in 16 32 128 256 512; do
  sips -z $sz $sz icon.svg.png --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null
  dbl=$((sz * 2))
  sips -z $dbl $dbl icon.svg.png --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET" icon.svg.png

cp Info.plist "$APP/Contents/Info.plist"

echo "· signing (ad-hoc)"
codesign --force --sign - "$APP"

echo "built: $PWD/$APP"
echo "run:   open \"$PWD/$APP\"     (dev: PT_URL=http://localhost:5174 \"$PWD/$APP/Contents/MacOS/PaperTrails\")"
