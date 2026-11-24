// GitHub credentials stay on the server. Macs receive only short-lived asset URLs.
const API = 'https://api.github.com/repos/Readyforeal/proclaim-tap';
export class UpdateError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)) return null;
  return value.split('.').map(Number);
}
export function newerVersion(candidate, current) {
  const a = versionParts(candidate), b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export class ReleaseUpdates {
  constructor({ token, fetch = globalThis.fetch, now = Date.now } = {}) {
    Object.assign(this, { token, fetch, now });
  }
  async request(path, accept = 'application/vnd.github+json') {
    if (!this.token) throw new UpdateError(503, 'App updates are not configured on the server yet.');
    try {
      return await this.fetch(`${API}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${this.token}`, Accept: accept, 'User-Agent': 'Proclaim-Tap-Updates',
          'X-GitHub-Api-Version': '2022-11-28' } });
    } catch { throw new UpdateError(502, 'Could not reach GitHub to check for updates. Try again shortly.'); }
  }
  async latest() {
    if (this.cached && this.now() - this.cachedAt < 60000) return this.cached;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const response = await this.request('/releases/latest');
      if (!response.ok) throw new UpdateError(502, 'Could not read app releases. Check the server’s GitHub access.');
      let release;
      try { release = await response.json(); } catch { throw new UpdateError(502, 'GitHub returned an invalid release.'); }
      const version = release.tag_name?.replace(/^v/, '');
      const asset = release.assets?.find(a => a.name === 'Proclaim-Tap.zip' && a.state === 'uploaded');
      if (release.draft || release.prerelease || !versionParts(version) || !asset || !Number.isSafeInteger(asset.id)
        || !Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) {
        throw new UpdateError(502, 'The latest release does not have a complete, verified Mac download.');
      }
      this.cached = { version, assetId: asset.id, size: asset.size, sha256: asset.digest.slice(7),
        notes: typeof release.body === 'string' ? release.body.slice(0, 20000) : '',
        releaseURL: `https://github.com/Readyforeal/proclaim-tap/releases/tag/v${version}` };
      this.cachedAt = this.now();
      return this.cached;
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }
  async check(current) {
    if (!versionParts(current)) throw new UpdateError(400, 'Invalid app version.');
    const release = await this.latest();
    const { assetId, ...info } = release;
    return { ...info, available: newerVersion(release.version, current) };
  }
  async download(version) {
    const release = await this.latest();
    if (release.version !== version) throw new UpdateError(409, 'The release changed. Check for updates again.');
    const response = await this.request(`/releases/assets/${release.assetId}`, 'application/octet-stream');
    let url;
    try { url = new URL(response.headers.get('location')); } catch { /* handled below */ }
    if (response.status !== 302 || !url || url.protocol !== 'https:' || url.hostname !== 'release-assets.githubusercontent.com'
      || url.username || url.password) throw new UpdateError(502, 'GitHub did not provide a valid download. Try again shortly.');
    return { ...await this.check(version), available: true, downloadURL: url.href };
  }
}
