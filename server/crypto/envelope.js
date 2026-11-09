// Per-user envelope encryption (docs/ELVAR_MULTIUSER.md section 4). node:crypto only.
//
//   KEK   platform key from the environment: ELVAR_KEK="<kid>:<base64 32 bytes>" (ELVAR_KEK_PREV during a rotation). Never stored in the database.
//         Behind a KekProvider so an external KMS can take over later (the provider only has to wrap / unwrap a DEK).
//   DEK   one random 32-byte key per user, stored only wrapped:  AES-256-GCM(KEK[kid], DEK, AAD = "elvar:dek:v2|<user id>|<dek ver>")
//   value AES-256-GCM(DEK, value, AAD = "elvar:sec:v2|<user id>|<name>|<dek ver>")
//
// The AAD carries the user id and the secret's name, so a ciphertext copied to another user's row, or under another name, fails to open.
// The primitives at the top (hkdf / seal / open / safeEqual) are shared with the old single-owner vault (server/config/vault.js re-exports them).
import crypto from 'node:crypto';

const b64 = (b) => Buffer.from(b).toString('base64url');
const unb64 = (s) => Buffer.from(String(s), 'base64url');
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });

export function hkdf(ikm, salt, info) { return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, 32)); }

const asBuf = (x) => (Buffer.isBuffer(x) ? x : Buffer.from(String(x)));
function key32(key) { if (!Buffer.isBuffer(key) || key.length !== 32) throw fail('bad_key', 500); return key; }

/** AES-256-GCM with a fresh random 96-bit IV, on raw bytes. The tag is appended to the ciphertext. @returns {{iv:Buffer, ct:Buffer}} */
export function sealBytes(key, plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key32(key), iv); c.setAAD(Buffer.from(aad));
  return { iv, ct: Buffer.concat([c.update(asBuf(plain)), c.final(), c.getAuthTag()]) };
}
/** @throws on a wrong key, tampered data or a different AAD */
export function openBytes(key, rec, aad) {
  const iv = Buffer.from(rec?.iv || []), all = Buffer.from(rec?.ct || []);
  if (iv.length !== 12 || all.length < 16) throw fail('bad_record');
  const d = crypto.createDecipheriv('aes-256-gcm', key32(key), iv); d.setAAD(Buffer.from(aad)); d.setAuthTag(all.subarray(all.length - 16));
  return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]);
}

/** Same as sealBytes with base64url strings (the form the old vault stores). */
export function seal(key, plain, aad) { const r = sealBytes(key, plain, aad); return { iv: b64(r.iv), ct: b64(r.ct) }; }
export function open(key, rec, aad) { return openBytes(key, { iv: unb64(rec?.iv), ct: unb64(rec?.ct) }, aad); }

/** Constant-time string equality (hashes first, so lengths do not leak). */
export function safeEqual(a, b) {
  const h = (x) => crypto.createHash('sha256').update(String(x ?? '')).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

// ---------------------------------------------------------------------------------------------------------------- identifiers
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** '|' is the AAD separator, so it is not allowed in a name (this is also the CHECK on app.user_secrets.name). */
export const SECRET_NAME_RE = /^[A-Za-z0-9_:.-]{1,80}$/;
export const KEK_ID_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const needUuid = (u) => { if (!UUID_RE.test(String(u))) throw fail('bad_user_id', 500); return String(u).toLowerCase(); };
const needName = (n) => { if (!SECRET_NAME_RE.test(String(n))) throw fail('bad_secret_name'); return String(n); };

export const dekAad = (userId, dekVer) => `elvar:dek:v2|${needUuid(userId)}|${Number(dekVer)}`;
export const secretAad = (userId, name, dekVer) => `elvar:sec:v2|${needUuid(userId)}|${needName(name)}|${Number(dekVer)}`;

// ---------------------------------------------------------------------------------------------------------------- KEK
/** "<kid>:<base64 of 32 bytes>" -> { id, key } */
export function parseKek(spec) {
  const s = String(spec || '').trim(), i = s.indexOf(':');
  const id = s.slice(0, i), raw = s.slice(i + 1);
  if (i < 1 || !KEK_ID_RE.test(id) || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) throw fail('kek_invalid', 500);
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw fail('kek_invalid', 500);
  return { id, key };
}

/**
 * KekProvider backed by the environment. ELVAR_KEK = the key used to wrap new DEKs; ELVAR_KEK_PREV = older key(s), comma separated, only for unwrapping
 * (and re-wrapping) while a rotation is in progress. Nothing is read until the first use, so importing this module never fails.
 *   currentId                        id of the key that wraps
 *   wrap(dek, aad)                   -> { kekId, iv, wrapped }
 *   unwrap({kekId, iv, wrapped}, aad) -> dek
 */
export function envKekProvider(env = process.env) {
  let loaded = null;
  const load = () => {
    if (loaded) return loaded;
    if (!env.ELVAR_KEK) throw fail('kek_missing', 500);
    const current = parseKek(env.ELVAR_KEK), keys = new Map([[current.id, current.key]]);
    for (const p of String(env.ELVAR_KEK_PREV || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      const k = parseKek(p); if (keys.has(k.id) && !keys.get(k.id).equals(k.key)) throw fail('kek_id_clash', 500); keys.set(k.id, k.key);
    }
    return (loaded = { current, keys });
  };
  return {
    get currentId() { return load().current.id; },
    async wrap(dek, aad) { const { current } = load(); const r = sealBytes(current.key, dek, aad); return { kekId: current.id, iv: r.iv, wrapped: r.ct }; },
    async unwrap(rec, aad) {
      const key = load().keys.get(rec.kekId); if (!key) throw fail('kek_unknown', 500);
      return openBytes(key, { iv: rec.iv, ct: rec.wrapped }, aad);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------- DEK and values
export const newDek = () => crypto.randomBytes(32);

/** @returns {{kekId:string, dekVer:number, iv:Buffer, wrapped:Buffer}}  (the columns of app.user_keys) */
export async function wrapDek(kek, userId, dekVer, dek) {
  const w = await kek.wrap(key32(dek), dekAad(userId, dekVer));
  return { kekId: w.kekId, dekVer, iv: w.iv, wrapped: w.wrapped };
}
export async function unwrapDek(kek, userId, rec) { return key32(await kek.unwrap(rec, dekAad(userId, rec.dekVer))); }

const last4Of = (v) => (typeof v === 'string' && v.length >= 8 ? v.slice(-4) : null);
/** @returns {{ct:Buffer, iv:Buffer, dekVer:number, last4:string|null}} (the columns of app.user_secrets) */
export function sealSecret(dek, userId, name, dekVer, value) {
  const v = String(value);
  const r = sealBytes(dek, v, secretAad(userId, name, dekVer));
  return { ct: r.ct, iv: r.iv, dekVer, last4: last4Of(v) };
}
export function openSecret(dek, userId, name, rec) { return openBytes(dek, rec, secretAad(userId, name, rec.dekVer)).toString('utf8'); }

/** Keys derived from the DEK for other purposes. Rotating the DEK invalidates both (pending approval tickets die with it). */
export const ticketKey = (dek, userId) => hkdf(dek, Buffer.from(needUuid(userId)), 'elvar-approval-ticket-v2');
export const connectorKey = (dek, userId) => hkdf(dek, Buffer.from(needUuid(userId)), 'elvar-connector-v2');

/** KEK rotation for one user: unwrap with whichever KEK wrapped it, wrap again with the current one. */
export async function rewrapDek(kek, userId, rec) {
  const dek = await unwrapDek(kek, userId, rec);
  return wrapDek(kek, userId, rec.dekVer, dek);
}

// ---------------------------------------------------------------------------------------------------------------- keyring
/**
 * The user's DEK and secrets on top of a repos object `r` (from db.asUser): r.uid, r.keys, r.secrets.
 * A warm instance keeps a decrypted DEK for `cacheMs` (default 60 s); it is dropped on rotation and when a secret shows a different dek_ver.
 */
export function createKeyring({ kek, cacheMs = 60_000, max = 500, now = Date.now } = {}) {
  if (!kek) throw new Error('createKeyring: kek is required');
  const cache = new Map();   // uid -> { dek, dekVer, kekId, at }
  const forget = (uid) => { cache.delete(uid); };
  const remember = (uid, v) => {
    cache.delete(uid); cache.set(uid, { ...v, at: now() });
    while (cache.size > max) cache.delete(cache.keys().next().value);   // oldest first
  };

  async function load(r, { cacheIt = true } = {}) {
    let rec = await r.keys.get();
    if (!rec) {
      const dek = newDek(), fresh = await wrapDek(kek, r.uid, 1, dek);
      if (await r.keys.create(fresh)) { if (cacheIt) remember(r.uid, { dek, dekVer: 1, kekId: fresh.kekId }); return { dek, dekVer: 1, kekId: fresh.kekId }; }
      rec = await r.keys.get();   // somebody else created it first
      if (!rec) throw fail('keys_unavailable', 500);
    }
    let dek;
    try { dek = await unwrapDek(kek, r.uid, rec); } catch (e) { if (e?.code) throw e; throw fail('dek_unreadable', 500); }
    const v = { dek, dekVer: rec.dekVer, kekId: rec.kekId };
    if (cacheIt) remember(r.uid, v);
    return v;
  }
  async function dek(r, wantVer) {
    const hit = cache.get(r.uid);
    if (hit && now() - hit.at < cacheMs && (wantVer === undefined || hit.dekVer === wantVer)) return hit;
    return load(r);
  }

  return {
    dek, forget, load,
    async setSecret(r, name, value) {
      needName(name); if (typeof value !== 'string' || !value) throw fail('bad_secret_value');
      const k = await dek(r), rec = sealSecret(k.dek, r.uid, name, k.dekVer, value);
      await r.secrets.put(name, rec);
      return { name, set: true, last4: rec.last4 };
    },
    /** @returns {Promise<string|null>} */
    async getSecret(r, name) {
      const rec = await r.secrets.get(needName(name)); if (!rec) return null;
      const k = await dek(r, rec.dekVer);
      try { return openSecret(k.dek, r.uid, name, rec); } catch { throw fail('secret_unreadable', 500); }
    },
    deleteSecret: (r, name) => r.secrets.del(needName(name)),
    /** Names, whether set and the last 4 characters. Values are never returned. */
    async secretStatus(r) { return (await r.secrets.list()).map((s) => ({ name: s.name, set: true, last4: s.last4, updatedAt: s.updatedAt })); },
    async ticketKey(r) { return ticketKey((await dek(r)).dek, r.uid); },
    async connectorKey(r) { return connectorKey((await dek(r)).dek, r.uid); },

    /**
     * New DEK for this user ("sign out everywhere and make a new key", or a suspected leak): every secret is re-encrypted and dek_ver goes up.
     * Run it inside one asUser() so that it is all-or-nothing. Tables added later (oauth_tokens) join here.
     */
    async rotateDek(r) {
      forget(r.uid);
      const cur = await load(r, { cacheIt: false }), nextVer = cur.dekVer + 1, next = newDek();
      const all = await r.secrets.allSealed();
      for (const s of all) {
        let plain; try { plain = openSecret(cur.dek, r.uid, s.name, s); } catch { throw fail('secret_unreadable', 500); }
        await r.secrets.put(s.name, sealSecret(next, r.uid, s.name, nextVer, plain));
      }
      await r.keys.replace(await wrapDek(kek, r.uid, nextVer, next));
      forget(r.uid);
      return { dekVer: nextVer, reencrypted: all.length };
    },
    /** KEK rotation for this user. @returns {Promise<boolean>} true if the wrap was changed */
    async rewrap(r) {
      const rec = await r.keys.get(); if (!rec) return false;
      if (rec.kekId === kek.currentId) return false;
      await r.keys.replace(await rewrapDek(kek, r.uid, rec)); forget(r.uid);
      return true;
    },
  };
}
