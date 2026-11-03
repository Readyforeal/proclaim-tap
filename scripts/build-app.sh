#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CLANG_MODULE_CACHE_PATH="$PWD/.build/clang-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/swift-cache"
swift build -c release --disable-sandbox --product ProclaimTap --triple arm64-apple-macosx13.0
arm_dir=$(swift build -c release --disable-sandbox --triple arm64-apple-macosx13.0 --show-bin-path)
swift build -c release --disable-sandbox --product ProclaimTap --triple x86_64-apple-macosx13.0
intel_dir=$(swift build -c release --disable-sandbox --triple x86_64-apple-macosx13.0 --show-bin-path)
app="$PWD/dist/Proclaim Tap.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
lipo -create "$arm_dir/ProclaimTap" "$intel_dir/ProclaimTap" -output "$app/Contents/MacOS/ProclaimTap"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>ProclaimTap</string>
<key>CFBundleIdentifier</key><string>org.revivalomaha.proclaim-tap</string>
<key>CFBundleName</key><string>Proclaim Tap</string>
<key>CFBundleDisplayName</key><string>Proclaim Tap</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>CFBundleVersion</key><string>2</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSLocalNetworkUsageDescription</key><string>Read the live presentation from Proclaim on this Mac.</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
codesign --force --sign - "$app"
ditto -c -k --sequesterRsrc --keepParent "$app" "$PWD/dist/Proclaim-Tap.zip"
echo "Built: $app"
