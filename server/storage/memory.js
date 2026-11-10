// A fake Storage with the same interface and the same POLICIES as the real one (server/storage/supabase.js + the policies of migration 07). For `npm test` and the
// local dev stack (ELVAR_DB=memory ELVAR_DEV_AUTH=1); it refuses to run in production. Objects live in this process only.
//   private bucket              nothing is public: every read goes through a signed link made for the owner
//   own prefix only             an identity reaches only users/<its uid>/... (other people's objects look absent, like Row Level Security makes them)
//   writes need a reservation   EVERY write asks `canInsert(uid, path)` at the moment of the write (the database: a live pending app.files row for exactly this path),
//                               exactly like the policy files_upload does on every insert. The browser uploads with the user's own JWT; there is no signed upload link
//                               that could be held and used after the reservation is gone (docs/ELVAR_MULTIUSER.md 3.3)
//   reads need a READY row      the owner reads (stat / hash / signed link) only an object whose row is `ready` (or `deleting`: a DELETE must find the row) (policy files_read of migration 20); canRead(uid, path)
//   deletes need a dying row    the owner deletes only an object whose row is `deleting` (policy files_delete); canDelete(uid, path). An expired reservation's object is removed with the service key.
//   no overwrite                an object is never replaced (no update policy; the upload fails with 409)
//   60 MB per object            the bucket's file_size_limit
// The "HTTP" side (what the browser's POST / GET reach) is uploadAs / downloadWithToken; the dev server exposes them under /dev-supabase/storage/v1 and tests call them.
import crypto from 'node:crypto';
import { dbError } from '../db/errors.js';
import { pathOwner, requireOwnPath, USER_BUCKET, USER_BUCKETS, MAX_OBJECT_BYTES } from './index.js';

if (process.env.VERCEL || process.env.NODE_ENV === 'production') throw new Error('server/storage/memory.js must never run in production');

const UPLOAD_TTL_MS = 30 * 60_000;
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

export function createMemoryStorage({ canInsert = () => true, canRead = () => true, canDelete = () => true, baseUrl = () => '', now = () => Date.now(), maxObjectBytes = MAX_OBJECT_BYTES } = {}) {
  const objects = new Map();    // `${bucket}/${path}` -> { bytes: Buffer, contentType, createdAt }
  const downloads = new Map();  // token -> { bucket, path, exp, name }
  const key = (bucket, path) => `${bucket}/${path}`;
  const token = () => crypto.randomBytes(24).toString('base64url');
  const url = (kind, bucket, path, tok) => `${baseUrl()}/storage/v1/object/${kind}/${bucket}/${enc(path)}?token=${tok}`;
  const sweepTokens = () => { for (const [k, v] of downloads) if (v.exp <= now()) downloads.delete(k); };

  const forUser = ({ uid }) => {
    const me = String(uid).toLowerCase();
    const own = (path) => pathOwner(path) === me;
    return {
      /** Where the browser POSTs the bytes (with the user's own access token; every write is checked against the live reservation at that moment). Nothing here can be held and reused. */
      async uploadTarget(path) {
        if (!own(path)) throw dbError('storage_forbidden', 403);
        return { url: `${baseUrl()}/storage/v1/object/${USER_BUCKET}/${enc(path)}`, method: 'POST', userToken: true };
      },
      /** The real object's size, or null (another user's object is "not there", exactly like Row Level Security makes it). */
      async stat(path) {
        if (!own(path)) return null;
        if (!canRead(me, path)) return null;
        const o = objects.get(key(USER_BUCKET, path)); return o ? { size: o.bytes.length, contentType: o.contentType } : null;
      },
      /** SHA-256 of the real bytes (streamed in the real implementation), refusing anything over maxBytes. */
      async hash(path, { maxBytes = maxObjectBytes } = {}) {
        if (!own(path) || !canRead(me, path)) return null;
        const o = objects.get(key(USER_BUCKET, path)); if (!o) return null;
        if (o.bytes.length > maxBytes) return { size: o.bytes.length, sha256: null, tooLarge: true };
        return { size: o.bytes.length, sha256: crypto.createHash('sha256').update(o.bytes).digest('hex') };
      },
      async createDownloadUrl(path, { name = '', expiresInSec = 300 } = {}) {
        if (!own(path) || !canRead(me, path) || !objects.has(key(USER_BUCKET, path))) throw dbError('not_found', 404);
        sweepTokens(); const t = token(); downloads.set(t, { bucket: USER_BUCKET, path, exp: now() + expiresInSec * 1000, name });
        return `${url('sign', USER_BUCKET, path, t)}${name ? `&download=${encodeURIComponent(name)}` : ''}`;
      },
      /** Deletes the caller's own objects; anything else is silently left alone (the delete policy). @returns {Promise<number>} how many were removed */
      async remove(paths) { let n = 0; for (const p of paths) if (own(p) && canDelete(me, p) && objects.delete(key(USER_BUCKET, p))) n++; return n; },
    };
  };

  const service = {
    async list(prefix, { bucket = USER_BUCKET } = {}) { return [...objects.keys()].filter((k) => k.startsWith(`${bucket}/${prefix}`)).map((k) => k.slice(bucket.length + 1)); },
    async remove(paths, { bucket = USER_BUCKET } = {}) { let n = 0; for (const p of paths) if (objects.delete(key(bucket, p))) n++; return n; },
    async count(prefix, { bucket = USER_BUCKET } = {}) { return (await this.list(prefix, { bucket })).length; },
    /** The real size and SHA-256 of an object, read with the service key (finalize: the owner's token can no longer read an unverified object). null when it is not there. */
    async hash(path, { bucket = USER_BUCKET, maxBytes = maxObjectBytes } = {}) {
      const o = objects.get(key(bucket, path)); if (!o) return null;
      if (o.bytes.length > maxBytes) return { size: o.bytes.length, sha256: null, tooLarge: true };
      return { size: o.bytes.length, sha256: crypto.createHash('sha256').update(o.bytes).digest('hex') };
    },
    /** The export (P7): the same three calls as the real service client. */
    async put(path, bytes, { bucket = USER_BUCKET, contentType = 'application/octet-stream' } = {}) { if (!pathOwner(path)) throw dbError('bad_path', 500); objects.set(key(bucket, path), { bytes: Buffer.from(bytes), contentType, createdAt: now() }); return true; },
    async get(path, { bucket = USER_BUCKET } = {}) { const o = objects.get(key(bucket, path)); return o ? Buffer.from(o.bytes) : null; },
    async sign(path, { bucket = USER_BUCKET, expiresInSec = 3600, name = '' } = {}) {
      if (!pathOwner(path) || !objects.has(key(bucket, path))) throw dbError('not_found', 404);
      sweepTokens(); const t = token(); downloads.set(t, { bucket, path, exp: now() + expiresInSec * 1000, name });
      return `${url('sign', bucket, path, t)}${name ? `&download=${encodeURIComponent(name)}` : ''}`;
    },
  };

  return {
    kind: 'memory', forUser, service,
    /**
     * The browser's POST of the bytes, as the user the access token belongs to (the HTTP layer verified it). The same rules as the policy files_upload: the caller's own
     * prefix, a live reservation for exactly this path RIGHT NOW (so a deleted, given-up, finished or expired reservation can never be written again), and no overwrite.
     */
    async uploadAs(uid, path, bytes, { contentType = 'application/octet-stream' } = {}) {
      const me = String(uid).toLowerCase();
      if (pathOwner(path) !== me || !canInsert(me, path)) throw Object.assign(new Error('new row violates row-level security policy'), { status: 403, code: 'storage_forbidden' });
      if (bytes.length > maxObjectBytes) throw Object.assign(new Error('too_large'), { status: 413, code: 'too_large' });
      if (objects.has(key(USER_BUCKET, path))) throw Object.assign(new Error('exists'), { status: 409, code: 'exists' });
      objects.set(key(USER_BUCKET, path), { bytes: Buffer.from(bytes), contentType, createdAt: now() });
      return { path };
    },
    /** The browser's GET of a signed download link. */
    async downloadWithToken(tok, where = null) {
      const d = downloads.get(tok);
      // a real signed link is bound to its object: the token of one path is useless on another (where = { bucket, path } as the URL names them)
      if (!d || d.exp <= now() || (where && (where.bucket !== d.bucket || where.path !== d.path))) throw Object.assign(new Error('invalid_token'), { status: 401, code: 'invalid_token' });
      const o = objects.get(key(d.bucket, d.path)); if (!o) throw Object.assign(new Error('not_found'), { status: 404, code: 'not_found' });
      return { bytes: o.bytes, contentType: o.contentType, name: d.name };
    },
    testing: {
      /** Put an object without any policy (test set-up, or tampering with what was uploaded). */
      put(path, bytes, { contentType = 'application/octet-stream', bucket = USER_BUCKET } = {}) { objects.set(key(bucket, path), { bytes: Buffer.from(bytes), contentType, createdAt: now() }); },
      get: (path, bucket = USER_BUCKET) => objects.get(key(bucket, path))?.bytes ?? null,
      has: (path, bucket = USER_BUCKET) => objects.has(key(bucket, path)),
      list: () => [...objects.keys()],
      ownerOf: pathOwner, requireOwnPath, buckets: USER_BUCKETS,
    },
  };
}
