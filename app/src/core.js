// Pure logic shared by the app model and its checks: data shapes, routing, and the two HTTP clients.

const need = (condition, message = 'Proclaim returned unexpected data.') => { if (!condition) throw new Error(message); };
const int = Number.isSafeInteger; // ponytail: revisions above 2^53 would need BigInt; Proclaim's are ~1e7.

/** Returns the trimmed HTTPS URL string, or null. Credentials and non-HTTPS schemes are refused. */
export function validURL(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || /\s/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? value : null;
  } catch { return null; }
}

export function parsePresentation(p) {
  need(p && typeof p.id === 'string' && typeof p.title === 'string' && int(p.localRevision) && Array.isArray(p.serviceItems)
    && int(p.warmupStartIndex) && int(p.serviceStartIndex) && int(p.postServiceStartIndex));
  return {
    id: p.id, title: p.title, localRevision: p.localRevision,
    warmupStartIndex: p.warmupStartIndex, serviceStartIndex: p.serviceStartIndex, postServiceStartIndex: p.postServiceStartIndex,
    serviceItems: p.serviceItems.map(item => {
      need(item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.kind === 'string' && Array.isArray(item.slides));
      return { id: item.id, title: item.title, kind: item.kind,
        slides: item.slides.map(slide => { need(slide && int(slide.index)); return { index: slide.index }; }) };
    }),
  };
}

export function parseStatus(s) {
  const status = s?.status;
  need(s && typeof s.presentationId === 'string' && int(s.presentationLocalRevision) && status && int(status.revision)
    && typeof status.itemId === 'string' && int(status.slideIndex) && typeof status.quickScreenKind === 'string');
  return { presentationId: s.presentationId, presentationLocalRevision: s.presentationLocalRevision,
    status: { revision: status.revision, itemId: status.itemId, slideIndex: status.slideIndex, quickScreenKind: status.quickScreenKind } };
}

export function parseLibrary(l) {
  const message = 'The server returned unexpected data.';
  need(l && int(l.revision) && Array.isArray(l.rules) && Array.isArray(l.presentations) && l.live
    && typeof l.live.destination === 'string' && typeof l.live.fallbackURL === 'string', message);
  return { revision: l.revision, rules: l.rules, presentations: l.presentations.map(parsePresentation),
    live: { ...l.live, presentationStatus: l.live.presentationStatus ? parseStatus(l.live.presentationStatus) : null } };
}

export const samePresentation = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export const itemById = (presentation, id) => presentation?.serviceItems.find(item => item.id === id) ?? null;

export function sectionAt(presentation, index) {
  if (index >= presentation.postServiceStartIndex) return 'Post-service';
  if (index >= presentation.serviceStartIndex) return 'Service';
  if (index >= presentation.warmupStartIndex) return 'Warm-up';
  return 'Pre-service';
}

// Exactly one explicit marker identifies an announcement. Must match server/src/library.js tapKey.
export function tapKey(title) {
  if (typeof title !== 'string') return null;
  const markers = [...title.matchAll(/\[tap:[^\]]*\]/gi)];
  if ((title.match(/\[tap:/gi) || []).length !== 1 || markers.length !== 1 || !/^\[tap:[a-z0-9][a-z0-9_-]{0,63}\]$/i.test(markers[0][0])) return null;
  return markers[0][0].slice(5, -1).toLowerCase();
}

// Local link profile: { fallbackURL, links: { "presentationId/itemId": url } }
export const newProfile = () => ({ fallbackURL: '', links: {} });
export const profileLink = (profile, presentationId, itemId) => profile.links[`${presentationId}/${itemId}`] ?? '';
export function setProfileLink(profile, link, presentationId, itemId) {
  const key = `${presentationId}/${itemId}`, value = link.trim();
  if (value) profile.links[key] = value; else delete profile.links[key];
}

export function cloudLink(library, item) {
  const key = tapKey(item.title);
  return key ? library?.rules.find(rule => rule.key === key)?.url ?? '' : '';
}

/** Chooses what a tap opens right now. Anything unverified falls back to Church Center. */
export function resolve({ profile, presentation, status, live, forceFallback }) {
  const fallback = reason => ({ url: validURL(profile.fallbackURL), isFallback: true, reason });
  if (forceFallback) return fallback('Manual Church Center override');
  if (!live || !presentation || !status) return fallback('No verified live presentation');
  if (presentation.id !== status.presentationId || presentation.localRevision !== status.presentationLocalRevision) {
    return fallback('Waiting for presentation sync');
  }
  if (status.status.quickScreenKind !== 'None') return fallback('Quick screen is showing');
  const item = itemById(presentation, status.status.itemId);
  if (!item || !item.slides.some(slide => slide.index === status.status.slideIndex)) {
    return fallback('Current slide is not in the synced presentation');
  }
  const url = validURL(profileLink(profile, presentation.id, item.id));
  return url ? { url, isFallback: false, reason: item.title } : fallback('No link assigned to this item');
}

export const publishUpdate = (publisherId, sequence, activeURL) =>
  ({ publisherId, sequence, sentAt: new Date().toISOString(), activeURL: activeURL ?? null });
export const liveUpdate = (publisherId, sequence, status, forceFallback) =>
  ({ protocolVersion: 2, publisherId, sequence, sentAt: new Date().toISOString(), onAir: status != null, forceFallback,
    ...(status ? { presentationStatus: status } : {}) });

async function send(fetchImpl, url, options, unreachable) {
  try { return await fetchImpl(url, { ...options, signal: AbortSignal.timeout(5000) }); }
  catch (error) { throw new Error(error?.name === 'TimeoutError' ? `${unreachable} The request timed out.` : unreachable); }
}

/** Read-only client for Proclaim's local remote-control API. */
export class ProclaimClient {
  constructor({ baseURL = 'http://127.0.0.1:52195', fetch = globalThis.fetch } = {}) { this.baseURL = baseURL; this.fetch = fetch; }

  async get(path, sessionId) {
    const response = await send(this.fetch, new URL(path, this.baseURL), {
      method: 'GET', cache: 'no-store', headers: { Accept: 'application/json', ...(sessionId ? { OnAirSessionId: sessionId } : {}) },
    }, 'Could not reach Proclaim on this Mac.');
    if (response.status < 200 || response.status >= 300) throw new Error(`Proclaim returned HTTP ${response.status}. Check Settings → Remote → Enable.`);
    // Some Proclaim versions include a UTF-8 BOM despite declaring JSON/plain text.
    return { code: response.status, text: (await response.text()).replace(/^﻿/, '') };
  }

  /** The on-air session ID, or null when Proclaim is off air. */
  async onAirSession() {
    const { code, text } = await this.get('/onair/session');
    const raw = text.trim();
    if (code === 204 || !raw) return null;
    let value = raw;
    try { const parsed = JSON.parse(raw); if (typeof parsed === 'string') value = parsed; } catch { /* plain text ID */ }
    if (!/^[0-9a-f]{32}$/i.test(value.replaceAll('-', ''))) throw new Error('Proclaim returned an unexpected session ID.');
    return value;
  }

  async presentation(sessionId) {
    return parsePresentation(parseJSON((await this.get('/presentations/onair', sessionId)).text));
  }

  async status(sessionId, localRevision) {
    const { code, text } = await this.get(`/onair/statusChanged?localrevision=${localRevision}&step=0`, sessionId);
    if (code === 204 || !text) throw new Error('Proclaim did not return a current slide.');
    return parseStatus(parseJSON(text));
  }
}

function parseJSON(text) {
  try { return JSON.parse(text); } catch { throw new Error('Proclaim returned unexpected data.'); }
}

/** Authenticated client for the redirect server. Redirects are refused so a misconfigured proxy never forwards the token. */
export class ServerClient {
  constructor({ fetch = globalThis.fetch } = {}) { this.fetch = fetch; }
  publish(baseURL, token, update) { return this.request(baseURL, token, '/api/state', 'PUT', update); }
  async library(baseURL, token) { return parseLibrary(await this.request(baseURL, token, '/api/library', 'GET')); }
  async updateLibrary(baseURL, token, mutation) { return parseLibrary(await this.request(baseURL, token, '/api/library', 'POST', mutation)); }

  async request(baseURL, token, path, method, body) {
    const response = await send(this.fetch, new URL(path, baseURL), {
      method, redirect: 'manual', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, 'Could not reach the server.');
    const data = await response.json().catch(() => null);
    if (response.status !== 200) throw new Error(typeof data?.error === 'string' ? data.error : `Server returned HTTP ${response.status}`);
    if (!data) throw new Error('The server returned unexpected data.');
    return data;
  }
}
