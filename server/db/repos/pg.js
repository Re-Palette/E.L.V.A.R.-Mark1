// All SQL of the user-facing repositories lives here (and nowhere else). `tx` is a transaction that asUser() already switched to the
// `authenticated` role with the user's claims, so Row Level Security applies; every statement still names user_id (defence in depth, and it
// lets Postgres use the user_id-first indexes).
//
// MemoryDb (server/db/memory.js) implements the same interface; test/contracts/db.contract.mjs runs against both.
// Values leave this module as plain JS: timestamps as ISO strings, bigint as numbers, bytea as Buffers.
import { dbError } from '../errors.js';
import * as V from '../validate.js';
import { requireVerifiedUid } from '../verified-uid.js';

const requireUuid = (u) => typeof u === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(u);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const num = (x) => (x === null || x === undefined ? x : Number(x));

const accountRow = (r) => (r ? { userId: r.user_id, status: r.status, storageQuotaBytes: num(r.storage_quota_bytes), hardLimits: r.hard_limits, suspendedReason: r.suspended_reason, createdAt: iso(r.created_at) } : null);
const keyRow = (r) => (r ? { kekId: r.kek_id, dekVer: r.dek_ver, wrapped: Buffer.from(r.wrapped), iv: Buffer.from(r.iv), rotatedAt: iso(r.rotated_at) } : null);
const secretMeta = (r) => ({ name: r.name, last4: r.last4, dekVer: r.dek_ver, updatedAt: iso(r.updated_at) });
const secretFull = (r) => ({ ...secretMeta(r), ct: Buffer.from(r.ct), iv: Buffer.from(r.iv) });
const deviceRow = (r) => ({ id: r.id, name: r.name, scopes: r.scopes, createdAt: iso(r.created_at), lastSeenAt: iso(r.last_seen_at) });
const auditRow = (r) => ({ id: String(r.id), at: iso(r.at), actor: r.actor, actorId: r.actor_id, action: r.action, target: r.target, meta: r.meta });
const tokenMeta = (r) => ({ provider: r.provider, scopes: [...(r.scopes || [])], status: r.status, reason: r.reason, revokeUrl: r.revoke_url, dekVer: r.dek_ver, updatedAt: iso(r.updated_at) });
const tokenFull = (r) => ({ ...tokenMeta(r), ct: Buffer.from(r.ct), iv: Buffer.from(r.iv) });
const buildRow = (r) => ({ id: r.id, repo: r.repo, target: r.target, issueNumber: r.issue_number, prNumber: r.pr_number, state: r.state, title: r.title, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });
const limitRow = (r) => ({ provider: r.provider, metric: r.metric, period: r.period, soft: num(r.soft), softAction: r.soft_action });

export function pgRepos(tx, uid, afterCommit = () => {}) {
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
          storageQuotaBytes: num(r.storage_quota_bytes), storageUsedBytes: num(r.storage_used_bytes), callsToday: num(r.calls_today), liveSecondsToday: num(r.live_seconds_today), calls30d: num(r.calls_30d) }));
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
      async put({ stateHash, sealed, ttl }) {
        V.need(V.isBytes(stateHash, 32) && V.isBytes(sealed) && sealed.length >= 1 && sealed.length <= 8192); const t = V.ttlSec(ttl);
        await tx`insert into app.oauth_pending (state_hash, user_id, sealed, expires_at) values (${V.toBuf(stateHash)}, ${uid}, ${V.toBuf(sealed)}, now() + make_interval(secs => ${t}))`;
      },
      /** Single use, and only for the user who started the flow (the row is invisible to everybody else). @returns {Promise<Buffer|null>} */
      async take(stateHash) {
        V.need(V.isBytes(stateHash, 32));
        const r = await tx`delete from app.oauth_pending where user_id = ${uid} and state_hash = ${V.toBuf(stateHash)} and expires_at > now() returning sealed`;
        return r.length ? Buffer.from(r[0].sealed) : null;
      },
      /** The callback takes a flow that has only been started, exactly once (started -> exchanging). @returns {Promise<Buffer|null>} null = unknown, expired or already taken */
      async begin(stateHash) {
        V.need(V.isBytes(stateHash, 32));
        const r = await tx`update app.oauth_pending set phase = 'exchanging' where user_id = ${uid} and state_hash = ${V.toBuf(stateHash)} and phase = 'started' and expires_at > now() returning sealed`;
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
      async record({ provider, metric, amount = 1, source = 'server' }) {
        V.need(typeof provider === 'string' && provider.length >= 1 && provider.length <= 40 && typeof metric === 'string' && metric.length >= 1 && metric.length <= 40
          && Number.isFinite(amount) && amount >= 0 && amount <= 1e9 && ['server', 'client'].includes(source));
        await tx`select app.record_usage(${provider}, ${metric}, ${amount}, ${source})`;
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
    async purgeExpired() { return Object.fromEntries((await sql`select table_name, deleted from app.purge_expired()`).map((r) => [r.table_name, Number(r.deleted)])); },
    async residualCheck(vuid) { return (await sql`select table_name, n from app.residual_check(${requireVerifiedUid(vuid)})`).map((r) => ({ table: r.table_name, n: Number(r.n) })); },
    /** Whose device token is this? hash = sha256 of the token's secret part. Returns the raw ids; the caller turns them into a VerifiedUid. */
    /** Accounts whose deletion is due (grace over, or immediate). */
    async dueDeletions(limit = 20) { return (await sql`select user_id, grace_days from app.due_deletions(${limit})`).map((r) => ({ userId: r.user_id, graceDays: r.grace_days })); },
    /** Proof that a deletion happened and how many tables were verified clean. Carries no user id and no e-mail. */
    async recordReceipt(tablesChecked) { V.need(Number.isInteger(tablesChecked) && tablesChecked >= 0); await sql`select app.record_deletion_receipt(${tablesChecked})`; },
    /** The confirmed account with this e-mail becomes an admin (the first one). @returns {Promise<string|null>} its id */
    async bootstrapAdmin(email) { V.need(typeof email === 'string' && email.length >= 3 && email.length <= 320); const [r] = await sql`select app.bootstrap_admin(${email}) as id`; return r.id || null; },
    /** Whose OAuth flow is this state (its hash)? The callback has no token; everything after this runs as that user. @returns {Promise<string|null>} the user id (not yet verified: mint it 'oauth_pending') */
    async oauthPendingOwner(stateHash) {
      V.need(V.isBytes(stateHash, 32));
      const [r] = await sql`select app.oauth_pending_owner(${V.toBuf(stateHash)}) as uid`;
      return r.uid || null;
    },
    async deviceLookup(hash) {
      V.need(V.isBytes(hash, 32));
      const [r] = await sql`select user_id, device_id, scopes from app.device_lookup(${V.toBuf(hash)})`;
      return r ? { userId: r.user_id, deviceId: r.device_id, scopes: r.scopes } : null;
    },
  };
}
