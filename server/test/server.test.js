import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createTapServer, configuration } from '../src/server.js';

const env = { PUBLIC_URL: 'https://tap.example.org', CHURCH_CENTER_URL: 'https://church.example.org/', PUBLISH_TOKEN: 'a'.repeat(64) };
const publisherId = '11111111-1111-1111-1111-111111111111';
async function fixture(t) {
  let clock = Date.parse('2026-11-03T19:00:00Z');
  const server = createTapServer(configuration(env), { now: () => clock });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: `Bearer ${env.PUBLISH_TOKEN}` };
  let sequence = 0;
  const put = (extra = {}, headers = {}) => fetch(`${base}/api/state`, {
    method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ publisherId, sequence: ++sequence, sentAt: new Date(clock).toISOString(), activeURL: 'https://church.example.org/signup', ...extra }),
  });
  return { server, base, auth, put, advance: ms => { clock += ms; } };
}
test('default, current announcement, HEAD, no-cache, ignored user URL and heartbeat expiry', async t => {
  const f = await fixture(t);
  const tap = (method = 'GET') => fetch(`${f.base}/?url=https://evil.example`, { method, redirect: 'manual' });
  assert.equal((await tap()).headers.get('location'), env.CHURCH_CENTER_URL);
  assert.equal((await f.put()).status, 200);
  const active = await tap();
  assert.equal(active.status, 302);
  assert.equal(active.headers.get('location'), 'https://church.example.org/signup');
  assert.match(active.headers.get('cache-control'), /no-store/);
  assert.equal((await tap('HEAD')).headers.get('location'), 'https://church.example.org/signup');
  f.advance(19000);
  assert.equal((await f.put()).status, 200);
  f.advance(19000);
  assert.equal((await tap()).headers.get('location'), 'https://church.example.org/signup');
  f.advance(1001);
  assert.equal((await tap()).headers.get('location'), env.CHURCH_CENTER_URL);
});
test('off-air/unmapped null immediately restores configured fallback', async t => {
  const f = await fixture(t);
  await f.put();
  const response = await f.put({ activeURL: null });
  const body = await response.json();
  assert.equal(body.mode, 'fallback');
  assert.equal(body.destination, env.CHURCH_CENTER_URL);
  assert.equal(body.connected, true);
});
test('unauthorized reads and writes are rejected and health is public', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.base}/api/state`)).status, 401);
  assert.equal((await f.put({}, { Authorization: 'Bearer incorrect' })).status, 401);
  assert.deepEqual(await (await fetch(`${f.base}/healthz`)).json(), { ok: true });
  assert.equal((await fetch(`${f.base}/api/state`, { headers: f.auth })).status, 200);
});
test('stale, malformed, unsafe and self-referential updates cannot change destination', async t => {
  const f = await fixture(t);
  for (const activeURL of ['javascript:alert(1)', 'http://example.org', 'https://user:pass@example.org', 'https://tap.example.org/', undefined]) {
    assert.equal((await f.put({ activeURL })).status, 400);
  }
  assert.equal((await f.put({ sentAt: '2026-11-03T18:00:00Z' })).status, 400);
  assert.equal((await f.put({ sentAt: '2026-11-03T20:00:00Z' })).status, 400);
  assert.equal((await f.put({ sequence: 0 })).status, 400);
  assert.equal((await f.put({ publisherId: '' })).status, 400);
  assert.equal((await fetch(`${f.base}/`, { redirect: 'manual' })).headers.get('location'), env.CHURCH_CENTER_URL);
});
test('sequence ordering and a single active publisher prevent competing or delayed updates', async t => {
  const f = await fixture(t);
  assert.equal((await f.put({ sequence: 100 })).status, 200);
  assert.equal((await f.put({ sequence: 99, activeURL: null })).status, 409);
  const other = '22222222-2222-2222-2222-222222222222';
  assert.equal((await f.put({ publisherId: other })).status, 409);
  f.advance(20001);
  assert.equal((await f.put({ publisherId: other })).status, 200);
});
test('restart begins with fallback; configuration rejects missing secrets and redirect loops', async t => {
  const a = await fixture(t);
  await a.put();
  const b = await fixture(t);
  assert.equal((await fetch(`${b.base}/`, { redirect: 'manual' })).headers.get('location'), env.CHURCH_CENTER_URL);
  assert.throws(() => configuration({ ...env, PUBLISH_TOKEN: '' }));
  assert.throws(() => configuration({ ...env, CHURCH_CENTER_URL: env.PUBLIC_URL }));
});
