import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const version = value => typeof value === 'string' && /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value);
export function isNewer(candidate, current) {
  if (!version(candidate) || !version(current)) return false;
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export function validateRelease(info, current) {
  if (!info || !version(info.version) || typeof info.available !== 'boolean'
    || !Number.isSafeInteger(info.size) || info.size <= 0 || info.size > 1024 ** 3
    || !/^[a-f0-9]{64}$/.test(info.sha256 ?? '')) throw new Error('The server returned invalid update information.');
  return { ...info, available: info.available && isNewer(info.version, current) };
}
export async function updateRequest(connection, route, fetchImpl = globalThis.fetch) {
  const url = new URL(connection.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Save a valid HTTPS server address in Settings first.');
  if (!connection.token) throw new Error('Enter your device token in Settings first.');
  let response;
  try {
    response = await fetchImpl(new URL(route, url), { redirect: 'manual', signal: AbortSignal.timeout(25000),
      headers: { Authorization: `Bearer ${connection.token}`, Accept: 'application/json' } });
  } catch { throw new Error('Could not reach the update server. Try again shortly.'); }
  const body = await response.json().catch(() => null);
  if (response.status === 404) throw new Error('Update the redirect server to enable app updates.');
  if (response.status !== 200) throw new Error(body?.error || `Update server returned HTTP ${response.status}.`);
  return body;
}

// Used by ad-hoc builds: download a checked archive for the user to replace in Finder.
// No GitHub or device credentials are attached to the temporary GitHub asset URL.
export async function downloadArchive(info, directory, fetchImpl = globalThis.fetch) {
  const url = new URL(info.downloadURL);
  if (url.protocol !== 'https:' || url.hostname !== 'release-assets.githubusercontent.com' || url.username || url.password)
    throw new Error('The server returned an unexpected download address.');
  validateRelease(info, '0.0.0');
  await fs.mkdir(directory, { recursive: true });
  const name = `Proclaim-Tap-${info.version}-${randomUUID().slice(0, 8)}.zip`;
  const target = path.join(directory, name), temporary = `${target}.partial`;
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(20 * 60 * 1000) });
    if (response.status !== 200 || !response.body) throw new Error('Download failed. Check for updates and try again.');
    const hash = createHash('sha256'); let size = 0;
    const verify = new Transform({ transform(chunk, encoding, done) {
      size += chunk.length;
      if (size > info.size) return done(new Error('The download size does not match the release.'));
      hash.update(chunk); done(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (size !== info.size || hash.digest('hex') !== info.sha256) throw new Error('The download did not pass verification. Please try again.');
    await fs.rename(temporary, target);
    return target;
  } finally { await fs.rm(temporary, { force: true }); }
}

// Checks and downloads happen only on request. Installation remains a Finder action.
export class UpdateController {
  constructor({ currentVersion, connection, packaged = true,
    request = updateRequest, download = downloadArchive, downloadDirectory, reveal = () => {} }) {
    Object.assign(this, { currentVersion, connection, packaged, request, download, downloadDirectory, reveal });
    this.state = { status: 'idle', message: 'Check for a newer version when you are ready.', currentVersion };
  }
  view() { return { ...this.state }; }
  get busy() { return ['checking', 'downloading'].includes(this.state.status); }
  fail(message) { this.state.status = 'error'; this.state.message = message; }
  async check() {
    if (this.busy) return;
    this.state.status = 'checking'; this.state.message = 'Checking for updates…';
    try {
      const info = validateRelease(await this.request(this.connection(), `/api/updates?current=${this.currentVersion}`), this.currentVersion);
      this.release = info;
      this.state.version = info.version;
      this.state.status = info.available ? 'available' : 'current';
      this.state.message = info.available ? `Version ${info.version} is available.` : 'You are running the latest available version.';
    } catch (error) { this.fail(error.message); }
  }
  async downloadUpdate() {
    if (this.busy || this.state.status !== 'available') return;
    if (!this.packaged) { this.fail('Install a packaged app in Applications before updating.'); return; }
    this.state.status = 'downloading'; this.state.message = 'Downloading and verifying the update…';
    try {
      const info = validateRelease(await this.request(this.connection(), `/api/updates/download?version=${this.release.version}`), this.currentVersion);
      if (!info.available || info.version !== this.release.version || info.sha256 !== this.release.sha256 || info.size !== this.release.size)
        throw new Error('The release changed. Check for updates again.');
      this.downloadedFile = await this.download(info, this.downloadDirectory);
      this.state.status = 'manual-ready';
      this.state.message = 'Download verified. Quit Proclaim Tap, unzip the download, and replace the app in Applications.';
      this.reveal(this.downloadedFile);
    } catch (error) { this.fail(error.message); }
  }
  revealDownload() { if (this.downloadedFile) this.reveal(this.downloadedFile); }
}
