import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProclaimClient, ServerClient, liveUpdate, newProfile, parsePresentation, parseStatus, profileLink, publishUpdate,
  resolve, sectionAt, setProfileLink, tapKey, validURL, itemById } from '../src/core.js';

const presentation = parsePresentation({ id: 'p1', localRevision: 26506329, title: 'Sunday', warmupStartIndex: 1, serviceStartIndex: 2,
  postServiceStartIndex: 3, serviceItems: [
    { id: 'connect-pre', title: 'Connect', kind: 'Content', slides: [{ index: 0 }] },
    { id: 'countdown', title: 'Countdown', kind: 'Content', slides: [{ index: 0 }] },
    { id: 'giving', title: 'Giving', kind: 'Content', slides: [{ index: 0 }, { index: 1 }] },
    { id: 'connect-post', title: 'Connect', kind: 'Content', slides: [{ index: 0 }] }] });
const status = ({ item = 'giving', revision = 26506329, quick = 'None', slide = 0, pid = 'p1' } = {}) => parseStatus({
  presentationId: pid, presentationLocalRevision: revision,
  status: { revision: 62, itemId: item, slideIndex: slide, quickScreenKind: quick, mediaState: 'Playing' } });
// A fetch stand-in: handler(url, options) returns [status, body].
const mock = handler => async (url, options) => {
  const [code, body] = handler(new URL(url), options);
  return new Response(code === 204 ? null : body, { status: code });
};
const proclaim = handler => new ProclaimClient({ fetch: mock(handler) });

test('routing falls back for anything unverified', () => {
  const profile = newProfile();
  profile.fallbackURL = 'https://church.example/';
  setProfileLink(profile, 'https://church.example/giving', 'p1', 'giving');
  const route = (s, live = true, forceFallback = false) => resolve({ profile, presentation, status: s, live, forceFallback });
  for (const slide of [0, 1]) {
    assert.deepEqual(route(status({ slide })), { url: 'https://church.example/giving', isFallback: false, reason: 'Giving' });
  }
  assert.equal(route(status({ slide: 2 })).isFallback, true, 'invalid slide');
  assert.equal(route(null).isFallback, true, 'missing status');
  assert.equal(route(status(), false).isFallback, true, 'off air');
  assert.equal(route(status(), true, true).isFallback, true, 'override wins');
  assert.equal(route(status({ quick: 'Blank' })).isFallback, true, 'quick screen');
  assert.equal(route(status({ item: 'connect-pre' })).isFallback, true, 'unmapped item');
  assert.equal(route(status({ item: 'missing' })).isFallback, true, 'unknown item');
  assert.equal(route(status({ revision: 26506330 })).isFallback, true, 'stale revision');
  assert.equal(route(status({ pid: 'different-service' })).isFallback, true, 'wrong presentation');
  assert.equal(route(null).url, 'https://church.example/');
});

test('local mappings, sections and URL validation', () => {
  const profile = newProfile();
  setProfileLink(profile, ' https://church.example/connect ', 'p1', 'connect-pre');
  assert.equal(profileLink(profile, 'p1', 'connect-pre'), 'https://church.example/connect');
  assert.equal(profileLink(profile, 'p1', 'connect-post'), '', 'duplicate titles stay independent');
  assert.equal(profileLink(profile, 'p2', 'connect-pre'), '', 'new services stay independent');
  setProfileLink(profile, '', 'p1', 'connect-pre');
  assert.deepEqual(profile.links, {});
  assert.deepEqual([0, 1, 2, 3].map(i => sectionAt(presentation, i)), ['Pre-service', 'Warm-up', 'Service', 'Post-service']);
  for (const raw of ['javascript:alert(1)', 'http://example.com', 'file:///tmp/test', 'https://user:pass@example.com', 'https://', 'not a URL', 'https://a.example/a b']) {
    assert.equal(validURL(raw), null, raw);
  }
  assert.equal(validURL('https://church.example/register?event=1'), 'https://church.example/register?event=1');
});

test('Proclaim session formats and off-air', async () => {
  const id = 'ccd663c1eca742b0a32d8c773088832b';
  for (const body of [id, `"${id}"`, `﻿${id}\n`]) {
    const client = proclaim(url => { assert.equal(url.pathname, '/onair/session'); return [200, body]; });
    assert.equal(await client.onAirSession(), id);
  }
  assert.equal(await proclaim(() => [204, '']).onAirSession(), null);
  for (const code of [403, 404, 500, 200]) {
    await assert.rejects(proclaim(() => [code, '<html>Error</html>']).onAirSession(), `HTTP ${code} must not become a session`);
  }
  await assert.rejects(new ProclaimClient({ fetch: async () => { throw new TypeError('fetch failed'); } }).onAirSession(), /Could not reach Proclaim/);
});

test('Proclaim presentation and status requests', async () => {
  const client = proclaim((url, options) => {
    assert.equal(options.headers.OnAirSessionId, 'test-session');
    assert.equal(options.method, 'GET', 'requests are read-only');
    if (url.pathname === '/presentations/onair') return [200, JSON.stringify(presentation)];
    assert.equal(url.pathname, '/onair/statusChanged');
    assert.equal(url.searchParams.get('localrevision'), '26506329');
    assert.equal(url.searchParams.get('step'), '0');
    return [200, JSON.stringify(status())];
  });
  const p = await client.presentation('test-session');
  const s = await client.status('test-session', p.localRevision);
  assert.equal(itemById(p, s.status.itemId).title, 'Giving');
  await assert.rejects(proclaim(() => [204, '']).status('x', 1), 'empty status must not preserve a live route');
  await assert.rejects(proclaim(() => [200, '{"id":"p1"}']).presentation('x'), 'malformed presentation');
});

test('publisher payloads, auth and redirects', async () => {
  const update = publishUpdate('test-publisher-0001', 1, null);
  assert.equal(JSON.parse(JSON.stringify(update)).activeURL, null, 'fallback is an explicit JSON null');
  const ack = { destination: 'https://church.example/', fallbackURL: 'https://church.example/', mode: 'fallback', connected: true, ttlSeconds: 20 };
  const server = new ServerClient({ fetch: mock((url, options) => {
    assert.equal(options.method, 'PUT');
    assert.equal(url.pathname, '/api/state');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.redirect, 'manual', 'the token must never follow a redirect');
    return [200, JSON.stringify(ack)];
  }) });
  assert.deepEqual(await server.publish('https://tap.example', 'test-token', update), ack);
  const rejecting = code => new ServerClient({ fetch: mock(() => [code, code === 401 ? '{"error":"Unauthorized"}' : '']) });
  await assert.rejects(rejecting(401).publish('https://tap.example', 'bad', update), /Unauthorized/);
  await assert.rejects(rejecting(301).publish('https://tap.example', 'test-token', update), /HTTP 301/);
  const live = JSON.parse(JSON.stringify(liveUpdate('test-publisher-0001', 2, status(), false)));
  assert.equal(live.protocolVersion, 2);
  assert.equal(live.onAir, true);
  assert.equal('activeURL' in live, false);
  assert.equal(live.presentationStatus.status.itemId, 'giving', 'cloud mode reports slide identity for server routing');
  assert.equal(liveUpdate('test-publisher-0001', 3, null, true).onAir, false);
});

test('tap markers', () => {
  assert.equal(tapKey('Giving [tap:giving]'), 'giving');
  assert.equal(tapKey('New title [TAP:CONFERENCE-2026]'), 'conference-2026');
  for (const title of ['Giving', '[tap:]', '[tap:has space]', '[tap:one] [tap:two]', '[tap:one] [tap:broken', '[tap:évent]']) {
    assert.equal(tapKey(title), null, title);
  }
});
