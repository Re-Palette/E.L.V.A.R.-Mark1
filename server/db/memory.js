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
const jclone = (v) => JSON.parse(JSON.stringify(v));   // what a jsonb column does to a value (undefined keys vanish)
const sameBytes = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const clone = (v) => {
  if (Buffer.isBuffer(v)) return Buffer.from(v);
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
};

const tokenMeta = (r) => ({ provider: r.provider, scopes: [...r.scopes], status: r.status, reason: r.reason, revokeUrl: r.revoke_url, dekVer: r.dek_ver, updatedAt: iso(r.updated_at) });
const tokenFull = (r) => ({ ...tokenMeta(r), ct: Buffer.from(r.ct), iv: Buffer.from(r.iv) });
const buildRow = (r) => ({ id: r.id, repo: r.repo, target: r.target, issueNumber: r.issue_number, prNumber: r.pr_number, state: r.state, title: r.title, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });

const noteMeta = (n) => ({ id: n.id, path: n.path, bytes: Buffer.byteLength(n.content, 'utf8'), tags: [...n.tags], rev: n.rev, updatedAt: iso(n.updated_at), deletedAt: n.deleted_at === null ? null : iso(n.deleted_at) });
const noteFull = (n) => ({ ...noteMeta(n), content: n.content, pushedRev: n.pushed_rev ?? null, createdAt: iso(n.created_at) });
const convRow = (c) => ({ id: c.id, channel: c.channel, startedAt: iso(c.started_at), lastAt: iso(c.last_at), count: c.n ?? 0, preview: c.preview ?? null });
const msgRow = (m) => ({ id: String(m.id), conversationId: m.conversation_id, role: m.role, text: m.text, at: iso(m.at) });
const inboxRow = (r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, url: r.url, notePath: r.note_path, key: r.key, at: iso(r.at), readAt: r.read_at === null ? null : iso(r.read_at) });

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
  // the same rule as the Postgres repos: notes + revisions + messages must stay within the account's storage quota (default 500 MB)
  const assertRoom = (uid, grow) => {
    const a = find('accounts', uid), quota = a ? a.storage_quota_bytes : DEFAULT_QUOTA, size = (t) => Buffer.byteLength(t, 'utf8');
    const used = rows('notes', uid).reduce((x, n) => x + size(n.content), 0) + rows('note_revisions', uid).reduce((x, n) => x + size(n.content), 0) + rows('messages', uid).reduce((x, n) => x + size(n.text), 0);
    if (used + grow > quota) throw dbError('storage_quota_exceeded', 413);
  };

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
        async del() { remove('user_secrets', (r) => r.user_id === uid); remove('oauth_tokens', (r) => r.user_id === uid); return remove('user_keys', (r) => r.user_id === uid) > 0; },   // on delete cascade (crypto-shred)
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
        async setNx(key, value, { ttlSec }) {
          V.key200(key); V.need(value !== null && value !== undefined); const t = V.ttlSec(ttlSec); const r = find('kv_ephemeral', uid, (x) => x.key === key);
          if (r && live(r)) return false;
          const next = { user_id: uid, key, value: clone(value), expires_at: clock() + t * 1000 };
          if (r) Object.assign(r, next); else tables.kv_ephemeral.push(next);
          return true;
        },
      },
      tickets: {
        async markUsed(jti, ttl) { V.key200(jti); const t = V.ttlSec(ttl); if (find('ticket_uses', uid, (r) => r.jti === jti)) return false; tables.ticket_uses.push({ user_id: uid, jti, exp: clock() + t * 1000 }); return true; },
      },
      oauthPending: {
        async put({ stateHash, sealed, ttl, provider = 'google' }) {
          V.need(V.isBytes(stateHash, 32) && V.isBytes(sealed) && sealed.length >= 1 && sealed.length <= 8192 && V.OAUTH_FLOW_KINDS.includes(provider)); const t = V.ttlSec(ttl);
          if (tables.oauth_pending.some((r) => sameBytes(r.state_hash, stateHash))) throw dbError('conflict', 409);
          tables.oauth_pending.push({ user_id: uid, state_hash: V.toBuf(stateHash), provider, sealed: V.toBuf(sealed), phase: 'started', expires_at: clock() + t * 1000 });
        },
        async take(stateHash) {
          V.need(V.isBytes(stateHash, 32));
          const r = find('oauth_pending', uid, (x) => sameBytes(x.state_hash, stateHash) && live(x)); if (!r) return null;
          remove('oauth_pending', (x) => x === r); return Buffer.from(r.sealed);
        },
        async begin(stateHash, provider) {
          V.need(V.isBytes(stateHash, 32) && V.OAUTH_FLOW_KINDS.includes(provider));
          const r = find('oauth_pending', uid, (x) => sameBytes(x.state_hash, stateHash) && x.provider === provider && live(x) && x.phase === 'started'); if (!r) return null;
          r.phase = 'exchanging'; return Buffer.from(r.sealed);
        },
        async settle(stateHash, { sealed, phase }) {
          V.need(V.isBytes(stateHash, 32) && V.isBytes(sealed) && sealed.length >= 1 && sealed.length <= 8192 && ['done', 'error'].includes(phase));
          const r = find('oauth_pending', uid, (x) => sameBytes(x.state_hash, stateHash) && live(x) && x.phase === 'exchanging'); if (!r) return false;
          r.sealed = V.toBuf(sealed); r.phase = phase; return true;
        },
        async get(stateHash) {
          V.need(V.isBytes(stateHash, 32));
          const r = find('oauth_pending', uid, (x) => sameBytes(x.state_hash, stateHash) && live(x)); return r ? { sealed: Buffer.from(r.sealed), phase: r.phase } : null;
        },
      },
      oauthTokens: {
        async list() { return rows('oauth_tokens', uid).sort((a, b) => (a.provider < b.provider ? -1 : 1)).map(tokenMeta); },
        async get(provider) { V.need(V.PROVIDER_RE.test(provider)); const r = find('oauth_tokens', uid, (x) => x.provider === provider); return r ? tokenFull(r) : null; },
        async allSealed() { return rows('oauth_tokens', uid).sort((a, b) => (a.provider < b.provider ? -1 : 1)).map(tokenFull); },
        async put(provider, rec) {
          const t = V.oauthTokenInput(provider, rec); const r = find('oauth_tokens', uid, (x) => x.provider === provider);
          const next = { user_id: uid, provider, ct: t.ct, iv: t.iv, dek_ver: t.dekVer, scopes: t.scopes, status: t.status, reason: t.reason, revoke_url: t.revokeUrl, updated_at: clock() };
          if (r) Object.assign(r, next); else tables.oauth_tokens.push(next);
        },
        async setStatus(provider, status, reason = null) {
          V.need(V.PROVIDER_RE.test(provider) && V.OAUTH_STATUSES.includes(status) && (reason === null || (typeof reason === 'string' && reason.length <= 60)));
          const r = find('oauth_tokens', uid, (x) => x.provider === provider); if (!r) return false; r.status = status; r.reason = reason; r.updated_at = clock(); return true;
        },
        async del(provider) { V.need(V.PROVIDER_RE.test(provider)); return remove('oauth_tokens', (r) => r.user_id === uid && r.provider === provider) > 0; },
        async delAll() { return remove('oauth_tokens', (r) => r.user_id === uid); },
      },
      connectors: {
        async list() {
          return rows('connectors', uid).sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1)).map((c) => ({
            ...jclone(c.manifest), id: c.id, enabled: c.enabled,
            tools: rows('connector_tools', uid).filter((t) => t.connector_id === c.id).sort((a, b) => a.pos - b.pos || (a.name < b.name ? -1 : 1)).map((t) => jclone(t.def)) }));
        },
        async get(id) { V.need(V.CONNECTOR_ID_RE.test(id)); return (await this.list()).find((c) => c.id === id) || null; },
        async put(c) {
          const x = V.connectorInput(c); const cur = find('connectors', uid, (r) => r.id === x.id);
          const row = { user_id: uid, id: x.id, manifest: jclone(x.manifest), enabled: x.enabled, synced_at: x.syncedAt, created_at: cur ? cur.created_at : clock(), updated_at: clock() };
          if (cur) Object.assign(cur, row); else tables.connectors.push(row);
          const keep = new Set(x.tools.map((t) => t.name));
          remove('connector_tools', (t) => t.user_id === uid && t.connector_id === x.id && !keep.has(t.name));
          for (const t of x.tools) {
            const next = { user_id: uid, connector_id: x.id, name: t.name, def: jclone(t.def), hash: t.hash, enabled: t.enabled, approval: t.approval, expose: t.expose, pos: t.pos };
            const old = find('connector_tools', uid, (r) => r.connector_id === x.id && r.name === t.name); if (old) Object.assign(old, next); else tables.connector_tools.push(next);
          }
        },
        async del(id) { V.need(V.CONNECTOR_ID_RE.test(id)); remove('connector_tools', (t) => t.user_id === uid && t.connector_id === id); return remove('connectors', (r) => r.user_id === uid && r.id === id) > 0; },
        async delAll() { remove('connector_tools', (t) => t.user_id === uid); return remove('connectors', (r) => r.user_id === uid); },
      },
      builds: {
        async record(b) {
          const x = V.buildInput(b); let r = find('build_requests', uid, (q) => q.repo === x.repo && q.issue_number === x.issueNumber);
          if (r) Object.assign(r, { title: x.title, state: x.state, updated_at: clock() });
          else { r = { user_id: uid, id: crypto.randomUUID(), repo: x.repo, target: x.target, issue_number: x.issueNumber, pr_number: null, state: x.state, title: x.title, created_at: clock(), updated_at: clock() }; tables.build_requests.push(r); }
          return buildRow(r);
        },
        async list({ limit = 50 } = {}) { V.need(Number.isInteger(limit) && limit >= 1 && limit <= 200); return rows('build_requests', uid).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1)).slice(0, limit).map(buildRow); },
        async update(id, { state, prNumber }) {
          V.need(UUID_RE.test(id) && (state === undefined || V.BUILD_STATES.includes(state)) && (prNumber === undefined || prNumber === null || (Number.isInteger(prNumber) && prNumber >= 1)));
          const r = find('build_requests', uid, (q) => q.id === id); if (!r) return false;
          if (state !== undefined) r.state = state; if (prNumber !== undefined && prNumber !== null) r.pr_number = prNumber; r.updated_at = clock(); return true;
        },
        async del(id) { V.need(UUID_RE.test(id)); return remove('build_requests', (r) => r.user_id === uid && r.id === id) > 0; },
        async delAll() { return remove('build_requests', (r) => r.user_id === uid); },
      },
      notes: {
        async list({ folder = '', trash = false, limit = 5000 } = {}) {
          V.need(typeof folder === 'string' && folder.length <= 300 && Number.isInteger(limit) && limit >= 1 && limit <= 20000);
          const prefix = folder ? folder.replace(/^\/+|\/+$/g, '') + '/' : '';
          return rows('notes', uid).filter((n) => (n.deleted_at !== null) === (trash === true) && n.path.startsWith(prefix)).sort((a, b) => (a.path < b.path ? -1 : 1)).slice(0, limit).map(noteMeta);
        },
        async count() { return rows('notes', uid).filter((n) => n.deleted_at === null).length; },
        async get(path, { withTrashed = false } = {}) { V.notePath(path); const n = find('notes', uid, (x) => x.path === path && (withTrashed || x.deleted_at === null)); return n ? noteFull(n) : null; },
        async getById(id) { V.need(UUID_RE.test(id)); const n = find('notes', uid, (x) => x.id === id); return n ? noteFull(n) : null; },
        async put({ path, content, tags, synced = false }) {
          V.notePath(path); V.noteContent(content); const tg = V.noteTags(tags);
          const cur = find('notes', uid, (x) => x.path === path), unchanged = cur && cur.content === content;
          if (!unchanged) assertRoom(uid, Buffer.byteLength(content, 'utf8'));
          if (!cur) { const n = { user_id: uid, id: crypto.randomUUID(), path, content, tags: tg ?? [], rev: 1, pushed_rev: synced ? 1 : null, deleted_at: null, created_at: clock(), updated_at: clock() }; tables.notes.push(n); return { id: n.id, path, rev: 1, created: true, unchanged: false }; }
          if (unchanged && cur.deleted_at === null) { if (tg) cur.tags = tg; return { id: cur.id, path, rev: cur.rev, created: false, unchanged: true }; }
          if (!unchanged) {
            if (!find('note_revisions', uid, (r) => r.note_id === cur.id && r.rev === cur.rev)) tables.note_revisions.push({ user_id: uid, note_id: cur.id, rev: cur.rev, content: cur.content, at: clock() });
            const keep = new Set(rows('note_revisions', uid).filter((r) => r.note_id === cur.id).sort((a, b) => b.rev - a.rev).slice(0, V.NOTE_REVISIONS_KEPT).map((r) => r.rev));
            remove('note_revisions', (r) => r.user_id === uid && r.note_id === cur.id && !keep.has(r.rev));
          }
          const next = unchanged ? cur.rev : cur.rev + 1;
          Object.assign(cur, { content, rev: next, deleted_at: null, updated_at: clock(), tags: tg ?? cur.tags, ...(synced ? { pushed_rev: next } : {}) });
          return { id: cur.id, path, rev: next, created: false, unchanged: false };
        },
        async trash(id) { V.need(UUID_RE.test(id)); const n = find('notes', uid, (x) => x.id === id && x.deleted_at === null); if (!n) return false; n.deleted_at = clock(); return true; },
        async restore(id) { V.need(UUID_RE.test(id)); const n = find('notes', uid, (x) => x.id === id && x.deleted_at !== null); if (!n) return false; n.deleted_at = null; n.updated_at = clock(); return true; },
        async purge(id) { V.need(UUID_RE.test(id)); remove('note_revisions', (r) => r.user_id === uid && r.note_id === id); return remove('notes', (n) => n.user_id === uid && n.id === id) > 0; },
        async emptyTrash() { const ids = rows('notes', uid).filter((n) => n.deleted_at !== null).map((n) => n.id); remove('note_revisions', (r) => r.user_id === uid && ids.includes(r.note_id)); return remove('notes', (n) => n.user_id === uid && n.deleted_at !== null); },
        async delAll() { remove('note_revisions', (r) => r.user_id === uid); return remove('notes', (n) => n.user_id === uid); },
        async revisions(id) { V.need(UUID_RE.test(id)); return rows('note_revisions', uid).filter((r) => r.note_id === id).sort((a, b) => b.rev - a.rev).map((r) => ({ rev: r.rev, at: iso(r.at), bytes: Buffer.byteLength(r.content, 'utf8') })); },
        async revision(id, rev) { V.need(UUID_RE.test(id) && Number.isInteger(rev) && rev >= 0); const r = find('note_revisions', uid, (x) => x.note_id === id && x.rev === rev); return r ? { rev: r.rev, at: iso(r.at), content: r.content } : null; },
        async search(terms, { limit = 200 } = {}) {
          const t = V.searchTerms(terms).map((x) => x.toLowerCase()); V.need(Number.isInteger(limit) && limit >= 1 && limit <= 300);   // what the ILIKE candidate query does
          return rows('notes', uid).filter((n) => n.deleted_at === null && t.some((x) => n.content.toLowerCase().includes(x) || n.path.toLowerCase().includes(x))).sort((a, b) => b.updated_at - a.updated_at).slice(0, limit)
            .map((n) => ({ id: n.id, path: n.path, content: n.content.slice(0, 60000), updatedAt: iso(n.updated_at) }));
        },
        async texts({ prefix = '', limit = 300, maxChars = 60000 } = {}) {
          V.need(typeof prefix === 'string' && prefix.length <= 300 && Number.isInteger(limit) && limit >= 1 && limit <= 2000 && Number.isInteger(maxChars) && maxChars >= 1 && maxChars <= 400000);
          return rows('notes', uid).filter((n) => n.deleted_at === null && n.path.startsWith(prefix)).sort((a, b) => b.updated_at - a.updated_at || (a.path < b.path ? -1 : 1)).slice(0, limit)
            .map((n) => ({ path: n.path, content: n.content.slice(0, maxChars), updatedAt: iso(n.updated_at), bytes: Buffer.byteLength(n.content, 'utf8') }));
        },
        async unpushed({ limit = 40 } = {}) { V.need(Number.isInteger(limit) && limit >= 1 && limit <= 200); return rows('notes', uid).filter((n) => n.deleted_at === null && n.rev > (n.pushed_rev ?? 0)).sort((a, b) => a.updated_at - b.updated_at).slice(0, limit).map((n) => ({ id: n.id, path: n.path, content: n.content, rev: n.rev })); },
        async unpushedCount() { return rows('notes', uid).filter((n) => n.deleted_at === null && n.rev > (n.pushed_rev ?? 0)).length; },
        async markPushed(id, rev) { V.need(UUID_RE.test(id) && Number.isInteger(rev) && rev >= 0); const n = find('notes', uid, (x) => x.id === id && x.rev >= rev); if (!n) return false; n.pushed_rev = rev; return true; },
      },
      messages: {
        async append({ turns, channel = 'voice', gapSec = 1800 }) {
          const t = V.messageTurns(turns); V.need(V.CHANNELS.includes(channel) && Number.isInteger(gapSec) && gapSec >= 1 && gapSec <= 86400);
          const gap = gapSec * 1000; assertRoom(uid, t.reduce((a, x) => a + Buffer.byteLength(x.text, 'utf8'), 0));
          let cid = null;
          for (const run of V.splitRuns(t, gap)) {
            const first = run[0].at, last = run[run.length - 1].at;
            let c = rows('conversations', uid).filter((x) => x.channel === channel && x.last_at >= first - gap && x.started_at <= last + gap).sort((a, b) => b.last_at - a.last_at)[0];
            if (!c) { c = { user_id: uid, id: crypto.randomUUID(), channel, started_at: first, last_at: last }; tables.conversations.push(c); }
            for (const m of run) tables.messages.push({ user_id: uid, id: ++auditSeq, conversation_id: c.id, role: m.role, text: m.text, at: m.at });
            c.last_at = Math.max(c.last_at, last); c.started_at = Math.min(c.started_at, first); cid = c.id;
          }
          return { conversationId: cid, added: t.length };
        },
        async conversations({ limit = 50, before = null } = {}) {
          V.need(Number.isInteger(limit) && limit >= 1 && limit <= 200 && (before === null || (typeof before === 'string' && !Number.isNaN(Date.parse(before)))));
          const b = before ? Date.parse(before) : Infinity;
          return rows('conversations', uid).filter((c) => c.last_at < b).sort((a, c) => c.last_at - a.last_at || (a.id < c.id ? -1 : 1)).slice(0, limit).map((c) => {
            const ms = rows('messages', uid).filter((m) => m.conversation_id === c.id).sort((x, y) => x.id - y.id);
            return convRow({ ...c, n: ms.length, preview: ms.find((m) => m.role === 'user')?.text.slice(0, 80) ?? null });
          });
        },
        async conversation(id, { limit = 1000 } = {}) {
          V.need(UUID_RE.test(id) && Number.isInteger(limit) && limit >= 1 && limit <= 5000);
          const c = find('conversations', uid, (x) => x.id === id); if (!c) return null;
          const ms = rows('messages', uid).filter((m) => m.conversation_id === id).sort((a, b) => a.at - b.at || a.id - b.id).slice(0, limit);
          return { ...convRow({ ...c, n: ms.length }), messages: ms.map(msgRow) };
        },
        async list({ q = null, since = null, until = null, limit = 100 } = {}) {
          V.need(Number.isInteger(limit) && limit >= 1 && limit <= 2000 && (since === null || !Number.isNaN(Date.parse(since))) && (until === null || !Number.isNaN(Date.parse(until))));
          let ms = rows('messages', uid);
          if (q) { const t = V.searchTerms(String(q).split(/\s+/).filter(Boolean), 8).map((x) => x.toLowerCase()); ms = ms.filter((m) => t.some((x) => m.text.toLowerCase().includes(x))); limit = Math.min(limit, 200); }
          else { if (since) ms = ms.filter((m) => m.at >= Date.parse(since)); if (until) ms = ms.filter((m) => m.at < Date.parse(until)); }
          return ms.sort((a, b) => b.at - a.at || b.id - a.id).slice(0, limit).map(msgRow);
        },
        async count() { return rows('messages', uid).length; },
        async del(id) { V.need(/^\d{1,18}$/.test(String(id))); return remove('messages', (m) => m.user_id === uid && m.id === Number(id)) > 0; },
        async delConversation(id) { V.need(UUID_RE.test(id)); remove('messages', (m) => m.user_id === uid && m.conversation_id === id); return remove('conversations', (c) => c.user_id === uid && c.id === id) > 0; },
        async purge({ before = null } = {}) {
          V.need(before === null || (typeof before === 'string' && !Number.isNaN(Date.parse(before))));
          const b = before ? Date.parse(before) : Infinity;
          const n = remove('messages', (m) => m.user_id === uid && m.at < b);
          remove('conversations', (c) => c.user_id === uid && !tables.messages.some((m) => m.user_id === uid && m.conversation_id === c.id));
          return n;
        },
      },
      inbox: {
        async list({ limit = 40 } = {}) { V.need(Number.isInteger(limit) && limit >= 1 && limit <= V.INBOX_MAX_ITEMS); return rows('inbox_items', uid).sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1)).slice(0, limit).map(inboxRow); },
        async add(item) {
          const x = V.inboxInput(item); let r = x.key ? find('inbox_items', uid, (q) => q.key === x.key) : null;
          if (r) Object.assign(r, { kind: x.kind, title: x.title, body: x.body, url: x.url, note_path: x.notePath, at: clock(), read_at: null });
          else { r = { user_id: uid, id: crypto.randomUUID(), kind: x.kind, title: x.title, body: x.body, url: x.url, note_path: x.notePath, key: x.key, at: clock(), read_at: null }; tables.inbox_items.push(r); }
          const keep = new Set(rows('inbox_items', uid).sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1)).slice(0, V.INBOX_MAX_ITEMS).map((q) => q.id));
          remove('inbox_items', (q) => q.user_id === uid && !keep.has(q.id));
          return inboxRow(r);
        },
        async markRead(id) { V.need(UUID_RE.test(id)); const r = find('inbox_items', uid, (x) => x.id === id); if (!r) return false; r.read_at ??= clock(); return true; },
        async markAllRead() { let n = 0; for (const r of rows('inbox_items', uid)) if (r.read_at === null) { r.read_at = clock(); n++; } return n; },
        async del(id) { V.need(UUID_RE.test(id)); return remove('inbox_items', (r) => r.user_id === uid && r.id === id) > 0; },
        async delAll() { return remove('inbox_items', (r) => r.user_id === uid); },
      },
      notif: {
        async push(items, { now = clock() } = {}) {
          V.need(Array.isArray(items));
          const ok = items.slice(0, 50).map((x) => { try { return V.notifItem(x); } catch { return null; } }).filter(Boolean);
          if (!ok.length) return { stored: 0 };
          remove('notif_items', (r) => r.user_id === uid && r.at < now - V.NOTIF_KEEP_MS);
          for (const x of ok) if (!find('notif_items', uid, (r) => r.id === x.id)) tables.notif_items.push({ user_id: uid, id: x.id, at: Math.min(x.at, now + 60_000), iv: x.iv, ct: x.ct });
          const keep = new Set(rows('notif_items', uid).sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1)).slice(0, V.NOTIF_MAX_ITEMS).map((r) => r.id));
          remove('notif_items', (r) => r.user_id === uid && !keep.has(r.id));
          return { stored: ok.length };
        },
        async pull({ since = 0, now = clock() } = {}) {
          V.need(Number.isFinite(since) && since >= 0);
          remove('notif_items', (r) => r.user_id === uid && r.at < now - V.NOTIF_KEEP_MS);
          return rows('notif_items', uid).filter((r) => r.at >= since).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)).slice(0, 100).map((r) => ({ id: r.id, at: r.at, iv: r.iv, ct: r.ct }));
        },
        async clear() { return remove('notif_items', (r) => r.user_id === uid); },
        async count() { return rows('notif_items', uid).filter((r) => r.at >= clock() - V.NOTIF_KEEP_MS).length; },
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
    for (const s of [...tables.user_secrets, ...tables.oauth_tokens]) if (s.user_id === uid && (!key || key.dek_ver !== s.dek_ver)) throw dbError('invalid_reference', 409);
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
        // P4 (migration 14): the same sweeps as app.purge_expired()
        notif_items: remove('notif_items', (r) => r.at <= clock() - 3 * 864e5),
        note_revisions: remove('note_revisions', (r) => r.at <= clock() - 90 * 864e5),
        notes: remove('notes', (r) => r.deleted_at !== null && r.deleted_at <= clock() - 30 * 864e5),
        messages: remove('messages', (m) => { const s = tables.settings.find((x) => x.user_id === m.user_id)?.settings?.MESSAGE_RETENTION_DAYS, d = /^[0-9]{1,5}$/.test(String(s ?? '')) ? Number(s) : 180; return d > 0 && m.at < clock() - d * 864e5; }),
        conversations: remove('conversations', (c) => c.last_at < clock() - 864e5 && !tables.messages.some((m) => m.user_id === c.user_id && m.conversation_id === c.id)),
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
    async oauthPendingOwner(stateHash, provider) { V.need(V.isBytes(stateHash, 32) && V.OAUTH_FLOW_KINDS.includes(provider)); const r = tables.oauth_pending.find((x) => sameBytes(x.state_hash, stateHash) && x.provider === provider && live(x)); return r ? r.user_id : null; },
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
      setQuota(uid, bytes) { const r = find('accounts', uid) || (tables.accounts.push({ user_id: uid, status: 'active', storage_quota_bytes: DEFAULT_QUOTA, hard_limits: {}, suspended_reason: null, created_at: clock() }), find('accounts', uid)); r.storage_quota_bytes = bytes; },
      setAccountStatus(uid, status) { const r = find('accounts', uid); if (r) r.status = status; },
      makeAdmin(uid) { if (!find('admins', uid)) tables.admins.push({ user_id: uid, granted_by: null, granted_at: clock() }); },
      advance(ms) { offset += ms; },
      now: () => clock(),
      /** A Map-like synchronous view of one user's live notes ({ text } by path) for tests: get / has / set / keys / delete. set() writes the row directly (no quota, no revision). */
      notesView(uid) {
        const live = () => tables.notes.filter((n) => n.user_id === uid && n.deleted_at === null);
        return {
          get: (p) => { const n = live().find((x) => x.path === p); return n ? { text: n.content, rev: n.rev } : undefined; },
          has: (p) => live().some((x) => x.path === p),
          keys: () => live().map((n) => n.path)[Symbol.iterator](),
          set: (p, v) => { const n = tables.notes.find((x) => x.user_id === uid && x.path === p); const text = typeof v === 'string' ? v : v.text, at = (typeof v === 'object' && v.at) || clock(); if (n) Object.assign(n, { content: text, deleted_at: null, rev: n.rev + 1, updated_at: at }); else tables.notes.push({ user_id: uid, id: crypto.randomUUID(), path: p, content: text, tags: [], rev: 1, pushed_rev: null, deleted_at: null, created_at: at, updated_at: at }); },
          delete: (p) => remove('notes', (n) => n.user_id === uid && n.path === p) > 0,
          [Symbol.iterator]() { return live().map((n) => [n.path, { text: n.content }])[Symbol.iterator](); },
          get size() { return live().length; },
        };
      },
    },
  };
}
