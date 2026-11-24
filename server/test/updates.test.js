import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ReleaseUpdates, newerVersion } from '../src/updates.js';
import { configuration, createTapServer } from '../src/server.js';

const release = () => ({ tag_name: 'v0.5.0', draft: false, prerelease: false, body: 'New release',
  assets: [{ id: 12, name: 'Proclaim-Tap.zip', state: 'uploaded', size: 1000, digest: `sha256:${'a'.repeat(64)}` }] });
const config = () => configuration({ PUBLIC_URL: 'https://tap.example.org', CHURCH_CENTER_URL: 'https://church.example.org',
  PUBLISH_TOKEN: 'p'.repeat(32), EDITOR_TOKEN: 'e'.repeat(32) });

test('only newer stable versions qualify; malformed versions and downgrades do not', () => {
  assert.equal(newerVersion('0.10.0', '0.9.0'), true);
  assert.equal(newerVersion('1.0.0', '0.99.99'), true);
  for (const v of ['0.4.0', '0.5.0', '0.6.0-beta', 'garbage', '01.0.0']) assert.equal(newerVersion(v, '0.5.0'), false);
});

test('release metadata is cached and credentials never enter download results', async () => {
  const calls = [];
  const updates = new ReleaseUpdates({ token: 'server-only', fetch: async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer server-only');
    assert.equal(options.redirect, 'manual');
    return url.endsWith('/latest') ? Response.json(release())
      : new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file?signature=temporary' } });
  } });
  assert.equal((await updates.check('0.4.0')).available, true);
  assert.equal((await updates.check('0.5.0')).available, false);
  assert.equal((await updates.check('0.6.0')).available, false);
  const download = await updates.download('0.5.0');
  assert.match(download.downloadURL, /^https:\/\/release-assets\.githubusercontent\.com\//);
  assert.equal(JSON.stringify(download).includes('server-only'), false);
  assert.equal(calls.length, 2);
  await assert.rejects(updates.download('0.4.0'), { code: 409 });
  await assert.rejects(updates.check('nonsense'), { code: 400 });
});

test('missing configuration, incomplete releases and unexpected download origins fail closed', async () => {
  await assert.rejects(new ReleaseUpdates().check('0.4.0'), { code: 503 });
  for (const mutate of [r => { r.prerelease = true; }, r => { r.assets[0].digest = null; }, r => { r.assets = []; }]) {
    const value = release(); mutate(value);
    await assert.rejects(new ReleaseUpdates({ token: 'x', fetch: async () => Response.json(value) }).check('0.4.0'), { code: 502 });
  }
  for (const location of ['https://evil.example/file', 'http://release-assets.githubusercontent.com/file', 'https://user@release-assets.githubusercontent.com/file']) {
    const updates = new ReleaseUpdates({ token: 'x', fetch: async url => url.endsWith('/latest') ? Response.json(release())
      : new Response(null, { status: 302, headers: { location } }) });
    await assert.rejects(updates.download('0.5.0'), { code: 502 });
  }
});

test('update endpoints allow both device roles and reject unauthenticated callers', async t => {
  let calls = 0;
  const updates = { check: async current => { calls++; return { available: false, version: current }; },
    download: async () => ({ downloadURL: 'https://release-assets.githubusercontent.com/file' }) };
  const server = createTapServer(config(), { updates });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/updates?current=0.4.0`)).status, 401);
  assert.equal(calls, 0);
  for (const token of ['p', 'e']) {
    const headers = { Authorization: `Bearer ${token.repeat(32)}` };
    const result = await fetch(`${base}/api/updates?current=0.4.0`, { headers });
    assert.equal(result.status, 200);
    assert.match(result.headers.get('cache-control'), /no-store/);
    assert.equal((await fetch(`${base}/api/updates/download?version=0.5.0`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/api/updates`, { method: 'POST', headers })).status, 405);
  }
});
