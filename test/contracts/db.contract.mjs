// The database contract: the same tests run against MemoryDb (npm test) and against the real Postgres layer (npm run test:db), so a fake that passes
// but a real database that fails cannot happen. Usage:
//   runDbContract('memory', async () => ({ db, newUser, deleteUser, makeAdmin, passTime }))
//     newUser()        -> uuid of a new auth user          deleteUser(uid)  what `delete from auth.users` does (the cascade)
//     makeAdmin(uid)   -> a row in app.admins              passTime(ms)     advance the clock (memory) or really wait (Postgres)
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mintVerifiedUid } from '../../server/db/verified-uid.js';
import { registryTables } from '../../server/rights/registry.js';
import { residualCheck } from '../../server/rights/residual.js';
import { createKeyring, envKekProvider } from '../../server/crypto/envelope.js';

process.env.ELVAR_TEST_MODE = '1';
const mint = (uid) => mintVerifiedUid(uid, 'test');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const rnd = (n) => crypto.randomBytes(n);
const code = (c) => (e) => { assert.equal(e?.code, c, `expected ${c}, got ${e?.code || e}`); return true; };
const sealedRec = (extra = {}) => ({ ct: rnd(40), iv: rnd(12), dekVer: 1, last4: 'wxyz', ...extra });
const keyRec = (extra = {}) => ({ kekId: 'k1', dekVer: 1, wrapped: rnd(48), iv: rnd(12), ...extra });
const device = (extra = {}) => ({ id: rnd(8).toString('hex'), name: 'phone', tokenHash: rnd(32), scopes: ['notif:push'], ...extra });
const testKek = () => envKekProvider({ ELVAR_KEK: 'ck1:' + rnd(32).toString('base64') });

export function runDbContract(label, setup) {
  const T = (name, fn) => test(`[${label}] ${name}`, async (t) => { const s = await getSetup(); return fn(s, t); });
  let pending = null;
  const getSetup = () => (pending ||= setup());
  const two = async (s) => { const a = await s.newUser(), b = await s.newUser(); return { a, b, A: mint(a), B: mint(b) }; };

  T('asUser accepts only a VerifiedUid (a string, a plain object, a copy are refused and fn never runs)', async ({ db, newUser }) => {
    const uid = await newUser(); let ran = false;
    for (const bad of [uid, { uid }, { uid, source: 'jwt' }, null, undefined, Object.freeze({ ...mint(uid) })]) {
      await assert.rejects(db.asUser(bad, async () => { ran = true; }), code('unverified_uid'));
    }
    assert.equal(ran, false);
    assert.equal(await db.asUser(mint(uid), async (r) => r.uid), uid);
  });

  T('accounts: created on first use, idempotent, 500 MB default quota (O1), active, not an admin until granted', async ({ db, newUser, makeAdmin }) => {
    const uid = await newUser(), U = mint(uid);
    assert.equal(await db.asUser(U, (r) => r.accounts.get()), null);
    const a1 = await db.asUser(U, (r) => r.accounts.ensure()), a2 = await db.asUser(U, (r) => r.accounts.ensure());
    assert.equal(a1.userId, uid); assert.equal(a1.status, 'active'); assert.equal(a1.storageQuotaBytes, 524288000); assert.deepEqual(a1.hardLimits, {});
    assert.equal(a2.createdAt, a1.createdAt);
    assert.equal(await db.asUser(U, (r) => r.accounts.isAdmin()), false);
    await makeAdmin(uid);
    assert.equal(await db.asUser(U, (r) => r.accounts.isAdmin()), true);
  });

  T('profile and settings: per user, replace, delete; only objects are accepted', async ({ db, newUser }) => {
    const { A, B } = await two({ newUser });
    assert.equal(await db.asUser(A, (r) => r.profile.get()), null); assert.deepEqual(await db.asUser(A, (r) => r.settings.get()), {});
    await db.asUser(A, (r) => r.profile.put({ version: 1, owner: { name: 'Aoi' } })); await db.asUser(A, (r) => r.settings.put({ theme: 'dark' }));
    await db.asUser(B, (r) => r.profile.put({ version: 1, owner: { name: 'Ben' } }));
    assert.equal((await db.asUser(A, (r) => r.profile.get())).owner.name, 'Aoi'); assert.equal((await db.asUser(B, (r) => r.profile.get())).owner.name, 'Ben');
    assert.deepEqual(await db.asUser(B, (r) => r.settings.get()), {});
    await db.asUser(A, (r) => r.profile.put({ version: 2 })); assert.deepEqual(await db.asUser(A, (r) => r.profile.get()), { version: 2 });
    for (const bad of [null, 'x', [1], 5]) await assert.rejects(db.asUser(A, (r) => r.profile.put(bad)), code('invalid_value'));
    assert.equal(await db.asUser(A, (r) => r.profile.del()), true); assert.equal(await db.asUser(A, (r) => r.profile.del()), false);
    assert.equal((await db.asUser(B, (r) => r.profile.get())).owner.name, 'Ben');
  });

  T('keys: created once (never overwritten by create), replace changes it, shapes are validated', async ({ db, newUser }) => {
    const { A, B } = await two({ newUser });
    const k1 = keyRec(), k2 = keyRec({ kekId: 'k2', dekVer: 2 });
    assert.equal(await db.asUser(A, (r) => r.keys.get()), null);
    assert.equal(await db.asUser(A, (r) => r.keys.create(k1)), true); assert.equal(await db.asUser(A, (r) => r.keys.create(k2)), false);
    const got = await db.asUser(A, (r) => r.keys.get());
    assert.ok(got.wrapped.equals(k1.wrapped) && got.iv.equals(k1.iv) && got.kekId === 'k1' && got.dekVer === 1 && got.rotatedAt === null);
    assert.equal(await db.asUser(B, (r) => r.keys.get()), null);
    await assert.rejects(db.asUser(B, (r) => r.keys.replace(k2)), code('not_found'));
    await db.asUser(A, (r) => r.keys.replace(k2));
    const g2 = await db.asUser(A, (r) => r.keys.get()); assert.ok(g2.wrapped.equals(k2.wrapped)); assert.equal(g2.dekVer, 2); assert.ok(g2.rotatedAt);
    for (const bad of [keyRec({ wrapped: rnd(47) }), keyRec({ iv: rnd(11) }), keyRec({ kekId: 'a b' }), keyRec({ dekVer: 0 })]) await assert.rejects(db.asUser(B, (r) => r.keys.create(bad)), code('invalid_value'));
    assert.equal(await db.asUser(A, (r) => r.keys.del()), true); assert.equal(await db.asUser(A, (r) => r.keys.get()), null);
  });

  T('secrets: ciphertext only, per user and per name, names validated, list never carries ciphertext', async ({ db, newUser }) => {
    const { A, B } = await two({ newUser });
    const sa = sealedRec(), sb = sealedRec({ last4: 'bbbb' });
    await db.asUser(A, (r) => r.secrets.put('GEMINI_API_KEY', sa)); await db.asUser(B, (r) => r.secrets.put('GEMINI_API_KEY', sb));
    await db.asUser(A, (r) => r.secrets.put('cx:abc:auth', sealedRec()));
    const list = await db.asUser(A, (r) => r.secrets.list());
    assert.deepEqual(list.map((x) => x.name), ['GEMINI_API_KEY', 'cx:abc:auth']);
    for (const x of list) assert.deepEqual(Object.keys(x).sort(), ['dekVer', 'last4', 'name', 'updatedAt']);
    const ga = await db.asUser(A, (r) => r.secrets.get('GEMINI_API_KEY')), gb = await db.asUser(B, (r) => r.secrets.get('GEMINI_API_KEY'));
    assert.ok(ga.ct.equals(sa.ct) && ga.iv.equals(sa.iv) && ga.last4 === 'wxyz'); assert.ok(gb.ct.equals(sb.ct));
    assert.equal(await db.asUser(B, (r) => r.secrets.get('cx:abc:auth')), null);
    await db.asUser(A, (r) => r.secrets.put('GEMINI_API_KEY', sealedRec({ last4: 'new1', dekVer: 2 })));
    assert.equal((await db.asUser(A, (r) => r.secrets.get('GEMINI_API_KEY'))).dekVer, 2);
    assert.equal((await db.asUser(A, (r) => r.secrets.allSealed())).length, 2);
    for (const bad of ['', 'a|b', 'x'.repeat(81), 'has space', 'ü']) {
      await assert.rejects(db.asUser(A, (r) => r.secrets.put(bad, sealedRec())), code('invalid_value'));
      await assert.rejects(db.asUser(A, (r) => r.secrets.get(bad)), code('invalid_value'));
    }
    await assert.rejects(db.asUser(A, (r) => r.secrets.put('OK_NAME', sealedRec({ iv: rnd(8) }))), code('invalid_value'));
    assert.equal(await db.asUser(A, (r) => r.secrets.del('cx:abc:auth')), true); assert.equal(await db.asUser(A, (r) => r.secrets.del('cx:abc:auth')), false);
    assert.equal(await db.asUser(A, (r) => r.secrets.delAll()), 1);
    assert.equal((await db.asUser(B, (r) => r.secrets.list())).length, 1);
  });

  T('devices: token hash is unique across all users, scopes are limited, the hash is never listed, revoke ends the lookup', async ({ db, newUser }) => {
    const { a, A, B } = await two({ newUser });
    const d = device();
    await db.asUser(A, (r) => r.devices.create(d));
    assert.deepEqual(await db.system.deviceLookup(d.tokenHash), { userId: a, deviceId: d.id, scopes: ['notif:push'] });
    assert.equal(await db.system.deviceLookup(rnd(32)), null);
    await assert.rejects(db.asUser(B, (r) => r.devices.create(device({ tokenHash: d.tokenHash }))), code('conflict'));
    await assert.rejects(db.asUser(A, (r) => r.devices.create(device({ id: d.id }))), code('conflict'));
    for (const bad of [device({ scopes: ['admin'] }), device({ scopes: [] }), device({ name: '' }), device({ name: 'x'.repeat(41) }), device({ id: 'XYZ' }), device({ tokenHash: rnd(31) })]) {
      await assert.rejects(db.asUser(A, (r) => r.devices.create(bad)), code('invalid_value'));
    }
    const list = await db.asUser(A, (r) => r.devices.list());
    assert.equal(list.length, 1); assert.deepEqual(Object.keys(list[0]).sort(), ['createdAt', 'id', 'lastSeenAt', 'name', 'scopes']); assert.equal(list[0].lastSeenAt, null);
    assert.equal(await db.asUser(B, (r) => r.devices.revoke(d.id)), false); assert.equal(await db.asUser(B, (r) => r.devices.rename(d.id, 'mine')), false);
    await db.asUser(A, (r) => r.devices.touch(d.id)); assert.ok((await db.asUser(A, (r) => r.devices.list()))[0].lastSeenAt);
    assert.equal(await db.asUser(A, (r) => r.devices.rename(d.id, 'tablet')), true); assert.equal((await db.asUser(A, (r) => r.devices.list()))[0].name, 'tablet');
    assert.equal(await db.asUser(A, (r) => r.devices.revoke(d.id)), true);
    assert.equal(await db.system.deviceLookup(d.tokenHash), null);
  });

  T('audit log: append and read only (newest first); an admin entry cannot be written by the user', async ({ db, newUser }) => {
    const { A, B } = await two({ newUser });
    assert.deepEqual(Object.keys((await db.asUser(A, async (r) => r.audit))).sort(), ['append', 'list']);
    await db.asUser(A, (r) => r.audit.append({ action: 'login' })); await db.asUser(A, (r) => r.audit.append({ actor: 'system', action: 'export', target: 'job1', meta: { parts: 2 } }));
    const l = await db.asUser(A, (r) => r.audit.list());
    assert.deepEqual(l.map((x) => x.action), ['export', 'login']); assert.equal(l[1].actor, 'user'); assert.equal(l[1].actorId, A.uid); assert.equal(l[0].actorId, null); assert.deepEqual(l[0].meta, { parts: 2 });
    assert.equal((await db.asUser(A, (r) => r.audit.list({ limit: 1 }))).length, 1);
    assert.deepEqual(await db.asUser(B, (r) => r.audit.list()), []);
    await assert.rejects(db.asUser(A, (r) => r.audit.append({ actor: 'admin', action: 'x' })), code('invalid_value'));
    await assert.rejects(db.asUser(A, (r) => r.audit.append({ action: '' })), code('invalid_value'));
    await assert.rejects(db.asUser(A, (r) => r.audit.list({ limit: 0 })), code('invalid_value'));
  });

  T('kv_ephemeral: set / get / delete, expires, per user, validated TTL; purgeExpired removes the expired', async ({ db, newUser, passTime }) => {
    const { A, B } = await two({ newUser });
    await db.asUser(A, (r) => r.kv.set('k', { n: 1 }, { ttlSec: 3600 })); await db.asUser(A, (r) => r.kv.set('short', 'v', { ttlSec: 1 }));
    assert.deepEqual(await db.asUser(A, (r) => r.kv.get('k')), { n: 1 }); assert.equal(await db.asUser(B, (r) => r.kv.get('k')), null);
    await db.asUser(A, (r) => r.kv.set('k', { n: 2 }, { ttlSec: 3600 })); assert.deepEqual(await db.asUser(A, (r) => r.kv.get('k')), { n: 2 });
    for (const bad of [0, -1, 8 * 86400, NaN, undefined]) await assert.rejects(db.asUser(A, (r) => r.kv.set('x', 1, { ttlSec: bad })), code('invalid_value'));
    await assert.rejects(db.asUser(A, (r) => r.kv.get('')), code('invalid_value'));
    await passTime(1300);
    assert.equal(await db.asUser(A, (r) => r.kv.get('short')), null, 'expired rows are invisible even before the sweep');
    const purged = await db.system.purgeExpired();
    assert.ok(purged.kv_ephemeral >= 1); assert.deepEqual(Object.keys(purged).sort(), ['kv_ephemeral', 'oauth_pending', 'rate_limits', 'ticket_uses']);
    assert.deepEqual(await db.asUser(A, (r) => r.kv.get('k')), { n: 2 });
    assert.equal(await db.asUser(A, (r) => r.kv.del('k')), true); assert.equal(await db.asUser(A, (r) => r.kv.del('k')), false);
  });

  T('approval tickets are single use, per user', async ({ db, newUser }) => {
    const { A, B } = await two({ newUser });
    assert.equal(await db.asUser(A, (r) => r.tickets.markUsed('jti-1', 600)), true);
    assert.equal(await db.asUser(A, (r) => r.tickets.markUsed('jti-1', 600)), false);
    assert.equal(await db.asUser(B, (r) => r.tickets.markUsed('jti-1', 600)), true);
    assert.deepEqual(await Promise.all([1, 2, 3].map(() => db.asUser(A, (r) => r.tickets.markUsed('jti-race', 600)))).then((x) => x.filter(Boolean).length), 1);
  });

  T('oauth pending: single use, only for the user who started it, expires, state hashes are unique', async ({ db, newUser, passTime }) => {
    const { A, B } = await two({ newUser });
    const h = sha('state-' + rnd(8).toString('hex')), sealed = rnd(60);
    await db.asUser(A, (r) => r.oauthPending.put({ stateHash: h, sealed, ttl: 600 }));
    assert.equal(await db.asUser(B, (r) => r.oauthPending.take(h)), null, 'another user cannot claim it');
    await assert.rejects(db.asUser(B, (r) => r.oauthPending.put({ stateHash: h, sealed: rnd(5), ttl: 600 })), code('conflict'));
    assert.ok((await db.asUser(A, (r) => r.oauthPending.take(h))).equals(sealed), 'the failed claim did not consume it');
    assert.equal(await db.asUser(A, (r) => r.oauthPending.take(h)), null, 'single use');
    const h2 = sha('s2-' + rnd(8).toString('hex'));
    await db.asUser(A, (r) => r.oauthPending.put({ stateHash: h2, sealed, ttl: 1 })); await passTime(1300);
    assert.equal(await db.asUser(A, (r) => r.oauthPending.take(h2)), null, 'expired');
    for (const bad of [{ stateHash: rnd(31), sealed, ttl: 5 }, { stateHash: h, sealed: Buffer.alloc(0), ttl: 5 }, { stateHash: h, sealed, ttl: 0 }]) await assert.rejects(db.asUser(A, (r) => r.oauthPending.put(bad)), code('invalid_value'));
  });

  T('soft limits are the user\'s own; usage numbers are read only', async ({ db, newUser }) => {
    const { A, B } = await two({ newUser });
    await db.asUser(A, (r) => r.usageLimits.put({ provider: 'gemini', metric: 'live_seconds', period: 'day', soft: 3600 }));
    await db.asUser(A, (r) => r.usageLimits.put({ provider: 'gemini', metric: 'live_seconds', period: 'day', soft: 1800, softAction: 'block' }));
    assert.deepEqual(await db.asUser(A, (r) => r.usageLimits.list()), [{ provider: 'gemini', metric: 'live_seconds', period: 'day', soft: 1800, softAction: 'block' }]);
    assert.deepEqual(await db.asUser(B, (r) => r.usageLimits.list()), []);
    for (const bad of [{ provider: '', metric: 'm', period: 'day', soft: 1 }, { provider: 'p', metric: 'm', period: 'year', soft: 1 }, { provider: 'p', metric: 'm', period: 'day', soft: -1 }, { provider: 'p', metric: 'm', period: 'day', soft: 1, softAction: 'kill' }]) {
      await assert.rejects(db.asUser(A, (r) => r.usageLimits.put(bad)), code('invalid_value'));
    }
    assert.equal(await db.asUser(B, (r) => r.usageLimits.del({ provider: 'gemini', metric: 'live_seconds', period: 'day' })), false);
    assert.equal(await db.asUser(A, (r) => r.usageLimits.del({ provider: 'gemini', metric: 'live_seconds', period: 'day' })), true);
    assert.deepEqual(await db.asUser(A, (r) => r.usage.daily({ from: '2000-01-01', to: '2999-12-31' })), []);
    assert.deepEqual(await db.asUser(A, (r) => r.usage.storage()), { filesBytes: 0, textBytes: 0, notesBytes: 0, messagesBytes: 0, reservedBytes: 0 });
    assert.deepEqual(await db.asUser(A, async (r) => Object.keys(r.usage).sort()), ['daily', 'storage'], 'no write method exists for usage numbers');
  });

  T('a failing request rolls back everything it wrote', async ({ db, newUser }) => {
    const { A } = await two({ newUser });
    await assert.rejects(db.asUser(A, async (r) => { await r.profile.put({ x: 1 }); await r.secrets.put('S', sealedRec()); await r.kv.set('k', 1, { ttlSec: 60 }); throw new Error('boom'); }), /boom/);
    assert.equal(await db.asUser(A, (r) => r.profile.get()), null); assert.deepEqual(await db.asUser(A, (r) => r.secrets.list()), []); assert.equal(await db.asUser(A, (r) => r.kv.get('k')), null);
    await assert.rejects(db.asUser(A, async (r) => { await r.profile.put({ x: 2 }); await r.secrets.put('bad name', sealedRec()); }), code('invalid_value'));
    assert.equal(await db.asUser(A, (r) => r.profile.get()), null, 'a rejected statement rolls the earlier ones back too');
  });

  T('rate limit counters: fixed windows, per bucket and caller, signed-in callers are keyed by their id', async ({ db, newUser }) => {
    const { A, B } = await two({ newUser });
    const bucket = 'rl-' + rnd(4).toString('hex'), who = 'ip-' + rnd(4).toString('hex');
    const seq = []; for (let i = 0; i < 3; i++) seq.push(await db.system.rlHit({ bucket, who, windowSec: 3600 }));
    assert.deepEqual(seq, [1, 2, 3]);
    assert.equal(await db.system.rlHit({ bucket, who: who + 'x', windowSec: 3600 }), 1);
    assert.equal(await db.system.rlHit({ bucket: bucket + 'y', who, windowSec: 3600 }), 1);
    assert.equal(await db.system.rlHit({ bucket, who: 'ignored', windowSec: 3600, userId: A }), 1);
    assert.equal(await db.system.rlHit({ bucket, who: 'ignored', windowSec: 3600, userId: A }), 2);
    assert.equal(await db.system.rlHit({ bucket, who: A.uid, windowSec: 3600 }), 3, 'same counter as the id form');
    assert.equal(await db.system.rlHit({ bucket, who: 'x', windowSec: 3600, userId: B }), 1);
    await assert.rejects(db.system.rlHit({ bucket, who, windowSec: 0 }));
    await assert.rejects(db.system.rlHit({ bucket, who, windowSec: 86401 }));
    await assert.rejects(db.system.rlHit({ bucket, who, windowSec: 60, userId: A.uid }), code('unverified_uid'));
  });

  T('nothing of one user is reachable through another user\'s repos (every repository, same names)', async ({ db, newUser }) => {
    const { A, B } = await two({ newUser });
    const h = sha('x' + rnd(8).toString('hex')), d = device();
    await db.asUser(A, async (r) => {
      await r.accounts.ensure(); await r.profile.put({ v: 1 }); await r.settings.put({ s: 1 }); await r.keys.create(keyRec()); await r.secrets.put('N', sealedRec()); await r.devices.create(d);
      await r.audit.append({ action: 'a' }); await r.kv.set('k', 1, { ttlSec: 60 }); await r.tickets.markUsed('j', 60); await r.oauthPending.put({ stateHash: h, sealed: rnd(4), ttl: 60 });
      await r.usageLimits.put({ provider: 'p', metric: 'm', period: 'day', soft: 1 });
    });
    const seenByB = await db.asUser(B, async (r) => ({
      account: await r.accounts.get(), profile: await r.profile.get(), settings: await r.settings.get(), keys: await r.keys.get(), secrets: await r.secrets.list(), sealed: await r.secrets.allSealed(),
      devices: await r.devices.list(), audit: await r.audit.list(), kv: await r.kv.get('k'), pending: await r.oauthPending.take(h), limits: await r.usageLimits.list(), ticket: await r.tickets.markUsed('j', 60),
    }));
    assert.deepEqual(seenByB, { account: null, profile: null, settings: {}, keys: null, secrets: [], sealed: [], devices: [], audit: [], kv: null, pending: null, limits: [], ticket: true });
  });

  T('deletion: after the auth user is deleted every registered table is empty for that user, the other user is untouched', async ({ db, newUser, deleteUser }) => {
    const { a, b, A, B } = await two({ newUser });
    for (const [U, uid] of [[A, a], [B, b]]) {
      await db.asUser(U, async (r) => {
        await r.accounts.ensure(); await r.profile.put({ v: 1 }); await r.settings.put({ s: 1 }); await r.keys.create(keyRec()); await r.secrets.put('N', sealedRec()); await r.devices.create(device());
        await r.audit.append({ action: 'a' }); await r.kv.set('k', 1, { ttlSec: 3600 }); await r.tickets.markUsed('j', 3600); await r.oauthPending.put({ stateHash: sha('p' + uid), sealed: rnd(4), ttl: 3600 });
        await r.usageLimits.put({ provider: 'p', metric: 'm', period: 'day', soft: 1 });
      });
      await db.system.rlHit({ bucket: 'del-test', who: uid, windowSec: 3600, userId: U });
    }
    const before = await residualCheck(db, A);
    assert.equal(before.clean, false); assert.deepEqual(before.missing, []); assert.deepEqual(before.unknown, []);
    const counts = Object.fromEntries(before.nonzero.map((x) => [x.table, x.n]));
    for (const t of ['accounts', 'profiles', 'settings', 'user_keys', 'user_secrets', 'devices', 'audit_log', 'kv_ephemeral', 'ticket_uses', 'oauth_pending', 'usage_limits', 'rate_limits']) assert.ok(counts[t] >= 1, t);
    const bBefore = await residualCheck(db, B);
    await deleteUser(a);
    const after = await residualCheck(db, A);
    assert.deepEqual({ clean: after.clean, nonzero: after.nonzero }, { clean: true, nonzero: [] });
    assert.equal(after.tablesChecked, registryTables().length);
    assert.deepEqual(await residualCheck(db, B), bBefore);
    assert.deepEqual((await db.asUser(B, (r) => r.secrets.list())).map((x) => x.name), ['N']);
  });

  // ---- envelope encryption on top of the repositories
  T('envelope: a secret round-trips, is stored as ciphertext, and cannot be moved to another user or another name', async ({ db, newUser }) => {
    const { A, B } = await two({ newUser });
    const ring = createKeyring({ kek: testKek() });
    const value = 'AIzaSy-test-value-0000';
    await db.asUser(A, (r) => ring.setSecret(r, 'GEMINI_API_KEY', value));
    assert.equal(await db.asUser(A, (r) => ring.getSecret(r, 'GEMINI_API_KEY')), value);
    assert.deepEqual(await db.asUser(A, (r) => ring.secretStatus(r)).then((s) => s.map(({ name, set, last4 }) => ({ name, set, last4 }))), [{ name: 'GEMINI_API_KEY', set: true, last4: '0000' }]);
    const stored = await db.asUser(A, (r) => r.secrets.get('GEMINI_API_KEY'));
    assert.ok(!stored.ct.includes(Buffer.from(value)), 'ciphertext does not contain the plain value');
    // B has its own key. Copying A's row into B's account (same name) or into A's account under another name must not open.
    await db.asUser(B, (r) => ring.setSecret(r, 'OTHER', 'b-secret-value-1234'));
    await db.asUser(B, (r) => r.secrets.put('GEMINI_API_KEY', stored));
    await assert.rejects(db.asUser(B, (r) => ring.getSecret(r, 'GEMINI_API_KEY')), code('secret_unreadable'));
    await db.asUser(A, (r) => r.secrets.put('GROQ_API_KEY', stored));
    await assert.rejects(db.asUser(A, (r) => ring.getSecret(r, 'GROQ_API_KEY')), code('secret_unreadable'));
    assert.equal(await db.asUser(A, (r) => ring.getSecret(r, 'EXA_API_KEY')), null);
  });

  T('envelope: two requests creating the first key at the same time end up with one DEK', async ({ db, newUser }) => {
    const { A } = await two({ newUser });
    const kek = testKek(), r1 = createKeyring({ kek }), r2 = createKeyring({ kek });   // separate caches: the race is decided by the database
    const [x, y] = await Promise.all([db.asUser(A, (r) => r1.dek(r)), db.asUser(A, (r) => r2.dek(r))]);
    assert.ok(x.dek.equals(y.dek)); assert.equal(x.dekVer, 1);
    assert.ok((await db.asUser(A, (r) => createKeyring({ kek }).dek(r))).dek.equals(x.dek));
  });

  T('envelope: DEK rotation re-encrypts every secret in one transaction; the old DEK and old derived keys stop working; a failure keeps the old state', async ({ db, newUser }) => {
    const { A } = await two({ newUser });
    const kek = testKek(), ring = createKeyring({ kek });
    await db.asUser(A, async (r) => { await ring.setSecret(r, 'S1', 'value-one-0001'); await ring.setSecret(r, 'S2', 'value-two-0002'); });
    const tk1 = await db.asUser(A, (r) => ring.ticketKey(r)), dek1 = (await db.asUser(A, (r) => ring.dek(r))).dek;
    const old = await db.asUser(A, (r) => r.secrets.get('S1'));
    const res = await db.asUser(A, (r) => ring.rotateDek(r)); assert.deepEqual(res, { dekVer: 2, reencrypted: 2 });
    assert.equal(await db.asUser(A, (r) => ring.getSecret(r, 'S1')), 'value-one-0001'); assert.equal(await db.asUser(A, (r) => ring.getSecret(r, 'S2')), 'value-two-0002');
    assert.equal((await db.asUser(A, (r) => r.secrets.get('S1'))).dekVer, 2);
    assert.ok(!(await db.asUser(A, (r) => ring.ticketKey(r))).equals(tk1), 'approval tickets die with the old DEK');
    assert.ok(!(await db.asUser(A, (r) => ring.dek(r))).dek.equals(dek1));
    // the old ciphertext no longer opens under the new key (put it back as if from a backup)
    await db.asUser(A, (r) => r.secrets.put('S1', old));
    await assert.rejects(db.asUser(A, (r) => ring.getSecret(r, 'S1')), code('secret_unreadable'));
    await db.asUser(A, (r) => ring.setSecret(r, 'S1', 'value-one-0001'));
    // a rotation that fails half way leaves nothing changed
    await assert.rejects(db.asUser(A, async (r) => { await ring.rotateDek(r); throw new Error('abort'); }), /abort/);
    ring.forget(A.uid);
    assert.equal((await db.asUser(A, (r) => r.keys.get())).dekVer, 2);
    assert.equal(await db.asUser(A, (r) => ring.getSecret(r, 'S1')), 'value-one-0001'); assert.equal(await db.asUser(A, (r) => ring.getSecret(r, 'S2')), 'value-two-0002');
  });

  T('envelope: KEK rotation re-wraps the DEK under the new key; the data does not change; the old key can be dropped afterwards', async ({ db, newUser }) => {
    const { A } = await two({ newUser });
    const k1 = 'old1:' + rnd(32).toString('base64'), k2 = 'new2:' + rnd(32).toString('base64');
    const ringOld = createKeyring({ kek: envKekProvider({ ELVAR_KEK: k1 }) });
    await db.asUser(A, (r) => ringOld.setSecret(r, 'S', 'value-0003-abcd'));
    const ringMid = createKeyring({ kek: envKekProvider({ ELVAR_KEK: k2, ELVAR_KEK_PREV: k1 }) });
    assert.equal(await db.asUser(A, (r) => ringMid.getSecret(r, 'S')), 'value-0003-abcd', 'readable while the old key is still configured');
    assert.equal((await db.asUser(A, (r) => r.keys.get())).kekId, 'old1');
    assert.equal(await db.asUser(A, (r) => ringMid.rewrap(r)), true); assert.equal(await db.asUser(A, (r) => ringMid.rewrap(r)), false);
    assert.equal((await db.asUser(A, (r) => r.keys.get())).kekId, 'new2');
    const ringNew = createKeyring({ kek: envKekProvider({ ELVAR_KEK: k2 }) });
    assert.equal(await db.asUser(A, (r) => ringNew.getSecret(r, 'S')), 'value-0003-abcd', 'readable with only the new key');
    await assert.rejects(db.asUser(A, (r) => ringOld.forget(A.uid) || ringOld.getSecret(r, 'S')), code('kek_unknown'));
  });
}
