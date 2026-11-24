import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration, createTapServer, httpsURL } from '../src/server.js';
import { LinkLibrary, tapKey } from '../src/library.js';

const env = { PUBLIC_URL: 'https://tap.example.org', CHURCH_CENTER_URL: 'https://church.example.org/',
  PUBLISH_TOKEN: 'a'.repeat(64), EDITOR_TOKEN: 'b'.repeat(64) };
const p = (id = 'week1', itemId = 'conference1', title = 'Conference [tap:conference-2026]') => ({
  id, title: id, localRevision: 1, warmupStartIndex: 0, serviceStartIndex: 0, postServiceStartIndex: 2,
  serviceItems: [{ id: itemId, title, kind: 'Content', slides: [{ index: 0 }] },
    { id: 'song', title: 'Song with no marker', kind: 'Song', slides: [{ index: 0 }] }],
});
const status = (id = 'week1', itemId = 'conference1') => ({ presentationId: id, presentationLocalRevision: 1,
  status: { revision: 1, itemId, slideIndex: 0, quickScreenKind: 'None' } });
const rule = { key: 'conference-2026', title: 'Conference', url: 'https://church.example.org/conference' };

async function fixture(t) {
  let clock = Date.now();
  const server = createTapServer(configuration(env), { now: () => clock });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = 'GET', body, token = env.PUBLISH_TOKEN) => fetch(base + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  });
  let revision = 0;
  const edit = async (operation, extra = {}, token) => {
    const response = await request('/api/library', 'POST', { baseRevision: revision, operation, ...extra }, token);
    const data = await response.json();
    if (response.ok) revision = data.revision;
    return { code: response.status, data };
  };
  let sequence = 0;
  const publish = (presentationStatus = status(), extra = {}, token) => request('/api/state', 'PUT', {
    protocolVersion: 2, publisherId: 'test-presentation-mac', sequence: ++sequence, sentAt: new Date(clock).toISOString(),
    onAir: presentationStatus !== null, forceFallback: false, presentationStatus, ...extra,
  }, token);
  const destination = async () => (await request('/')).headers.get('location');
  return { request, edit, publish, destination, advance: ms => { clock += ms; } };
}

test('explicit markers survive weekly IDs, changed titles, and song swaps; edits take effect on the live item', async t => {
  const f = await fixture(t);
  assert.equal((await f.edit('savePresentation', { presentation: p() })).code, 200);
  assert.equal((await f.edit('saveLink', { rule }, env.EDITOR_TOKEN)).code, 200);
  assert.equal((await f.publish()).status, 200);
  assert.equal(await f.destination(), rule.url);
  const updated = { ...rule, url: 'https://church.example.org/new-registration' };
  await f.edit('saveLink', { rule: updated }, env.EDITOR_TOKEN);
  assert.equal(await f.destination(), updated.url, 'Editor changes affect taps without another booth publish');
  await f.edit('savePresentation', { presentation: p('week2', 'new-item', 'Register today [TAP:CONFERENCE-2026]') });
  await f.publish(status('week2', 'new-item'));
  assert.equal(await f.destination(), updated.url, 'New presentation and item IDs preserve explicit identity');
  await f.publish(status('week2', 'song'));
  assert.equal(await f.destination(), env.CHURCH_CENTER_URL);
  await f.publish(status('week2', 'new-item'));
  await f.edit('deleteLink', { rule });
  assert.equal(await f.destination(), env.CHURCH_CENTER_URL, 'Removing a shared link stops all uses immediately');
});

test('freshness, exact presentation revision, quick screens, override and valid slides gate cloud redirects', async t => {
  const f = await fixture(t);
  await f.edit('savePresentation', { presentation: p() });
  await f.edit('saveLink', { rule });
  const changed = status(); changed.presentationLocalRevision = 2;
  const quick = status(); quick.status.quickScreenKind = 'Blank';
  const invalidSlide = status(); invalidSlide.status.slideIndex = 7;
  for (const value of [changed, quick, invalidSlide, status('unknown'), null]) {
    await f.publish(value);
    assert.equal(await f.destination(), env.CHURCH_CENTER_URL);
  }
  await f.publish(status(), { forceFallback: true });
  assert.equal(await f.destination(), env.CHURCH_CENTER_URL);
  await f.publish();
  assert.equal(await f.destination(), rule.url);
  f.advance(20001);
  assert.equal(await f.destination(), env.CHURCH_CENTER_URL);
  await f.edit('saveLink', { rule: { ...rule, url: 'https://church.example.org/changed' } });
  assert.equal(await f.destination(), env.CHURCH_CENTER_URL, 'Editing a link must not renew the live heartbeat');
});

test('cloud access, editor scope, concurrent edit conflicts, safe URLs and atomic migration', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/library', 'GET', undefined, 'bad')).status, 401);
  assert.equal((await f.edit('savePresentation', { presentation: p() }, env.EDITOR_TOKEN)).code, 403);
  assert.equal((await f.publish(status(), {}, env.EDITOR_TOKEN)).status, 403);
  assert.equal((await f.edit('saveLink', { rule }, env.EDITOR_TOKEN)).code, 200);
  const stale = await f.request('/api/library', 'POST', { baseRevision: 0, operation: 'deleteLink', rule }, env.EDITOR_TOKEN);
  assert.equal(stale.status, 409);
  for (const url of ['http://insecure.example', 'https://tap.example.org/', 'https://user:pass@church.example']) {
    assert.equal((await f.edit('saveLink', { rule: { ...rule, url } })).code, 400);
  }
  const conflict = await f.edit('importLinks', { rules: [
    { key: 'giving', title: 'Giving', url: 'https://church.example.org/give' },
    { ...rule, url: 'https://church.example.org/conflict' },
  ] });
  assert.equal(conflict.code, 409);
  const library = await (await f.request('/api/library', 'GET', undefined, env.EDITOR_TOKEN)).json();
  assert.deepEqual(library.rules, [rule], 'Conflicted imports must not partially save');
  assert.equal((await f.edit('savePresentation', { presentation: p('demo-presentation') })).code, 400);
  const blank = p('blank-section', 'blank', '');
  blank.warmupStartIndex = -1;
  assert.equal((await f.edit('savePresentation', { presentation: blank })).code, 200, 'Blank unmarked items and absent-section sentinels must not block a catalog upload');
});

test('SQLite preserves links and presentations across restarts; only live state is discarded', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'proclaim-library-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'links.sqlite');
  const original = new LinkLibrary(path);
  original.update({ baseRevision: 0, operation: 'saveLink', rule }, httpsURL);
  original.update({ baseRevision: 1, operation: 'savePresentation', presentation: p() }, httpsURL);
  original.close();
  const reopened = new LinkLibrary(path);
  const server = createTapServer(configuration(env), { library: reopened });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { redirect: 'manual' });
  assert.equal(response.headers.get('location'), env.CHURCH_CENTER_URL);
  assert.equal(reopened.resolve(status()), rule.url);
  assert.equal(reopened.snapshot().revision, 2);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

test('marker parsing rejects malformed and ambiguous markers and never matches a title alone', () => {
  assert.equal(tapKey('Giving [tap:giving]'), 'giving');
  assert.equal(tapKey('Renamed [TAP:Conference-2026]'), 'conference-2026');
  for (const title of ['Giving', '[tap:]', '[tap:has space]', '[tap:one] [tap:two]', '[tap:one] [tap:broken', '[tap:évent]']) {
    assert.equal(tapKey(title), null, title);
  }
});
