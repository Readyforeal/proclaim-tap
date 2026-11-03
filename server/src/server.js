import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

export function httpsURL(value, name = 'URL') {
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) throw new Error(`Invalid ${name}`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid ${name}`); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error(`${name} must be an HTTPS URL without credentials`);
  return url.href;
}

export function configuration(env = process.env) {
  const publicURL = httpsURL(env.PUBLIC_URL, 'PUBLIC_URL');
  const fallbackURL = httpsURL(env.CHURCH_CENTER_URL, 'CHURCH_CENTER_URL');
  if (new URL(publicURL).origin === new URL(fallbackURL).origin) throw new Error('Fallback must not point back to the redirect server');
  const token = env.PUBLISH_TOKEN ?? '';
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token) || token.startsWith('replace')) throw new Error('PUBLISH_TOKEN must be a random token of at least 32 characters');
  const ttlSeconds = Number(env.HEARTBEAT_TTL_SECONDS ?? 20);
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 10 || ttlSeconds > 120) throw new Error('HEARTBEAT_TTL_SECONDS must be 10–120');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  return { publicURL, fallbackURL, token, ttlSeconds, port, host: env.HOST ?? '127.0.0.1' };
}

const digest = value => createHash('sha256').update(value).digest();
class HTTPError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function jsonBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new HTTPError(415, 'Use application/json');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new HTTPError(413, 'Request too large');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HTTPError(400, 'Invalid JSON object'); }
}

// One process owns the short-lived live state. A restart intentionally restores fallback.
export function createTapServer(config, { now = Date.now } = {}) {
  const expectedAuth = digest(`Bearer ${config.token}`);
  let state = null;
  const fresh = () => state !== null && state.expiresAt > now();
  function snapshot() {
    const isFresh = fresh();
    return {
      destination: isFresh && state.activeURL ? state.activeURL : config.fallbackURL,
      fallbackURL: config.fallbackURL,
      mode: isFresh && state.activeURL ? 'announcement' : 'fallback',
      connected: isFresh,
      expiresAt: isFresh ? new Date(state.expiresAt).toISOString() : null,
      ttlSeconds: config.ttlSeconds,
    };
  }
  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Surrogate-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (code, value) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    try {
      const path = new URL(req.url, 'http://local.invalid').pathname;
      if (path === '/' && ['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(302, { Location: snapshot().destination });
        res.end();
        return;
      }
      if (path === '/healthz' && ['GET', 'HEAD'].includes(req.method)) {
        send(200, { ok: true });
        return;
      }
      if (path !== '/api/state') { send(404, { error: 'Not found' }); return; }
      if (!timingSafeEqual(digest(req.headers.authorization ?? ''), expectedAuth)) {
        send(401, { error: 'Unauthorized' }); return;
      }
      if (req.method === 'GET') { send(200, snapshot()); return; }
      if (req.method !== 'PUT') {
        res.setHeader('Allow', 'GET, PUT');
        send(405, { error: 'Method not allowed' }); return;
      }
      const body = await jsonBody(req);
      if (typeof body.publisherId !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(body.publisherId)) throw new HTTPError(400, 'Invalid publisherId');
      if (!Number.isSafeInteger(body.sequence) || body.sequence < 1) throw new HTTPError(400, 'Invalid sequence');
      const sentAt = typeof body.sentAt === 'string' ? Date.parse(body.sentAt) : NaN;
      if (!Number.isFinite(sentAt) || sentAt < now() - 10000 || sentAt > now() + 5000) throw new HTTPError(400, 'Update timestamp expired; check the booth clock');
      let activeURL = null;
      if (body.activeURL !== null) {
        try { activeURL = httpsURL(body.activeURL, 'activeURL'); } catch (e) { throw new HTTPError(400, e.message); }
        if (new URL(activeURL).origin === new URL(config.publicURL).origin) throw new HTTPError(400, 'Destination must not point back to this server');
      }
      if (fresh() && state.publisherId !== body.publisherId) throw new HTTPError(409, 'Another companion is publishing; stop it and wait for the heartbeat timeout');
      if (state?.publisherId === body.publisherId && body.sequence <= state.sequence) throw new HTTPError(409, 'Out-of-order update rejected');
      state = { publisherId: body.publisherId, sequence: body.sequence, activeURL, expiresAt: now() + config.ttlSeconds * 1000 };
      send(200, snapshot());
    } catch (error) {
      if (!res.headersSent && !res.destroyed) send(error instanceof HTTPError ? error.code : 500,
        { error: error instanceof HTTPError ? error.message : 'Internal server error' });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.timeout = 5000;
  server.keepAliveTimeout = 5000;
  return server;
}
