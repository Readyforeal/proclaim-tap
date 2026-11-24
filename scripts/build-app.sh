#!/bin/bash
# Builds dist/Proclaim Tap.app and dist/Proclaim-Tap.zip. ARCH=arm64|x64|universal (default universal).
set -euo pipefail
cd "$(dirname "$0")/../app"
arch="${ARCH:-universal}"
icon_source="$PWD/../Proclaim Tap.icon"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Static icon for macOS 13–15 and for builds without Xcode. Regenerated from the Icon Composer
# document whenever Icon Composer is installed; otherwise the committed build/icon.icns is used.
ictool="/Applications/Icon Composer.app/Contents/Executables/ictool"
if [ -x "$ictool" ]; then
  "$ictool" "$icon_source" --export-image --output-file "$work/full.png" --platform macOS --rendition Default --width 1024 --height 1024 --scale 1 > /dev/null
  # Icon Composer renders edge to edge; classic .icns artwork sits on an 824pt grid inside 1024.
  sips -z 824 824 "$work/full.png" --out "$work/art.png" > /dev/null
  sips -p 1024 1024 "$work/art.png" --out "$work/master.png" > /dev/null
  mkdir "$work/icon.iconset"
  for size in 16 32 128 256 512; do
    sips -z $size $size "$work/master.png" --out "$work/icon.iconset/icon_${size}x${size}.png" > /dev/null
    sips -z $((size * 2)) $((size * 2)) "$work/master.png" --out "$work/icon.iconset/icon_${size}x${size}@2x.png" > /dev/null
  done
  mkdir -p build
  iconutil -c icns "$work/icon.iconset" -o build/icon.icns
fi

# Light/dark/tinted icon for macOS 26 and later. The packager compiles the Icon Composer document when it sits
# beside the .icns, but that needs Xcode 26+'s asset compiler; Command Line Tools alone do not have it.
cp build/icon.icns "$work/icon.icns"
if actool --version > /dev/null 2>&1; then
  cp -R "$icon_source" "$work/icon.icon"
else
  echo "Note: Xcode not found, so this build has the static icon only. Install Xcode for the light/dark icon."
fi

npm ci
version=$(node -p "require('./package.json').version")
rm -rf ../dist
npx electron-packager . "Proclaim Tap" --platform=darwin --arch="$arch" --out="$work/out" --asar \
  --icon="$work/icon.icns" --app-bundle-id=org.revivalomaha.proclaim-tap --build-version="$version" \
  --ignore='^/(test|build)($|/)'
mkdir -p ../dist
mv "$work/out/Proclaim Tap-darwin-$arch/Proclaim Tap.app" ../dist/
app="$PWD/../dist/Proclaim Tap.app"

codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
ditto -c -k --sequesterRsrc --keepParent "$app" "$PWD/../dist/Proclaim-Tap.zip"
(cd ../dist && shasum -a 256 Proclaim-Tap.zip > SHA256SUMS.txt)
echo "Built: $app"
