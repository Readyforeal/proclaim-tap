#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CLANG_MODULE_CACHE_PATH="$PWD/.build/clang-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/swift-cache"
swift build --disable-sandbox --product ProclaimTap
binary_dir=$(swift build --disable-sandbox --show-bin-path)
swiftc -parse-as-library -target "$(uname -m)-apple-macosx13.0" \
  -I "$binary_dir/Modules" \
  Sources/ProclaimTap/AppModel.swift Sources/ProclaimTap/ServerSettings.swift scripts/MonitorChecks.swift \
  "$binary_dir/TapCore.build/Models.swift.o" \
  "$binary_dir/TapCore.build/ProclaimClient.swift.o" \
  "$binary_dir/TapCore.build/ServerClient.swift.o" \
  -o "$PWD/.build/MonitorChecks"
"$PWD/.build/MonitorChecks"
