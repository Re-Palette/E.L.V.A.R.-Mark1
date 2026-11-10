// All SQL of the user-facing repositories lives here (and nowhere else). `tx` is a transaction that asUser() already switched to the
// `authenticated` role with the user's claims, so Row Level Security applies; every statement still names user_id (defence in depth, and it
// lets Postgres use the user_id-first indexes).
//
// MemoryDb (server/db/memory.js) implements the same interface; test/contracts/db.contract.mjs runs against both.
// Values leave this module as plain JS: timestamps as ISO strings, bigint as numbers, bytea as Buffers.
import { dbError, mapPgError, isDriverError } from '../errors.js';
import * as V from '../validate.js';
import { requireVerifiedUid } from '../verified-uid.js';
import { REGISTRY } from '../../rights/registry.js';
import { PAGED, pageRow, keyOf } from '../../rights/export-pages.js';
const guardedSys = async (_sql, fn) => { try { return await fn(); } catch (e) { throw isDriverError(e) ? mapPgError(e) : e; } };

const requireUuid = (u) => typeof u === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(u);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const num = (x) => (x === null || x === undefined ? x : Number(x));

const exportRow = (r) => ({ id: r.id, status: r.status, cursor: r.cursor ?? null, parts: r.parts, bytes: num(r.bytes), createdAt: iso(r.created_at), expiresAt: iso(r.expires_at), error: r.error ?? null, updatedAt: iso(r.updated_at) });
const accountRow = (r) => (r ? { userId: r.user_id, status: r.status, storageQuotaBytes: num(r.storage_quota_bytes), hardLimits: r.hard_limits, suspendedReason: r.suspended_reason, createdAt: iso(r.created_at) } : null);
const keyRow = (r) => (r ? { kekId: r.kek_id, dekVer: r.dek_ver, wrapped: Buffer.from(r.wrapped), iv: Buffer.from(r.iv), rotatedAt: iso(r.rotated_at) } : null);
const secretMeta = (r) => ({ name: r.name, last4: r.last4, dekVer: r.dek_ver, updatedAt: iso(r.updated_at) });
const secretFull = (r) => ({ ...secretMeta(r), ct: Buffer.from(r.ct), iv: Buffer.from(r.iv) });
const deviceRow = (r) => ({ id: r.id, name: r.name, scopes: r.scopes, createdAt: iso(r.created_at), lastSeenAt: iso(r.last_seen_at) });
const auditRow = (r) => ({ id: String(r.id), at: iso(r.at), actor: r.actor, actorId: r.actor_id, action: r.action, target: r.target, meta: r.meta });
const tokenMeta = (r) => ({ provider: r.provider, scopes: [...(r.scopes || [])], status: r.status, reason: r.reason, revokeUrl: r.revoke_url, dekVer: r.dek_ver, updatedAt: iso(r.updated_at) });
const tokenFull = (r) => ({ ...tokenMeta(r), ct: Buffer.from(r.ct), iv: Buffer.from(r.iv) });
const buildRow = (r) => ({ id: r.id, repo: r.repo, target: r.target, issueNumber: r.issue_number, prNumber: r.pr_number, state: r.state, title: r.title, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });
const noteMeta = (r) => ({ id: r.id, path: r.path, bytes: r.bytes, tags: [...(r.tags || [])], rev: r.rev, updatedAt: iso(r.updated_at), deletedAt: iso(r.deleted_at) });
const noteFull = (r) => ({ ...noteMeta(r), content: r.content, pushedRev: r.pushed_rev ?? null, createdAt: iso(r.created_at) });
const convRow = (r) => ({ id: r.id, channel: r.channel, startedAt: iso(r.started_at), lastAt: iso(r.last_at), count: num(r.n ?? 0), preview: r.preview ?? null });
const msgRow = (r) => ({ id: String(r.id), conversationId: r.conversation_id, role: r.role, text: r.text, at: iso(r.at) });
const inboxRow = (r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, url: r.url, notePath: r.note_path, key: r.key, at: iso(r.at), readAt: iso(r.read_at) });
const limitRow = (r) => ({ provider: r.provider, metric: r.metric, period: r.period, soft: num(r.soft), softAction: r.soft_action });

/** Refuse a write that would take the user over their storage quota (accounts.storage_quota_bytes, default 500 MB). The bytes in use are kept by the triggers of
 *  migration 07 in app.storage_usage: files + extracted texts + notes + their revisions + messages + the uploads that are reserved but not finished. */
async function assertRoom(tx, uid, grow) {
  const [r] = await tx`select coalesce((select storage_quota_bytes from app.accounts where user_id = ${uid}), 524288000) as quota,
      coalesce((select files_bytes + text_bytes + notes_bytes + messages_bytes + reserved_bytes from app.storage_usage where user_id = ${uid}), 0) as used`;
  if (Number(r.used) + grow > Number(r.quota)) throw dbError('storage_quota_exceeded', 413);
}

const fileRow = (r) => ({
  id: r.id, name: r.name, mime: r.mime, kind: r.kind, size: num(r.size_bytes), sha256: r.sha256, status: r.status, source: r.source, objectPath: r.object_path,
  title: r.title, docKind: r.doc_kind, kindLabel: r.kind_label, tags: [...(r.tags || [])], memo: r.memo, keywords: [...(r.keywords || [])], snippet: r.snippet,
  analysis: r.analysis || {}, related: r.related ?? null, reservedUntil: iso(r.reserved_until), createdAt: iso(r.created_at), finalizedAt: iso(r.finalized_at), updatedAt: iso(r.updated_at),
});
const FILE_COLS = 'id, name, mime, kind, size_bytes, sha256, status, source, object_path, title, doc_kind, kind_label, tags, memo, keywords, snippet, analysis, related, reserved_until, created_at, finalized_at, updated_at';

export function pgRepos(tx, uid, afterCommit = () => {}) {
  /** A statement that may legitimately fail (quota, reservation, not found): run in a savepoint so the failure does not abort the caller's transaction, and as a DbError. */
  const guarded = async (fn) => { try { return await tx.savepoint(fn); } catch (e) { throw isDriverError(e) ? mapPgError(e) : e; } };
  return {
    uid,
    /** Run `fn` after the surrounding asUser() transaction has committed (never if it rolls back). Used for warm caches of things the transaction created. */
    afterCommit,

    accounts: {
      /** Creates the account row on first use (idempotent), returns it. */
      async ensure() { await tx`select app.ensure_account()`; return this.get(); },
      async get() { const [r] = await tx`select user_id, status, storage_quota_bytes, hard_limits, suspended_reason, created_at from app.accounts where user_id = ${uid}`; return accountRow(r); },
      async isAdmin() { const [r] = await tx`select app.is_admin() as a`; return r.a === true; },
      /** O3: graceDays 0 (purge now) or 7. Records the request and marks the account pending_deletion. @returns {Promise<string>} when it will be purged (ISO) */
      async requestDeletion(graceDays, email = null) {
        V.need(graceDays === 0 || graceDays === 7); V.need(email === null || (typeof email === 'string' && email.length <= 320));
        const [r] = await tx`select app.request_deletion(${graceDays}::smallint, ${email}) as due`; return iso(r.due);
      },
      /** @returns {Promise<boolean>} false when there is nothing to cancel (no request, or an immediate one) */
      async cancelDeletion() { const [r] = await tx`select app.cancel_deletion() as ok`; return r.ok === true; },
      async deletion() {
        const [r] = await tx`select grace_days, requested_at, purge_after from app.deletion_requests where user_id = ${uid}`;
        return r ? { graceDays: r.grace_days, requestedAt: iso(r.requested_at), purgeAfter: iso(r.purge_after) } : null;
      },
    },

    /** Admin (M11): metadata only, through definer functions that check is_admin() themselves. Nothing here can read content or secrets. */
    admin: {
      async listUsers({ limit = 100, offset = 0 } = {}) {
        V.need(Number.isInteger(limit) && limit >= 1 && limit <= 500 && Number.isInteger(offset) && offset >= 0);
        return (await tx`select * from app.admin_users(${limit}, ${offset})`).map((r) => ({
          userId: r.user_id, email: r.email, createdAt: iso(r.created_at), lastSignInAt: iso(r.last_sign_in_at), status: r.status, isAdmin: r.is_admin,
          storageQuotaBytes: num(r.storage_quota_bytes), storageUsedBytes: num(r.storage_used_bytes), callsToday: num(r.calls_today), liveSecondsToday: num(r.live_seconds_today), calls30d: num(r.calls_30d),
          hardLimits: r.hard_limits || {}, suspendedReason: r.suspended_reason ?? null }));
      },
      /** The hard limits of one user (numbers only; null removes a key). @returns {Promise<object>} the limits after the change */
      async setLimits(userId, limits) {
        V.need(requireUuid(userId) && limits && typeof limits === 'object' && !Array.isArray(limits));
        const [r] = await guarded((sp) => sp`select app.admin_set_limits(${userId}::uuid, ${tx.json(limits)}::jsonb) as l`); return r.l;
      },
      /** One user's usage per day / provider / metric (numbers only; no per-tool counts). */
      async userUsage(userId, days = 14) {
        V.need(requireUuid(userId) && Number.isInteger(days) && days >= 1 && days <= 60);
        return (await guarded((sp) => sp`select day::text as day, provider, metric, amount from app.admin_user_usage(${userId}::uuid, ${days})`)).map((r) => ({ day: r.day, provider: r.provider, metric: r.metric, amount: num(r.amount) }));
      },
      /** The storage quota of one user (bytes). A number, never content (M11). */
      async setQuota(userId, bytes) {
        V.need(requireUuid(userId) && Number.isInteger(bytes) && bytes >= 0 && bytes <= 1099511627776);
        const [r] = await guarded((sp) => sp`select app.admin_set_quota(${userId}::uuid, ${bytes}::bigint) as b`); return num(r.b);
      },
      async setStatus(userId, status, reason = null) {
        V.need(requireUuid(userId) && ['active', 'suspended'].includes(status) && (reason === null || (typeof reason === 'string' && reason.length <= 500)));
        const [r] = await tx`select app.admin_set_status(${userId}::uuid, ${status}, ${reason}) as s`; return r.s;
      },
    },

    profile: {
      async get() { const [r] = await tx`select profile from app.profiles where user_id = ${uid}`; return r ? r.profile : null; },
      async put(profile) {
        V.jsonObject(profile);
        await tx`insert into app.profiles (user_id, profile) values (${uid}, ${profile}::jsonb)
                 on conflict (user_id) do update set profile = excluded.profile, updated_at = now()`;
      },
      async del() { return (await tx`delete from app.profiles where user_id = ${uid}`).count > 0; },
    },

    settings: {
      async get() { const [r] = await tx`select settings from app.settings where user_id = ${uid}`; return r ? r.settings : {}; },
      async put(settings) {
        V.jsonObject(settings);
        await tx`insert into app.settings (user_id, settings) values (${uid}, ${settings}::jsonb)
                 on conflict (user_id) do update set settings = excluded.settings, updated_at = now()`;
      },
    },

    keys: {
      async get() { const [r] = await tx`select kek_id, dek_ver, wrapped, iv, rotated_at from app.user_keys where user_id = ${uid}`; return keyRow(r); },
      /** @returns {Promise<boolean>} false if the user already has a key (never overwritten here) */
      async create(rec) {
        const k = V.keyInput(rec);
        const r = await tx`insert into app.user_keys (user_id, kek_id, dek_ver, wrapped, iv) values (${uid}, ${k.kekId}, ${k.dekVer}, ${k.wrapped}, ${k.iv})
                           on conflict (user_id) do nothing returning user_id`;
        return r.length === 1;
      },
      async replace(rec) {
        const k = V.keyInput(rec);
        const r = await tx`update app.user_keys set kek_id = ${k.kekId}, dek_ver = ${k.dekVer}, wrapped = ${k.wrapped}, iv = ${k.iv}, rotated_at = now() where user_id = ${uid}`;
        if (r.count !== 1) throw dbError('not_found', 404);
      },
      async del() { return (await tx`delete from app.user_keys where user_id = ${uid}`).count > 0; },
    },

    secrets: {
      async list() { return (await tx`select name, last4, dek_ver, updated_at from app.user_secrets where user_id = ${uid} order by name collate "C"`).map(secretMeta); },
      async get(name) { V.secretName(name); const [r] = await tx`select name, ct, iv, dek_ver, last4, updated_at from app.user_secrets where user_id = ${uid} and name = ${name}`; return r ? secretFull(r) : null; },
      /** Every secret with its ciphertext (for DEK rotation). */
      async allSealed() { return (await tx`select name, ct, iv, dek_ver, last4, updated_at from app.user_secrets where user_id = ${uid} order by name collate "C"`).map(secretFull); },
      async put(name, rec) {
        V.secretName(name); const s = V.sealedInput(rec);
        await tx`insert into app.user_secrets (user_id, name, ct, iv, dek_ver, last4) values (${uid}, ${name}, ${s.ct}, ${s.iv}, ${s.dekVer}, ${s.last4})
                 on conflict (user_id, name) do update set ct = excluded.ct, iv = excluded.iv, dek_ver = excluded.dek_ver, last4 = excluded.last4, updated_at = now()`;
      },
      async del(name) { V.secretName(name); return (await tx`delete from app.user_secrets where user_id = ${uid} and name = ${name}`).count > 0; },
      async delAll() { return (await tx`delete from app.user_secrets where user_id = ${uid}`).count; },
    },

    devices: {
      async create(d) {
        const x = V.deviceInput(d);
        await tx`insert into app.devices (user_id, id, name, token_hash, scopes) values (${uid}, ${x.id}, ${x.name}, ${x.tokenHash}, ${x.scopes})`;
      },
      async list() { return (await tx`select id, name, scopes, created_at, last_seen_at from app.devices where user_id = ${uid} order by created_at, id`).map(deviceRow); },
      async rename(id, name) { V.need(V.DEVICE_ID_RE.test(id) && typeof name === 'string' && name.length >= 1 && name.length <= 40); return (await tx`update app.devices set name = ${name} where user_id = ${uid} and id = ${id}`).count > 0; },
      async revoke(id) { V.need(V.DEVICE_ID_RE.test(id)); return (await tx`delete from app.devices where user_id = ${uid} and id = ${id}`).count > 0; },
      async revokeAll() { return (await tx`delete from app.devices where user_id = ${uid}`).count; },
      async touch(id) { V.need(V.DEVICE_ID_RE.test(id)); await tx`update app.devices set last_seen_at = now() where user_id = ${uid} and id = ${id}`; },
    },

    /** Append-only: there is no update or delete. */
    audit: {
      async append({ actor = 'user', actorId, action, target = null, meta = null }) {
        V.need(['user', 'system'].includes(actor) && typeof action === 'string' && action.length >= 1 && action.length <= 100);
        V.need(actor === 'user' ? (actorId === undefined || actorId === uid) : (actorId === undefined || actorId === null));   // the policy: user -> auth.uid(), system -> null
        await tx`insert into app.audit_log (user_id, actor, actor_id, action, target, meta) values (${uid}, ${actor}, ${actor === 'user' ? uid : null}, ${action}, ${target}, ${meta}::jsonb)`;
      },
      async list({ limit = 100 } = {}) {
        V.need(Number.isInteger(limit) && limit >= 1 && limit <= 1000);
        return (await tx`select id, at, actor, actor_id, action, target, meta from app.audit_log where user_id = ${uid} order by id desc limit ${limit}`).map(auditRow);
      },
    },

    kv: {
      async get(key) { V.key200(key); const [r] = await tx`select value from app.kv_ephemeral where user_id = ${uid} and key = ${key} and expires_at > now()`; return r ? r.value : null; },
      async set(key, value, { ttlSec }) {
        V.key200(key); V.need(value !== null && value !== undefined); const t = V.ttlSec(ttlSec);
        await tx`insert into app.kv_ephemeral (user_id, key, value, expires_at) values (${uid}, ${key}, ${value}::jsonb, now() + make_interval(secs => ${t}))
                 on conflict (user_id, key) do update set value = excluded.value, expires_at = excluded.expires_at`;
      },
      async del(key) { V.key200(key); return (await tx`delete from app.kv_ephemeral where user_id = ${uid} and key = ${key}`).count > 0; },
      /** Set only when there is no live value (a lock). @returns {Promise<boolean>} true when this call took it */
      async setNx(key, value, { ttlSec }) {
        V.key200(key); V.need(value !== null && value !== undefined); const t = V.ttlSec(ttlSec);
        const r = await tx`insert into app.kv_ephemeral (user_id, key, value, expires_at) values (${uid}, ${key}, ${value}::jsonb, now() + make_interval(secs => ${t}))
                           on conflict (user_id, key) do update set value = excluded.value, expires_at = excluded.expires_at where app.kv_ephemeral.expires_at <= now() returning key`;
        return r.length === 1;
      },
    },

    tickets: {
      /** @returns {Promise<boolean>} true the first time a jti is seen for this user, false on a replay */
      async markUsed(jti, ttl) {
        V.key200(jti); const t = V.ttlSec(ttl);
        const r = await tx`insert into app.ticket_uses (user_id, jti, exp) values (${uid}, ${jti}, now() + make_interval(secs => ${t})) on conflict (user_id, jti) do nothing returning jti`;
        return r.length === 1;
      },
    },

    oauthPending: {
      async put({ stateHash, sealed, ttl, provider = 'google' }) {
        V.need(V.isBytes(stateHash, 32) && V.isBytes(sealed) && sealed.length >= 1 && sealed.length <= 8192 && V.OAUTH_FLOW_KINDS.includes(provider)); const t = V.ttlSec(ttl);
        await tx`insert into app.oauth_pending (state_hash, user_id, provider, sealed, expires_at) values (${V.toBuf(stateHash)}, ${uid}, ${provider}, ${V.toBuf(sealed)}, now() + make_interval(secs => ${t}))`;
      },
      /** Single use, and only for the user who started the flow (the row is invisible to everybody else). @returns {Promise<Buffer|null>} */
      async take(stateHash) {
        V.need(V.isBytes(stateHash, 32));
        const r = await tx`delete from app.oauth_pending where user_id = ${uid} and state_hash = ${V.toBuf(stateHash)} and expires_at > now() returning sealed`;
        return r.length ? Buffer.from(r[0].sealed) : null;
      },
      /** The callback takes a flow that has only been started, exactly once (started -> exchanging). @returns {Promise<Buffer|null>} null = unknown, expired or already taken */
      async begin(stateHash, provider) {
        V.need(V.isBytes(stateHash, 32) && V.OAUTH_FLOW_KINDS.includes(provider));   // the callback names ITS kind: a state of another kind is not taken
        const r = await tx`update app.oauth_pending set phase = 'exchanging' where user_id = ${uid} and state_hash = ${V.toBuf(stateHash)} and provider = ${provider} and phase = 'started' and expires_at > now() returning sealed`;
        return r.length ? Buffer.from(r[0].sealed) : null;
      },
      /** Write the result of the exchange (exchanging -> done | error); the expiry stays. @returns {Promise<boolean>} */
      async settle(stateHash, { sealed, phase }) {
        V.need(V.isBytes(stateHash, 32) && V.isBytes(sealed) && sealed.length >= 1 && sealed.length <= 8192 && ['done', 'error'].includes(phase));
        return (await tx`update app.oauth_pending set sealed = ${V.toBuf(sealed)}, phase = ${phase} where user_id = ${uid} and state_hash = ${V.toBuf(stateHash)} and phase = 'exchanging' and expires_at > now()`).count === 1;
      },
      /** Look without taking (the claim polls until the callback has arrived). */
      async get(stateHash) {
        V.need(V.isBytes(stateHash, 32));
        const [r] = await tx`select sealed, phase from app.oauth_pending where user_id = ${uid} and state_hash = ${V.toBuf(stateHash)} and expires_at > now()`;
        return r ? { sealed: Buffer.from(r.sealed), phase: r.phase } : null;
      },
    },

    /** The OAuth tokens of the user's Google login ('google') and MCP connectors ('cx:<id>'), sealed under the DEK (server/auth/keyring.js). */
    oauthTokens: {
      async list() { return (await tx`select provider, scopes, status, reason, revoke_url, dek_ver, updated_at from app.oauth_tokens where user_id = ${uid} order by provider collate "C"`).map(tokenMeta); },
      async get(provider) {
        V.need(V.PROVIDER_RE.test(provider));
        const [r] = await tx`select provider, ct, iv, dek_ver, scopes, status, reason, revoke_url, updated_at from app.oauth_tokens where user_id = ${uid} and provider = ${provider}`;
        return r ? tokenFull(r) : null;
      },
      async allSealed() { return (await tx`select provider, ct, iv, dek_ver, scopes, status, reason, revoke_url, updated_at from app.oauth_tokens where user_id = ${uid} order by provider collate "C"`).map(tokenFull); },
      async put(provider, rec) {
        const t = V.oauthTokenInput(provider, rec);
        await tx`insert into app.oauth_tokens (user_id, provider, ct, iv, dek_ver, scopes, status, reason, revoke_url) values (${uid}, ${provider}, ${t.ct}, ${t.iv}, ${t.dekVer}, ${t.scopes}, ${t.status}, ${t.reason}, ${t.revokeUrl})
                 on conflict (user_id, provider) do update set ct = excluded.ct, iv = excluded.iv, dek_ver = excluded.dek_ver, scopes = excluded.scopes, status = excluded.status, reason = excluded.reason, revoke_url = excluded.revoke_url, updated_at = now()`;
      },
      /** Flag a login as refused by the provider (or clear the flag) without touching the ciphertext. */
      async setStatus(provider, status, reason = null) {
        V.need(V.PROVIDER_RE.test(provider) && V.OAUTH_STATUSES.includes(status) && (reason === null || (typeof reason === 'string' && reason.length <= 60)));
        return (await tx`update app.oauth_tokens set status = ${status}, reason = ${reason}, updated_at = now() where user_id = ${uid} and provider = ${provider}`).count > 0;
      },
      async del(provider) { V.need(V.PROVIDER_RE.test(provider)); return (await tx`delete from app.oauth_tokens where user_id = ${uid} and provider = ${provider}`).count > 0; },
      async delAll() { return (await tx`delete from app.oauth_tokens where user_id = ${uid}`).count; },
    },

    /** The user's connectors (MCP servers, HTTP APIs) as manifest objects with their tools (server/connectors/manifest.js). Secrets are NOT here (user_secrets cx:<id>:*). */
    connectors: {
      async list() {
        const cs = await tx`select id, manifest, enabled from app.connectors where user_id = ${uid} order by created_at, id collate "C"`;
        const ts = await tx`select connector_id, def from app.connector_tools where user_id = ${uid} order by connector_id collate "C", pos, name collate "C"`;
        return cs.map((c) => ({ ...c.manifest, id: c.id, enabled: c.enabled, tools: ts.filter((t) => t.connector_id === c.id).map((t) => t.def) }));
      },
      async get(id) { V.need(V.CONNECTOR_ID_RE.test(id)); return (await this.list()).find((c) => c.id === id) || null; },
      /** Create or replace a connector together with its tools (a tool that is no longer in the manifest is removed). */
      async put(c) {
        const x = V.connectorInput(c);
        await tx`insert into app.connectors (user_id, id, manifest, enabled, synced_at) values (${uid}, ${x.id}, ${x.manifest}::jsonb, ${x.enabled}, ${x.syncedAt === null ? null : new Date(x.syncedAt)})
                 on conflict (user_id, id) do update set manifest = excluded.manifest, enabled = excluded.enabled, synced_at = excluded.synced_at, updated_at = now()`;
        const names = x.tools.map((t) => t.name);
        await tx`delete from app.connector_tools where user_id = ${uid} and connector_id = ${x.id} and not (name = any(${names}::text[]))`;
        if (x.tools.length) {
          await tx`insert into app.connector_tools (user_id, connector_id, name, def, hash, enabled, approval, expose, pos)
                   select ${uid}, ${x.id}, t.name, t.def, t.hash, t.enabled, t.approval, t.expose, t.pos from jsonb_to_recordset(${tx.json(x.tools)}::jsonb) as t(name text, def jsonb, hash text, enabled boolean, approval text, expose text, pos int)
                   on conflict (user_id, connector_id, name) do update set def = excluded.def, hash = excluded.hash, enabled = excluded.enabled, approval = excluded.approval, expose = excluded.expose, pos = excluded.pos`;
        }
      },
      async del(id) { V.need(V.CONNECTOR_ID_RE.test(id)); return (await tx`delete from app.connectors where user_id = ${uid} and id = ${id}`).count > 0; },   // its tools go with it (cascade)
      async delAll() { return (await tx`delete from app.connectors where user_id = ${uid}`).count; },
    },

    /** Build requests (Claude Code through the user's own GitHub repository). */
    builds: {
      async record(b) {
        const x = V.buildInput(b);
        const [r] = await tx`insert into app.build_requests (user_id, repo, target, issue_number, state, title) values (${uid}, ${x.repo}, ${x.target}, ${x.issueNumber}, ${x.state}, ${x.title})
                             on conflict (user_id, repo, issue_number) do update set title = excluded.title, state = excluded.state, updated_at = now()
                             returning id, repo, target, issue_number, pr_number, state, title, created_at, updated_at`;
        return buildRow(r);
      },
      async list({ limit = 50 } = {}) {
        V.need(Number.isInteger(limit) && limit >= 1 && limit <= 200);
        return (await tx`select id, repo, target, issue_number, pr_number, state, title, created_at, updated_at from app.build_requests where user_id = ${uid} order by created_at desc, id limit ${limit}`).map(buildRow);
      },
      async update(id, { state, prNumber }) {
        V.need(requireUuid(id) && (state === undefined || V.BUILD_STATES.includes(state)) && (prNumber === undefined || prNumber === null || (Number.isInteger(prNumber) && prNumber >= 1)));
        return (await tx`update app.build_requests set state = coalesce(${state ?? null}, state), pr_number = coalesce(${prNumber ?? null}, pr_number), updated_at = now() where user_id = ${uid} and id = ${id}`).count > 0;
      },
      async del(id) { V.need(requireUuid(id)); return (await tx`delete from app.build_requests where user_id = ${uid} and id = ${id}`).count > 0; },
      async delAll() { return (await tx`delete from app.build_requests where user_id = ${uid}`).count; },
    },

    /** The second brain: Markdown notes (docs/ELVAR_MULTIUSER.md 8.5). Changing the text keeps the old one as a revision (newest 30). */
    notes: {
      /** Without the trash by default. `folder` = a path prefix such as '家計' or '家計/'. */
      async list({ folder = '', trash = false, limit = 5000 } = {}) {
        V.need(typeof folder === 'string' && folder.length <= 300 && Number.isInteger(limit) && limit >= 1 && limit <= 20000);
        const prefix = folder ? folder.replace(/^\/+|\/+$/g, '') + '/' : '';
        return (await tx`select id, path, bytes, tags, rev, updated_at, deleted_at from app.notes where user_id = ${uid} and (deleted_at is not null) = ${trash === true}
                         ${prefix ? tx`and left(path, ${prefix.length}) = ${prefix}` : tx``} order by path collate "C" limit ${limit}`).map(noteMeta);
      },
      async count() { const [r] = await tx`select count(*)::int as n from app.notes where user_id = ${uid} and deleted_at is null`; return r.n; },
      /** Live notes only unless withTrashed. `lock` takes the row for the rest of the transaction (read-modify-write). */
      async get(path, { withTrashed = false, lock = false } = {}) {
        V.notePath(path);
        const [r] = await tx`select id, path, content, bytes, tags, rev, pushed_rev, created_at, updated_at, deleted_at from app.notes where user_id = ${uid} and path = ${path}
                             ${withTrashed ? tx`` : tx`and deleted_at is null`} ${lock ? tx`for update` : tx``}`;
        return r ? noteFull(r) : null;
      },
      async getById(id) {
        V.need(requireUuid(id));
        const [r] = await tx`select id, path, content, bytes, tags, rev, pushed_rev, created_at, updated_at, deleted_at from app.notes where user_id = ${uid} and id = ${id}`;
        return r ? noteFull(r) : null;
      },
      /** Create or replace the text of a note (a trashed note comes back). `synced` marks the text as already mirrored to the user's own repository (an import).
       *  @throws storage_quota_exceeded (413) @returns {Promise<{id:string, path:string, rev:number, created:boolean, unchanged:boolean}>} */
      async put({ path, content, tags, synced = false }) {
        V.notePath(path); V.noteContent(content); const tg = V.noteTags(tags);
        const [cur] = await tx`select id, content, rev, deleted_at from app.notes where user_id = ${uid} and path = ${path} for update`;
        const unchanged = cur && cur.content === content;
        if (!unchanged) await assertRoom(tx, uid, Buffer.byteLength(content, 'utf8'));   // the old text stays as a revision, so the net growth is the new text
        if (!cur) {
          const [n] = await tx`insert into app.notes (user_id, path, content, tags, pushed_rev) values (${uid}, ${path}, ${content}, ${tg ?? []}::text[], ${synced ? 1 : null}) returning id, rev`;
          return { id: n.id, path, rev: n.rev, created: true, unchanged: false };
        }
        if (unchanged && !cur.deleted_at) { if (tg) await tx`update app.notes set tags = ${tg}::text[] where user_id = ${uid} and id = ${cur.id}`; return { id: cur.id, path, rev: cur.rev, created: false, unchanged: true }; }
        if (!unchanged) {
          await tx`insert into app.note_revisions (user_id, note_id, rev, content) values (${uid}, ${cur.id}, ${cur.rev}, ${cur.content}) on conflict (user_id, note_id, rev) do nothing`;
          await tx`delete from app.note_revisions where user_id = ${uid} and note_id = ${cur.id} and rev not in (select rev from app.note_revisions where user_id = ${uid} and note_id = ${cur.id} order by rev desc limit ${V.NOTE_REVISIONS_KEPT})`;
        }
        const next = unchanged ? cur.rev : cur.rev + 1;
        if (synced) await tx`update app.notes set content = ${content}, rev = ${next}, deleted_at = null, updated_at = now(), tags = coalesce(${tg}::text[], tags), pushed_rev = ${next} where user_id = ${uid} and id = ${cur.id}`;
        else await tx`update app.notes set content = ${content}, rev = ${next}, deleted_at = null, updated_at = now(), tags = coalesce(${tg}::text[], tags) where user_id = ${uid} and id = ${cur.id}`;
        return { id: cur.id, path, rev: next, created: false, unchanged: false };
      },
      async trash(id) { V.need(requireUuid(id)); return (await tx`update app.notes set deleted_at = now() where user_id = ${uid} and id = ${id} and deleted_at is null`).count > 0; },
      async restore(id) { V.need(requireUuid(id)); return (await tx`update app.notes set deleted_at = null, updated_at = now() where user_id = ${uid} and id = ${id} and deleted_at is not null`).count > 0; },
      /** Permanent: the note and all its revisions. */
      async purge(id) { V.need(requireUuid(id)); return (await tx`delete from app.notes where user_id = ${uid} and id = ${id}`).count > 0; },
      async emptyTrash() { return (await tx`delete from app.notes where user_id = ${uid} and deleted_at is not null`).count; },
      async delAll() { return (await tx`delete from app.notes where user_id = ${uid}`).count; },
      /** The revisions of a note, newest first (the current text is `rev` of the note itself). */
      async revisions(id) {
        V.need(requireUuid(id));
        return (await tx`select rev, at, octet_length(content) as bytes from app.note_revisions where user_id = ${uid} and note_id = ${id} order by rev desc`).map((r) => ({ rev: r.rev, at: iso(r.at), bytes: r.bytes }));
      },
      async revision(id, rev) {
        V.need(requireUuid(id) && Number.isInteger(rev) && rev >= 0);
        const [r] = await tx`select rev, at, content from app.note_revisions where user_id = ${uid} and note_id = ${id} and rev = ${rev}`;
        return r ? { rev: r.rev, at: iso(r.at), content: r.content } : null;
      },
      /** Notes that contain at least one of the terms (candidates; the caller scores them): PGroonga or a trigram index, see migration 05. */
      async search(terms, { limit = 200 } = {}) {
        const t = V.searchTerms(terms); V.need(Number.isInteger(limit) && limit >= 1 && limit <= 300);
        const like = t.map(V.likePattern);
        let rows;
        try { rows = await tx.savepoint((sp) => sp`select id, path, content, updated_at from app.search_notes(${t}::text[], ${like}::text[], ${limit})`); }
        catch (e) {   // an engine that does not know the operator: the plain ILIKE query gives the same candidates (slower)
          if (e?.code === '57014') throw e;
          rows = await tx`select id, path, left(content, 60000) as content, updated_at from app.notes where user_id = ${uid} and deleted_at is null and (content ilike any (${like}::text[]) or path ilike any (${like}::text[])) order by updated_at desc limit ${limit}`;
        }
        return rows.map((r) => ({ id: r.id, path: r.path, content: r.content, updatedAt: iso(r.updated_at) }));
      },
      /** Texts of live notes (path prefix optional), newest first, each cut at maxBytes characters. */
      async texts({ prefix = '', limit = 300, maxChars = 60000 } = {}) {
        V.need(typeof prefix === 'string' && prefix.length <= 300 && Number.isInteger(limit) && limit >= 1 && limit <= 2000 && Number.isInteger(maxChars) && maxChars >= 1 && maxChars <= 400000);
        return (await tx`select path, left(content, ${maxChars}) as content, updated_at, bytes from app.notes where user_id = ${uid} and deleted_at is null ${prefix ? tx`and left(path, ${prefix.length}) = ${prefix}` : tx``} order by updated_at desc, path collate "C" limit ${limit}`)
          .map((r) => ({ path: r.path, content: r.content, updatedAt: iso(r.updated_at), bytes: r.bytes }));
      },
      /** Notes changed since they were last mirrored to the user's own repository (github-brain). */
      async unpushed({ limit = 40 } = {}) {
        V.need(Number.isInteger(limit) && limit >= 1 && limit <= 200);
        return (await tx`select id, path, content, rev from app.notes where user_id = ${uid} and deleted_at is null and rev > coalesce(pushed_rev, 0) order by updated_at limit ${limit}`).map((r) => ({ id: r.id, path: r.path, content: r.content, rev: r.rev }));
      },
      async unpushedCount() { const [r] = await tx`select count(*)::int as n from app.notes where user_id = ${uid} and deleted_at is null and rev > coalesce(pushed_rev, 0)`; return r.n; },
      async markPushed(id, rev) { V.need(requireUuid(id) && Number.isInteger(rev) && rev >= 0); return (await tx`update app.notes set pushed_rev = ${rev} where user_id = ${uid} and id = ${id} and rev >= ${rev}`).count > 0; },
    },

    /** The conversation log (short-term memory). A conversation is a run of turns on one channel with no gap longer than 30 minutes. */
    messages: {
      /** @param {{turns: Array<{role:string,text:string,at:number}>, channel?: string, gapSec?: number}} o @returns {Promise<{conversationId:string, added:number}>} */
      async append({ turns, channel = 'voice', gapSec = 1800 }) {
        const t = V.messageTurns(turns); V.need(V.CHANNELS.includes(channel) && Number.isInteger(gapSec) && gapSec >= 1 && gapSec <= 86400);
        await assertRoom(tx, uid, t.reduce((a, x) => a + Buffer.byteLength(x.text, 'utf8'), 0));
        let cid = null;
        for (const run of V.splitRuns(t, gapSec * 1000)) {
          const first = run[0].at, last = run[run.length - 1].at;
          const [open] = await tx`select id from app.conversations where user_id = ${uid} and channel = ${channel} and last_at >= to_timestamp(${first / 1000}) - make_interval(secs => ${gapSec}) and started_at <= to_timestamp(${last / 1000}) + make_interval(secs => ${gapSec}) order by last_at desc limit 1`;
          cid = open ? open.id : (await tx`insert into app.conversations (user_id, channel, started_at, last_at) values (${uid}, ${channel}, to_timestamp(${first / 1000}), to_timestamp(${last / 1000})) returning id`)[0].id;
          await tx`insert into app.messages (user_id, conversation_id, role, text, at) select ${uid}, ${cid}, m.role, m.text, to_timestamp(m.at / 1000.0) from jsonb_to_recordset(${tx.json(run)}::jsonb) as m(role text, text text, at double precision)`;
          await tx`update app.conversations set last_at = greatest(last_at, to_timestamp(${last / 1000})), started_at = least(started_at, to_timestamp(${first / 1000})) where user_id = ${uid} and id = ${cid}`;
        }
        return { conversationId: cid, added: t.length };
      },
      async conversations({ limit = 50, before = null } = {}) {
        V.need(Number.isInteger(limit) && limit >= 1 && limit <= 200 && (before === null || (typeof before === 'string' && !Number.isNaN(Date.parse(before)))));
        return (await tx`select c.id, c.channel, c.started_at, c.last_at, (select count(*)::int from app.messages m where m.user_id = c.user_id and m.conversation_id = c.id) as n,
                           (select left(m.text, 80) from app.messages m where m.user_id = c.user_id and m.conversation_id = c.id and m.role = 'user' order by m.id limit 1) as preview
                         from app.conversations c where c.user_id = ${uid} ${before ? tx`and c.last_at < ${new Date(before)}` : tx``} order by c.last_at desc, c.id limit ${limit}`).map(convRow);
      },
      async conversation(id, { limit = 1000 } = {}) {
        V.need(requireUuid(id) && Number.isInteger(limit) && limit >= 1 && limit <= 5000);
        const [c] = await tx`select id, channel, started_at, last_at from app.conversations where user_id = ${uid} and id = ${id}`;
        if (!c) return null;
        const ms = await tx`select id, conversation_id, role, text, at from app.messages where user_id = ${uid} and conversation_id = ${id} order by at, id limit ${limit}`;
        return { ...convRow({ ...c, n: ms.length }), messages: ms.map(msgRow) };
      },
      /** Newest first. `q` = words to find (ILIKE / PGroonga); `since` / `until` = ISO times. */
      async list({ q = null, since = null, until = null, limit = 100 } = {}) {
        V.need(Number.isInteger(limit) && limit >= 1 && limit <= 2000 && (since === null || !Number.isNaN(Date.parse(since))) && (until === null || !Number.isNaN(Date.parse(until))));
        if (q) {
          const t = V.searchTerms(String(q).split(/\s+/).filter(Boolean), 8), like = t.map(V.likePattern);
          let rows;
          try { rows = await tx.savepoint((sp) => sp`select id, conversation_id, role, text, at from app.search_messages(${t}::text[], ${like}::text[], ${Math.min(limit, 200)})`); }
          catch (e) { if (e?.code === '57014') throw e; rows = await tx`select id, conversation_id, role, text, at from app.messages where user_id = ${uid} and text ilike any (${like}::text[]) order by at desc, id desc limit ${Math.min(limit, 200)}`; }
          return rows.map(msgRow);
        }
        return (await tx`select id, conversation_id, role, text, at from app.messages where user_id = ${uid} ${since ? tx`and at >= ${new Date(since)}` : tx``} ${until ? tx`and at < ${new Date(until)}` : tx``} order by at desc, id desc limit ${limit}`).map(msgRow);
      },
      async count() { const [r] = await tx`select count(*)::int as n from app.messages where user_id = ${uid}`; return r.n; },
      async del(id) { V.need(/^\d{1,18}$/.test(String(id))); return (await tx`delete from app.messages where user_id = ${uid} and id = ${String(id)}::bigint`).count > 0; },
      async delConversation(id) { V.need(requireUuid(id)); return (await tx`delete from app.conversations where user_id = ${uid} and id = ${id}`).count > 0; },   // its messages go with it (cascade)
      /** Everything before `before` (ISO), or everything when `before` is null. @returns {Promise<number>} messages deleted */
      async purge({ before = null } = {}) {
        V.need(before === null || (typeof before === 'string' && !Number.isNaN(Date.parse(before))));
        const n = (await tx`delete from app.messages where user_id = ${uid} ${before ? tx`and at < ${new Date(before)}` : tx``}`).count;
        await tx`delete from app.conversations c where c.user_id = ${uid} and not exists (select 1 from app.messages m where m.user_id = c.user_id and m.conversation_id = c.id)`;
        return n;
      },
    },

    /** The bell panel (reports, finished work, alerts). The same `key` replaces the older item. */
    inbox: {
      async list({ limit = 40 } = {}) {
        V.need(Number.isInteger(limit) && limit >= 1 && limit <= V.INBOX_MAX_ITEMS);
        return (await tx`select id, kind, title, body, url, note_path, key, at, read_at from app.inbox_items where user_id = ${uid} order by at desc, id limit ${limit}`).map(inboxRow);
      },
      async add(item) {
        const x = V.inboxInput(item);
        const [r] = await tx`insert into app.inbox_items (user_id, kind, title, body, url, note_path, key) values (${uid}, ${x.kind}, ${x.title}, ${x.body}, ${x.url}, ${x.notePath}, ${x.key})
                             on conflict (user_id, key) where key is not null do update set kind = excluded.kind, title = excluded.title, body = excluded.body, url = excluded.url, note_path = excluded.note_path, at = now(), read_at = null
                             returning id, kind, title, body, url, note_path, key, at, read_at`;
        await tx`delete from app.inbox_items where user_id = ${uid} and id not in (select id from app.inbox_items where user_id = ${uid} order by at desc, id limit ${V.INBOX_MAX_ITEMS})`;
        return inboxRow(r);
      },
      async markRead(id) { V.need(requireUuid(id)); return (await tx`update app.inbox_items set read_at = coalesce(read_at, now()) where user_id = ${uid} and id = ${id}`).count > 0; },
      async markAllRead() { return (await tx`update app.inbox_items set read_at = now() where user_id = ${uid} and read_at is null`).count; },
      async del(id) { V.need(requireUuid(id)); return (await tx`delete from app.inbox_items where user_id = ${uid} and id = ${id}`).count > 0; },
      async delAll() { return (await tx`delete from app.inbox_items where user_id = ${uid}`).count; },
    },

    /** The phone-notification relay: ciphertext only, 3 days, 200 items. The phone's device token (scope notif:push / notif:pull) reaches nothing but this. */
    notif: {
      async push(items, { now = Date.now() } = {}) {
        V.need(Array.isArray(items));
        const ok = items.slice(0, 50).map((x) => { try { return V.notifItem(x); } catch { return null; } }).filter(Boolean);
        if (!ok.length) return { stored: 0 };
        const rows = ok.map((x) => ({ id: x.id, at: new Date(Math.min(x.at, now + 60_000)).toISOString(), iv: x.iv, ct: x.ct }));
        await tx`delete from app.notif_items where user_id = ${uid} and at < ${new Date(now - V.NOTIF_KEEP_MS)}`;
        await tx`insert into app.notif_items (user_id, id, at, iv, ct) select ${uid}, r.id, r.at, r.iv, r.ct from jsonb_to_recordset(${tx.json(rows)}::jsonb) as r(id text, at timestamptz, iv text, ct text) on conflict (user_id, id) do nothing`;
        await tx`delete from app.notif_items where user_id = ${uid} and id not in (select id from app.notif_items where user_id = ${uid} order by at desc, id limit ${V.NOTIF_MAX_ITEMS})`;
        return { stored: ok.length };
      },
      /** Items at or after `since` (ms), oldest first, at most 100. */
      async pull({ since = 0, now = Date.now() } = {}) {
        V.need(Number.isFinite(since) && since >= 0);
        await tx`delete from app.notif_items where user_id = ${uid} and at < ${new Date(now - V.NOTIF_KEEP_MS)}`;
        return (await tx`select id, at, iv, ct from app.notif_items where user_id = ${uid} and at >= ${new Date(Math.max(0, since))} order by at, id limit 100`).map((r) => ({ id: r.id, at: new Date(r.at).getTime(), iv: r.iv, ct: r.ct }));
      },
      async clear() { return (await tx`delete from app.notif_items where user_id = ${uid}`).count; },
      async count() { const [r] = await tx`select count(*)::int as n from app.notif_items where user_id = ${uid} and at >= ${new Date(Date.now() - V.NOTIF_KEEP_MS)}`; return r.n; },
    },

    /** The file vault (P5). Reads are plain selects (Row Level Security); every change is a definer function that checks the caller and the quota. */
    files: {
      /** Reserve room for an upload (atomic, counts the announced extracted text too). @returns {Promise<{duplicate:{id:string,name:string}}|{fileId:string,objectPath:string,reservedUntil:string}>}
       *  @throws storage_quota_exceeded / file_too_large (413), conflict (too many uploads at once, account not active) */
      async reserve(x) {
        const v = V.fileReserveInput(x);
        const [r] = await guarded((sp) => sp`select app.reserve_file(${v.name}, ${v.mime}, ${v.kind}, ${v.size}::bigint, ${v.sha256}, ${v.textBytes}::bigint, ${v.source}, ${v.allowDuplicate}) as r`);
        return r.r;
      },
      /** The caller has verified the real object (size, SHA-256). @throws reservation_expired (409), file_too_large, storage_quota_exceeded, not_found */
      async finalize(id, input) {
        V.need(V.FILE_ID_RE.test(String(id))); const v = V.fileFinalizeInput(input); V.need(Number.isInteger(input?.size) && input.size >= 1);
        await guarded((sp) => sp`select app.finalize_file(${id}::uuid, ${input.size}::bigint, ${v.title ?? null}, ${v.docKind ?? null}, ${v.keywords ?? []}::text[], ${v.snippet ?? ''}, ${v.analysis ?? {}}::jsonb, ${v.related ?? null}::jsonb, ${v.text})`);
      },
      /** Name, tags, memo, kind label, the memory fields; `text` (with setText) replaces the extracted text. */
      async patch(id, patch, { text = null, setText = false } = {}) {
        V.need(V.FILE_ID_RE.test(String(id))); const p = V.filePatchInput(patch); if (setText) V.fileText(text ?? '');
        await guarded((sp) => sp`select app.patch_file(${id}::uuid, ${p}::jsonb, ${setText ? text ?? '' : null}, ${setText})`);
      },
      async get(id) { V.need(V.FILE_ID_RE.test(String(id))); const [r] = await tx.unsafe(`select ${FILE_COLS} from app.files where user_id = $1 and id = $2`, [uid, id]); return r ? fileRow(r) : null; },
      /** Ready files, newest first (the library list). */
      async list({ limit = 5000 } = {}) {
        V.need(Number.isInteger(limit) && limit >= 1 && limit <= 20000);
        return (await tx.unsafe(`select ${FILE_COLS} from app.files where user_id = $1 and status = 'ready' order by created_at desc, id limit ${limit}`, [uid])).map(fileRow);
      },
      async findBySha(sha) { V.need(V.isSha256(sha)); const [r] = await tx.unsafe(`select ${FILE_COLS} from app.files where user_id = $1 and sha256 = $2 and status = 'ready' order by created_at limit 1`, [uid, sha]); return r ? fileRow(r) : null; },
      async text(id) { V.need(V.FILE_ID_RE.test(String(id))); const [r] = await tx`select t.text from app.file_texts t join app.files f on f.user_id = t.user_id and f.id = t.file_id where t.user_id = ${uid} and t.file_id = ${id} and f.status = 'ready'`; return r ? r.text : null; },
      /** Files whose extracted text contains at least one term (the candidates; the caller ranks them). @returns {Promise<Map<string,string>>} id -> text */
      async searchText(terms, { limit = 200 } = {}) {
        const t = V.searchTerms(terms), like = t.map(V.likePattern); V.need(Number.isInteger(limit) && limit >= 1 && limit <= 300);
        let rows;
        try { rows = await tx.savepoint((sp) => sp`select id, text from app.search_files(${t}::text[], ${like}::text[], ${limit})`); }
        catch (e) {   // an engine that does not know the operator: the plain ILIKE query gives the same candidates (slower)
          if (e?.code === '57014') throw e;
          rows = await tx`select t.file_id as id, left(t.text, 200000) as text from app.file_texts t join app.files f on f.user_id = t.user_id and f.id = t.file_id
                          where t.user_id = ${uid} and f.status = 'ready' and t.text ilike any (${like}::text[]) limit ${limit}`;
        }
        return new Map(rows.map((r) => [r.id, r.text]));
      },
      async count() { const [r] = await tx`select count(*)::int as n from app.files where user_id = ${uid} and status = 'ready'`; return r.n; },
      /** Step 1 of a delete (also cancels an upload): the row is hidden and the Storage path comes back. @returns {Promise<string|null>} null when there is no such file */
      async beginDelete(id) {
        V.need(V.FILE_ID_RE.test(String(id)));
        try { const [r] = await guarded((sp) => sp`select app.begin_delete_file(${id}::uuid) as p`); return r.p; } catch (e) { if (e?.code === 'not_found') return null; throw e; }
      },
      /** Step 2, after the Storage object is gone: the row (and its text) goes and the bytes are free. */
      async finishDelete(id) { V.need(V.FILE_ID_RE.test(String(id))); const [r] = await tx`select app.finish_delete_file(${id}::uuid) as ok`; return r.ok === true; },
      /** Rows whose Storage object must be removed first: deleting, or an upload reservation that ran out. */
      async stale() { return (await tx`select id, object_path from app.my_stale_files()`).map((r) => ({ id: r.id, objectPath: r.object_path })); },
      /** Every file the user has, in any state (for "delete everything"): ids and Storage paths. */
      async allPaths() { return (await tx`select id, object_path from app.files where user_id = ${uid}`).map((r) => ({ id: r.id, objectPath: r.object_path })); },
    },

    /** The export jobs of this user (read only: progress is written by the server through the system functions). */
    exportJobs: {
      async list() { return (await tx`select id, status, cursor, parts, bytes, created_at, expires_at, error, updated_at from app.export_jobs where user_id = ${uid} order by created_at desc, id limit 20`).map(exportRow); },
      async get(id) { V.need(requireUuid(id)); const [r] = await tx`select id, status, cursor, parts, bytes, created_at, expires_at, error, updated_at from app.export_jobs where user_id = ${uid} and id = ${id}`; return r ? exportRow(r) : null; },
    },
    /** How many rows of every registered table this user can see (the "my data" screen and the export manifest). RLS applies: a table the user cannot read counts 0. */
    rights: {
      /** The export's keyset pager (server/rights/export-pages.js): up to `limit` rows of one table after the cursor `after` (the key of the last row of the previous page), in primary-key order.
       *  @returns {Promise<{rows: object[], next: string[]|null}>} next = null when there are no more rows */
      async exportPage(table, { after = null, limit = null } = {}) {
        const spec = PAGED[table]; V.need(spec); const n = limit ?? spec.page;
        V.need(Number.isInteger(n) && n >= 1 && n <= 2000 && (after === null || (Array.isArray(after) && after.length === spec.key.length && after.every((x) => typeof x === 'string' && x.length <= 300))));
        const cols = spec.key.map(([c]) => c).join(', '), cond = after ? `and (${cols}) > (${spec.key.map(([, t], i) => '$' + (i + 2) + '::' + t).join(', ')})` : '';
        const raw = (await tx.unsafe(`select to_jsonb(t) as j from app.${table} t where user_id = $1 ${cond} order by ${cols} limit ${n}`, [uid, ...(after || [])])).map((r) => r.j);
        const rows = raw.map((j) => pageRow(table, j));
        return { rows, next: raw.length === n ? keyOf(table, raw.at(-1)) : null };
      },
      async counts() {
        const out = {};
        for (const e of REGISTRY) {
          const [p] = await tx.unsafe(`select has_table_privilege(current_user, 'app.${e.table}', 'select') as ok`);   // working tables (counters, admins) are not readable by the user at all: 0
          if (!p.ok) { out[e.table] = 0; continue; }
          const [r] = await tx.unsafe(`select count(*)::int as n from app.${e.table} where ${e.ownerColumn} = $1`, [uid]); out[e.table] = r.n;
        }
        return out;
      },
    },

    usageLimits: {
      async list() { return (await tx`select provider, metric, period, soft, soft_action from app.usage_limits where user_id = ${uid} order by provider collate "C", metric collate "C", period`).map(limitRow); },
      async put({ provider, metric, period, soft, softAction = 'warn' }) {
        V.need(typeof provider === 'string' && provider && provider.length <= 40 && typeof metric === 'string' && metric && metric.length <= 40
          && ['day', 'month'].includes(period) && Number.isFinite(soft) && soft >= 0 && ['warn', 'block'].includes(softAction));
        await tx`insert into app.usage_limits (user_id, provider, metric, period, soft, soft_action) values (${uid}, ${provider}, ${metric}, ${period}, ${soft}, ${softAction})
                 on conflict (user_id, provider, metric, period) do update set soft = excluded.soft, soft_action = excluded.soft_action`;
      },
      async del({ provider, metric, period }) { return (await tx`delete from app.usage_limits where user_id = ${uid} and provider = ${provider} and metric = ${metric} and period = ${period}`).count > 0; },
    },

    /** The numbers are written only through app.record_usage (the caller's own account). */
    usage: {
      /** `day` (YYYY-MM-DD) is the user's own day; omitted = the database date. Only today and yesterday of the database clock (+-1) are accepted. */
      async record({ provider, metric, amount = 1, source = 'server', day = null }) {
        V.need(typeof provider === 'string' && provider.length >= 1 && provider.length <= 40 && typeof metric === 'string' && metric.length >= 1 && metric.length <= 40
          && Number.isFinite(amount) && amount >= 0 && amount <= 1e9 && ['server', 'client'].includes(source) && (day === null || /^\d{4}-\d{2}-\d{2}$/.test(day)));
        await guarded((sp) => sp`select app.record_usage(${provider}, ${metric}, ${amount}, ${source}, ${day}::date)`);   // the function refuses a day far from the database date (22023 -> invalid_value)
      },
      async daily({ from, to }) {
        return (await tx`select day::text as day, provider, metric, amount from app.usage_daily where user_id = ${uid} and day >= ${from}::date and day <= ${to}::date order by day, provider, metric`)
          .map((r) => ({ day: r.day, provider: r.provider, metric: r.metric, amount: num(r.amount) }));
      },
      async storage() {
        const [r] = await tx`select files_bytes, text_bytes, notes_bytes, messages_bytes, reserved_bytes from app.storage_usage where user_id = ${uid}`;
        return r ? { filesBytes: num(r.files_bytes), textBytes: num(r.text_bytes), notesBytes: num(r.notes_bytes), messagesBytes: num(r.messages_bytes), reservedBytes: num(r.reserved_bytes) }
          : { filesBytes: 0, textBytes: 0, notesBytes: 0, messagesBytes: 0, reservedBytes: 0 };
      },
    },
  };
}

/**
 * Operations that run as elvar_app WITHOUT a user context, each through one definer function. Nothing here reads or writes a table directly.
 * (They still take care with user ids: rlHit / residualCheck want a VerifiedUid.)
 */
export function pgSystem(sql) {
  return {
    /** Count one hit in the current fixed window; returns the new count. `userId` (a VerifiedUid) for signed-in callers, then who is the id. */
    async rlHit({ bucket, who, windowSec, userId = null }) {
      const uid = userId ? requireVerifiedUid(userId) : null;
      const [r] = await sql`select app.rl_hit(${bucket}, ${uid ?? String(who)}, ${windowSec}, ${uid}) as n`;
      return r.n;
    },
    /** The daily sweep of the file vault: rows whose Storage object must be removed (deleting, or an upload that was never finished). */
    async staleFiles(limit = 200) { V.need(Number.isInteger(limit) && limit >= 1 && limit <= 1000); return (await sql`select user_id, id, object_path from app.stale_files(${limit})`).map((r) => ({ userId: r.user_id, id: r.id, objectPath: r.object_path })); },
    /** P7: export jobs. The user id is a VerifiedUid; progress is only ever written here. */
    async createExportJob(vuid) { const [r] = await guardedSys(sql, () => sql`select app.export_job_create(${requireVerifiedUid(vuid)}::uuid) as id`); return r.id; },
    async updateExportJob(vuid, id, { status, cursor = null, parts = 0, bytes = 0, error = null, expiresAt = null }) {
      V.need(requireUuid(id) && ['running', 'done', 'failed'].includes(status) && Number.isInteger(parts) && parts >= 0 && Number.isFinite(bytes) && bytes >= 0);
      const [r] = await sql`select app.export_job_update(${requireVerifiedUid(vuid)}::uuid, ${id}::uuid, ${status}, ${sql.json(cursor)}::jsonb, ${parts}, ${bytes}, ${error}, ${expiresAt}::timestamptz) as ok`; return r.ok === true;
    },
    async expiredExportJobs(limit = 100) { V.need(Number.isInteger(limit) && limit >= 1 && limit <= 500); return (await sql`select user_id, id from app.export_jobs_expired(${limit})`).map((r) => ({ userId: r.user_id, id: r.id })); },
    async dropExportJob(userId, id) { V.need(requireUuid(userId) && requireUuid(id)); const [r] = await sql`select app.export_job_drop(${userId}::uuid, ${id}::uuid) as ok`; return r.ok === true; },
    async dropStaleFile(userId, id) { V.need(requireUuid(userId) && requireUuid(id)); const [r] = await sql`select app.drop_stale_file(${userId}::uuid, ${id}::uuid) as ok`; return r.ok === true; },
    /** Recount everybody's storage_usage from the tables. @returns {Promise<number>} users corrected */
    async reconcileStorage() { const [r] = await sql`select app.reconcile_storage() as n`; return Number(r.n); },
    async purgeExpired() { return Object.fromEntries((await sql`select table_name, deleted from app.purge_expired()`).map((r) => [r.table_name, Number(r.deleted)])); },
    async residualCheck(vuid) { return (await sql`select table_name, n from app.residual_check(${requireVerifiedUid(vuid)})`).map((r) => ({ table: r.table_name, n: Number(r.n) })); },
    /** Whose device token is this? hash = sha256 of the token's secret part. Returns the raw ids; the caller turns them into a VerifiedUid. */
    /** Accounts whose deletion is due (grace over, or immediate). */
    async dueDeletions(limit = 20) { return (await sql`select user_id, grace_days, email from app.due_deletions(${limit})`).map((r) => ({ userId: r.user_id, graceDays: r.grace_days, email: r.email ?? null })); },
    /** Proof that a deletion happened and how many tables were verified clean. Carries no user id and no e-mail. */
    async recordReceipt(tablesChecked) { V.need(Number.isInteger(tablesChecked) && tablesChecked >= 0); await sql`select app.record_deletion_receipt(${tablesChecked})`; },
    /** The confirmed account with this e-mail becomes an admin (the first one). @returns {Promise<string|null>} its id */
    async bootstrapAdmin(email) { V.need(typeof email === 'string' && email.length >= 3 && email.length <= 320); const [r] = await sql`select app.bootstrap_admin(${email}) as id`; return r.id || null; },
    /** Whose OAuth flow is this state (its hash)? The callback has no token; everything after this runs as that user. @returns {Promise<string|null>} the user id (not yet verified: mint it 'oauth_pending') */
    async oauthPendingOwner(stateHash, provider) {
      V.need(V.isBytes(stateHash, 32) && V.OAUTH_FLOW_KINDS.includes(provider));
      const [r] = await sql`select app.oauth_pending_owner(${V.toBuf(stateHash)}, ${provider}) as uid`;
      return r.uid || null;
    },
    /** The sign-up policy (open | invite | closed) the Auth hook enforces: the single source. */
    async signupMode() { const [r] = await sql`select app.platform_signup_mode() as m`; return r.m; },
    async accountCount() { const [r] = await sql`select app.account_count() as n`; return Number(r.n); },
    /** The per-file limit of the platform (app.platform_config max_file_bytes; the bucket's file_size_limit follows it by trigger). */
    async maxFileBytes() { const [r] = await sql`select app.platform_max_file_bytes() as n`; return Number(r.n); },
    async setMaxFileBytes(n) { V.need(Number.isInteger(n) && n >= 1048576 && n <= 5368709120); const [r] = await sql`select app.set_max_file_bytes(${n}) as n`; return Number(r.n); },
    async deviceLookup(hash) {
      V.need(V.isBytes(hash, 32));
      const [r] = await sql`select user_id, device_id, scopes from app.device_lookup(${V.toBuf(hash)})`;
      return r ? { userId: r.user_id, deviceId: r.device_id, scopes: r.scopes } : null;
    },
  };
}
