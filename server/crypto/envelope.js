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

/** AAD of an OAuth token record (app.oauth_tokens): the user, the provider ('google' | 'cx:<id>') and the DEK version. */
export const tokenAad = (userId, provider, dekVer) => `elvar:oauth:v2|${needUuid(userId)}|${String(provider)}|${Number(dekVer)}`;

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

/** An OAuth token record (any JSON object: refresh token, access token, client id ...). @returns {{ct:Buffer, iv:Buffer, dekVer:number}} */
export function sealToken(dek, userId, provider, dekVer, obj) {
  const r = sealBytes(dek, JSON.stringify(obj), tokenAad(userId, provider, dekVer));
  return { ct: r.ct, iv: r.iv, dekVer };
}
export function openToken(dek, userId, provider, rec) { return JSON.parse(openBytes(dek, rec, tokenAad(userId, provider, rec.dekVer)).toString('utf8')); }

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
 * The user's DEK and secrets on top of a repos object `r` (from db.asUser): r.uid, r.keys, r.secrets, r.afterCommit.
 *
 * Cache rules (a DEK that is not in the database must never be used, and a replaced DEK must never be used again):
 *   - A DEK is put into the warm-instance cache only AFTER the transaction that read or created it has committed (r.afterCommit). If the
 *     transaction rolls back, nothing was cached, so the next request creates (or reads) the real key.
 *   - A cache hit is never trusted blindly: inside the current transaction user_keys is read again and the hit is used only if the row is the same
 *     wrap (kek_id, dek_ver and the wrap's IV all equal). Another instance that rotated the DEK or re-wrapped it is therefore noticed at once.
 *   - Within one transaction a small per-transaction memo avoids unwrapping twice.
 * Secrets additionally carry a composite foreign key to user_keys(user_id, dek_ver) (migration 02), so even a bug here cannot store a secret
 * under a DEK version that does not exist.
 */
export function createKeyring({ kek, cacheMs = 60_000, max = 500, now = Date.now } = {}) {
  if (!kek) throw new Error('createKeyring: kek is required');
  const cache = new Map();          // uid -> { dek, dekVer, kekId, iv, at }   committed keys only
  const memo = new WeakMap();       // r (one transaction) -> { dek, dekVer, kekId, iv }
  const forget = (uid) => { cache.delete(uid); };
  const remember = (uid, v) => {
    cache.delete(uid); cache.set(uid, { ...v, at: now() });
    while (cache.size > max) cache.delete(cache.keys().next().value);   // oldest first
  };
  const afterCommit = (r, fn) => { if (typeof r.afterCommit === 'function') r.afterCommit(fn); };   // no hook -> no caching (fail safe)
  const same = (v, rec) => v && rec && v.kekId === rec.kekId && v.dekVer === rec.dekVer && Buffer.from(v.iv).equals(Buffer.from(rec.iv));
  const publish = (r, v) => { memo.set(r, v); afterCommit(r, () => remember(r.uid, v)); return v; };

  async function load(r) {
    let rec = await r.keys.get();
    if (!rec) {
      const dek = newDek(), fresh = await wrapDek(kek, r.uid, 1, dek);
      if (await r.keys.create(fresh)) return publish(r, { dek, dekVer: 1, kekId: fresh.kekId, iv: fresh.iv });   // cached only if this transaction commits
      rec = await r.keys.get();   // somebody else created it first
      if (!rec) throw fail('keys_unavailable', 500);
    }
    const m = memo.get(r);
    if (same(m, rec)) return m;
    const hit = cache.get(r.uid);
    if (same(hit, rec) && now() - hit.at < cacheMs) return hit;   // validated against the row we just read in this transaction
    let dek;
    try { dek = await unwrapDek(kek, r.uid, rec); } catch (e) { if (e?.code) throw e; throw fail('dek_unreadable', 500); }
    return publish(r, { dek, dekVer: rec.dekVer, kekId: rec.kekId, iv: rec.iv });
  }
  const dek = (r) => load(r);

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
      const k = await dek(r);
      try { return openSecret(k.dek, r.uid, name, rec); } catch { throw fail('secret_unreadable', 500); }
    },
    deleteSecret: (r, name) => r.secrets.del(needName(name)),
    /**
     * OAuth tokens (Google, MCP connectors): the record is sealed under the DEK like a secret; scopes / status / revoke_url stay readable columns.
     * `data` is merged over the stored record when `merge` is true (a refresh keeps the client id and the refresh token).
     */
    async putToken(r, provider, data, { scopes = [], status = 'ok', reason = null, revokeUrl = null, merge = false } = {}) {
      const k = await dek(r); let next = data, meta = { scopes, status, reason, revokeUrl };
      if (merge) {
        const cur = await r.oauthTokens.get(provider);
        if (cur) { try { next = { ...openToken(k.dek, r.uid, provider, cur), ...data }; } catch { throw fail('secret_unreadable', 500); } meta = { scopes: scopes.length ? scopes : cur.scopes, status, reason, revokeUrl: revokeUrl ?? cur.revokeUrl }; }
      }
      await r.oauthTokens.put(provider, { ...sealToken(k.dek, r.uid, provider, k.dekVer, next), ...meta });
    },
    /** @returns {Promise<{data:object, scopes:string[], status:string, reason:string|null, revokeUrl:string|null, updatedAt:string}|null>} */
    async getToken(r, provider) {
      const rec = await r.oauthTokens.get(provider); if (!rec) return null;
      const k = await dek(r);
      try { return { data: openToken(k.dek, r.uid, provider, rec), scopes: rec.scopes, status: rec.status, reason: rec.reason, revokeUrl: rec.revokeUrl, updatedAt: rec.updatedAt }; } catch { throw fail('secret_unreadable', 500); }
    },
    /** Every token of the user, opened (account deletion revokes them at the providers). A record that cannot be opened is skipped. */
    async allTokens(r) {
      const out = [], k = await dek(r);
      for (const rec of await r.oauthTokens.allSealed()) { try { out.push({ provider: rec.provider, data: openToken(k.dek, r.uid, rec.provider, rec), scopes: rec.scopes, revokeUrl: rec.revokeUrl }); } catch { /* unreadable: nothing to revoke with */ } }
      return out;
    },
    /** Names, whether set and the last 4 characters. Values are never returned. */
    async secretStatus(r) { return (await r.secrets.list()).map((s) => ({ name: s.name, set: true, last4: s.last4, updatedAt: s.updatedAt })); },
    async ticketKey(r) { return ticketKey((await dek(r)).dek, r.uid); },
    async connectorKey(r) { return connectorKey((await dek(r)).dek, r.uid); },

    /**
     * New DEK for this user ("sign out everywhere and make a new key", or a suspected leak): every secret is re-encrypted and dek_ver goes up.
     * Run it inside one asUser() so that it is all-or-nothing. user_secrets and oauth_tokens are both re-encrypted.
     */
    async rotateDek(r) {
      forget(r.uid);
      const cur = await load(r), nextVer = cur.dekVer + 1, next = newDek();
      const all = await r.secrets.allSealed();
      for (const s of all) {
        let plain; try { plain = openSecret(cur.dek, r.uid, s.name, s); } catch { throw fail('secret_unreadable', 500); }
        await r.secrets.put(s.name, sealSecret(next, r.uid, s.name, nextVer, plain));
      }
      let tokens = 0;
      for (const t of await r.oauthTokens.allSealed()) {
        let plain; try { plain = openToken(cur.dek, r.uid, t.provider, t); } catch { throw fail('secret_unreadable', 500); }
        await r.oauthTokens.put(t.provider, { ...sealToken(next, r.uid, t.provider, nextVer, plain), scopes: t.scopes, status: t.status, reason: t.reason, revokeUrl: t.revokeUrl }); tokens++;
      }
      await r.keys.replace(await wrapDek(kek, r.uid, nextVer, next));
      memo.delete(r); forget(r.uid); afterCommit(r, () => forget(r.uid));
      return { dekVer: nextVer, reencrypted: all.length + tokens };
    },
    /** KEK rotation for this user. @returns {Promise<boolean>} true if the wrap was changed */
    async rewrap(r) {
      const rec = await r.keys.get(); if (!rec) return false;
      if (rec.kekId === kek.currentId) return false;
      await r.keys.replace(await rewrapDek(kek, r.uid, rec)); memo.delete(r); forget(r.uid); afterCommit(r, () => forget(r.uid));
      return true;
    },
  };
}
