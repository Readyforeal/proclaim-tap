# Proclaim Tap redirect server

Every NFC tag contains `https://tap.revivalomaha.org`. The public root returns a non-cacheable **302** to the current announcement URL. When there is no fresh announcement, it redirects to the configured Church Center homepage.

The Mac companion sends authenticated updates and a heartbeat every five seconds. The default expiry is twenty seconds. Off-air, unmapped items, quick screens, pause, and the manual fallback override send `activeURL: null`, restoring Church Center immediately after the next successful update. App crashes, power loss, and internet failures expire automatically. Each tap is independent; a person already completing a form stays on that page.

## Deploy with Nginx and systemd (no Docker)

Nginx handles HTTPS and forwards requests to a small Node process on `127.0.0.1:3000`. systemd starts that process at boot and restarts it if it crashes. There are no npm dependencies to install and no build step.

These commands target Ubuntu/Debian with an existing Nginx installation and sudo access. Install **Node.js 22 or later system-wide** first, then check `node --version` and `command -v node`. The supplied service uses `/usr/bin/node`; if yours is elsewhere, change `ExecStart` before installing it. A Node installation under a user's home directory will not work with this service's `ProtectHome` setting.

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

Keep the same token for the companion's settings. Do not put it in NFC tags, URLs, Git, or public pages. systemd reads the root-owned environment file before starting the unprivileged process. The server refuses to start with a missing/placeholder token, a non-HTTPS fallback, or a fallback on its own origin.

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

## Connect the Mac companion

Install **Proclaim Tap 0.2.0 or later** from the repository's Releases page. Quit the previous app before replacing it. Existing announcement link mappings are retained.

In the companion's gear menu:

1. Set the redirect server address to `https://tap.revivalomaha.org` (no `/api/state` path).
2. Paste the server's `PUBLISH_TOKEN` from `/etc/proclaim-tap.env` (or `.env` for Docker).
3. Enable **Publish live destinations**, then **Save server settings**.

The token is stored in macOS Keychain; the URL and publishing preference are stored locally. The app shows acknowledgement or an error; it does not report a failed update as published. The server's `CHURCH_CENTER_URL` is authoritative for public fallback. The old local Church Center field is only for preview before a server connection is established.

Only one companion should publish at a time. A second instance receives HTTP 409 while the first one's heartbeat is fresh. On app restart, a new publisher ID may wait up to twenty seconds for the previous lease to expire. Stop the other instance rather than enabling multiple booth Macs. Demo slides are never published, although an enabled publisher sends fallback while in demo mode.

## Validate before a service

- Show a linked announcement and open the tap URL in a fresh browser visit. Verify the destination matches.
- Change announcements and repeat the visit; verify it changes within a few seconds.
- Show an unmapped item or go off air; verify Church Center.
- Quit the companion and wait twenty seconds; verify Church Center.
- Restart the server; it must start at Church Center until a fresh companion update arrives.
- Try the companion's manual **Use Church Center for every tap** override.

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

There is no database or volume to migrate. The only live state is an expiring in-memory lease; it deliberately resets to fallback on restart. Back up `/etc/proclaim-tap.env` (or Docker's `.env`) securely and the booth Mac's link mappings separately. Run **one server process/replica per tap domain**; multiple replicas would have independent live state.

No phone identifiers, tap history, or presentation content are stored by this service. It receives only the destination URL and publisher protocol fields. Your external proxy may have its own access logs. Keep booth/server clocks synchronized: updates older than ten seconds or more than five seconds in the future are rejected. The companion never follows HTTP redirects on authenticated publish requests.

For a temporary foreground run on a development machine, copy `.env.example` to `.env`, fill in its values, and run `npm start` from `server`. The systemd deployment reads `/etc/proclaim-tap.env` instead.

## API and tests

| Route | Authentication | Purpose |
|---|---|---|
| `GET /`, `HEAD /` | None | Temporary redirect to current destination or fallback |
| `GET /healthz` | None | Service health |
| `GET /api/state` | Bearer token | Current effective destination and lease status |
| `PUT /api/state` | Bearer token | Update destination and renew the lease |

Example update body:

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
