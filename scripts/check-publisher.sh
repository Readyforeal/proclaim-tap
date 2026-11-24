#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CLANG_MODULE_CACHE_PATH="$PWD/.build/clang-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/swift-cache"
swift build --disable-sandbox --product ProclaimTap
binary_dir=$(swift build --disable-sandbox --show-bin-path)
swiftc -parse-as-library -target "$(uname -m)-apple-macosx13.0" \
  -I "$binary_dir/Modules" scripts/PublishChecks.swift \
  "$binary_dir/TapCore.build/ServerClient.swift.o" \
  "$binary_dir/TapCore.build/Models.swift.o" \
  -o "$PWD/.build/PublishChecks"
export PUBLIC_URL=https://tap.example.org
export CHURCH_CENTER_URL=https://church.example/
export PUBLISH_TOKEN
PUBLISH_TOKEN=$(openssl rand -hex 32)
export PORT=3099 HOST=127.0.0.1
export DATA_DIR="$PWD/.build/publisher-data"
node server/src/main.js > .build/publisher-test-server.log 2>&1 &
test_server_pid=$!
trap 'kill "$test_server_pid" 2>/dev/null || true' EXIT
for attempt in {1..30}; do
  if ! kill -0 "$test_server_pid" 2>/dev/null; then cat .build/publisher-test-server.log; exit 1; fi
  if curl -fsS http://127.0.0.1:3099/healthz > /dev/null 2>&1; then break; fi
  sleep 0.1
done
"$PWD/.build/PublishChecks"
