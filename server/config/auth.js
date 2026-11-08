// Owner authentication (docs/ELVAR_ARCHITECTURE.md 2.4): setup code -> owner password -> per-device tokens (x-elvar-token: elv1.<deviceId>.<secret>).
// Modes: 'vault' (initialised: a valid device token), 'env' (ELVAR_ACCESS_TOKEN, vault not initialised), 'local' (loopback of a local node, vault not initialised).
// Secrets are never logged and never returned; comparisons are constant-time; the setup code goes to the server log only.
import crypto from 'node:crypto';
import { getStore, storeKind } from '../store/index.js';
import * as V from './vault.js';
import { VERSION } from '../version.js';

const SETUP_KEY = 'elvar:v1:setup';
const rlKey = (bucket, who) => `elvar:v1:rl:${bucket}:${who}`;
const SETUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O/1/I/L
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const onVercel = () => Boolean(process.env.VERCEL);

/** The caller's address for rate limiting: the platform header on Vercel, the socket otherwise (a client cannot spoof its own socket address). */
export function clientIp(req) {
  if (onVercel()) return String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim().slice(0, 64) || 'unknown';
  return String(req.socket?.remoteAddress || 'unknown');
}
/** A local request from this very machine. A reverse proxy in front of the node server adds forwarding headers: then it is not trusted as local. */
export function isLoopback(req) {
  if (onVercel()) return false;
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['forwarded'] || req.headers['x-real-ip']) return false;
  const a = req.socket?.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

const fail = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });

/**
 * @returns {Promise<{ok:true, mode:'vault'|'env'|'local', deviceId?:string, dek?:Buffer, meta?:object}|{ok:false, status:number, error:string}>}
 */
export async function authenticate(req) {
  const token = String(req.headers['x-elvar-token'] || '');
  const envTok = process.env.ELVAR_ACCESS_TOKEN || '';
  let store = null, meta = null;
  try { store = getStore(); meta = store ? await V.loadMeta(store) : null; }
  catch (e) { console.error('[elvar] store unavailable:', e?.code || e?.message); return fail(503, 'store_unavailable'); }
  if (meta) {
    const u = await V.unlockWithToken(store, token, meta);
    if (!u) return fail(401, 'unauthorized');
    V.touchDevice(store, meta, u.deviceId).catch(() => {});
    return { ok: true, mode: 'vault', deviceId: u.deviceId, dek: u.dek, meta };
  }
  if (envTok) return V.safeEqual(token, envTok) ? { ok: true, mode: 'env' } : fail(401, 'unauthorized');
  if (isLoopback(req)) return { ok: true, mode: 'local' };   // fail-closed: only this machine, and only until the vault exists
  return fail(401, store ? 'setup_required' : 'storage_required');
}

// ---- rate limiting (store-backed so it holds across serverless instances)
async function hits(store, bucket, who) { return Number(await store.get(rlKey(bucket, who))) || 0; }
async function bump(store, bucket, who, ttlSec) { return store.incr(rlKey(bucket, who), ttlSec); }
/** Count one attempt; false once the limit is exceeded. */
export async function rateLimit(store, bucket, who, limit, ttlSec) { return (await bump(store, bucket, who, ttlSec)) <= limit; }

// ---- setup code
/** Make sure a setup code exists. Prints it to the SERVER LOG only. @returns {Promise<boolean>} true if a new code was created */
export async function ensureSetupCode(store, { rotate = false } = {}) {
  if (process.env.ELVAR_SETUP_CODE) return false;
  if (!rotate && await store.get(SETUP_KEY)) return false;
  let code = ''; const rnd = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) code += SETUP_ALPHABET[rnd[i] % SETUP_ALPHABET.length];
  const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
  const ok = await store.set(SETUP_KEY, { h: sha(code) }, { ttlSec: 3600, nx: !rotate });
  if (ok) console.log(`[elvar] ELVAR SETUP CODE: ${shown}  (valid for 60 minutes; needed once, to create the owner password)`);
  return ok;
}
async function setupCodeOk(store, given) {
  const want = process.env.ELVAR_SETUP_CODE;
  if (want) return V.safeEqual(normCode(given), normCode(want)) && normCode(given).length > 0;
  const rec = await store.get(SETUP_KEY); if (!rec?.h) return false;
  return V.safeEqual(sha(normCode(given)), rec.h);
}

/** GET /api/elvar/state (no auth). */
export async function setupState(req) {
  const kind = storeKind();
  let store = null, initialized = false;
  try { store = getStore(); initialized = store ? Boolean(await V.loadMeta(store)) : false; } catch { return { status: 200, body: { initialized: false, storage: kind, storageError: true, envMode: false, setupCodeRequired: false, version: VERSION } }; }
  const envMode = !initialized && Boolean(process.env.ELVAR_ACCESS_TOKEN);
  const local = isLoopback(req);
  const setupCodeRequired = Boolean(store) && !initialized && !(local && !process.env.ELVAR_SETUP_CODE);
  if (setupCodeRequired) { try { await ensureSetupCode(store); } catch { /* the wizard will say storage is not ready */ } }
  return { status: 200, body: { initialized, storage: store ? kind : 'none', envMode, setupCodeRequired, local, version: VERSION } };
}

const bad = (status, error, message) => ({ status, body: { error, ...(message ? { message } : {}) } });
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40);

/** POST /api/elvar/setup/claim { setupCode, password, deviceName }: first-time setup. */
export async function claim(req, body = {}) {
  const store = getStore(); if (!store) return bad(503, 'storage_required', '保存先（Upstash Redis）がありません');
  const ip = clientIp(req);
  if (!(await rateLimit(store, 'setup', ip, 5, 3600)) || !(await rateLimit(store, 'setup', 'all', 50, 3600))) return bad(429, 'rate_limited', '試行が多すぎます。しばらくしてからもう一度お試しください');
  if (await V.loadMeta(store)) return bad(409, 'already_initialized', 'すでにセットアップ済みです');
  const pwErr = V.checkPassword(body.password); if (pwErr) return bad(400, 'weak_password', pwErr);
  const needCode = !(isLoopback(req) && !process.env.ELVAR_SETUP_CODE);
  if (needCode && !(await setupCodeOk(store, body.setupCode))) return bad(403, 'invalid_setup_code', 'セットアップコードが違います');
  try {
    const { token, deviceId } = await V.createVault(store, { password: body.password, deviceName: cleanName(body.deviceName) || 'この端末', kdf: kdfForTests() });
    await store.del(SETUP_KEY);
    console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event: 'vault-created', device: deviceId }));
    return { status: 200, body: { token, deviceId } };
  } catch (e) {
    if (e.status === 409) return bad(409, 'already_initialized', 'すでにセットアップ済みです');
    throw e;
  }
}
// Tests may ask for a cheaper scrypt through this hook (never set in production).
let kdfOverride = null;
export const _setKdfForTests = (kdf) => { kdfOverride = kdf; };
const kdfForTests = () => kdfOverride || V.KDF_DEFAULT;

/** POST /api/elvar/auth/login { password, deviceName }: a new device token. 5 failures / 15 min / address, 20 / day. */
export async function login(req, body = {}) {
  const store = getStore(); if (!store) return bad(503, 'storage_required');
  const meta = await V.loadMeta(store); if (!meta) return bad(409, 'not_initialized', 'まだセットアップされていません');
  const ip = clientIp(req);
  if ((await hits(store, 'login', ip)) >= 5 || (await hits(store, 'loginday', ip)) >= 20) return bad(429, 'rate_limited', '失敗が続いたため、しばらくロックしています。15分ほどしてからもう一度お試しください');
  const u = await V.unlockWithPassword(store, body.password);
  if (!u) { await bump(store, 'login', ip, 900); await bump(store, 'loginday', ip, 86400); return bad(401, 'invalid_credentials', 'パスワードが違います'); }
  await store.del(rlKey('login', ip));
  const d = await V.addDevice(store, u.dek, cleanName(body.deviceName) || 'この端末');
  console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event: 'device-login', device: d.deviceId }));
  return { status: 200, body: { token: d.token, deviceId: d.deviceId } };
}

export async function logout(auth) {
  if (auth.mode !== 'vault') return { status: 200, body: { ok: true } };
  await V.revokeDevice(getStore(), auth.deviceId);
  return { status: 200, body: { ok: true } };
}
export function listDevices(auth) {
  return { status: 200, body: { devices: auth.mode === 'vault' ? V.publicDevices(auth.meta, auth.deviceId) : [] } };
}
export async function removeDevice(auth, id) {
  if (auth.mode !== 'vault') return bad(409, 'read_only');
  if (!/^[0-9a-f]{16}$/.test(String(id))) return bad(400, 'bad_id');
  const ok = await V.revokeDevice(getStore(), id);
  if (ok) console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event: 'device-revoked', device: id, by: auth.deviceId }));
  return ok ? { status: 200, body: { ok: true, self: id === auth.deviceId } } : bad(404, 'not_found');
}
/** POST /api/elvar/auth/password { current, next } */
export async function changeOwnerPassword(req, auth, body = {}) {
  if (auth.mode !== 'vault') return bad(409, 'read_only');
  const store = getStore(), ip = clientIp(req);
  if ((await hits(store, 'login', ip)) >= 5) return bad(429, 'rate_limited', '失敗が続いたため、しばらくロックしています');
  const err = V.checkPassword(body.next); if (err) return bad(400, 'weak_password', err);
  const u = await V.unlockWithPassword(store, body.current);
  if (!u) { await bump(store, 'login', ip, 900); return bad(401, 'invalid_credentials', '今のパスワードが違います'); }
  await V.changePassword(store, auth.dek, body.next);
  console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event: 'password-changed', by: auth.deviceId }));
  return { status: 200, body: { ok: true } };
}
