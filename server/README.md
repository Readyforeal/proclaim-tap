# Proclaim Tap redirect server

Every NFC tag contains `https://tap.revivalomaha.org`. The public root returns a non-cacheable **302** to the current announcement URL. When there is no fresh announcement, it redirects to the configured Church Center homepage.

The Mac companion sends authenticated updates and a heartbeat every five seconds. The default expiry is twenty seconds. Off-air, unmapped items, quick screens, pause, and the manual fallback override send `activeURL: null`, restoring Church Center immediately after the next successful update. App crashes, power loss, and internet failures expire automatically. Each tap is independent; a person already completing a form stays on that page.

## Deploy with Docker Compose

On the server, authenticate to GitHub with an account or read-only deploy key that can access the private repository, then:

```sh
git clone git@github.com:Readyforeal/proclaim-tap.git
cd proclaim-tap/server
cp .env.example .env
openssl rand -hex 32
```

Edit `.env` and set:

```dotenv
PUBLIC_URL=https://tap.revivalomaha.org
CHURCH_CENTER_URL=https://YOUR-ACTUAL-CHURCH.churchcenter.com/
PUBLISH_TOKEN=PASTE_THE_RANDOM_TOKEN_HERE
HEARTBEAT_TTL_SECONDS=20
```

Use the church's actual Church Center homepage, and keep the same token for the companion's settings. Do not put the token in NFC tags, URLs, Git, or public pages. `.env` is ignored by Git and the Docker build. Restrict its filesystem permissions:

```sh
chmod 600 .env
docker compose up -d --build
docker compose ps
curl -I http://127.0.0.1:3080/
```

The last command should return `302` with your Church Center URL in `Location`. The server refuses to start with a missing/placeholder token, a non-HTTPS fallback, or a fallback on the redirect server's own origin.

## HTTPS and DNS

Point the DNS record for `tap.revivalomaha.org` at this server. Configure your existing HTTPS reverse proxy to forward that hostname to **127.0.0.1:3080**. Forward all paths, including `/api/state`, and preserve the Authorization header. Disable any proxy/CDN rule that caches redirects or API responses.

For an existing Caddy installation on the host, add this site block (also provided in `deploy/Caddyfile.example`), validate its config, and reload Caddy:

```caddy
tap.revivalomaha.org {
    reverse_proxy 127.0.0.1:3080
}
```

The Compose file binds port 3080 to the host loopback interface; the Node port is not publicly exposed. If your reverse proxy runs in another Docker container, attach both services to your proxy's Docker network and proxy to `tap:3000` instead. Do not use `127.0.0.1` inside the proxy container to reach another container.

Verify HTTPS externally:

```sh
curl -I https://tap.revivalomaha.org/
curl https://tap.revivalomaha.org/healthz
```

The health check returns `{"ok":true}`. It reports that the redirect service is running, not that a booth companion is connected.

## Connect the Mac companion

Install **Proclaim Tap 0.2.0 or later** from the repository's Releases page. Quit the previous app before replacing it. Existing announcement link mappings are retained.

In the companion's gear menu:

1. Set the redirect server address to `https://tap.revivalomaha.org` (no `/api/state` path).
2. Paste the `PUBLISH_TOKEN` from the server's `.env`.
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

```sh
git pull --ff-only
docker compose up -d --build
docker compose logs --tail=100 tap
```

There is no database or volume to migrate. The only live state is an expiring in-memory lease; it deliberately resets to fallback on restart. Back up `.env` securely and the booth Mac's link mappings separately. Run **one server process/replica per tap domain**; multiple replicas would have independent live state.

No phone identifiers, tap history, or presentation content are stored by this service. It receives only the destination URL and publisher protocol fields. Your external proxy may have its own access logs. Keep booth/server clocks synchronized: updates older than ten seconds or more than five seconds in the future are rejected. The companion never follows HTTP redirects on authenticated publish requests.

## Without Docker

Use Node.js 22 or later:

```sh
cd server
cp .env.example .env
# Fill in the configuration above.
npm start
```

There are no npm dependencies to install. This listens on `127.0.0.1:3000` by default. Point the HTTPS proxy there instead of 3080, and run the process under your server's normal service manager so it restarts after reboot.

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
