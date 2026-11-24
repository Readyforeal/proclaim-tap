# Proclaim Tap redirect server

Every NFC tag contains `https://tap.revivalomaha.org`. The public root returns a non-cacheable **302** to the current announcement URL. When there is no fresh announcement, it redirects to the configured Church Center homepage.

In cloud mode (0.3.0), the presentation Mac uploads item metadata and reports live slide identity. The server resolves `[tap:marker]` against its persistent link library. Remote editors can change shared links without publishing live slides. The Mac companion sends authenticated updates and a heartbeat every five seconds. The default expiry is twenty seconds. Off-air, unmapped items, quick screens, pause, and the manual fallback override restore Church Center after the next successful live-state update. Legacy 0.2.0 clients continue sending a resolved `activeURL` or `null`. App crashes, power loss, and internet failures expire automatically. Each tap is independent; a person already completing a form stays on that page.

## Deploy with Nginx and systemd (no Docker)

Nginx handles HTTPS and forwards requests to a small Node process on `127.0.0.1:3000`. systemd starts that process at boot and restarts it if it crashes. There are no npm dependencies to install and no build step. SQLite is bundled with Node; the service stores its library in `/var/lib/proclaim-tap/links.sqlite`.

These commands target Ubuntu/Debian with an existing Nginx installation and sudo access. Install **Node.js 22.13 or later system-wide** first, then check `node --version` and `command -v node`. The supplied service uses `/usr/bin/node`; if yours is elsewhere, change `ExecStart` before installing it. A Node installation under a user's home directory will not work with this service's `ProtectHome` setting.

### 1. Get the repository

Authenticate to GitHub with an account or read-only deploy key that can access the private repository. Run Git as your normal login user:

```sh
sudo install -d -m 755 -o "$USER" -g "$(id -gn)" /opt/proclaim-tap
git clone git@github.com:Readyforeal/proclaim-tap.git /opt/proclaim-tap
cd /opt/proclaim-tap/server
```

If already cloned at this path, just `cd /opt/proclaim-tap/server` and `git pull --ff-only`. If choosing another path, update both paths in the service file and ensure the service user can read the source. The default service intentionally cannot read files under `/home`.

### 2. Configure the server

```sh
sudo install -m 600 .env.example /etc/proclaim-tap.env
openssl rand -hex 32
sudoedit /etc/proclaim-tap.env
```

Set these values, using the actual Church Center homepage and the generated token:

```dotenv
PUBLIC_URL=https://tap.revivalomaha.org
CHURCH_CENTER_URL=https://YOUR-ACTUAL-CHURCH.churchcenter.com/
PUBLISH_TOKEN=PASTE_THE_RANDOM_TOKEN_HERE
HEARTBEAT_TTL_SECONDS=20
PORT=3000
HOST=127.0.0.1
```

Keep the same publish token for the presentation Mac. To give a laptop permission to edit without permission to publish live state, generate another random token and add `EDITOR_TOKEN=...` to the same environment file. Use that second token on editor Macs. Do not put it in NFC tags, URLs, Git, or public pages. systemd reads the root-owned environment file before starting the unprivileged process. The server refuses to start with a missing/placeholder token, a non-HTTPS fallback, or a fallback on its own origin.

If another application uses port 3000, choose an unused port here and change `proxy_pass` in the Nginx snippet to match.

### 3. Install and start the service

Create the dedicated account once (skip `useradd` if it already exists):

```sh
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin proclaim-tap
sudo install -m 644 deploy/proclaim-tap.service /etc/systemd/system/proclaim-tap.service
sudo systemctl daemon-reload
sudo systemctl enable --now proclaim-tap
sudo systemctl status proclaim-tap --no-pager
curl -I http://127.0.0.1:3000/
```

The last command should return `302` with your Church Center URL in `Location`. If startup fails, inspect `sudo journalctl -u proclaim-tap -n 50 --no-pager`. Ensure `/opt/proclaim-tap/server` and its source files are readable by the `proclaim-tap` user; check with `sudo -u proclaim-tap test -r /opt/proclaim-tap/server/src/main.js`.

### 4. Add the Nginx site

Point the DNS record for `tap.revivalomaha.org` at this server. Install the proxy snippet:

```sh
sudo install -d -m 755 /etc/nginx/snippets
sudo install -m 644 deploy/nginx-proclaim-tap.conf /etc/nginx/snippets/proclaim-tap.conf
```

If you already have an HTTPS `server` block for **tap.revivalomaha.org**, replace its existing `location /` block with:

```nginx
include /etc/nginx/snippets/proclaim-tap.conf;
```

Keep that site's certificate settings. Include this only in the tap hostname's site, not your other websites. The snippet forwards every path, including `/api/state`, preserves Authorization, and disables proxy caching. Remove any other location blocks in this site that would override `/api/state` or `/healthz`.

If this is a new hostname, use `deploy/nginx-site.conf.example` as a complete site template. Obtain a certificate for the hostname using your existing certificate tooling first, and adjust the certificate paths in the template before enabling it. For Ubuntu/Debian's `sites-available` layout:

```sh
sudo install -m 644 deploy/nginx-site.conf.example /etc/nginx/sites-available/proclaim-tap
sudoedit /etc/nginx/sites-available/proclaim-tap
sudo ln -s /etc/nginx/sites-available/proclaim-tap /etc/nginx/sites-enabled/proclaim-tap
```

Do not create a second site if this hostname is already configured. Keep any ACME certificate renewal locations required by your existing tooling. Validate before reloading:

```sh
sudo nginx -t && sudo systemctl reload nginx
curl -I https://tap.revivalomaha.org/
curl https://tap.revivalomaha.org/healthz
```

The root should return `302` to Church Center; the health check returns `{"ok":true}`. Health means the redirect service is running, not that a booth companion is connected. Use HTTPS for publishing and disable any CDN rule that caches these responses. Port 3000 stays on loopback; only Nginx needs public access.

See the official [Nginx proxy documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) for the directives used in the snippet.

## Optional: Docker Compose

Docker is an alternative to the native service above. From the repository's `server` directory:

```sh
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
# Edit .env with your public URL, Church Center URL, and generated token.
docker compose up -d --build
curl -I http://127.0.0.1:3080/
```

`.env` is ignored by Git and the Docker build. Compose binds host port **3080**, so point your HTTPS proxy to `127.0.0.1:3080` instead of 3000. For Nginx, change `proxy_pass` in the supplied snippet. An optional Caddy example is in `deploy/Caddyfile.example`. If the proxy itself runs in Docker, join the same Docker network and use `tap:3000` instead. Run either this deployment or the native service for a tap domain.

## Upgrade an existing native installation to 0.3.0

Upgrade the server before enabling cloud sync in the new Mac app. Existing 0.2.0 clients remain supported. In particular, reinstall the service unit: the old unit does not grant a writable database directory.

```sh
cd /opt/proclaim-tap
git pull --ff-only
/usr/bin/node --version
# Must be 22.13 or later.
sudo install -m 644 server/deploy/proclaim-tap.service /etc/systemd/system/proclaim-tap.service
sudo install -m 644 server/deploy/nginx-proclaim-tap.conf /etc/nginx/snippets/proclaim-tap.conf
```

Preserve any custom Node path or port changes you made in those installed files. The updated service sets `DATA_DIR=/var/lib/proclaim-tap` and uses systemd `StateDirectory` to create it with the service account's ownership. The updated Nginx snippet allows presentation uploads up to 256 KiB; live publish bodies remain limited to 16 KiB by the application.

Optionally generate an editor token with `openssl rand -hex 32` and add it as `EDITOR_TOKEN` using `sudoedit /etc/proclaim-tap.env`. Keep the existing `PUBLISH_TOKEN` unchanged.

```sh
sudo systemctl daemon-reload
sudo systemctl restart proclaim-tap
sudo nginx -t && sudo systemctl reload nginx
curl -I https://tap.revivalomaha.org/
curl https://tap.revivalomaha.org/healthz
```

The database starts empty. Existing local mappings are not automatically uploaded or lost; use the import workflow below after adding markers. Stop the old publisher before starting the new one; its lease may take twenty seconds to expire.

## Connect the Mac companion

Install **Proclaim Tap 0.3.0 or later** from Releases. Quit the previous app before replacing it. The same universal app runs on the presentation Mac and your laptop.

On the **presentation Mac**, open the gear menu:

1. Set the server address to `https://tap.revivalomaha.org` (no API path).
2. Enter the `PUBLISH_TOKEN` from the server configuration.
3. Choose **Presentation Mac**. Enable **Sync links and presentations with server** and **Publish live destinations**, then save.
4. In Proclaim item titles, add markers such as `Giving [tap:giving]` and `Conference [tap:conference-2026]`. Go on air so the companion can fetch and upload the presentation.
5. Select each marked item in Proclaim Tap and save its URL. To reuse existing local assignments, click **Import local links for this presentation** in Settings after adding markers to those same items.

On the **laptop**, enter the server URL and `EDITOR_TOKEN`, choose **Remote editor**, enable cloud sync and save. Choose an uploaded presentation from the presentation picker. Proclaim is not required on this Mac. It never publishes live state. Both tokens can read/edit links; only the publish token can upload presentation snapshots or report live state. Editor tokens are shared by editor devices in this release; rotating one revokes all devices using it. Per-device pairing/accounts are not implemented.

Cloud rules use the marker alone: duplicating presentations, changing item IDs, reordering items, and changing the rest of the title preserve the link. Changing the marker changes its identity. Unmarked/unknown/malformed/multiple-marker items use Church Center. Markers accept 1–64 letters, digits, hyphens or underscores, starting with a letter or digit, and ignore case. Clearing a shared URL removes it for every item using that marker. There is no automatic expiration; use distinct keys for distinct events.

The server stores the latest thirty presentation snapshots. The verified API only exposes the on-air presentation; a new presentation must be observed by the booth companion before a laptop can browse it. Previously uploaded presentations can be edited while the booth Mac is off. Changes synchronize about every three seconds; the server applies a saved URL to subsequent taps immediately. Conflicting edits require review. Offline browsing uses a local cache, but saves require connectivity and there is no durable offline draft queue.

Migration imports only locally mapped items with markers in the currently selected presentation. Conflicting URLs for the same marker abort the entire import; assign the desired URL manually. Export/back up local `links.json` before migrating. Existing app settings stay in local mode until cloud sync is explicitly enabled. The server's `CHURCH_CENTER_URL` remains authoritative; tokens stay on each Mac, encrypted with its macOS Keychain.

Only one companion should publish at a time. A second receives HTTP 409 while the first one's heartbeat is fresh. Demo slides never upload or publish; an enabled presentation Mac sends fallback while in demo mode.

## Validate before a service

- Show a linked announcement and open the tap URL in a fresh browser visit. Verify the destination matches.
- Change announcements and repeat the visit; verify it changes within a few seconds.
- Show an unmapped item or go off air; verify Church Center.
- Quit the companion and wait twenty seconds; verify Church Center.
- Restart the server; it must start at Church Center until a fresh companion update arrives.
- Try the companion's manual **Use Church Center for every tap** override.
- Duplicate the presentation, keep a marker, and verify the destination remains assigned despite new IDs.
- Edit that marker's URL from the laptop and confirm a fresh tap uses it.
- Restart the server and verify the shared link remains available while live state waits for a fresh heartbeat.

The simulator and automated tests cover the protocol, but these deployment checks verify your DNS, TLS, proxy and booth network together.

## Updating and operations

For the native systemd deployment:

```sh
cd /opt/proclaim-tap
git pull --ff-only
sudo systemctl restart proclaim-tap
sudo journalctl -u proclaim-tap -n 100 --no-pager
```

Editing `/etc/proclaim-tap.env` also requires a service restart. If you update the installed unit file, run `sudo systemctl daemon-reload` before restarting. Changes to Nginx files require `sudo nginx -t && sudo systemctl reload nginx`.

For Docker, run `git pull --ff-only`, then `docker compose up -d --build` from the `server` directory. View logs with `docker compose logs --tail=100 tap`.

The SQLite library is durable; the live heartbeat lease is in memory and deliberately resets to fallback on restart. Native data lives at `/var/lib/proclaim-tap/links.sqlite`; Docker stores it in the `tap_data` volume. Do not remove this directory or volume during upgrades. Back up the database and `/etc/proclaim-tap.env` (or Docker's `.env`) securely, with a copy outside this server. The foreground process uses `DATA_DIR` or `./data`.

For a consistent native database backup, install the `sqlite3` command if needed (`sudo apt install sqlite3`) and use its backup operation instead of copying an active WAL database:

```sh
sudo install -d -m 700 /var/backups/proclaim-tap
sudo sqlite3 /var/lib/proclaim-tap/links.sqlite ".backup '/var/backups/proclaim-tap/links.sqlite'"
```

To restore, stop `proclaim-tap`, restore the backup to the data directory with ownership `proclaim-tap:proclaim-tap`, and start the service. Preserve/move aside the whole existing database directory including WAL files before restoring. Reconnect clients through Settings after restoring an older library revision. Run **one server process/replica per tap domain**; multiple replicas would have independent live state.

No phone identifiers, tap history, or presentation content are stored by this service. Cloud mode receives presentation/item titles, IDs, order, slide indices, marker URLs and live status. It does not upload slide images, presentation files, lyrics or speaker notes. Legacy mode receives only a destination URL and publisher protocol fields. Your external proxy may have its own access logs. Keep booth/server clocks synchronized: updates older than ten seconds or more than five seconds in the future are rejected. The companion never follows HTTP redirects on authenticated publish requests.

For a temporary foreground run on a development machine, copy `.env.example` to `.env`, fill in its values, and run `npm start` from `server`. The systemd deployment reads `/etc/proclaim-tap.env` instead.

## API and tests

| Route | Authentication | Purpose |
|---|---|---|
| `GET /`, `HEAD /` | None | Temporary redirect to current destination or fallback |
| `GET /healthz` | None | Service health |
| `GET /api/state` | Bearer token | Current effective destination and lease status |
| `PUT /api/state` | Publish token | Report live state (v2) or a legacy destination; renew the lease |
| `GET /api/library` | Publish or editor token | Shared links, presentation snapshots and current live status |
| `POST /api/library` | Publish or editor token | Conditional link edits/imports; presentation uploads require publish token |

Legacy update body (still supported):

```json
{
  "publisherId": "00000000-0000-0000-0000-000000000001",
  "sequence": 1,
  "sentAt": "2026-11-03T19:00:00Z",
  "activeURL": "https://your-church.churchcenter.com/registrations/events/example"
}
```

Use the actual current UTC timestamp. Send `null` for `activeURL` to restore fallback. Sequence numbers increase within each publisher session; stale/replayed updates are rejected. Responses contain `destination`, `fallbackURL`, `mode`, `connected`, `expiresAt`, and `ttlSeconds`. HTTPS destinations with credentials or on the tap server's own origin are rejected.

Run `npm test` to exercise redirects, cache headers, heartbeat renewal/expiry, fallback, authentication, URL validation, stale updates, publisher conflicts, ordering, and restart behavior using real localhost HTTP requests.

Cloud live updates use `protocolVersion: 2`, `onAir`, `forceFallback`, and `presentationStatus` in place of `activeURL`, alongside the same publisher ID, sequence and timestamp. The server checks the uploaded presentation revision, item and slide index before resolving its marker. Link edits do not extend the heartbeat lease.

Library mutations require the latest `baseRevision`, an `operation` (`saveLink`, `deleteLink`, `importLinks`, or `savePresentation`), and the corresponding `rule`, `rules`, or `presentation`. Rules have `key`, `title` and `url`. Revision conflicts return 409 without saving any part of the mutation. Back up the database before a future schema migration; the 0.3.0 schema is the first persistent library.

## Enable Mac app update downloads

Version 0.5.0 adds authenticated update checks for the companion's download-and-replace flow. There is no database migration, Nginx change, or new npm dependency.

On the server:

```sh
cd /opt/proclaim-tap
git pull --ff-only origin main
sudoedit /etc/proclaim-tap.env
```

Add `UPDATE_GITHUB_TOKEN` using a GitHub fine-grained personal access token with **Contents: Read-only**, restricted to **Readyforeal/proclaim-tap**. The account owning the token must have access to the private repository. Leave your existing publish/editor tokens and other settings in place. Do not copy this GitHub token into the Mac app or repository.

```dotenv
UPDATE_GITHUB_TOKEN=YOUR_READ_ONLY_REPOSITORY_TOKEN
```

Then restart and check the service:

```sh
sudo systemctl restart proclaim-tap
sudo systemctl status proclaim-tap --no-pager
curl -fsS https://tap.revivalomaha.org/healthz
```

In the Mac app, use **Settings → App updates → Check for updates**. Both publisher and editor device tokens are accepted. The server reads the latest stable GitHub release, caches metadata for one minute, and obtains short-lived download URLs. The archive comes directly from GitHub; the server does not relay the large ZIP or expose its GitHub token.

Releases must include an uploaded universal **Proclaim-Tap.zip** with a GitHub SHA-256 digest. The app independently verifies the byte count and hash before showing the download in Finder. Drafts, prereleases, malformed versions, older versions, and incomplete assets are not offered. Missing update configuration returns a clear error and does not affect live redirects or cloud links. Renew the GitHub token when it expires.
