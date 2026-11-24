# Proclaim Tap

A native macOS companion and self-hosted redirect server for Revival's presentation-aware NFC links. Every NFC tag holds one permanent URL; Proclaim's live announcement chooses the destination.

**[Server deployment instructions](server/README.md)** · **[Mac app downloads](https://github.com/Readyforeal/proclaim-tap/releases)**

The companion requires macOS 13 or later. The distributable is a universal app for Apple silicon and Intel Macs; no Node, Python, or additional runtime is required on the booth Mac. The server runs directly on Node.js 22.13+ behind Nginx, with a supplied systemd service, SQLite persistence, and no npm dependencies. Docker Compose is also available as an optional deployment.

## Set up cloud links (0.3.0)

Upgrade the server first using the [cloud upgrade instructions](server/README.md#upgrade-an-existing-native-installation-to-030). The database lives on your existing server; Docker is optional. The server requires Node.js **22.13 or later** for its bundled SQLite support.

1. Download **Proclaim Tap 0.3.0** from Releases and copy it to Applications on each Mac.
2. On the presentation Mac, enable Proclaim **Settings → Remote**, open your presentation and go **On Air**.
3. In Proclaim Tap's gear menu, set the HTTPS server URL and publish token. Choose **Presentation Mac**, enable **Sync links and presentations with server** and **Publish live destinations**, then save.
4. In Proclaim, add one marker to each linked item's title, for example `Giving [tap:giving]` or `Conference [tap:conference-2026]`.
5. Select that item in Proclaim Tap, enter its HTTPS URL and save. The app confirms the save only after the server accepts it.
6. On your laptop, use the same server URL and its separate editor token. Choose **Remote editor**, enable cloud sync, and save. Choose an uploaded presentation to edit its links. Proclaim is not required on the laptop.

The presentation Mac uploads item metadata and sends live slide status. The server resolves the current marker against the shared link library. Editing a shared URL takes effect for subsequent taps even before the booth sends another heartbeat. Remote editors never publish live state. Use only one live presentation Mac at a time; a previous publishing session expires after twenty seconds.

## Links across weekly presentations

**The marker is the identity**, not the presentation ID, item ID, title, or position. Duplicate last week's presentation and swap songs as usual. An unchanged `[tap:conference-2026]` continues using its saved URL even when Proclaim generates new IDs or the surrounding item title changes.

- Markers contain 1–64 ASCII letters, digits, hyphens or underscores, beginning with a letter or digit. Matching ignores case.
- Each item must have exactly one valid marker. Unmarked items, unknown markers, malformed/multiple markers, and unmapped items use Church Center.
- Every slide in an item shares its marker. Reusing a marker intentionally shares its URL across items, pre/post-service copies, and presentations.
- Renaming the marker itself creates a new identity. Use a new marker for a different event, such as `conference-2027`.
- Removing an item from a presentation leaves its shared link available for other presentations. Clearing the URL in the app removes that marker's shared link everywhere.
- There is no automatic title matching, content matching, or link expiration in this release.

Links and the latest thirty uploaded presentation snapshots persist in SQLite across app and server restarts. The live publishing lease deliberately does not survive a server restart; the public redirect stays at Church Center until fresh booth status arrives. Losing the booth heartbeat also restores fallback after twenty seconds.

The app syncs shared data about every three seconds. Conflicting saves are rejected for review instead of silently overwriting another device. A read-only local cache supports browsing during outages; saving needs a server connection. Unsaved text remains in the current editor during a connection interruption but is not an offline edit queue or a draft saved across app restarts.

The verified Proclaim API fetches **on-air presentations only**. A new presentation must be seen on air by the booth companion before it appears remotely. Uploaded presentations remain available when the booth Mac is off. Local Proclaim preparation on a second Mac is not automatically uploaded by Remote editor mode.

## Migrating local links

Existing 0.2.0 installations keep local mode until you enable cloud sync. Old clients can continue publishing to the upgraded server while you prepare the migration.

1. Keep a copy of `~/Library/Application Support/Proclaim Tap/links.json` or use **Export local link mappings**.
2. Open the existing mapped presentation on the booth Mac. Add markers to those same Proclaim items and allow the companion to sync.
3. Enable cloud sync in Settings, then click **Import local links for this presentation**. Only locally mapped items with valid markers are imported. Conflicting URLs for the same marker reject the entire import; resolve those by assigning the desired shared URL manually.
4. Verify the shared links and public redirect before a service. Repeat for any other locally mapped presentations you want to import.

Local-mode assignments remain keyed by presentation ID + item ID and can need reassignment after duplication. Cloud mode uses only the server's marker links; it never silently substitutes an old local link. Tokens remain in each Mac's Keychain and are not included in exported mappings or the offline cache.

The app requires macOS 13 or later. It is ad-hoc signed, not notarized. It starts monitoring/syncing when opened but does not install a login item. Closing its window quits it. Its manual **Use Church Center for every tap** override is available on the presentation Mac and resets when the app restarts. Demo slides are never uploaded or published.

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

Run `npm test` in `server` for HTTP routing, authentication, heartbeat expiry, marker reuse across weekly IDs, editor permissions, conflict handling and SQLite restart persistence.

Run `bash scripts/check-cloud-editor.sh` for the actual Mac app model's remote-editor behavior, acknowledged saves, stale-edit rejection, offline cache and old-settings migration. Run `bash scripts/check-publisher.sh` for a Swift-to-Node integration test using a temporary local server and test credentials. The workflow runs these checks and validates the Linux service, Nginx configuration and Docker build.

To repeat the monitor regression checks on a development Mac without Proclaim running, start `python3 scripts/mock-proclaim.py /private/tmp/proclaim-tap-state.json` in one terminal and run `bash scripts/check-monitor.sh` in another. Stop the simulator afterward. It uses memory-only link settings and does not publish to the real server.

The original local-monitor integration was confirmed on Proclaim 4.22. Test the new cloud workflow against the real booth presentation before a service, including duplicating a presentation and confirming that markers remain in the item titles. The native app and server automate URL routing; they do not alter or advance Proclaim slides.
