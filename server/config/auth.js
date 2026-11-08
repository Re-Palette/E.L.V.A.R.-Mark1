// Owner authentication (docs/ELVAR_ARCHITECTURE.md 2.4): setup code -> owner password -> per-device tokens (x-elvar-token: elv1.<deviceId>.<secret>).
// Modes: 'vault' (initialised: a valid device token), 'env' (ELVAR_ACCESS_TOKEN, vault not initialised), 'local' (a strictly local browser of a local
// node, vault not initialised; see localRequest()). Claiming the vault ALWAYS needs the setup code (and the env token in env mode).
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
const audit = (event, extra = {}) => console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event, ...extra }));

// ---- client address (rate limiting)
/** IPv6 addresses are grouped by /64 (one subscriber gets a whole /64); IPv4 (and IPv4-mapped IPv6) as is. */
export function addrKey(ip) {
  let a = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a); if (mapped) return mapped[1];
  if (!a.includes(':')) return a.slice(0, 64) || 'unknown';
  const [head, tail = ''] = a.split('::');
  const h = head ? head.split(':') : [], t = a.includes('::') ? (tail ? tail.split(':') : []) : [];
  const full = a.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  if (full.length !== 8 || full.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return 'bad6';
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
/**
 * The caller's address: Vercel's platform header on Vercel; off Vercel the socket, unless ELVAR_TRUST_PROXY names the header that YOUR reverse proxy sets
 * (e.g. x-forwarded-for, x-real-ip). Without it a client cannot choose its own address.
 */
export function clientIp(req) {
  const first = (v) => String(v || '').split(',')[0].trim();
  if (onVercel()) return addrKey(first(req.headers['x-real-ip']) || first(req.headers['x-forwarded-for']) || 'unknown');
  const h = String(process.env.ELVAR_TRUST_PROXY || '').trim().toLowerCase();
  if (h && /^[a-z0-9-]{1,40}$/.test(h) && req.headers[h]) {
    const v = String(req.headers[h]).split(',').map((x) => x.trim()).filter(Boolean);
    return addrKey(v.at(-1) || 'unknown');   // the entry YOUR proxy appended (rightmost), not what the client sent
  }
  return addrKey(req.socket?.remoteAddress || 'unknown');
}

const LOOP_ADDR = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOP_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;
/** The TCP peer is this machine and no proxy is involved (a reverse proxy adds forwarding headers). */
export function isLoopback(req) {
  if (onVercel()) return false;
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['forwarded'] || req.headers['x-real-ip']) return false;
  return LOOP_ADDR.has(req.socket?.remoteAddress || '');
}
/**
 * A request from a browser on this machine, for this machine: loopback peer, loopback Host (defeats DNS rebinding), no foreign Origin and not
 * cross-site (defeats CSRF), JSON body for writes (a cross-site form or text/plain POST cannot set it without a preflight).
 */
export function localRequest(req) {
  if (!isLoopback(req)) return false;
  if (!LOOP_HOST.test(String(req.headers.host || ''))) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== 'null') { try { if (!LOOP_HOST.test(new URL(origin).host)) return false; } catch { return false; } }
  if (origin === 'null') return false;
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || 'GET').toUpperCase()) && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return false;
  return true;
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
    V.touchDevice(store, u.dek, meta, u.deviceId).catch(() => {});
    return { ok: true, mode: 'vault', deviceId: u.deviceId, dek: u.dek, meta };
  }
  if (envTok) return V.safeEqual(token, envTok) ? { ok: true, mode: 'env' } : fail(401, 'unauthorized');
  if (localRequest(req)) return { ok: true, mode: 'local' };   // fail-closed: only a local browser, and only until the vault exists
  return fail(401, store ? 'setup_required' : 'storage_required');
}

// ---- rate limiting (store-backed so it holds across serverless instances). Counting happens BEFORE the expensive check, atomically.
const bump = (store, bucket, who, ttlSec, by = 1) => store.incr(rlKey(bucket, who), ttlSec, by);
/** Count one attempt; false once the limit is exceeded. */
export async function rateLimit(store, bucket, who, limit, ttlSec) { return (await bump(store, bucket, who, ttlSec)) <= limit; }

// ---- setup code
function newCode() {
  let code = ''; const rnd = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) code += SETUP_ALPHABET[rnd[i] % SETUP_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
/**
 * Make sure a setup code exists, printing it to the SERVER LOG only (never over the network).
 * @returns {Promise<string|null>} the new code (for the start-up banner of the local server), or null when none was created
 */
export async function ensureSetupCode(store, { rotate = false, port } = {}) {
  if (process.env.ELVAR_SETUP_CODE) return null;
  if (!rotate && await store.get(SETUP_KEY)) return null;
  const shown = newCode();
  const ok = await store.set(SETUP_KEY, { h: sha(normCode(shown)) }, { ttlSec: 3600, nx: !rotate });
  if (!ok) return null;
  console.log(`[elvar] ELVAR SETUP CODE: ${shown}  (valid for 60 minutes; needed once, to create the owner password)`);
  if (port && !onVercel()) console.log(`[elvar] finish setup on this computer: http://localhost:${port}/?setup=${shown}`);
  return shown;
}
async function setupCodeOk(store, given) {
  if (!normCode(given)) return false;
  const want = process.env.ELVAR_SETUP_CODE;
  if (want) return V.safeEqual(normCode(given), normCode(want));
  const rec = await store.get(SETUP_KEY); if (!rec?.h) return false;
  return V.safeEqual(sha(normCode(given)), rec.h);
}

/** GET /api/elvar/state (no auth). */
export async function setupState(req) {
  const kind = storeKind();
  let store = null, initialized = false;
  try { store = getStore(); initialized = store ? Boolean(await V.loadMeta(store)) : false; } catch { return { status: 200, body: { initialized: false, storage: kind, storageError: true, envMode: false, setupCodeRequired: false, version: VERSION } }; }
  const envMode = !initialized && Boolean(process.env.ELVAR_ACCESS_TOKEN);
  const setupCodeRequired = Boolean(store) && !initialized;
  if (setupCodeRequired) { try { await ensureSetupCode(store); } catch { /* the wizard will say storage is not ready */ } }
  return { status: 200, body: { initialized, storage: store ? kind : 'none', envMode, setupCodeRequired, local: isLoopback(req), version: VERSION } };
}

const bad = (status, error, message) => ({ status, body: { error, ...(message ? { message } : {}) } });
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40);
const SETUP_ROTATE_AFTER = 20;   // wrong codes (all addresses) before the code is replaced (and printed again): brute force cannot keep guessing one code

/**
 * POST /api/elvar/setup/claim { setupCode, password, deviceName }: first-time setup.
 * Always needs the setup code. In env mode (ELVAR_ACCESS_TOKEN set) it also needs that token in x-elvar-token, so the env owner keeps control.
 */
export async function claim(req, body = {}) {
  const store = getStore(); if (!store) return bad(503, 'storage_required', '保存先（Upstash Redis）がありません');
  const ip = clientIp(req);
  if (!(await rateLimit(store, 'setup', ip, 5, 3600))) return bad(429, 'rate_limited', '試行が多すぎます。しばらくしてからもう一度お試しください');
  if (await V.loadMeta(store)) return bad(409, 'already_initialized', 'すでにセットアップ済みです');
  const envTok = process.env.ELVAR_ACCESS_TOKEN || '';
  if (envTok && !V.safeEqual(String(req.headers['x-elvar-token'] || ''), envTok)) return bad(401, 'unauthorized', 'このサーバーはアクセストークンで保護されています。先にトークンで接続してください');
  const pwErr = V.checkPassword(body.password); if (pwErr) return bad(400, 'weak_password', pwErr);
  if (!(await setupCodeOk(store, body.setupCode))) {
    if ((await bump(store, 'setupfail', 'all', 3600)) >= SETUP_ROTATE_AFTER && !process.env.ELVAR_SETUP_CODE) {
      await store.del(rlKey('setupfail', 'all'));
      await ensureSetupCode(store, { rotate: true });
      audit('setup-code-rotated', { reason: 'too many wrong codes' });
    }
    return bad(403, 'invalid_setup_code', 'セットアップコードが違います');
  }
  try {
    const { token, deviceId } = await V.createVault(store, { password: body.password, deviceName: cleanName(body.deviceName) || 'この端末', kdf: kdfForTests() });
    await store.del(SETUP_KEY);
    audit('vault-created', { device: deviceId });
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

// Password guesses: every attempt is counted atomically BEFORE scrypt runs, so parallel guesses cannot slip past the limit.
// Per address: 5 / 15 min and 20 / day; all addresses together: 100 failures / 15 min. A success clears the address's 15-minute count and
// gives its attempt back to the day and global counts.
const PW_LIMITS = [['login', 5, 900], ['loginday', 20, 86400]], PW_GLOBAL = ['loginall', 100, 900];
async function passwordAttempt(store, ip) {
  const counts = [];
  for (const [b, , ttl] of PW_LIMITS) counts.push(await bump(store, b, ip, ttl));
  counts.push(await bump(store, PW_GLOBAL[0], 'all', PW_GLOBAL[2]));
  const limits = [...PW_LIMITS.map((x) => x[1]), PW_GLOBAL[1]];
  return counts.every((n, i) => n <= limits[i]);
}
async function passwordSucceeded(store, ip) {
  await store.del(rlKey('login', ip));
  await bump(store, 'loginday', ip, 86400, -1);
  await bump(store, PW_GLOBAL[0], 'all', PW_GLOBAL[2], -1);
}
const LOCKED = () => bad(429, 'rate_limited', '失敗が続いたため、しばらくロックしています。15分ほどしてからもう一度お試しください');

/** POST /api/elvar/auth/login { password, deviceName }: a new device token. */
export async function login(req, body = {}) {
  const store = getStore(); if (!store) return bad(503, 'storage_required');
  const meta = await V.loadMeta(store); if (!meta) return bad(409, 'not_initialized', 'まだセットアップされていません');
  const ip = clientIp(req);
  if (!(await passwordAttempt(store, ip))) return LOCKED();
  const u = await V.unlockWithPassword(store, body.password);
  if (!u) return bad(401, 'invalid_credentials', 'パスワードが違います');
  await passwordSucceeded(store, ip);
  const d = await V.addDevice(store, u.dek, cleanName(body.deviceName) || 'この端末');
  audit('device-login', { device: d.deviceId });
  return { status: 200, body: { token: d.token, deviceId: d.deviceId } };
}

export async function logout(auth) {
  if (auth.mode !== 'vault') return { status: 200, body: { ok: true } };
  await V.revokeDevice(getStore(), auth.dek, auth.deviceId);
  return { status: 200, body: { ok: true } };
}
export function listDevices(auth) {
  return { status: 200, body: { devices: auth.mode === 'vault' ? V.publicDevices(auth.meta, auth.deviceId) : [] } };
}
export async function removeDevice(auth, id) {
  if (auth.mode !== 'vault') return bad(409, 'read_only');
  if (!/^[0-9a-f]{16}$/.test(String(id))) return bad(400, 'bad_id');
  const ok = await V.revokeDevice(getStore(), auth.dek, id);
  if (ok) audit('device-revoked', { device: id, by: auth.deviceId });
  return ok ? { status: 200, body: { ok: true, self: id === auth.deviceId } } : bad(404, 'not_found');
}
/** POST /api/elvar/auth/password { current, next } (same attempt counting as login) */
export async function changeOwnerPassword(req, auth, body = {}) {
  if (auth.mode !== 'vault') return bad(409, 'read_only');
  const store = getStore(), ip = clientIp(req);
  const err = V.checkPassword(body.next); if (err) return bad(400, 'weak_password', err);
  if (!(await passwordAttempt(store, ip))) return LOCKED();
  const u = await V.unlockWithPassword(store, body.current);
  if (!u) return bad(401, 'invalid_credentials', '今のパスワードが違います');
  await passwordSucceeded(store, ip);
  await V.changePassword(store, auth.dek, body.next);
  audit('password-changed', { by: auth.deviceId });
  return { status: 200, body: { ok: true } };
}
