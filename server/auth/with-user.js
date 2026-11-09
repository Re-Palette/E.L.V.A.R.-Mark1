// Request authentication for the multi-user platform (docs/ELVAR_MULTIUSER.md 2.2): user / admin / device:<scope> / cron.
//   authenticate(kind, req) -> { ok:true, ctx } | { ok:false, status, error }        used by the router (auth: 'user' | 'admin' | 'device:<scope>' | 'cron')
//   withUser(handler) withAdmin(handler) withDevice(scope)(handler) withCron(handler)  Vercel-function style wrappers: handler(req, res, ctx)
//
// ctx (user, admin, device):  { kind, uid, email, role, jwt, deviceId, scopes, account, db(fn), cfg }
//   uid      a VerifiedUid (the only thing the database layer accepts)
//   db(fn)   = database.asUser(uid, fn): runs fn(repos) as that user, with Row Level Security
//   cfg      the request configuration (user-scoped; the platform's environment never supplies a user's secrets)
// ctx (cron): { kind:'cron', system }   the system operations only (no user, no table access)
// A signed-in user whose account is suspended or pending deletion gets 403. The account row is created on the first request.
import { getDb } from '../db/index.js';
import { DbError } from '../db/errors.js';
import { mintVerifiedUid } from '../db/verified-uid.js';
import { runWithConfig } from '../config/resolve.js';
import { safeEqual } from '../crypto/envelope.js';
import { sendJson } from '../http.js';
import { getVerifier, bearerFrom, AuthError } from './jwt.js';
import { deviceTokenFrom, parseDeviceToken } from './device-token.js';
import { userConfigShell } from './user-config.js';

const ACCOUNT_CACHE_MS = 30_000, ACCOUNT_CACHE_MAX = 1000;
const accountCache = new Map();   // uid -> { status, at }
export const invalidateAccount = (uid) => { accountCache.delete(String(uid?.uid ?? uid)); };
export const _clearAccountCache = () => accountCache.clear();

const fail = (status, error) => ({ ok: false, status, error });
const STATUS_ERROR = { suspended: 'account_suspended', pending_deletion: 'account_pending_deletion' };

async function loadAccount(db, uid, now) {
  const hit = accountCache.get(uid.uid);
  if (hit && now - hit.at < ACCOUNT_CACHE_MS) return hit.account;
  const account = await db.asUser(uid, async (r) => (await r.accounts.get()) || r.accounts.ensure());
  accountCache.set(uid.uid, { account, at: now });
  if (accountCache.size > ACCOUNT_CACHE_MAX) accountCache.delete(accountCache.keys().next().value);
  return account;
}

function makeCtx(db, extra) {
  const ctx = { ...extra, db: (fn) => db.asUser(ctx.uid, fn) };
  ctx.cfg = userConfigShell(ctx);
  return ctx;
}

/**
 * @param {string} kind  'user' | 'admin' | 'device:<scope>' | 'cron'
 * @param {{ allowPendingDeletion?: boolean, now?: number }} [opts]
 */
export async function authenticate(kind, req, opts = {}) {
  const now = opts.now ?? Date.now();
  try {
    if (kind === 'cron') return await authCron(req);
    const db = await getDb();
    if (kind === 'user' || kind === 'admin') {
      const token = bearerFrom(req); if (!token) return fail(401, 'login_required');
      const jwt = await getVerifier()(token);
      const account = await loadAccount(db, jwt.uid, now);
      if (STATUS_ERROR[account.status] && !(account.status === 'pending_deletion' && opts.allowPendingDeletion)) return fail(403, STATUS_ERROR[account.status]);
      if (kind === 'admin') {
        // two independent checks: the signed claim and a row in app.admins (read through a definer function)
        if (jwt.role !== 'admin' || !(await db.asUser(jwt.uid, (r) => r.accounts.isAdmin()))) return fail(403, 'forbidden');
      }
      return { ok: true, ctx: makeCtx(db, { kind, uid: jwt.uid, email: jwt.email, role: jwt.role, jwt: { ...jwt, token }, account }) };
    }
    if (kind.startsWith('device:')) {
      const scope = kind.slice('device:'.length);
      const t = parseDeviceToken(deviceTokenFrom(req)); if (!t) return fail(401, 'login_required');
      const row = await db.system.deviceLookup(t.hash);
      if (!row || row.deviceId !== t.deviceId || !row.scopes.includes(scope)) return fail(401, 'invalid_token');
      const uid = mintVerifiedUid(row.userId, 'device');
      const account = await loadAccount(db, uid, now);
      if (STATUS_ERROR[account.status]) return fail(403, STATUS_ERROR[account.status]);
      const ctx = makeCtx(db, { kind: 'device', uid, email: null, role: 'device', jwt: null, deviceId: row.deviceId, scopes: row.scopes, account });
      ctx.db((r) => r.devices.touch(row.deviceId)).catch(() => {});   // best effort
      return { ok: true, ctx };
    }
    return fail(500, 'bad_auth_kind');
  } catch (e) {
    if (e instanceof AuthError) return fail(e.status, e.code);
    if (e instanceof DbError && e.status >= 500) { console.error('[elvar] auth: database', e.code); return fail(503, 'db_unavailable'); }
    if (e instanceof DbError) return fail(e.status, e.code);
    throw e;
  }
}

async function authCron(req) {
  const secret = process.env.CRON_SECRET || '';
  if (secret.length < 16) return fail(503, 'cron_unconfigured');   // fail closed: no secret, no cron
  const token = bearerFrom(req);
  if (!token || !safeEqual(token, secret)) return fail(401, 'invalid_token');
  const db = await getDb();
  return { ok: true, ctx: { kind: 'cron', system: db.system } };
}

/**
 * Sensitive operations (delete the account, change the e-mail, export, admin actions): the access token must be recent (default 10 minutes) and
 * Supabase Auth must still accept it (a revoked session fails). Throws AuthError 401 'reauth_required' so the client signs in again.
 */
export async function requireFresh(ctx, maxAgeSec = 600, { fetchImpl = globalThis.fetch, env = process.env, now = Date.now() } = {}) {
  if (!ctx?.jwt || !(now / 1000 - ctx.jwt.iat <= maxAgeSec)) throw new AuthError('reauth_required');
  const url = String(env.SUPABASE_URL || '').replace(/\/+$/, ''), anon = env.SUPABASE_PUBLISHABLE_KEY || '';
  if (!url || !anon) throw new AuthError('auth_unconfigured', 503);
  let res;
  try { res = await fetchImpl(`${url}/auth/v1/user`, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { apikey: anon, authorization: `Bearer ${ctx.jwt.token}` } }); }
  catch { throw new AuthError('auth_unavailable', 503); }
  if (res.status >= 500) throw new AuthError('auth_unavailable', 503);
  if (!res.ok) throw new AuthError('reauth_required');
  let body; try { body = await res.json(); } catch { throw new AuthError('reauth_required'); }
  if (String(body?.id || '').toLowerCase() !== ctx.uid.uid) throw new AuthError('reauth_required');
}

// ---- wrappers for Vercel functions (api/*.js) and the local server
const guard = (e) => {
  if (e instanceof AuthError || (e instanceof DbError && e.status < 500)) return { status: e.status, body: { error: e.code } };
  console.error('[elvar]', e?.code || e?.message || e);
  return { status: e instanceof DbError && e.status === 503 ? 503 : 500, body: { error: e instanceof DbError && e.status === 503 ? 'db_unavailable' : 'internal_error' } };
};
function wrap(kind, handler, opts) {
  return async (req, res) => {
    try {
      const a = await authenticate(kind, req, opts);
      if (!a.ok) return sendJson(res, { status: a.status, body: { error: a.error } });
      return await runWithConfig(a.ctx.cfg || undefined, () => handler(req, res, a.ctx));
    } catch (e) { return sendJson(res, guard(e)); }
  };
}
/** Signed-in user (Supabase access token). handler(req, res, ctx) */
export const withUser = (handler, opts) => wrap('user', handler, opts);
/** Signed-in admin: the token claim AND a row in app.admins. */
export const withAdmin = (handler, opts) => wrap('admin', handler, opts);
/** Device token with the given scope (Android notification sync). */
export const withDevice = (scope) => (handler, opts) => wrap(`device:${scope}`, handler, opts);
/** Vercel Cron: Authorization: Bearer CRON_SECRET. handler(req, res, { kind:'cron', system }) */
export const withCron = (handler) => wrap('cron', handler);

