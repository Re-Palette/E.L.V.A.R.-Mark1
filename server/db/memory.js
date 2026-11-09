// MemoryDb: the in-memory implementation of the same database interface as the Postgres one (npm test is Docker-free).
//   asUser(verifiedUid, fn)  -> fn(repos)        repos only ever see the rows of that user; a throw rolls the user's rows back
//   system                   rlHit / purgeExpired / residualCheck / deviceLookup
//   testing                  newUser / deleteUser (the cascade of "delete from auth.users") / makeAdmin / setAccountStatus / advance(ms) (fake clock)
// It enforces the same input rules as the CHECK constraints (server/db/validate.js) and the same unique keys, so the contract tests
// (test/contracts/db.contract.mjs) pass on both. The tables are exactly the ones in the data registry.
import crypto from 'node:crypto';
import { dbError } from './errors.js';
import * as V from './validate.js';
import { requireVerifiedUid } from './verified-uid.js';
import { REGISTRY } from '../rights/registry.js';

const DEFAULT_QUOTA = 524288000;
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const iso = (ms) => new Date(ms).toISOString();
const sameBytes = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const clone = (v) => {
  if (Buffer.isBuffer(v)) return Buffer.from(v);
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
};

export function createMemoryDb({ now = null } = {}) {
  let offset = 0;
  const clock = now || (() => Date.now() + offset);
  const tables = Object.fromEntries(REGISTRY.map((e) => [e.table, []]));
  const users = new Set();
  const ownerOf = (t) => REGISTRY.find((e) => e.table === t).ownerColumn;

  const rows = (t, uid) => tables[t].filter((r) => r[ownerOf(t)] === uid);
  const find = (t, uid, pred = () => true) => tables[t].find((r) => r.user_id === uid && pred(r));
  const remove = (t, pred) => { const n = tables[t].length; tables[t] = tables[t].filter((r) => !pred(r)); return n - tables[t].length; };
  const live = (r) => r.expires_at > clock();

  function repos(uid, hooks = []) {
    return {
      uid,
      afterCommit(h) { hooks.push(h); },
      accounts: {
        // like the real ensure_account(): the row references auth.users, so an unknown or deleted user is refused (SQLSTATE 23503 -> invalid_reference)
        async ensure() { if (!users.has(uid)) throw dbError('invalid_reference', 409); if (!find('accounts', uid)) tables.accounts.push({ user_id: uid, status: 'active', storage_quota_bytes: DEFAULT_QUOTA, hard_limits: {}, suspended_reason: null, created_at: clock() }); return this.get(); },
        async get() { const r = find('accounts', uid); return r ? { userId: uid, status: r.status, storageQuotaBytes: r.storage_quota_bytes, hardLimits: clone(r.hard_limits), suspendedReason: r.suspended_reason, createdAt: iso(r.created_at) } : null; },
        async isAdmin() { return Boolean(find('admins', uid)); },
      },
      profile: {
        async get() { const r = find('profiles', uid); return r ? clone(r.profile) : null; },
        async put(profile) { V.jsonObject(profile); const r = find('profiles', uid); if (r) { r.profile = clone(profile); r.updated_at = clock(); } else tables.profiles.push({ user_id: uid, profile: clone(profile), updated_at: clock() }); },
        async del() { return remove('profiles', (r) => r.user_id === uid) > 0; },
      },
      settings: {
        async get() { const r = find('settings', uid); return r ? clone(r.settings) : {}; },
        async put(settings) { V.jsonObject(settings); const r = find('settings', uid); if (r) { r.settings = clone(settings); r.updated_at = clock(); } else tables.settings.push({ user_id: uid, settings: clone(settings), updated_at: clock() }); },
      },
      keys: {
        async get() { const r = find('user_keys', uid); return r ? { kekId: r.kek_id, dekVer: r.dek_ver, wrapped: Buffer.from(r.wrapped), iv: Buffer.from(r.iv), rotatedAt: r.rotated_at ? iso(r.rotated_at) : null } : null; },
        async create(rec) { const k = V.keyInput(rec); if (find('user_keys', uid)) return false; tables.user_keys.push({ user_id: uid, kek_id: k.kekId, dek_ver: k.dekVer, wrapped: k.wrapped, iv: k.iv, rotated_at: null }); return true; },
        async replace(rec) { const k = V.keyInput(rec); const r = find('user_keys', uid); if (!r) throw dbError('not_found', 404); Object.assign(r, { kek_id: k.kekId, dek_ver: k.dekVer, wrapped: k.wrapped, iv: k.iv, rotated_at: clock() }); },
        async del() { remove('user_secrets', (r) => r.user_id === uid); return remove('user_keys', (r) => r.user_id === uid) > 0; },   // on delete cascade (crypto-shred)
      },
      secrets: {
        async list() { return rows('user_secrets', uid).sort((a, b) => (a.name < b.name ? -1 : 1)).map((r) => ({ name: r.name, last4: r.last4, dekVer: r.dek_ver, updatedAt: iso(r.updated_at) })); },
        async get(name) { V.secretName(name); const r = find('user_secrets', uid, (x) => x.name === name); return r ? { name, last4: r.last4, dekVer: r.dek_ver, updatedAt: iso(r.updated_at), ct: Buffer.from(r.ct), iv: Buffer.from(r.iv) } : null; },
        async allSealed() { return rows('user_secrets', uid).sort((a, b) => (a.name < b.name ? -1 : 1)).map((r) => ({ name: r.name, last4: r.last4, dekVer: r.dek_ver, updatedAt: iso(r.updated_at), ct: Buffer.from(r.ct), iv: Buffer.from(r.iv) })); },
        async put(name, rec) {
          V.secretName(name); const s = V.sealedInput(rec); const r = find('user_secrets', uid, (x) => x.name === name);
          const next = { user_id: uid, name, ct: s.ct, iv: s.iv, dek_ver: s.dekVer, last4: s.last4, updated_at: clock() };
          if (r) Object.assign(r, next); else tables.user_secrets.push(next);
        },
        async del(name) { V.secretName(name); return remove('user_secrets', (r) => r.user_id === uid && r.name === name) > 0; },
        async delAll() { return remove('user_secrets', (r) => r.user_id === uid); },
      },
      devices: {
        async create(d) {
          const x = V.deviceInput(d);
          if (tables.devices.some((r) => sameBytes(r.token_hash, x.tokenHash)) || find('devices', uid, (r) => r.id === x.id)) throw dbError('conflict', 409);
          tables.devices.push({ user_id: uid, id: x.id, name: x.name, token_hash: x.tokenHash, scopes: x.scopes, created_at: clock(), last_seen_at: null });
        },
        async list() { return rows('devices', uid).sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1)).map((r) => ({ id: r.id, name: r.name, scopes: [...r.scopes], createdAt: iso(r.created_at), lastSeenAt: r.last_seen_at ? iso(r.last_seen_at) : null })); },
        async rename(id, name) { V.need(V.DEVICE_ID_RE.test(id) && typeof name === 'string' && name.length >= 1 && name.length <= 40); const r = find('devices', uid, (x) => x.id === id); if (!r) return false; r.name = name; return true; },
        async revoke(id) { V.need(V.DEVICE_ID_RE.test(id)); return remove('devices', (r) => r.user_id === uid && r.id === id) > 0; },
        async touch(id) { V.need(V.DEVICE_ID_RE.test(id)); const r = find('devices', uid, (x) => x.id === id); if (r) r.last_seen_at = clock(); },
      },
      audit: {
        async append({ actor = 'user', actorId, action, target = null, meta = null }) {
          V.need(['user', 'system'].includes(actor) && typeof action === 'string' && action.length >= 1 && action.length <= 100);
          V.need(actor === 'user' ? (actorId === undefined || actorId === uid) : (actorId === undefined || actorId === null));   // the policy: user -> auth.uid(), system -> null
          tables.audit_log.push({ user_id: uid, id: ++auditSeq, at: clock(), actor, actor_id: actor === 'user' ? uid : null, action, target, meta: clone(meta) });
        },
        async list({ limit = 100 } = {}) {
          V.need(Number.isInteger(limit) && limit >= 1 && limit <= 1000);
          return rows('audit_log', uid).sort((a, b) => b.id - a.id).slice(0, limit).map((r) => ({ id: String(r.id), at: iso(r.at), actor: r.actor, actorId: r.actor_id, action: r.action, target: r.target, meta: clone(r.meta) }));
        },
      },
      kv: {
        async get(key) { V.key200(key); const r = find('kv_ephemeral', uid, (x) => x.key === key && live(x)); return r ? clone(r.value) : null; },
        async set(key, value, { ttlSec }) {
          V.key200(key); V.need(value !== null && value !== undefined); const t = V.ttlSec(ttlSec); const r = find('kv_ephemeral', uid, (x) => x.key === key);
          const next = { user_id: uid, key, value: clone(value), expires_at: clock() + t * 1000 };
          if (r) Object.assign(r, next); else tables.kv_ephemeral.push(next);
        },
        async del(key) { V.key200(key); return remove('kv_ephemeral', (r) => r.user_id === uid && r.key === key) > 0; },
      },
      tickets: {
        async markUsed(jti, ttl) { V.key200(jti); const t = V.ttlSec(ttl); if (find('ticket_uses', uid, (r) => r.jti === jti)) return false; tables.ticket_uses.push({ user_id: uid, jti, exp: clock() + t * 1000 }); return true; },
      },
      oauthPending: {
        async put({ stateHash, sealed, ttl }) {
          V.need(V.isBytes(stateHash, 32) && V.isBytes(sealed) && sealed.length >= 1 && sealed.length <= 8192); const t = V.ttlSec(ttl);
          if (tables.oauth_pending.some((r) => sameBytes(r.state_hash, stateHash))) throw dbError('conflict', 409);
          tables.oauth_pending.push({ user_id: uid, state_hash: V.toBuf(stateHash), sealed: V.toBuf(sealed), expires_at: clock() + t * 1000 });
        },
        async take(stateHash) {
          V.need(V.isBytes(stateHash, 32));
          const r = find('oauth_pending', uid, (x) => sameBytes(x.state_hash, stateHash) && live(x)); if (!r) return null;
          remove('oauth_pending', (x) => x === r); return Buffer.from(r.sealed);
        },
      },
      usageLimits: {
        async list() { return rows('usage_limits', uid).sort((a, b) => `${a.provider}|${a.metric}|${a.period}`.localeCompare(`${b.provider}|${b.metric}|${b.period}`)).map((r) => ({ provider: r.provider, metric: r.metric, period: r.period, soft: r.soft, softAction: r.soft_action })); },
        async put({ provider, metric, period, soft, softAction = 'warn' }) {
          V.need(typeof provider === 'string' && provider && provider.length <= 40 && typeof metric === 'string' && metric && metric.length <= 40
            && ['day', 'month'].includes(period) && Number.isFinite(soft) && soft >= 0 && ['warn', 'block'].includes(softAction));
          const r = find('usage_limits', uid, (x) => x.provider === provider && x.metric === metric && x.period === period);
          if (r) Object.assign(r, { soft, soft_action: softAction }); else tables.usage_limits.push({ user_id: uid, provider, metric, period, soft, soft_action: softAction });
        },
        async del({ provider, metric, period }) { return remove('usage_limits', (r) => r.user_id === uid && r.provider === provider && r.metric === metric && r.period === period) > 0; },
      },
      usage: {
        async daily({ from, to }) { return rows('usage_daily', uid).filter((r) => r.day >= from && r.day <= to).sort((a, b) => `${a.day}|${a.provider}|${a.metric}`.localeCompare(`${b.day}|${b.provider}|${b.metric}`)).map((r) => ({ day: r.day, provider: r.provider, metric: r.metric, amount: r.amount })); },
        async storage() { const r = find('storage_usage', uid); return r ? { filesBytes: r.files_bytes, textBytes: r.text_bytes, notesBytes: r.notes_bytes, messagesBytes: r.messages_bytes, reservedBytes: r.reserved_bytes } : { filesBytes: 0, textBytes: 0, notesBytes: 0, messagesBytes: 0, reservedBytes: 0 }; },
      },
    };
  }
  let auditSeq = 0;
  // user_secrets (user_id, dek_ver) -> user_keys (user_id, dek_ver), deferrable: checked when the transaction commits (a failure rolls it back)
  const checkKeyReferences = (uid) => {
    const key = find('user_keys', uid);
    for (const s of tables.user_secrets) if (s.user_id === uid && (!key || key.dek_ver !== s.dek_ver)) throw dbError('invalid_reference', 409);
  };

  const system = {
    async rlHit({ bucket, who, windowSec, userId = null }) {
      const uid = userId ? requireVerifiedUid(userId) : null;
      if (!uid) V.need(typeof who === 'string' && who.length >= 1 && who.length <= 120 && !UUID_ANYWHERE.test(who));   // a user id is not an address
      const w = uid ? `u:${uid}` : `ip:${who}`;
      V.need(typeof bucket === 'string' && bucket.length >= 1 && bucket.length <= 64 && Number.isInteger(windowSec) && windowSec >= 1 && windowSec <= 86400);
      const start = Math.floor(clock() / 1000 / windowSec) * windowSec * 1000;
      let r = tables.rate_limits.find((x) => x.bucket === bucket && x.who === w && x.window_start === start);
      if (!r) { r = { bucket, who: w, window_start: start, n: 0, user_id: uid, expires_at: start + windowSec * 2000 }; tables.rate_limits.push(r); }
      return ++r.n;
    },
    async purgeExpired() {
      return {
        kv_ephemeral: remove('kv_ephemeral', (r) => r.expires_at <= clock()), rate_limits: remove('rate_limits', (r) => r.expires_at <= clock()),
        ticket_uses: remove('ticket_uses', (r) => r.exp <= clock()), oauth_pending: remove('oauth_pending', (r) => r.expires_at <= clock()),
      };
    },
    async residualCheck(vuid) {
      const uid = requireVerifiedUid(vuid);
      return REGISTRY.map((e) => ({ table: e.table, n: tables[e.table].filter((r) => r[e.ownerColumn] === uid || (e.table === 'rate_limits' && (r.who === `u:${uid}` || r.who === uid))).length })).sort((a, b) => (a.table < b.table ? -1 : 1)); },
    async deviceLookup(hash) { V.need(V.isBytes(hash, 32)); const r = tables.devices.find((x) => sameBytes(x.token_hash, hash)); return r ? { userId: r.user_id, deviceId: r.id, scopes: [...r.scopes] } : null; },
  };

  return {
    kind: 'memory',
    async asUser(vuid, fn) {
      const uid = requireVerifiedUid(vuid);
      const snap = Object.fromEntries(REGISTRY.map((e) => [e.table, tables[e.table].filter((r) => r[e.ownerColumn] === uid).map(clone)]));
      const hooks = [];
      try {
        const out = await fn(repos(uid, hooks));
        checkKeyReferences(uid);   // what the deferred composite foreign key checks at COMMIT
        for (const h of hooks) { try { await h(); } catch { /* ignore */ } }
        return out;
      } catch (e) {   // roll back this user's rows (only theirs: a concurrent request of another user is not touched)
        for (const en of REGISTRY) tables[en.table] = [...tables[en.table].filter((r) => r[en.ownerColumn] !== uid), ...snap[en.table]];
        throw e;
      }
    },
    system,
    async ping() { return true; },
    async close() {},
    testing: {
      newUser() { const id = crypto.randomUUID(); users.add(id); return id; },
      /** What `delete from auth.users` does: every row of the user goes (on delete cascade). */
      deleteUser(uid) { users.delete(uid); for (const e of REGISTRY) tables[e.table] = tables[e.table].filter((r) => r[e.ownerColumn] !== uid); },
      setAccountStatus(uid, status) { const r = find('accounts', uid); if (r) r.status = status; },
      makeAdmin(uid) { if (!find('admins', uid)) tables.admins.push({ user_id: uid, granted_by: null, granted_at: clock() }); },
      advance(ms) { offset += ms; },
    },
  };
}
