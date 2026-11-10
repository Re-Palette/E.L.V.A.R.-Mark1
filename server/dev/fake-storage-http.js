// The HTTP face of the fake Storage (server/storage/memory.js) for LOCAL DEVELOPMENT ONLY: what the browser's signed-link PUT (upload) and GET (download) reach under
// /dev-supabase/storage/v1, the same paths a real Supabase project serves. Like the fake Auth issuer it needs ELVAR_DEV_AUTH=1 + ELVAR_DB=memory, refuses Vercel and
// production, and answers only requests whose Host header is this computer's own name (no DNS rebinding). Only server/index.js imports it, inside the dev-login branch.
import { assertDevAuthAllowed, isLoopbackHostHeader } from './dev-auth-guard.js';

if (process.env.VERCEL || process.env.NODE_ENV === 'production') throw new Error('server/dev/fake-storage-http.js must never run in production');

const MAX_BODY = 62914560 + 1024 * 1024;   // the bucket limit (60 MB) plus a little: anything bigger is refused by the storage itself
const UPLOAD = /^\/storage\/v1\/object\/upload\/sign\/user-files\/(.+)$/, DOWNLOAD = /^\/storage\/v1\/object\/sign\/user-files\/(.+)$/;

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { reject(Object.assign(new Error('too_large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}

export function createFakeStorageHttp({ storage, base = '/dev-supabase', env = process.env } = {}) {
  assertDevAuthAllowed(env);
  const send = (res, status, body, headers = {}) => { res.statusCode = status; for (const [k, v] of Object.entries({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })) res.setHeader(k, v); res.end(body); };
  return {
    /** @returns {Promise<boolean>} true when the request was for the fake Storage (and has been answered) */
    async handle(req, res, pathname, query = {}) {
      if (!pathname.startsWith(base + '/storage/')) return false;
      if (!isLoopbackHostHeader(req.headers?.host)) { send(res, 421, JSON.stringify({ error: 'dev_storage_loopback_only' }), { 'content-type': 'application/json' }); return true; }
      const rel = pathname.slice(base.length), json = (status, body) => send(res, status, JSON.stringify(body), { 'content-type': 'application/json' });
      try {
        let m;
        if (req.method === 'PUT' && (m = UPLOAD.exec(rel))) {
          const bytes = await readBody(req, MAX_BODY), r = await storage.uploadWithToken(String(query.token || ''), bytes, { contentType: String(req.headers['content-type'] || 'application/octet-stream').split(';')[0] });
          json(200, { Key: `user-files/${decodeURIComponent(m[1])}`, path: r.path }); return true;
        }
        if (req.method === 'GET' && DOWNLOAD.exec(rel)) {
          const d = await storage.downloadWithToken(String(query.token || ''));
          send(res, 200, d.bytes, { 'content-type': 'application/octet-stream', ...(query.download ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(String(query.download))}` } : {}) }); return true;
        }
        json(404, { error: 'not_found' });
      } catch (e) { json(e?.status || 500, { error: e?.code || 'error', message: e?.message || '' }); }
      return true;
    },
  };
}
