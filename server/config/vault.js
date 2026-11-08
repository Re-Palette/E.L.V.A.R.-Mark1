// Envelope-encrypted vault (docs/ELVAR_ARCHITECTURE.md 2.3). node:crypto only.
//   DEK          32 random bytes, generated once at setup, never stored in the clear
//   device wrap  AES-256-GCM(DEK) under HKDF(device secret, salt = deviceId)      -> one per device token
//   password wrap AES-256-GCM(DEK) under HKDF(scrypt(password))                    -> one per vault
//   records      AES-256-GCM(JSON) under the DEK, AAD = "<record key>|v<version>"  (swap / rollback is detected)
// Redis (or the JSON file) holds only ciphertext plus the plain `meta` envelope.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
export const META_KEY = 'elvar:v1:meta', DOC_KEY = 'elvar:v1:doc';
export const tokKey = (name) => `elvar:v1:tok:${name}`;
export const KDF_DEFAULT = Object.freeze({ N: 2 ** 15, r: 8, p: 1 });
const KDF_MAX_N = 2 ** 17;
export const MIN_PASSWORD = 10, MAX_PASSWORD = 200;

const b64 = (b) => Buffer.from(b).toString('base64url');
const unb64 = (s) => Buffer.from(String(s), 'base64url');
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });

export function hkdf(ikm, salt, info) { return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, 32)); }

/** AES-256-GCM with a fresh random 96-bit IV. The tag is appended to the ciphertext. */
export function seal(key, plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(Buffer.isBuffer(plain) ? plain : Buffer.from(String(plain))), c.final(), c.getAuthTag()]);
  return { iv: b64(iv), ct: b64(ct) };
}
/** @throws on a wrong key, tampered data or a different AAD */
export function open(key, rec, aad) {
  const iv = unb64(rec?.iv), all = unb64(rec?.ct);
  if (iv.length !== 12 || all.length < 16) throw fail('bad_record');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAAD(Buffer.from(aad)); d.setAuthTag(all.subarray(all.length - 16));
  return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]);
}

/** Constant-time string equality (hashes first, so lengths do not leak). */
export function safeEqual(a, b) {
  const h = (x) => crypto.createHash('sha256').update(String(x ?? '')).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

// ---- device tokens: "elv1.<deviceId 16 hex>.<secret 32 bytes base64url>"
const TOKEN_RE = /^elv1\.([0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;
export function newDeviceToken() {
  const deviceId = crypto.randomBytes(8).toString('hex'), secret = b64(crypto.randomBytes(32));
  return { deviceId, secret, token: `elv1.${deviceId}.${secret}` };
}
export function parseToken(token) { const m = TOKEN_RE.exec(String(token || '')); return m ? { deviceId: m[1], secret: m[2] } : null; }
const deviceWrapKey = (deviceId, secret) => hkdf(unb64(secret), Buffer.from(deviceId), 'elvar-dek-wrap-v1');
async function passwordWrapKey(password, kdf) {
  const N = Number(kdf.N), r = Number(kdf.r), p = Number(kdf.p);
  if (!(N >= 2 ** 10 && N <= KDF_MAX_N) || !(r >= 1 && r <= 16) || !(p >= 1 && p <= 4)) throw fail('bad_kdf');
  const salt = unb64(kdf.salt);
  const raw = await scrypt(String(password).normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
  return hkdf(raw, salt, 'elvar-dek-wrap-pw-v1');
}
export function checkPassword(pw) {
  const s = typeof pw === 'string' ? pw : '';
  if (s.length < MIN_PASSWORD) return `パスワードは${MIN_PASSWORD}文字以上にしてください`;
  if (s.length > MAX_PASSWORD) return `パスワードは${MAX_PASSWORD}文字までです`;
  return '';
}

const recAad = (key, ver) => `${key}|v${ver}`;
/** Encrypt an object into a store record: { ver, iv, ct }. */
export function sealRecord(dek, key, ver, obj) { return { ver, ...seal(dek, JSON.stringify(obj), recAad(key, ver)) }; }
export function openRecord(dek, key, rec) { return JSON.parse(open(dek, rec, recAad(key, rec.ver)).toString()); }

export async function readRecord(store, dek, key) {
  const rec = await store.get(key); if (!rec) return null;
  try { return { data: openRecord(dek, key, rec), ver: rec.ver }; } catch { throw fail('vault_corrupt', 500); }
}
/** Write with compare-and-set. Returns false on a version conflict. */
export async function writeRecord(store, dek, key, obj, expectedVer) {
  return store.cas(key, expectedVer, sealRecord(dek, key, expectedVer + 1, obj));
}

export const emptyDoc = (profile) => ({ profile: profile || null, settings: {}, secrets: {}, connectors: [], notifSecret: b64(crypto.randomBytes(32)) });

export async function loadMeta(store) { return store.get(META_KEY); }

async function mutateMeta(store, fn) {
  for (let i = 0; i < 6; i++) {
    const meta = await store.get(META_KEY); if (!meta) throw fail('not_initialized', 409);
    const next = fn(structuredClone(meta)); if (next === false) return meta;
    next.ver = (meta.ver || 0) + 1;
    if (await store.cas(META_KEY, meta.ver || 0, next)) return next;
  }
  throw fail('conflict', 409);
}

/** First-time setup. @returns {{token, deviceId, dek}} @throws already_initialized (409) */
export async function createVault(store, { password, deviceName = 'この端末', kdf = KDF_DEFAULT, profile } = {}) {
  const err = checkPassword(password); if (err) throw fail('weak_password');
  const dek = crypto.randomBytes(32), now = Date.now();
  const kdfRec = { alg: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: b64(crypto.randomBytes(16)) };
  const pwWrap = seal(await passwordWrapKey(password, kdfRec), dek, 'wrap:pw');
  const dev = newDeviceToken();
  const meta = { ver: 1, v: 1, createdAt: now, kdf: kdfRec, pwWrap, docVer: 1,
    devices: { [dev.deviceId]: { name: cleanName(deviceName), createdAt: now, lastSeenAt: now, wrap: seal(deviceWrapKey(dev.deviceId, dev.secret), dek, `wrap:${dev.deviceId}`) } } };
  if (!(await store.cas(META_KEY, 0, meta))) throw fail('already_initialized', 409);
  await writeRecord(store, dek, DOC_KEY, emptyDoc(profile), 0);
  return { token: dev.token, deviceId: dev.deviceId, dek };
}
const cleanName = (n) => String(n || 'この端末').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40) || 'この端末';

/** @returns {Promise<{dek:Buffer, deviceId:string, meta:object}|null>} null for an unknown device, a wrong secret or a revoked token */
export async function unlockWithToken(store, token, meta) {
  const t = parseToken(token); if (!t) return null;
  meta = meta || await loadMeta(store); const d = meta?.devices?.[t.deviceId]; if (!d) return null;
  try { return { dek: open(deviceWrapKey(t.deviceId, t.secret), d.wrap, `wrap:${t.deviceId}`), deviceId: t.deviceId, meta }; } catch { return null; }
}
export async function unlockWithPassword(store, password) {
  const meta = await loadMeta(store); if (!meta || typeof password !== 'string' || !password || password.length > MAX_PASSWORD) return null;
  try { return { dek: open(await passwordWrapKey(password, meta.kdf), meta.pwWrap, 'wrap:pw'), meta }; } catch { return null; }
}

export async function addDevice(store, dek, name) {
  const dev = newDeviceToken(), now = Date.now();
  await mutateMeta(store, (m) => { m.devices[dev.deviceId] = { name: cleanName(name), createdAt: now, lastSeenAt: now, wrap: seal(deviceWrapKey(dev.deviceId, dev.secret), dek, `wrap:${dev.deviceId}`) }; return m; });
  return { token: dev.token, deviceId: dev.deviceId };
}
/** Revoking = deleting the device's wrap: the token can no longer unlock anything. */
export async function revokeDevice(store, deviceId) {
  let found = false;
  await mutateMeta(store, (m) => { if (!m.devices[deviceId]) return false; delete m.devices[deviceId]; found = true; return m; });
  return found;
}
export const publicDevices = (meta, currentId) => Object.entries(meta?.devices || {}).map(([id, d]) => ({ id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, current: id === currentId }))
  .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
/** Best-effort: at most one write per device per 10 minutes, a lost race is ignored. */
export async function touchDevice(store, meta, deviceId, now = Date.now()) {
  const d = meta?.devices?.[deviceId]; if (!d || now - (d.lastSeenAt || 0) < 600_000) return;
  const next = structuredClone(meta); next.devices[deviceId].lastSeenAt = now; next.ver = (meta.ver || 0) + 1;
  try { await store.cas(META_KEY, meta.ver || 0, next); } catch { /* ignore */ }
}
export async function changePassword(store, dek, newPassword) {
  if (checkPassword(newPassword)) throw fail('weak_password');
  const kdf = { alg: 'scrypt', N: KDF_DEFAULT.N, r: KDF_DEFAULT.r, p: KDF_DEFAULT.p, salt: b64(crypto.randomBytes(16)) };
  const cur = await loadMeta(store); if (cur?.kdf?.N && cur.kdf.N < KDF_DEFAULT.N) kdf.N = cur.kdf.N;   // a vault created with cheaper parameters (tests) keeps them
  const pwWrap = seal(await passwordWrapKey(newPassword, kdf), dek, 'wrap:pw');
  await mutateMeta(store, (m) => { m.kdf = kdf; m.pwWrap = pwWrap; return m; });
}

export async function readDoc(store, dek) {
  const r = await readRecord(store, dek, DOC_KEY); if (!r) throw fail('not_initialized', 409);
  return { doc: r.data, ver: r.ver };
}
/** Read-modify-write with a retry on version conflicts. fn receives a clone of the doc and returns it (or mutates it). */
export async function updateDoc(store, dek, fn) {
  for (let i = 0; i < 6; i++) {
    const { doc, ver } = await readDoc(store, dek);
    const next = (await fn(structuredClone(doc))) || doc;
    if (await writeRecord(store, dek, DOC_KEY, next, ver)) {
      await mutateMeta(store, (m) => { m.docVer = ver + 1; return m; }).catch(() => {});
      return { doc: next, ver: ver + 1 };
    }
  }
  throw fail('conflict', 409);
}

// ---- keys derived from the DEK for other purposes
export const ticketKeyFromDek = (dek) => hkdf(dek, Buffer.alloc(0), 'elvar-approval-ticket-v1');
