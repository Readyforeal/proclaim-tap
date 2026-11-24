import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UpdateController, downloadArchive, updateRequest, isNewer } from '../src/updates.js';

const bytes = Buffer.from('test archive');
const info = () => ({ available: true, version: '0.6.0', size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), downloadURL: 'https://release-assets.githubusercontent.com/file?temporary=yes' });
const connection = () => ({ url: 'https://tap.example.org', token: 'device-secret' });

test('checks use device authentication without following redirects or sending secrets to another origin', async () => {
  assert.equal(isNewer('0.10.0', '0.9.0'), true);
  assert.equal(isNewer('0.5.0', '0.6.0'), false);
  assert.equal(isNewer('0.7.0-beta', '0.6.0'), false);
  let calls = 0;
  const result = await updateRequest(connection(), '/api/updates?current=0.5.0', async (url, options) => {
    calls++;
    assert.equal(url.origin, connection().url);
    assert.equal(options.headers.Authorization, 'Bearer device-secret');
    assert.equal(options.redirect, 'manual');
    return Response.json(info());
  });
  assert.equal(result.version, '0.6.0');
  await assert.rejects(updateRequest({ ...connection(), url: 'http://tap.example.org' }, '/api/updates', () => calls++));
  await assert.rejects(updateRequest(connection(), '/api/updates', async () => new Response(null, { status: 302 })), /HTTP 302/);
  await assert.rejects(updateRequest(connection(), '/api/updates', async () => new Response(null, { status: 404 })), /Update the redirect server/);
  assert.equal(calls, 1);
});

test('archive verification checks hash and size, removes partial files, and sends no credentials', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tap-updates-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fetch = async (url, options) => {
    assert.equal(new URL(url).hostname, 'release-assets.githubusercontent.com');
    assert.equal(options.headers, undefined);
    assert.equal(options.redirect, 'error');
    return new Response(bytes);
  };
  const file = await downloadArchive(info(), dir, fetch);
  assert.deepEqual(await readFile(file), bytes);
  for (const broken of [{ sha256: 'a'.repeat(64) }, { size: 1 }, { size: bytes.length + 1 }, { downloadURL: 'https://evil.example/file' }])
    await assert.rejects(downloadArchive({ ...info(), ...broken }, dir, fetch));
  assert.equal((await readdir(dir)).length, 1, 'only the successfully verified archive remains');
});

test('updates require an explicit download, serialize requests, and never install or restart the app', async () => {
  let downloads = 0, revealed;
  let resolveCheck;
  const pending = new Promise(resolve => { resolveCheck = resolve; });
  const updater = new UpdateController({ currentVersion: '0.5.0', connection,
    request: async (_connection, route) => route.includes('/download') ? info() : pending,
    download: async () => { downloads++; return '/tmp/verified.zip'; }, reveal: file => { revealed = file; } });
  const check = updater.check();
  await updater.check();
  await updater.downloadUpdate();
  assert.equal(downloads, 0);
  assert.equal(updater.view().status, 'checking');
  resolveCheck(info()); await check;
  assert.equal(updater.view().status, 'available');
  assert.equal(downloads, 0);
  await updater.downloadUpdate();
  assert.equal(downloads, 1);
  assert.equal(revealed, '/tmp/verified.zip');
  assert.equal(updater.view().status, 'manual-ready');
  await updater.downloadUpdate();
  assert.equal(downloads, 1);
});

test('replaced release assets and downgrades cannot be downloaded', async () => {
  let downloads = 0;
  const updater = new UpdateController({ currentVersion: '0.5.0', connection,
    request: async (_connection, route) => ({ ...info(), ...(route.includes('/download') ? { sha256: 'b'.repeat(64) } : {}) }),
    download: async () => downloads++ });
  await updater.check(); await updater.downloadUpdate();
  assert.equal(updater.view().status, 'error');
  assert.match(updater.view().message, /release changed/);
  assert.equal(downloads, 0);
  updater.request = async () => ({ ...info(), version: '0.4.0' });
  await updater.check(); await updater.downloadUpdate();
  assert.equal(updater.view().status, 'current');
  assert.equal(downloads, 0);
});
