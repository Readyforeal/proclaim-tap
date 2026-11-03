# Proclaim Tap

A native macOS companion and self-hosted redirect server for Revival's presentation-aware NFC links. Every NFC tag holds one permanent URL; Proclaim's live announcement chooses the destination.

**[Server deployment instructions](server/README.md)** · **[Mac app downloads](https://github.com/Readyforeal/proclaim-tap/releases)**

The companion requires macOS 13 or later. The distributable is a universal app for Apple silicon and Intel Macs; no Node, Python, or additional runtime is required on the booth Mac. The server runs directly on Node.js 22+ behind Nginx, with a supplied systemd service and no npm dependencies or database. Docker Compose is also available as an optional deployment.

## Open the companion

1. Copy `dist/Proclaim Tap.app` to the Mac that runs Proclaim (Applications is a convenient destination).
2. In Proclaim, enable **Settings → Remote**, open a presentation, and go **On Air**.
3. Open **Proclaim Tap**. It connects and fetches the on-air presentation automatically.
4. Deploy the server using its README. In the gear menu, enter its HTTPS URL and publish token, enable publishing, and save the server settings.
5. Select an item, enter its HTTPS destination, and click **Save link**. Each mapping covers all slides in that item.

The current item updates without pressing Sync. **Sync** explicitly reloads the presentation; changes to its revision also trigger a reload automatically. The item list stays available for editing when the connection drops. The live preview clears on failure, pause, or off-air detection. **Explore a sample presentation** works without Proclaim; its mappings use a separate demo presentation ID.

Version 0.2.0 publishes destination changes and sends a heartbeat every five seconds when server publishing is enabled. The server restores Church Center after twenty seconds without a fresh update. The manual Church Center override restores fallback on the next successful update and resets when the app restarts. Public fallback is configured by the server's `CHURCH_CENTER_URL`; the app's local fallback field is for preview before connecting a server. Without server settings, the companion remains a local preview.

The app starts monitoring when opened; it does not install a login item. Closing the window quits the app. The app is ad-hoc signed, not Developer ID signed or notarized; macOS may require explicit approval after transferring it to another Mac.

## Link persistence

Links are stored atomically in `~/Library/Application Support/Proclaim Tap/links.json` and can be exported from Settings. Keys use **presentation ID + item ID**, not titles or positions. This prevents accidental matches between repeated titles and separate services. Copies in pre-service, service, and post-service each have their own mapping. A duplicated weekly presentation may need its links reassigned; reusable destination groups and cross-week mapping are not implemented yet.

The app reads presentation data from `127.0.0.1:52195`. When publishing is enabled, it sends only the resolved destination URL and publisher protocol fields to your server over HTTPS. It does not upload presentation content or the full mapping list. The publish token is stored in macOS Keychain, outside the exported mappings. The UI's “Sync” fetches the on-air presentation from the local API; it does not trigger Proclaim cloud synchronization.

## Verified API contract

Verified manually with Proclaim 4.22 on November 3, 2026:

- `GET /onair/session`: returns the on-air session ID. Empty/204 means off air.
- `GET /presentations/onair`, with `OnAirSessionId`: returns presentation ID, local revision, items, slide indices, and section boundaries.
- `GET /onair/statusChanged?localrevision=<revision>&step=0`, with `OnAirSessionId`: returns current item ID, slide index, quick-screen state, and presentation revision.

The status route was verified against two different announcements on screen. This implementation polls sequentially, waiting one second after each cycle, with bounded request timeouts and automatic retries. It does not assume a WebSocket or push subscription. A new session causes a fresh presentation fetch. Revision changes cause a reload; mismatched revisions cannot activate mapped links. Quick screens, unknown items, out-of-range slides, and unmapped items use the fallback.

Reference implementation: [Companion maintainer's remote API branch](https://github.com/hussra/companion-module-logos-proclaim/blob/feat/remote-api-v2/src/api.ts). This API is version-sensitive; live testing on the booth Mac remains necessary.

## Build and test

Install Apple's Command Line Tools, then run:

```sh
bash scripts/build-app.sh
CLANG_MODULE_CACHE_PATH="$PWD/.build/clang-cache" SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/swift-cache" swift run --disable-sandbox TapChecks
```

The build produces `dist/Proclaim Tap.app` and `dist/Proclaim-Tap.zip`. Launch with `--demo` for a sample presentation. Checks use a standalone Swift executable and a mock URL protocol, so they run with Command Line Tools without requiring Xcode's XCTest framework.

## Booth acceptance check

- Confirm the reported item follows forward, backward, and direct item selection.
- Confirm the pre-service loop advances the preview automatically.
- Assign a link and confirm an unmapped item returns the preview to Church Center.
- Test off air, quit/relaunch Proclaim, and pause/resume the companion.
- Edit an on-air presentation and confirm refreshed item data; use Sync if Proclaim has not yet updated its local API snapshot.
- Test quick screens and the manual fallback override.
- Restart the companion and confirm saved links persist.

These live booth checks are separate from the automated API-contract and routing tests.

## Development validation

The standalone API/routing checks and monitor integration checks passed on November 3, 2026. The monitor was tested against `scripts/mock-proclaim.py` for auto-sync, item changes, revision refresh, quick screens, off air, server errors, reconnection, pause, and cancellation. The universal binary contains both arm64 and x86_64 slices, and the bundle signature and Info.plist validate. Only the Apple silicon build was executed here.

To repeat the monitor checks on a development Mac without Proclaim running, start `python3 scripts/mock-proclaim.py /private/tmp/proclaim-tap-state.json` in one terminal and run `bash scripts/check-monitor.sh` in another. Stop the simulator afterward. The test fixture is clearly labeled and uses memory-only link settings in the test process.

The initial companion was confirmed by the operator to pull live slides successfully. Automated checks cover the publisher protocol and server behavior. Docker is not installed in the local development environment; the GitHub workflow builds the container on Linux. Live server deployment remains operator-managed. Visual QA of the updated settings panel could not be completed here because the computer-use tool's macOS screen capture failed.
