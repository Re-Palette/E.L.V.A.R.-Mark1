// Supabase Storage over its REST API. Everything a user may do runs with THEIR access token (Row Level Security of migration 07 decides); the service key is only
// used through server/db/service.js, for the sweeps. The browser uploads directly to Storage with ITS OWN access token (nothing of the file passes through our
// function): Row Level Security (policy files_upload) checks the live reservation on EVERY write, so there is no long-lived link to hold. Downloads use a short
// signed link; the server only inspects (size, SHA-256), signs downloads and removes.
// NOT verified against a live Supabase project in this repository (no project is available to the build): the request shapes follow the Storage API
// (POST object/<bucket>/<path> by the browser, object/info, object/authenticated, POST object/sign, DELETE object/<bucket>) and are covered by test/storage-supabase.test.mjs with a stub.
import crypto from 'node:crypto';
import { dbError } from '../db/errors.js';
import { storageListUser, storageRemove } from '../db/service.js';
import { USER_BUCKET, MAX_OBJECT_BYTES, pathOwner, requireOwnPath } from './index.js';

const TIMEOUT_MS = 15_000, HASH_TIMEOUT_MS = 60_000;
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

export function storageConfig(env = process.env) {
  const url = String(env.SUPABASE_URL || '').replace(/\/+$/, ''), key = env.SUPABASE_PUBLISHABLE_KEY || '';
  if (!url || !key) throw dbError('storage_unconfigured', 503);
  let u; try { u = new URL(url); } catch { throw dbError('storage_unconfigured', 503); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw dbError('storage_unconfigured', 503);
  return { url, key };
}

export function createSupabaseStorage({ env = process.env, fetchImpl = null } = {}) {
  const f = (...a) => (fetchImpl || globalThis.fetch)(...a);
  const base = () => `${storageConfig(env).url}/storage/v1`;
  const call = async (token, method, path, body, { timeoutMs = TIMEOUT_MS, raw = false } = {}) => {
    const { key } = storageConfig(env);
    let res;
    try {
      res = await f(`${base()}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { apikey: key, authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) { throw dbError('storage_unreachable', 502, e); }
    if (raw) return res;
    if (res.status === 404 || res.status === 400 && method === 'GET') return { status: 404, body: null };
    if (res.status === 401 || res.status === 403) throw dbError('storage_forbidden', 403);
    if (res.status === 409) throw dbError('storage_conflict', 409);
    if (!res.ok) throw dbError('storage_failed', 502);
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, body: json };
  };

  const forUser = ({ uid, token }) => {
    const me = String(uid).toLowerCase(), own = (p) => pathOwner(p) === me;
    return {
      /** Where (and how) the browser uploads: a plain authenticated POST of the object, which the INSERT policy checks against the live reservation. No signed upload URL exists. */
      async uploadTarget(path) {
        requireOwnPath(me, path);
        return { url: `${base()}/object/${USER_BUCKET}/${enc(path)}`, method: 'POST', userToken: true, headers: { apikey: storageConfig(env).key } };
      },
      async stat(path) {
        if (!own(path)) return null;
        const r = await call(token, 'GET', `/object/info/${USER_BUCKET}/${enc(path)}`);
        if (r.status === 404 || !r.body) return null;
        const size = Number(r.body.size ?? r.body.metadata?.size);
        return Number.isFinite(size) ? { size, contentType: r.body.content_type ?? r.body.contentType ?? r.body.metadata?.mimetype ?? null } : null;
      },
      /** Streams the object through SHA-256 (never holds more than one chunk); stops as soon as it is larger than maxBytes. */
      async hash(path, { maxBytes = MAX_OBJECT_BYTES } = {}) {
        if (!own(path)) return null;
        const res = await call(token, 'GET', `/object/authenticated/${USER_BUCKET}/${enc(path)}`, undefined, { raw: true, timeoutMs: HASH_TIMEOUT_MS });
        if (res.status === 404 || res.status === 400) return null;
        if (res.status === 401 || res.status === 403) throw dbError('storage_forbidden', 403);
        if (!res.ok || !res.body) throw dbError('storage_failed', 502);
        const h = crypto.createHash('sha256'); let size = 0;
        for await (const chunk of res.body) {
          size += chunk.length; if (size > maxBytes) { try { await res.body.cancel?.(); } catch { /* ignore */ } return { size, sha256: null, tooLarge: true }; }
          h.update(chunk);
        }
        return { size, sha256: h.digest('hex') };
      },
      async createDownloadUrl(path, { name = '', expiresInSec = 300 } = {}) {
        requireOwnPath(me, path);
        const r = await call(token, 'POST', `/object/sign/${USER_BUCKET}/${enc(path)}`, { expiresIn: Math.max(1, Math.min(3600, Math.floor(expiresInSec))) });
        if (r.status === 404) throw dbError('not_found', 404);
        const rel = r.body?.signedURL ?? r.body?.signedUrl; if (typeof rel !== 'string' || !rel.startsWith('/object/sign/')) throw dbError('storage_failed', 502);
        return `${base()}${rel}${name ? `${rel.includes('?') ? '&' : '?'}download=${encodeURIComponent(name)}` : ''}`;
      },
      /** Removes the caller's own objects (the delete policy keeps it inside users/<uid>/). Safe to repeat. */
      async remove(paths) {
        for (const p of paths) requireOwnPath(me, p);
        let n = 0;
        for (let i = 0; i < paths.length; i += 1000) { const r = await call(token, 'DELETE', `/object/${USER_BUCKET}`, { prefixes: paths.slice(i, i + 1000) }); n += Array.isArray(r.body) ? r.body.length : 0; }
        return n;
      },
    };
  };

  /** The sweeps (service key, through db/service.js). `list` / `count` take the user's prefix `users/<uid>/`. */
  const service = {
    async list(prefix, { bucket = USER_BUCKET } = {}) {
      const m = /^users\/([0-9a-f-]{36})\/?$/.exec(prefix); if (!m) throw dbError('bad_path', 500);
      return storageListUser(bucket, m[1], { env, fetchImpl: fetchImpl || undefined });
    },
    async remove(paths, { bucket = USER_BUCKET } = {}) { return storageRemove(bucket, paths, { env, fetchImpl: fetchImpl || undefined }); },
    async count(prefix, { bucket = USER_BUCKET } = {}) { return (await this.list(prefix, { bucket })).length; },
  };
  return { kind: 'supabase', forUser, service };
}
