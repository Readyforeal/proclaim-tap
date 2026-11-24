import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class LibraryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Exactly one explicit marker identifies an announcement across weekly duplicates.
// Ambiguous or malformed markers never choose a destination.
export function tapKey(title) {
  if (typeof title !== 'string') return null;
  const markers = [...title.matchAll(/\[tap:[^\]]*\]/gi)];
  if ((title.match(/\[tap:/gi) || []).length !== 1 || markers.length !== 1 || !/^\[tap:[a-z0-9][a-z0-9_-]{0,63}\]$/i.test(markers[0][0])) return null;
  return markers[0][0].slice(5, -1).toLowerCase();
}
const validKey = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const string = (value, max = 500) => typeof value === 'string' && value.length > 0 && value.length <= max;
const invalid = message => { throw new LibraryError(400, message); };

export function validatePresentation(p) {
  if (!p || !string(p.id, 200) || !string(p.title) || !Number.isSafeInteger(p.localRevision)
      || !Array.isArray(p.serviceItems) || p.serviceItems.length > 1000) invalid('Invalid presentation');
  for (const field of ['warmupStartIndex', 'serviceStartIndex', 'postServiceStartIndex']) {
    // Section offsets are display metadata; Proclaim may use sentinel values for absent sections.
    if (!Number.isSafeInteger(p[field])) invalid('Invalid presentation section');
  }
  const ids = new Set();
  const items = p.serviceItems.map(item => {
    if (!item || !string(item.id, 200) || ids.has(item.id) || typeof item.title !== 'string' || item.title.length > 500 || !string(item.kind, 100)
        || !Array.isArray(item.slides) || item.slides.length > 1000) invalid('Invalid presentation item');
    ids.add(item.id);
    const indices = new Set();
    const slides = item.slides.map(slide => {
      if (!slide || !Number.isSafeInteger(slide.index) || slide.index < 0 || indices.has(slide.index)) invalid('Invalid slide');
      indices.add(slide.index);
      return { index: slide.index };
    });
    return { id: item.id, title: item.title, kind: item.kind, slides };
  });
  return { id: p.id, title: p.title, localRevision: p.localRevision,
    warmupStartIndex: p.warmupStartIndex, serviceStartIndex: p.serviceStartIndex,
    postServiceStartIndex: p.postServiceStartIndex, serviceItems: items };
}

// One server process owns the database. Every edit uses optimistic concurrency;
// SQLite commits the full small catalog atomically before the API acknowledges it.
export class LinkLibrary {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS catalog (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)');
    this.db.prepare('INSERT OR IGNORE INTO catalog VALUES (1, ?)').run(JSON.stringify({ revision: 0, rules: [], presentations: [] }));
    this.data = JSON.parse(this.db.prepare('SELECT document FROM catalog WHERE id=1').get().document);
    if (!Number.isSafeInteger(this.data.revision) || !Array.isArray(this.data.rules) || !Array.isArray(this.data.presentations)) throw new Error('Invalid cloud library database');
  }
  close() { this.db.close(); }
  snapshot() { return structuredClone(this.data); }
  resolve(status) {
    const p = this.data.presentations.find(p => p.id === status?.presentationId);
    if (!p || p.localRevision !== status.presentationLocalRevision) return null;
    const item = p.serviceItems.find(item => item.id === status.status.itemId);
    if (!item || !item.slides.some(slide => slide.index === status.status.slideIndex)) return null;
    return this.data.rules.find(rule => rule.key === tapKey(item.title))?.url ?? null;
  }
  update(body, validateURL) {
    if (!body || !Number.isSafeInteger(body.baseRevision)) invalid('Missing library revision');
    if (body.baseRevision !== this.data.revision) throw new LibraryError(409, 'Links changed on another device. Refresh, review the latest value, and save again.');
    const next = this.snapshot();
    const validateRule = rule => {
      if (!rule || !string(rule.title) || !validKey(rule.key)) invalid('Invalid link marker or title');
      let url;
      try { url = validateURL(rule.url); } catch { invalid('Use an HTTPS destination outside the tap server'); }
      return { key: rule.key, title: rule.title, url };
    };
    if (body.operation === 'saveLink') {
      const rule = validateRule(body.rule);
      next.rules = next.rules.filter(old => old.key !== rule.key);
      next.rules.push(rule);
    } else if (body.operation === 'deleteLink') {
      if (!body.rule || !validKey(body.rule.key)) invalid('Invalid link marker or title');
      next.rules = next.rules.filter(old => old.key !== body.rule.key);
    } else if (body.operation === 'importLinks') {
      if (!Array.isArray(body.rules) || body.rules.length > 1000) invalid('Invalid import');
      for (const value of body.rules) {
        const rule = validateRule(value);
        const old = next.rules.find(old => old.key === rule.key);
        if (old && old.url !== rule.url) throw new LibraryError(409, `Conflicting saved links for [tap:${rule.key}]. Assign this marker manually; no links were imported.`);
        if (!old) next.rules.push(rule);
      }
    } else if (body.operation === 'savePresentation') {
      const presentation = validatePresentation(body.presentation);
      if (presentation.id === 'demo-presentation') invalid('Demo presentations cannot be uploaded');
      const old = next.presentations.find(p => p.id === presentation.id);
      if (old && JSON.stringify(old) === JSON.stringify(presentation)) return this.snapshot();
      next.presentations = [presentation, ...next.presentations.filter(p => p.id !== presentation.id)].slice(0, 30);
    } else invalid('Unknown library operation');
    if (next.rules.length > 5000) invalid('Link library limit reached');
    next.revision += 1;
    const document = JSON.stringify(next);
    if (Buffer.byteLength(document) > 8 * 1024 * 1024) invalid('Library is too large');
    this.db.prepare('UPDATE catalog SET document=? WHERE id=1').run(document);
    this.data = next;
    return this.snapshot();
  }
}
