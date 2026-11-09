// All SQL of the user-facing repositories lives here (and nowhere else). `tx` is a transaction that asUser() already switched to the
// `authenticated` role with the user's claims, so Row Level Security applies; every statement still names user_id (defence in depth, and it
// lets Postgres use the user_id-first indexes).
//
// MemoryDb (server/db/memory.js) implements the same interface; test/contracts/db.contract.mjs runs against both.
// Values leave this module as plain JS: timestamps as ISO strings, bigint as numbers, bytea as Buffers.
import { dbError } from '../errors.js';
import * as V from '../validate.js';
import { requireVerifiedUid } from '../verified-uid.js';

const iso = (d) => (d ? new Date(d).toISOString() : null);
const num = (x) => (x === null || x === undefined ? x : Number(x));

const accountRow = (r) => (r ? { userId: r.user_id, status: r.status, storageQuotaBytes: num(r.storage_quota_bytes), hardLimits: r.hard_limits, suspendedReason: r.suspended_reason, createdAt: iso(r.created_at) } : null);
const keyRow = (r) => (r ? { kekId: r.kek_id, dekVer: r.dek_ver, wrapped: Buffer.from(r.wrapped), iv: Buffer.from(r.iv), rotatedAt: iso(r.rotated_at) } : null);
const secretMeta = (r) => ({ name: r.name, last4: r.last4, dekVer: r.dek_ver, updatedAt: iso(r.updated_at) });
const secretFull = (r) => ({ ...secretMeta(r), ct: Buffer.from(r.ct), iv: Buffer.from(r.iv) });
const deviceRow = (r) => ({ id: r.id, name: r.name, scopes: r.scopes, createdAt: iso(r.created_at), lastSeenAt: iso(r.last_seen_at) });
const auditRow = (r) => ({ id: String(r.id), at: iso(r.at), actor: r.actor, actorId: r.actor_id, action: r.action, target: r.target, meta: r.meta });
const limitRow = (r) => ({ provider: r.provider, metric: r.metric, period: r.period, soft: num(r.soft), softAction: r.soft_action });

export function pgRepos(tx, uid) {
  return {
    uid,

    accounts: {
      /** Creates the account row on first use (idempotent), returns it. */
      async ensure() { await tx`select app.ensure_account()`; return this.get(); },
      async get() { const [r] = await tx`select user_id, status, storage_quota_bytes, hard_limits, suspended_reason, created_at from app.accounts where user_id = ${uid}`; return accountRow(r); },
      async isAdmin() { const [r] = await tx`select app.is_admin() as a`; return r.a === true; },
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
      async touch(id) { V.need(V.DEVICE_ID_RE.test(id)); await tx`update app.devices set last_seen_at = now() where user_id = ${uid} and id = ${id}`; },
    },

    /** Append-only: there is no update or delete. */
    audit: {
      async append({ actor = 'user', actorId, action, target = null, meta = null }) {
        V.need(['user', 'system'].includes(actor) && typeof action === 'string' && action.length >= 1 && action.length <= 100);
        await tx`insert into app.audit_log (user_id, actor, actor_id, action, target, meta) values (${uid}, ${actor}, ${actorId ?? (actor === 'user' ? uid : null)}, ${action}, ${target}, ${meta}::jsonb)`;
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

    /** Read-only: the numbers are written by the server's metering (P6) through definer functions. */
    usage: {
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
    async deviceLookup(hash) {
      V.need(V.isBytes(hash, 32));
      const [r] = await sql`select user_id, device_id, scopes from app.device_lookup(${V.toBuf(hash)})`;
      return r ? { userId: r.user_id, deviceId: r.device_id, scopes: r.scopes } : null;
    },
  };
}
