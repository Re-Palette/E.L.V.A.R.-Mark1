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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  const profilesOfUsers = new Map();   // uid -> { email, confirmed, createdAt, lastSignInAt } (what auth.users holds)
  const receipts = [];
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
        async requestDeletion(graceDays, email = null) {
          V.need(graceDays === 0 || graceDays === 7); V.need(email === null || (typeof email === 'string' && email.length <= 320));
          const cur = find('deletion_requests', uid); if (cur) return iso(cur.purge_after);
          if (!find('accounts', uid)) tables.accounts.push({ user_id: uid, status: 'active', storage_quota_bytes: DEFAULT_QUOTA, hard_limits: {}, suspended_reason: null, created_at: clock() });
          const due = clock() + graceDays * 86400_000;
          tables.deletion_requests.push({ user_id: uid, requested_at: clock(), grace_days: graceDays, purge_after: due, email_for_receipt: email || null });
          find('accounts', uid).status = 'pending_deletion';
          tables.audit_log.push({ user_id: uid, id: ++auditSeq, at: clock(), actor: 'user', actor_id: uid, action: 'account.delete_requested', target: null, meta: { grace_days: graceDays } });
          return iso(due);
        },
        async cancelDeletion() {
          const cur = find('deletion_requests', uid); if (!cur || !(cur.grace_days > 0) || !(cur.purge_after > clock())) return false;
          remove('deletion_requests', (r) => r.user_id === uid); const a = find('accounts', uid); if (a && a.status === 'pending_deletion') a.status = 'active';
          tables.audit_log.push({ user_id: uid, id: ++auditSeq, at: clock(), actor: 'user', actor_id: uid, action: 'account.delete_cancelled', target: null, meta: null });
          return true;
        },
        async deletion() { const r = find('deletion_requests', uid); return r ? { graceDays: r.grace_days, requestedAt: iso(r.requested_at), purgeAfter: iso(r.purge_after) } : null; },
      },
      admin: {   // metadata only (M11); every call checks the admins table like app.is_admin()
        async listUsers({ limit = 100, offset = 0 } = {}) {
          if (!find('admins', uid)) throw dbError('forbidden', 403);
          V.need(Number.isInteger(limit) && limit >= 1 && limit <= 500 && Number.isInteger(offset) && offset >= 0);
          const day = new Date(clock()).toISOString().slice(0, 10), since = new Date(clock() - 29 * 86400_000).toISOString().slice(0, 10);
          return [...users].map((id) => ({ id, ...(profilesOfUsers.get(id) || {}) })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || (a.id < b.id ? -1 : 1)).slice(offset, offset + limit).map((u) => {
            const a = tables.accounts.find((r) => r.user_id === u.id), su = tables.storage_usage.find((r) => r.user_id === u.id);
            const sum = (pred) => tables.usage_daily.filter((r) => r.user_id === u.id && pred(r)).reduce((x, r) => x + r.amount, 0);
            return { userId: u.id, email: u.email ?? null, createdAt: u.createdAt ? iso(u.createdAt) : null, lastSignInAt: u.lastSignInAt ? iso(u.lastSignInAt) : null, status: a?.status || 'active', isAdmin: Boolean(tables.admins.find((r) => r.user_id === u.id)),
              storageQuotaBytes: a?.storage_quota_bytes ?? DEFAULT_QUOTA, storageUsedBytes: su ? su.files_bytes + su.text_bytes + su.notes_bytes + su.messages_bytes : 0,
              callsToday: sum((r) => r.day === day && r.metric === 'calls'), liveSecondsToday: sum((r) => r.day === day && r.metric === 'live_seconds'), calls30d: sum((r) => r.day >= since && r.metric === 'calls') };
          });
        },
        async setStatus(userId, status, reason = null) {
          if (!find('admins', uid)) throw dbError('forbidden', 403);
          V.need(typeof userId === 'string' && UUID_RE.test(userId) && ['active', 'suspended'].includes(status) && (reason === null || (typeof reason === 'string' && reason.length <= 500)));
          if (!users.has(userId)) throw dbError('not_found', 404);
          if (tables.admins.some((r) => r.user_id === userId)) throw dbError('forbidden', 403);
          let a = tables.accounts.find((r) => r.user_id === userId);
          if (!a) { a = { user_id: userId, status: 'active', storage_quota_bytes: DEFAULT_QUOTA, hard_limits: {}, suspended_reason: null, created_at: clock() }; tables.accounts.push(a); }
          if (a.status === 'pending_deletion') throw dbError('conflict', 409);
          a.status = status; a.suspended_reason = status === 'suspended' ? (reason || null) : null;
          tables.audit_log.push({ user_id: userId, id: ++auditSeq, at: clock(), actor: 'admin', actor_id: uid, action: status === 'suspended' ? 'account.suspended' : 'account.unsuspended', target: null, meta: { reason: reason || null } });
          return status;
        },
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
        async revokeAll() { return remove('devices', (r) => r.user_id === uid); },
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
        async record({ provider, metric, amount = 1, source = 'server' }) {
          V.need(typeof provider === 'string' && provider.length >= 1 && provider.length <= 40 && typeof metric === 'string' && metric.length >= 1 && metric.length <= 40
            && Number.isFinite(amount) && amount >= 0 && amount <= 1e9 && ['server', 'client'].includes(source));
          if (!users.has(uid)) throw dbError('invalid_reference', 409);
          tables.usage_events.push({ user_id: uid, id: ++auditSeq, at: clock(), provider, metric, amount, source, meta: null });
          const day = new Date(clock()).toISOString().slice(0, 10); const d = tables.usage_daily.find((r) => r.user_id === uid && r.day === day && r.provider === provider && r.metric === metric);
          if (d) d.amount += amount; else tables.usage_daily.push({ user_id: uid, day, provider, metric, amount });
        },
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
    async dueDeletions(limit = 20) { return tables.deletion_requests.filter((r) => r.purge_after <= clock()).sort((a, b) => a.purge_after - b.purge_after).slice(0, Math.max(1, Math.min(limit, 200))).map((r) => ({ userId: r.user_id, graceDays: r.grace_days })); },
    async recordReceipt(tablesChecked) { V.need(Number.isInteger(tablesChecked) && tablesChecked >= 0); receipts.push({ completedAt: clock(), tablesChecked }); },
    async bootstrapAdmin(email) {
      V.need(typeof email === 'string' && email.length >= 3 && email.length <= 320);
      const u = [...users].map((id) => ({ id, ...(profilesOfUsers.get(id) || {}) })).find((x) => x.email && x.email.toLowerCase() === email.trim().toLowerCase() && x.confirmed !== false); if (!u) return null;
      if (!tables.accounts.find((r) => r.user_id === u.id)) tables.accounts.push({ user_id: u.id, status: 'active', storage_quota_bytes: DEFAULT_QUOTA, hard_limits: {}, suspended_reason: null, created_at: clock() });
      if (!tables.admins.find((r) => r.user_id === u.id)) tables.admins.push({ user_id: u.id, granted_by: null, granted_at: clock() });
      return u.id;
    },
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
      newUser(id = crypto.randomUUID(), email = null, { confirmed = true } = {}) { users.add(id); profilesOfUsers.set(id, { email, confirmed, createdAt: clock(), lastSignInAt: null }); return id; },
      /** What Auth records on a sign-in (the admin list shows it). */
      touchSignIn(id) { const p = profilesOfUsers.get(id); if (p) p.lastSignInAt = clock(); },
      setConfirmed(id, confirmed = true) { const p = profilesOfUsers.get(id); if (p) p.confirmed = confirmed; },
      receipts: () => receipts.map((r) => ({ ...r })),
      /** What `delete from auth.users` does: every row of the user goes (on delete cascade). */
      deleteUser(uid) { users.delete(uid); profilesOfUsers.delete(uid); for (const e of REGISTRY) tables[e.table] = tables[e.table].filter((r) => r[e.ownerColumn] !== uid); },
      setAccountStatus(uid, status) { const r = find('accounts', uid); if (r) r.status = status; },
      makeAdmin(uid) { if (!find('admins', uid)) tables.admins.push({ user_id: uid, granted_by: null, granted_at: clock() }); },
      advance(ms) { offset += ms; },
    },
  };
}
