// The ONLY place that holds the Supabase service-role key (SUPABASE_SECRET_KEY). It bypasses every policy, so it is used for exactly the jobs of
// docs/ELVAR_MULTIUSER.md section 3.4 that cannot be done as the user: Auth admin calls (delete a user, ban or unban, set app_metadata) and the Storage sweeps
// (P5: list and remove everything under users/<uid>/ when an account is deleted, remove the objects of abandoned uploads). Export writes and usage
// reconciliation (P6, P7) will be added here too.
// test/service-role-usage.test.mjs fails the build if anything else reads the key or imports this file without being on its list.
// Table rows are NOT touched through here: they always go through asUser() (with `where user_id = $uid` in every statement).
import { dbError } from './errors.js';
import { isUuid } from './verified-uid.js';

const TIMEOUT_MS = 10_000;

export function serviceConfig(env = process.env) {
  const url = String(env.SUPABASE_URL || '').replace(/\/+$/, ''), key = env.SUPABASE_SECRET_KEY || '';
  if (!url || !key) throw dbError('service_unconfigured', 503);
  let u; try { u = new URL(url); } catch { throw dbError('service_unconfigured', 503); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw dbError('service_unconfigured', 503);   // never send the key over plain http to a remote host
  return { url, key };
}

let fetchOverride = null;
/** Tests: the fetch every service call uses (null restores the global one). */
export const _setServiceFetch = (f) => { fetchOverride = f; };

async function authAdmin(method, path, body, { env = process.env, fetchImpl = fetchOverride || globalThis.fetch, what = 'auth_admin' } = {}) {
  const { url, key } = serviceConfig(env);
  let res;
  try {
    res = await fetchImpl(`${url}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { apikey: key, authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) { throw dbError(`${what}_unreachable`, 502, e); }
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) throw dbError(`${what}_failed`, 502);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const need = (uid) => { if (!isUuid(uid)) throw dbError('bad_uid', 500); return uid.toLowerCase(); };

/** Delete the auth user; every app.* row follows by on delete cascade. @returns {Promise<boolean>} false if there was no such user */
export async function deleteAuthUser(uid, opts) { return (await authAdmin('DELETE', `/auth/v1/admin/users/${need(uid)}`, undefined, opts)).status !== 404; }
/** duration: 'none' lifts the ban, otherwise a Go duration such as '876000h'. */
export async function setBan(uid, duration, opts) { await authAdmin('PUT', `/auth/v1/admin/users/${need(uid)}`, { ban_duration: String(duration) }, opts); }
/** Server-controlled claims (for example { elvar_role: 'admin' }); a user cannot change app_metadata. */
export async function setAppMetadata(uid, appMetadata, opts) { await authAdmin('PUT', `/auth/v1/admin/users/${need(uid)}`, { app_metadata: appMetadata }, opts); }

// ---- Storage sweeps (P5). The service key can see every user's objects, so the prefix is always users/<uuid> and nothing else is accepted.
const STORAGE_BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const LIST_PAGE = 1000, LIST_MAX = 100000;

/** Every object path under users/<uid>/ in one bucket (folders are walked). A bucket that does not exist has none. */
export async function storageListUser(bucket, uid, opts = {}) {
  if (!STORAGE_BUCKET_RE.test(String(bucket))) throw dbError('bad_bucket', 500);
  const out = [], walk = async (prefix, depth) => {
    if (depth > 8) throw dbError('storage_too_deep', 500);
    for (let offset = 0; ; offset += LIST_PAGE) {
      const r = await authAdmin('POST', `/storage/v1/object/list/${bucket}`, { prefix, limit: LIST_PAGE, offset, sortBy: { column: 'name', order: 'asc' } }, { ...opts, what: 'storage_admin' });
      if (r.status === 404 || !Array.isArray(r.body)) return;
      for (const e of r.body) { if (e.id === null || e.id === undefined) await walk(`${prefix}/${e.name}`, depth + 1); else out.push(`${prefix}/${e.name}`); if (out.length > LIST_MAX) throw dbError('storage_too_many', 500); }
      if (r.body.length < LIST_PAGE) return;
    }
  };
  await walk(`users/${need(uid)}`, 0);
  return out;
}

/** Remove objects (each path must be inside users/<uuid>/). 1000 per request. @returns {Promise<number>} how many were sent */
export async function storageRemove(bucket, paths, opts = {}) {
  if (!STORAGE_BUCKET_RE.test(String(bucket))) throw dbError('bad_bucket', 500);
  for (const p of paths) if (!/^users\/[0-9a-f-]{36}\/[^\u0000-\u001f]+$/.test(String(p)) || String(p).split('/').some((x) => x === '..' || x === '.' || x === '')) throw dbError('bad_path', 500);
  for (let i = 0; i < paths.length; i += 1000) await authAdmin('DELETE', `/storage/v1/object/${bucket}`, { prefixes: paths.slice(i, i + 1000) }, { ...opts, what: 'storage_admin' });
  return paths.length;
}
