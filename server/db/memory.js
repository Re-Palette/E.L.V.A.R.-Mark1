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
import { PAGED, pageRow, keyOf } from '../rights/export-pages.js';
import { envMaxFileBytes } from '../config/platform-limits.js';

const DEFAULT_QUOTA = 524288000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const iso = (ms) => new Date(ms).toISOString();
const exportRow = (j) => ({ id: j.id, status: j.status, cursor: structuredClone(j.cursor ?? null), parts: j.parts, bytes: j.bytes, createdAt: iso(j.created_at), expiresAt: j.expires_at ? iso(j.expires_at) : null, error: j.error ?? null, updatedAt: iso(j.updated_at) });
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
  let platformMaxFile = envMaxFileBytes() ?? V.FILE_MAX_BYTES, platformMaxTotal = null, platformMaxAccounts = null;   // platform_config: max_file_bytes, max_total_storage_bytes, max_accounts   // app.platform_config max_file_bytes (migration 20)
  const ownerOf = (t) => REGISTRY.find((e) => e.table === t).ownerColumn;

  const rows = (t, uid) => tables[t].filter((r) => r[ownerOf(t)] === uid);
  const find = (t, uid, pred = () => true) => tables[t].find((r) => r.user_id === uid && pred(r));
  const remove = (t, pred) => { const n = tables[t].length; tables[t] = tables[t].filter((r) => !pred(r)); return n - tables[t].length; };
  const live = (r) => r.expires_at > clock();
  // the same figures as the triggers of migration 07 keep in app.storage_usage: files (ready + deleting), reserved uploads, extracted texts, notes + revisions, messages
  const size = (t) => Buffer.byteLength(t, 'utf8');
  const sumOf = (list, f) => list.reduce((x, r) => x + f(r), 0);
  const usageOf = (uid) => {
    const fl = rows('files', uid);
    return { filesBytes: sumOf(fl.filter((f) => f.status !== 'pending'), (f) => f.size_bytes), reservedBytes: sumOf(fl.filter((f) => f.status === 'pending'), (f) => f.reserved_bytes),
      textBytes: sumOf(rows('file_texts', uid), (t) => size(t.text)), notesBytes: sumOf(rows('notes', uid), (n) => size(n.content)) + sumOf(rows('note_revisions', uid), (n) => size(n.content)),
      messagesBytes: sumOf(rows('messages', uid), (m) => size(m.text)) };
  };
  const usedTotal = (u) => u.filesBytes + u.reservedBytes + u.textBytes + u.notesBytes + u.messagesBytes;
  /** Keep the storage_usage row in step (what the triggers do); created once the user has any counted byte. */
  const syncUsage = (uid) => {
    const u = usageOf(uid), cur = find('storage_usage', uid), row = { files_bytes: u.filesBytes, text_bytes: u.textBytes, notes_bytes: u.notesBytes, messages_bytes: u.messagesBytes, reserved_bytes: u.reservedBytes };
    if (cur) { const changed = Object.entries(row).some(([k, v]) => cur[k] !== v); Object.assign(cur, row); return changed; }
    if (usedTotal(u) > 0 && users.has(uid)) tables.storage_usage.push({ user_id: uid, ...row });
    return false;
  };
  // the same rule as the Postgres repos: everything that counts must stay within the account's storage quota (default 500 MB)
  const assertRoom = (uid, grow) => {
    const a = find('accounts', uid), quota = a ? a.storage_quota_bytes : DEFAULT_QUOTA;
    if (usedTotal(usageOf(uid)) + grow > quota) throw dbError('storage_quota_exceeded', 413);
  };
  const fileRow = (f) => ({
    id: f.id, name: f.name, mime: f.mime, kind: f.kind, size: f.size_bytes, sha256: f.sha256, status: f.status, source: f.source, objectPath: f.object_path,
    title: f.title, docKind: f.doc_kind, kindLabel: f.kind_label, tags: [...f.tags], memo: f.memo, keywords: [...f.keywords], snippet: f.snippet, analysis: clone(f.analysis),
    related: f.related === null ? null : clone(f.related), reservedUntil: f.reserved_until === null ? null : iso(f.reserved_until), createdAt: iso(f.created_at),
    finalizedAt: f.finalized_at === null ? null : iso(f.finalized_at), updatedAt: iso(f.updated_at),
  });
  const STALE_GRACE_MS = 5 * 60_000;

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
              callsToday: sum((r) => r.day === day && r.metric === 'calls'), liveSecondsToday: sum((r) => r.day === day && r.metric === 'live_seconds'), calls30d: sum((r) => r.day >= since && r.metric === 'calls' && r.provider !== 'tool'),
              hardLimits: clone(a?.hard_limits || {}), suspendedReason: a?.suspended_reason ?? null };
          });
        },
        /** The hard limits of one user: the same catalog and rules as app.admin_set_limits (migration 18). */
        async setLimits(userId, limits) {
          if (!find('admins', uid)) throw dbError('forbidden', 403);
          V.need(typeof userId === 'string' && UUID_RE.test(userId) && limits && typeof limits === 'object' && !Array.isArray(limits) && Object.keys(limits).length <= 20);
          if (!users.has(userId)) throw dbError('not_found', 404);
          let a = tables.accounts.find((r) => r.user_id === userId);
          if (!a) { a = { user_id: userId, status: 'active', storage_quota_bytes: DEFAULT_QUOTA, hard_limits: {}, suspended_reason: null, created_at: clock() }; tables.accounts.push(a); }
          const from = clone(a.hard_limits || {}), next = { ...from };
          for (const [k, v] of Object.entries(limits)) {
            V.need(V.HARD_LIMIT_KEYS.includes(k));
            if (v === null) delete next[k];
            else { V.need(Number.isInteger(v) && v >= 0 && v <= 2000000000 && (k !== 'maxFileBytes' || v <= V.FILE_MAX_BYTES)); next[k] = v; }
          }
          a.hard_limits = next;
          tables.audit_log.push({ user_id: userId, id: ++auditSeq, at: clock(), actor: 'admin', actor_id: uid, action: 'account.limits_changed', target: null, meta: { from, to: clone(next) } });
          return clone(next);
        },
        async userUsage(userId, days = 14) {
          if (!find('admins', uid)) throw dbError('forbidden', 403);
          V.need(typeof userId === 'string' && UUID_RE.test(userId) && Number.isInteger(days) && days >= 1 && days <= 60);
          if (!users.has(userId)) throw dbError('not_found', 404);
          const since = new Date(clock() - (days - 1) * 86400_000).toISOString().slice(0, 10);
          return tables.usage_daily.filter((r) => r.user_id === userId && r.day >= since && r.provider !== 'tool').sort((a, b) => `${a.day}|${a.provider}|${a.metric}`.localeCompare(`${b.day}|${b.provider}|${b.metric}`)).map((r) => ({ day: r.day, provider: r.provider, metric: r.metric, amount: r.amount }));
        },
        async setQuota(userId, bytes) {
          if (!find('admins', uid)) throw dbError('forbidden', 403);
          V.need(typeof userId === 'string' && UUID_RE.test(userId) && Number.isInteger(bytes) && bytes >= 0 && bytes <= 1099511627776);
          if (!users.has(userId)) throw dbError('not_found', 404);
          let a = tables.accounts.find((r) => r.user_id === userId);
          if (!a) { a = { user_id: userId, status: 'active', storage_quota_bytes: DEFAULT_QUOTA, hard_limits: {}, suspended_reason: null, created_at: clock() }; tables.accounts.push(a); }
          const from = a.storage_quota_bytes; a.storage_quota_bytes = bytes;
          tables.audit_log.push({ user_id: userId, id: ++auditSeq, at: clock(), actor: 'admin', actor_id: uid, action: 'account.quota_changed', target: null, meta: { from, to: bytes } });
          return bytes;
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
      exportJobs: {
        async list() { return rows('export_jobs', uid).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1)).slice(0, 20).map(exportRow); },
        async get(id) { V.need(UUID_RE.test(String(id))); const j = find('export_jobs', uid, (x) => x.id === id); return j ? exportRow(j) : null; },
      },
      rights: {
        /** The same keyset pager as the Postgres one (server/rights/export-pages.js). */
        async exportPage(table, { after = null, limit = null } = {}) {
          const spec = PAGED[table]; V.need(spec); const n = limit ?? spec.page;
          V.need(Number.isInteger(n) && n >= 1 && n <= 2000 && (after === null || (Array.isArray(after) && after.length === spec.key.length && after.every((x) => typeof x === 'string' && x.length <= 300))));
          const cmp = (a, b) => { for (const [c, t] of spec.key) { const num = ['int', 'bigint'].includes(t), x = num ? Number(a[c]) : String(a[c]), y = num ? Number(b[c]) : String(b[c]); if (x < y) return -1; if (x > y) return 1; } return 0; };
          const cursor = after ? Object.fromEntries(spec.key.map(([c], i) => [c, after[i]])) : null;
          const all = rows(table, uid).sort(cmp).filter((r) => !cursor || cmp(r, cursor) > 0), page = all.slice(0, n);
          return { rows: page.map((r) => pageRow(table, clone(r))), next: page.length === n ? keyOf(table, page.at(-1)) : null };
        },
        async counts() { return Object.fromEntries(REGISTRY.map((e) => [e.table, ['rate_limits', 'admins'].includes(e.table) ? 0 : tables[e.table].filter((r) => r[e.ownerColumn] === uid).length])); } },   // like the database: the user cannot read these two tables at all
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
      /** The file vault (P5): the same rules as the Postgres functions of migration 07. */
      files: {
        async reserve(x) {
          const v = V.fileReserveInput(x);
          if (!users.has(uid)) throw dbError('invalid_reference', 409);
          let a = find('accounts', uid);
          if (!a) { a = { user_id: uid, status: 'active', storage_quota_bytes: DEFAULT_QUOTA, hard_limits: {}, suspended_reason: null, created_at: clock() }; tables.accounts.push(a); }
          if (a.status !== 'active') throw dbError('conflict', 409);
          const hl = a.hard_limits?.maxFileBytes, maxf = Math.min(platformMaxFile, typeof hl === 'number' && hl >= 0 ? hl : platformMaxFile);
          if (v.size > maxf) throw dbError('file_too_large', 413);
          if (!v.allowDuplicate) { const d = rows('files', uid).filter((f) => f.sha256 === v.sha256 && f.status === 'ready').sort((p, q) => p.created_at - q.created_at)[0]; if (d) return { duplicate: { id: d.id, name: d.name } }; }
          if (rows('files', uid).filter((f) => f.status === 'pending' && f.reserved_until > clock()).length >= 20) throw dbError('conflict', 409);
          if (usedTotal(usageOf(uid)) + v.size + v.textBytes > a.storage_quota_bytes) throw dbError('storage_quota_exceeded', 413);
          if (platformMaxTotal !== null && [...users].reduce((s, id) => s + usedTotal(usageOf(id)), 0) + v.size + v.textBytes > platformMaxTotal) throw dbError('platform_storage_full', 413);
          const id = crypto.randomUUID(), objectPath = `users/${uid}/files/${id}/${v.sha256}`, until = clock() + V.FILE_RESERVE_MINUTES * 60_000;
          tables.files.push({ user_id: uid, id, name: v.name, mime: v.mime, kind: v.kind, size_bytes: v.size, sha256: v.sha256, object_path: objectPath, status: 'pending', reserved_bytes: v.size + v.textBytes,
            reserved_until: until, source: v.source, title: null, doc_kind: null, kind_label: null, tags: [], memo: '', keywords: [], snippet: '', analysis: {}, related: null, created_at: clock(), finalized_at: null, updated_at: clock() });
          return { fileId: id, objectPath, reservedUntil: iso(until) };
        },
        async finalize(id, input) {
          V.need(V.FILE_ID_RE.test(String(id))); const v = V.fileFinalizeInput(input); V.need(Number.isInteger(input?.size) && input.size >= 1);
          const f = find('files', uid, (r) => r.id === id); if (!f) throw dbError('not_found', 404);
          if (f.status === 'ready') return;
          if (f.status !== 'pending' || f.reserved_until === null || f.reserved_until < clock()) throw dbError('reservation_expired', 409);
          if (input.size !== f.size_bytes) throw dbError('file_too_large', 413);
          const tb = size(v.text); if (tb > f.reserved_bytes - f.size_bytes) throw dbError('storage_quota_exceeded', 413);
          Object.assign(f, { status: 'ready', finalized_at: clock(), reserved_until: null, updated_at: clock(), title: v.title ?? null, doc_kind: v.docKind ?? null, keywords: v.keywords ?? [], snippet: v.snippet ?? '', analysis: clone(v.analysis ?? {}), related: v.related ?? null });
          if (tb > 0) { remove('file_texts', (t) => t.user_id === uid && t.file_id === id); tables.file_texts.push({ user_id: uid, file_id: id, text: v.text }); }
        },
        async patch(id, patch, { text = null, setText = false } = {}) {
          V.need(V.FILE_ID_RE.test(String(id))); const p = V.filePatchInput(patch); if (setText) V.fileText(text ?? '');
          const f = find('files', uid, (r) => r.id === id && r.status === 'ready'); if (!f) throw dbError('not_found', 404);
          if (setText) {
            const old = find('file_texts', uid, (t) => t.file_id === id), oldB = old ? size(old.text) : 0, nb = size(text ?? '');
            const a = find('accounts', uid), quota = a ? a.storage_quota_bytes : DEFAULT_QUOTA;
            if (nb > oldB && usedTotal(usageOf(uid)) + (nb - oldB) > quota) throw dbError('storage_quota_exceeded', 413);
            remove('file_texts', (t) => t.user_id === uid && t.file_id === id); if (nb > 0) tables.file_texts.push({ user_id: uid, file_id: id, text });
          }
          if (p.name !== undefined) f.name = p.name;
          if (p.tags !== undefined) f.tags = p.tags;
          if (p.memo !== undefined) f.memo = p.memo;
          if (p.kindLabel !== undefined) f.kind_label = p.kindLabel || null;
          if (p.title !== undefined) f.title = p.title;
          if (p.docKind !== undefined) f.doc_kind = p.docKind;
          if (p.keywords !== undefined) f.keywords = p.keywords;
          if (p.snippet !== undefined) f.snippet = p.snippet;
          if (p.related !== undefined) f.related = p.related;
          if (p.analysis !== undefined) f.analysis = { ...f.analysis, ...clone(p.analysis) };
          f.updated_at = clock();
        },
        async get(id) { V.need(V.FILE_ID_RE.test(String(id))); const f = find('files', uid, (r) => r.id === id); return f ? fileRow(f) : null; },
        async list({ limit = 5000 } = {}) { V.need(Number.isInteger(limit) && limit >= 1 && limit <= 20000); return rows('files', uid).filter((f) => f.status === 'ready').sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1)).slice(0, limit).map(fileRow); },
        async findBySha(sha) { V.need(V.isSha256(sha)); const f = rows('files', uid).filter((r) => r.sha256 === sha && r.status === 'ready').sort((a, b) => a.created_at - b.created_at)[0]; return f ? fileRow(f) : null; },
        async text(id) { V.need(V.FILE_ID_RE.test(String(id))); const f = find('files', uid, (r) => r.id === id && r.status === 'ready'); const t = f && find('file_texts', uid, (x) => x.file_id === id); return t ? t.text : null; },
        async searchText(terms, { limit = 200 } = {}) {
          const t = V.searchTerms(terms).map((x) => x.toLowerCase()); V.need(Number.isInteger(limit) && limit >= 1 && limit <= 300);
          const out = new Map();
          for (const f of rows('files', uid).filter((r) => r.status === 'ready')) { const x = find('file_texts', uid, (r) => r.file_id === f.id); if (x && t.some((w) => x.text.toLowerCase().includes(w))) { out.set(f.id, x.text.slice(0, 200000)); if (out.size >= limit) break; } }
          return out;
        },
        async count() { return rows('files', uid).filter((f) => f.status === 'ready').length; },
        async beginDelete(id) { V.need(V.FILE_ID_RE.test(String(id))); const f = find('files', uid, (r) => r.id === id); if (!f) return null; f.status = 'deleting'; f.reserved_until = null; f.updated_at = clock(); return f.object_path; },
        async finishDelete(id) {
          V.need(V.FILE_ID_RE.test(String(id)));
          return remove('files', (f) => f.user_id === uid && f.id === id && (f.status === 'deleting' || (f.status === 'pending' && (f.reserved_until === null || f.reserved_until < clock())))) > 0 && (remove('file_texts', (t) => t.user_id === uid && t.file_id === id), true);   // the text cascades
        },
        async stale() { return rows('files', uid).filter((f) => f.status === 'deleting' || (f.status === 'pending' && f.reserved_until < clock())).map((f) => ({ id: f.id, objectPath: f.object_path })); },
        async allPaths() { return rows('files', uid).map((f) => ({ id: f.id, objectPath: f.object_path })); },
      },

      usage: {
        async record({ provider, metric, amount = 1, source = 'server', day: userDay = null }) {
          V.need(typeof provider === 'string' && provider.length >= 1 && provider.length <= 40 && typeof metric === 'string' && metric.length >= 1 && metric.length <= 40
            && Number.isFinite(amount) && amount >= 0 && amount <= 1e9 && ['server', 'client'].includes(source) && (userDay === null || /^\d{4}-\d{2}-\d{2}$/.test(userDay)));
          if (!users.has(uid)) throw dbError('invalid_reference', 409);
          const dbDay = new Date(clock()).toISOString().slice(0, 10), within = (x) => Math.abs(Date.parse(x) - Date.parse(dbDay)) <= 86400_000;   // like the function: the database date +-1 day
          if (userDay !== null && !within(userDay)) throw dbError('invalid_value', 400);
          tables.usage_events.push({ user_id: uid, id: ++auditSeq, at: clock(), provider, metric, amount, source, meta: null });
          const day = userDay ?? dbDay; const d = tables.usage_daily.find((r) => r.user_id === uid && r.day === day && r.provider === provider && r.metric === metric);
          if (d) d.amount += amount; else tables.usage_daily.push({ user_id: uid, day, provider, metric, amount });
        },
        async daily({ from, to }) { return rows('usage_daily', uid).filter((r) => r.day >= from && r.day <= to).sort((a, b) => `${a.day}|${a.provider}|${a.metric}`.localeCompare(`${b.day}|${b.provider}|${b.metric}`)).map((r) => ({ day: r.day, provider: r.provider, metric: r.metric, amount: r.amount })); },
        async storage() { return usageOf(uid); },
      },
    };
  }
  let auditSeq = 0, signupMode = 'open';
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
    // P7: export jobs (progress is written only here; the same rules as migration 19)
    async createExportJob(vuid) {
      const u = requireVerifiedUid(vuid); if (!users.has(u)) throw dbError('not_found', 404);
      if (tables.export_jobs.some((j) => j.user_id === u && ['queued', 'running'].includes(j.status))) throw dbError('conflict', 409);
      const id = crypto.randomUUID(); tables.export_jobs.push({ user_id: u, id, status: 'queued', cursor: null, parts: 0, bytes: 0, created_at: clock(), expires_at: null, error: null, updated_at: clock() });
      tables.audit_log.push({ user_id: u, id: ++auditSeq, at: clock(), actor: 'user', actor_id: u, action: 'export.requested', target: id, meta: null });
      return id;
    },
    async updateExportJob(vuid, id, { status, cursor = null, parts = 0, bytes = 0, error = null, expiresAt = null }) {
      const u = requireVerifiedUid(vuid); V.need(UUID_RE.test(id) && ['running', 'done', 'failed'].includes(status) && Number.isInteger(parts) && parts >= 0 && Number.isFinite(bytes) && bytes >= 0);
      const j = tables.export_jobs.find((x) => x.user_id === u && x.id === id && ['queued', 'running'].includes(x.status)); if (!j) return false;
      Object.assign(j, { status, cursor: clone(cursor), parts, bytes, error: error ? String(error).slice(0, 500) : null, updated_at: clock(), ...(status === 'done' ? { expires_at: expiresAt ? new Date(expiresAt).getTime() : null } : {}) });
      if (status === 'done') tables.audit_log.push({ user_id: u, id: ++auditSeq, at: clock(), actor: 'system', actor_id: null, action: 'export.completed', target: id, meta: { parts, bytes } });
      return true;
    },
    async expiredExportJobs(limit = 100) {
      V.need(Number.isInteger(limit) && limit >= 1 && limit <= 500);
      for (const j of tables.export_jobs) if (['queued', 'running'].includes(j.status) && j.updated_at < clock() - 30 * 60_000) { j.status = 'failed'; j.error = 'stalled'; j.updated_at = clock(); }
      return tables.export_jobs.filter((j) => (j.status === 'done' && j.expires_at <= clock()) || (['failed', 'expired'].includes(j.status) && j.updated_at < clock() - 2 * 864e5)).slice(0, limit).map((j) => ({ userId: j.user_id, id: j.id }));
    },
    async dropExportJob(userId, id) { V.need(UUID_RE.test(userId) && UUID_RE.test(id)); return remove('export_jobs', (j) => j.user_id === userId && j.id === id) > 0; },
    async staleFiles(limit = 200) {
      V.need(Number.isInteger(limit) && limit >= 1 && limit <= 1000);
      return tables.files.filter((f) => f.status === 'deleting' || (f.status === 'pending' && f.reserved_until < clock() - STALE_GRACE_MS)).sort((a, b) => a.updated_at - b.updated_at).slice(0, limit).map((f) => ({ userId: f.user_id, id: f.id, objectPath: f.object_path }));
    },
    async dropStaleFile(userId, id) {
      V.need(UUID_RE.test(userId) && UUID_RE.test(id));
      const n = remove('files', (f) => f.user_id === userId && f.id === id && (f.status === 'deleting' || (f.status === 'pending' && f.reserved_until < clock() - STALE_GRACE_MS)));
      if (n) { remove('file_texts', (t) => t.user_id === userId && t.file_id === id); syncUsage(userId); }   // the trigger of the real database
      return n > 0;
    },
    async reconcileStorage() { let n = 0; for (const r of [...tables.storage_usage]) if (syncUsage(r.user_id)) n++; return n; },
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
        // P6 (migration 18): raw usage events 90 days, daily totals 2 years
        usage_events: remove('usage_events', (r) => r.at <= clock() - 90 * 864e5), usage_daily: remove('usage_daily', (r) => r.day <= new Date(clock() - 730 * 864e5).toISOString().slice(0, 10)),
      };
    },
    async residualCheck(vuid) {
      const uid = requireVerifiedUid(vuid);
      return REGISTRY.map((e) => ({ table: e.table, n: tables[e.table].filter((r) => r[e.ownerColumn] === uid || (e.table === 'rate_limits' && (r.who === `u:${uid}` || r.who === uid))).length })).sort((a, b) => (a.table < b.table ? -1 : 1)); },
    async dueDeletions(limit = 20) { return tables.deletion_requests.filter((r) => r.purge_after <= clock()).sort((a, b) => a.purge_after - b.purge_after).slice(0, Math.max(1, Math.min(limit, 200))).map((r) => ({ userId: r.user_id, graceDays: r.grace_days, email: r.email_for_receipt ?? null })); },
    async recordReceipt(tablesChecked) { V.need(Number.isInteger(tablesChecked) && tablesChecked >= 0); receipts.push({ completedAt: clock(), tablesChecked }); },
    async bootstrapAdmin(email) {
      V.need(typeof email === 'string' && email.length >= 3 && email.length <= 320);
      const u = [...users].map((id) => ({ id, ...(profilesOfUsers.get(id) || {}) })).find((x) => x.email && x.email.toLowerCase() === email.trim().toLowerCase() && x.confirmed !== false); if (!u) return null;
      if (!tables.accounts.find((r) => r.user_id === u.id)) tables.accounts.push({ user_id: u.id, status: 'active', storage_quota_bytes: DEFAULT_QUOTA, hard_limits: {}, suspended_reason: null, created_at: clock() });
      if (!tables.admins.find((r) => r.user_id === u.id)) tables.admins.push({ user_id: u.id, granted_by: null, granted_at: clock() });
      return u.id;
    },
    async oauthPendingOwner(stateHash, provider) { V.need(V.isBytes(stateHash, 32) && V.OAUTH_FLOW_KINDS.includes(provider)); const r = tables.oauth_pending.find((x) => sameBytes(x.state_hash, stateHash) && x.provider === provider && live(x)); return r ? r.user_id : null; },
    async signupMode() { return signupMode; },
    async accountCount() { return tables.accounts.length; },
    async existingUsers(ids) { V.need(Array.isArray(ids) && ids.length <= 1000 && ids.every((x) => UUID_RE.test(x))); return ids.filter((x) => users.has(x)); },
    async maxFileBytes() { return platformMaxFile; },
    async setMaxFileBytes(n) { V.need(Number.isInteger(n) && n >= 1048576); platformMaxFile = Math.min(n, V.FILE_MAX_BYTES); return platformMaxFile; },
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
        syncUsage(uid);            // what the storage triggers keep up to date
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
      setHardLimits(uid, limits) { const r = find('accounts', uid) || (tables.accounts.push({ user_id: uid, status: 'active', storage_quota_bytes: DEFAULT_QUOTA, hard_limits: {}, suspended_reason: null, created_at: clock() }), find('accounts', uid)); r.hard_limits = clone(limits); },
      setAccountStatus(uid, status) { const r = find('accounts', uid); if (r) r.status = status; },
      makeAdmin(uid) { if (!find('admins', uid)) tables.admins.push({ user_id: uid, granted_by: null, granted_at: clock() }); },
      advance(ms) { offset += ms; },
      /** What the Storage policy files_upload asks the database: does this user have a live reservation for exactly this path? */
      hasReservation: (uid, path) => find('accounts', uid)?.status === 'active' && tables.files.some((f) => f.user_id === uid && f.object_path === path && f.status === 'pending' && f.reserved_until > clock()),
      /** What the Storage policies files_read / files_delete ask the database about an object path of this user: the status of its row, and whether the reservation has run out. */
      fileState: (uid, path) => { const f = tables.files.find((x) => x.user_id === uid && x.object_path === path); return f ? { status: f.status, expired: f.reserved_until === null || f.reserved_until < clock() } : null; },
      usage: (uid) => usageOf(uid),
      now: () => clock(),
      setSignupMode(m) { signupMode = m; },
      /** platform_config limits for tests: { maxTotalStorageBytes, maxAccounts } (null = none). */
      setPlatformCaps({ maxTotalStorageBytes = null, maxAccounts = null } = {}) { platformMaxTotal = maxTotalStorageBytes; platformMaxAccounts = maxAccounts; },
      /** What the Auth hook answers for a sign-up now (the account cap): null = allowed. */
      signupDenied() { return platformMaxAccounts !== null && users.size >= platformMaxAccounts ? 'full' : null; },
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
