// Drives the real AppModel against a local stand-in for Proclaim and against the real redirect server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModel, parseSettings } from '../src/model.js';
import { ProclaimClient, ServerClient, cloudLink, liveUpdate, parsePresentation, parseStatus, publishUpdate } from '../src/core.js';
import { configuration, createTapServer } from '../../server/src/server.js';

const tempDir = t => { const dir = mkdtempSync(join(tmpdir(), 'tap-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
async function waitFor(description, condition, tries = 100) {
  for (let i = 0; i < tries; i++) { if (condition()) return; await new Promise(done => setTimeout(done, 100)); }
  assert.fail(`Timed out: ${description}`);
}
async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('monitor follows Proclaim and clears stale state', async t => {
  const session = 'a'.repeat(32);
  const items = [{ id: 'fixture-connect', title: 'Connect', kind: 'Content', slides: [{ index: 0 }] },
    { id: 'fixture-parents', title: 'Parent’s Night Out', kind: 'Content', slides: [{ index: 0 }] }];
  let state = { onAir: true, currentItem: 0, localRevision: 1 };
  const base = await listen(t, http.createServer((req, res) => {
    const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    if (state === 'broken') return reply(500, 'broken');
    const path = new URL(req.url, 'http://x').pathname, revision = state.localRevision ?? 1;
    if (path === '/onair/session') return state.onAir ? reply(200, session) : reply(204);
    if (req.headers.onairsessionid !== session) return reply(404, 'Missing session header');
    if (path === '/presentations/onair') {
      return reply(200, { id: 'integration-fixture', localRevision: revision, title: `Revision ${revision}`,
        warmupStartIndex: 2, serviceStartIndex: 2, postServiceStartIndex: 2, serviceItems: items });
    }
    reply(200, { presentationId: 'integration-fixture', presentationLocalRevision: revision,
      status: { revision: 1, itemId: items[state.currentItem ?? 0].id, slideIndex: 0, quickScreenKind: state.quickScreenKind ?? 'None' } });
  }));
  const model = new AppModel({ dir: tempDir(t), allowPublishing: false, proclaim: new ProclaimClient({ baseURL: base }) });
  t.after(() => model.shutdown());
  model.setFallback('https://church.example/');
  model.start();
  await waitFor('connect and auto-sync', () => model.connection === 'On air' && model.currentItem?.id === 'fixture-connect');
  model.setLink('https://church.example/connect', 'fixture-connect');
  assert.equal(model.destination.url, 'https://church.example/connect');
  assert.equal(model.view().live.title, 'Connect');

  state = { onAir: true, currentItem: 1, localRevision: 1 };
  await waitFor('slide changes without manual sync', () => model.currentItem?.id === 'fixture-parents');
  assert.equal(model.destination.isFallback, true, 'unmapped item uses fallback');

  state = { onAir: true, currentItem: 0, localRevision: 2 };
  await waitFor('revision change refreshes the presentation', () => model.presentation?.localRevision === 2 && model.currentItem?.id === 'fixture-connect');
  state = { ...state, quickScreenKind: 'Blank' };
  await waitFor('quick screens clear the mapped route', () => model.currentStatus?.status.quickScreenKind === 'Blank' && model.destination.isFallback);
  state = { onAir: false };
  await waitFor('off air clears the current slide', () => model.connection === 'Off air' && model.currentStatus === null);
  assert.equal(model.destination.isFallback, true);

  state = { onAir: true, currentItem: 0, localRevision: 3 };
  await waitFor('returning on air refetches', () => model.connection === 'On air' && model.presentation?.localRevision === 3);
  state = 'broken';
  await waitFor('connection failure clears the stale route', () => model.connection === 'Disconnected' && model.currentStatus === null);
  assert.equal(model.destination.isFallback, true);
  state = { onAir: true, currentItem: 1, localRevision: 4 };
  await waitFor('automatic reconnect', () => model.connection === 'On air' && model.currentItem?.id === 'fixture-parents' && model.presentation?.localRevision === 4);

  model.stop();
  assert.ok(model.connection === 'Paused' && model.currentStatus === null && model.destination.isFallback, 'pause clears state');
  model.start();
  model.stop();
  await new Promise(done => setTimeout(done, 300));
  assert.ok(model.connection === 'Paused' && model.currentStatus === null, 'a cancelled poll must not restore live status');

  model.showDemo();
  assert.equal(model.view().items.length, 8);
  model.stop();
  assert.equal(model.presentation, null, 'demo items never linger as a real presentation');
});

test('remote editor: acknowledged saves, conflict protection, offline cache', async t => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'server.json'), JSON.stringify({ url: 'https://cloud-test.invalid', enabled: true, cloudEnabled: true, monitorLocal: false }));
  const snapshot = { revision: 1, rules: [], presentations: [{ id: 'p1', localRevision: 1, title: 'Sunday', warmupStartIndex: 0, serviceStartIndex: 0,
    postServiceStartIndex: 1, serviceItems: [{ id: 'i1', title: 'Giving [tap:giving]', kind: 'Content', slides: [{ index: 0 }] }] }],
    live: { destination: 'https://church.example/', fallbackURL: 'https://church.example/', mode: 'fallback', connected: false, expiresAt: null, ttlSeconds: 20, presentationStatus: null } };
  let writes = 0;
  const serverClient = new ServerClient({ fetch: async (url, options) => {
    assert.equal(new URL(url).pathname, '/api/library', 'an editor must never publish or contact Proclaim');
    assert.equal(options.headers.Authorization, `Bearer ${'e'.repeat(32)}`);
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.operation, 'saveLink');
      assert.equal(body.baseRevision, 1, 'saves are conditional on the revision');
      assert.equal(body.rule.key, 'giving', 'the marker is the identity');
      snapshot.rules = [body.rule]; snapshot.revision = 2; writes += 1;
    }
    return Response.json(snapshot);
  } });
  const proclaim = { onAirSession() { assert.fail('remote editor contacted Proclaim'); } };
  const model = new AppModel({ dir, serverClient, proclaim, loadToken: () => 'e'.repeat(32) });
  t.after(() => model.shutdown());
  model.start();
  await waitFor('remote editor loads the shared presentation', () => model.cloudFresh && model.presentation?.id === 'p1');
  assert.ok(!model.isMonitoring && model.currentStatus === null, 'remote editor does not run the local monitor');
  model.setLink('https://church.example/give', 'i1', '');
  await waitFor('cloud save waits for the server', () => model.cloudLibrary?.revision === 2 && !model.cloudSaving);
  assert.ok(writes === 1 && model.link('i1') === 'https://church.example/give');
  model.setLink('https://church.example/stale', 'i1', '');
  assert.ok(model.cloudEditError && writes === 1, 'stale editor text must not overwrite a refreshed value');

  const cached = new AppModel({ dir, serverClient, proclaim });
  assert.ok(cached.presentation?.id === 'p1' && !cached.cloudFresh && cached.currentStatus === null && cached.destination.isFallback,
    'cached data never implies live status');
  assert.equal(JSON.parse(readFileSync(join(dir, 'cloud-cache.json'), 'utf8')).library.revision, 2);

  model.configureServer({ url: 'https://cloud-test.invalid/path', enabled: false });
  assert.match(model.serverError, /without a path/);
  model.configureServer({ url: 'https://cloud-test.invalid', enabled: false, cloudEnabled: false, monitorLocal: false });
  assert.match(model.serverError, /requires cloud sync/);
});

test('settings saved by older versions stay in local mode', () => {
  assert.deepEqual(parseSettings({ url: 'https://tap.example', enabled: true }),
    { url: 'https://tap.example', enabled: true, cloudEnabled: false, monitorLocal: true });
});

test('publisher and cloud catalog against the real server', async t => {
  const token = 'p'.repeat(40);
  const base = await listen(t, createTapServer(configuration({ PUBLIC_URL: 'https://tap.example.org', CHURCH_CENTER_URL: 'https://church.example/', PUBLISH_TOKEN: token })));
  const client = new ServerClient(), id = 'check-publisher-0001';
  const first = await client.publish(base, token, publishUpdate(id, 1, 'https://church.example/signup'));
  assert.ok(first.mode === 'announcement' && first.destination === 'https://church.example/signup');
  const clear = await client.publish(base, token, publishUpdate(id, 2, null));
  assert.ok(clear.mode === 'fallback' && clear.destination === 'https://church.example/');
  await assert.rejects(client.publish(base, 'incorrect', publishUpdate(id, 3, null)), /Unauthorized/);

  const presentation = parsePresentation({ id: 'cloud-fixture', localRevision: 1, title: 'Cloud fixture', warmupStartIndex: 0, serviceStartIndex: 0,
    postServiceStartIndex: 1, serviceItems: [{ id: 'giving', title: 'Giving [tap:giving]', kind: 'Content', slides: [{ index: 0 }] }] });
  let library = await client.library(base, token);
  library = await client.updateLibrary(base, token, { baseRevision: library.revision, operation: 'savePresentation', presentation });
  assert.deepEqual(library.presentations[0], presentation, 'an uploaded snapshot must round-trip unchanged, or the booth would re-upload forever');
  library = await client.updateLibrary(base, token, { baseRevision: library.revision, operation: 'saveLink',
    rule: { key: 'giving', title: 'Giving', url: 'https://church.example/give' } });
  assert.equal(cloudLink(library, presentation.serviceItems[0]), 'https://church.example/give');
  const status = parseStatus({ presentationId: 'cloud-fixture', presentationLocalRevision: 1,
    status: { revision: 1, itemId: 'giving', slideIndex: 0, quickScreenKind: 'None' } });
  const live = await client.publish(base, token, liveUpdate(id, 4, status, false));
  assert.equal(live.destination, 'https://church.example/give');
  assert.deepEqual(live.presentationStatus, status);
});
