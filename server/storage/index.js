// The file vault's Storage (docs/ELVAR_MULTIUSER.md 3.3). One interface, two implementations:
//   supabase.js  Supabase Storage over its REST API (production): the user's own JWT for everything a user may do, the service key (db/service.js) only for the
//                sweeps of section 3.4 (delete everything of a deleted account, remove objects of abandoned uploads)
//   memory.js    a fake with the same interface AND the same policies (private bucket, only the owner reaches users/<uid>/, writes need a live reservation,
//                no overwrite, 60 MB per object), for `npm test` and the local dev stack (ELVAR_DB=memory)
//
//   getStorage()                         -> the storage
//   storage.forUser({ uid, token })       -> { uploadTarget(path), stat(path), hash(path, {maxBytes}), createDownloadUrl(path, {name, expiresInSec}), remove(paths) }
//   storage.service                      -> { list(prefix, {bucket}), remove(paths, {bucket}), count(prefix, {bucket}) }
//   userStorage(ctx)                     -> storage.forUser for a signed-in request (the user's own token)
// Object paths are always users/<uid>/...: built by the database (app.reserve_file) and re-checked here before any call.
import { dbError } from '../db/errors.js';
import { isUuid } from '../db/verified-uid.js';

export const USER_BUCKET = 'user-files';
/** Every bucket that can hold a user's objects (docs 3.3): the deletion sweeps all of them. */
export const USER_BUCKETS = Object.freeze(['user-files', 'user-exports', 'user-cache']);
export const MAX_OBJECT_BYTES = 62914560;

const PATH_RE = /^users\/([0-9a-f-]{36})\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/;
/** The owner of an object path, or null when the path is not of the form users/<uuid>/... (no empty, dot or traversal segments). */
export function pathOwner(path) {
  const m = typeof path === 'string' && path.length <= 400 && !path.split('/').some((s) => s === '.' || s === '..' || s === '') ? PATH_RE.exec(path) : null;
  return m && isUuid(m[1]) ? m[1].toLowerCase() : null;
}
/** Throws unless `path` is inside the caller's own prefix (defence in depth: the policies say the same). */
export function requireOwnPath(uid, path) {
  if (pathOwner(path) !== String(uid).toLowerCase()) throw dbError('storage_forbidden', 403);
  return path;
}

let override = null, cached = null, cachedKey = '';
/** Tests: use this storage until null is passed. */
export const _setStorageForTests = (s) => { override = s; };

export async function getStorage(env = process.env) {
  if (override) return override;
  if (env.ELVAR_DB === 'memory') {
    const { getDb } = await import('../db/index.js');
    const db = await getDb(env);
    if (cached && cachedKey === 'memory' && cached.db === db) return cached.storage;
    const { createMemoryStorage } = await import('./memory.js');
    const storage = createMemoryStorage({ canInsert: db.testing.hasReservation, baseUrl: () => String(process.env.SUPABASE_URL || '').replace(/\/+$/, '') });
    cached = { db, storage }; cachedKey = 'memory';
    return storage;
  }
  const { createSupabaseStorage } = await import('./supabase.js');
  if (cached && cachedKey === 'supabase') return cached.storage;
  cached = { storage: createSupabaseStorage({ env }) }; cachedKey = 'supabase';
  return cached.storage;
}

/** The storage acting as the signed-in user of a request (their own access token; a device token has none and cannot reach the vault). */
export async function userStorage(ctx) {
  const token = ctx?.jwt?.token;
  if (!token || !ctx.uid?.uid) throw dbError('storage_forbidden', 403);
  return (await getStorage()).forUser({ uid: ctx.uid.uid, token });
}
