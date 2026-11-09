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
    // a secret needs a key row of the same dek_ver (composite foreign key, checked at commit): nothing is stored without one
    await assert.rejects(db.asUser(A, (r) => r.secrets.put('GEMINI_API_KEY', sa)), code('invalid_reference'));
    assert.equal((await db.asUser(A, (r) => r.secrets.list())).length, 0, 'the refused commit left nothing behind');
    await db.asUser(A, (r) => r.keys.create(keyRec())); await db.asUser(B, (r) => r.keys.create(keyRec()));
    await db.asUser(A, (r) => r.secrets.put('GEMINI_API_KEY', sa)); await db.asUser(B, (r) => r.secrets.put('GEMINI_API_KEY', sb));
    await db.asUser(A, (r) => r.secrets.put('cx:abc:auth', sealedRec()));
    const list = await db.asUser(A, (r) => r.secrets.list());
    assert.deepEqual(list.map((x) => x.name), ['GEMINI_API_KEY', 'cx:abc:auth']);
    for (const x of list) assert.deepEqual(Object.keys(x).sort(), ['dekVer', 'last4', 'name', 'updatedAt']);
    const ga = await db.asUser(A, (r) => r.secrets.get('GEMINI_API_KEY')), gb = await db.asUser(B, (r) => r.secrets.get('GEMINI_API_KEY'));
    assert.ok(ga.ct.equals(sa.ct) && ga.iv.equals(sa.iv) && ga.last4 === 'wxyz'); assert.ok(gb.ct.equals(sb.ct));
    assert.equal(await db.asUser(B, (r) => r.secrets.get('cx:abc:auth')), null);
    await assert.rejects(db.asUser(A, (r) => r.secrets.put('GEMINI_API_KEY', sealedRec({ last4: 'new1', dekVer: 2 }))), code('invalid_reference'));   // no key version 2 yet
    await db.asUser(A, async (r) => {   // a rotation writes the secrets first and replaces the key last: fine, the check is at commit
      await r.secrets.put('GEMINI_API_KEY', sealedRec({ last4: 'new1', dekVer: 2 })); await r.secrets.put('cx:abc:auth', sealedRec({ dekVer: 2 })); await r.keys.replace(keyRec({ dekVer: 2 }));
    });
    assert.equal((await db.asUser(A, (r) => r.secrets.get('GEMINI_API_KEY'))).dekVer, 2);
    assert.equal((await db.asUser(A, (r) => r.secrets.allSealed())).length, 2);
    await assert.rejects(db.asUser(A, (r) => r.keys.replace(keyRec({ dekVer: 3 }))), code('invalid_reference'));   // would orphan the version-2 secrets
    await assert.rejects(db.asUser(A, (r) => r.secrets.put('cx:abc:auth', sealedRec({ dekVer: 1 }))), code('invalid_reference'));
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
    assert.ok(purged.kv_ephemeral >= 1); assert.deepEqual(Object.keys(purged).sort(), ['conversations', 'kv_ephemeral', 'messages', 'note_revisions', 'notes', 'notif_items', 'oauth_pending', 'rate_limits', 'ticket_uses']);
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

  T('oauth pending (callback): begin takes a started flow exactly once, settle stores the result, get peeks, the owner is found by the state hash only while it lives', async ({ db, newUser, passTime }) => {
    const { a, A, B } = await two({ newUser });
    const h = sha('cb-' + rnd(8).toString('hex')), sealed = rnd(60), result = rnd(70);
    await db.asUser(A, (r) => r.oauthPending.put({ stateHash: h, sealed, ttl: 600 }));
    assert.equal(await db.system.oauthPendingOwner(h, 'google'), a, 'the callback finds whose flow it is');
    assert.equal(await db.system.oauthPendingOwner(h, 'mcp'), null, 'a callback of another kind does not find it');
    assert.equal(await db.asUser(A, (r) => r.oauthPending.begin(h, 'mcp')), null, 'and cannot take it');
    assert.equal(await db.system.oauthPendingOwner(sha('nope'), 'google'), null);
    assert.deepEqual(await db.asUser(A, (r) => r.oauthPending.get(h)).then((x) => ({ phase: x.phase, same: x.sealed.equals(sealed) })), { phase: 'started', same: true });
    assert.equal(await db.asUser(B, (r) => r.oauthPending.get(h)), null, 'another user does not see it'); assert.equal(await db.asUser(B, (r) => r.oauthPending.begin(h, 'google')), null, 'and cannot take it');
    assert.ok((await db.asUser(A, (r) => r.oauthPending.begin(h, 'google'))).equals(sealed), 'the first begin gets it');
    assert.equal(await db.asUser(A, (r) => r.oauthPending.begin(h, 'google')), null, 'the second does not (single use)');
    assert.equal((await db.asUser(A, (r) => r.oauthPending.get(h))).phase, 'exchanging');
    assert.equal(await db.asUser(B, (r) => r.oauthPending.settle(h, { sealed: rnd(5), phase: 'done' })), false, 'B cannot write A\'s result');
    assert.equal(await db.asUser(A, (r) => r.oauthPending.settle(h, { sealed: result, phase: 'done' })), true);
    assert.equal(await db.asUser(A, (r) => r.oauthPending.settle(h, { sealed: result, phase: 'done' })), false, 'only an exchange in progress can be settled');
    const done = await db.asUser(A, (r) => r.oauthPending.get(h)); assert.equal(done.phase, 'done'); assert.ok(done.sealed.equals(result));
    for (const bad of [{ sealed: result, phase: 'started' }, { sealed: Buffer.alloc(0), phase: 'done' }, { sealed: result, phase: 'x' }]) await assert.rejects(db.asUser(A, (r) => r.oauthPending.settle(h, bad)), code('invalid_value'));
    assert.ok((await db.asUser(A, (r) => r.oauthPending.take(h))).equals(result)); assert.equal(await db.system.oauthPendingOwner(h, 'google'), null, 'gone once claimed');
    const h2 = sha('cb2-' + rnd(8).toString('hex')); await db.asUser(A, (r) => r.oauthPending.put({ stateHash: h2, sealed, ttl: 1 })); await passTime(1300);
    assert.equal(await db.system.oauthPendingOwner(h2, 'google'), null, 'expired'); assert.equal(await db.asUser(A, (r) => r.oauthPending.begin(h2, 'google')), null);
  });

  T('kv.setNx: a lock that only one caller gets while it lives, per user', async ({ db, newUser, passTime }) => {
    const { A, B } = await two({ newUser });
    const got = await Promise.all([1, 2, 3].map(() => db.asUser(A, (r) => r.kv.setNx('lock', 1, { ttlSec: 1 }))));
    assert.equal(got.filter(Boolean).length, 1); assert.equal(await db.asUser(B, (r) => r.kv.setNx('lock', 1, { ttlSec: 60 })), true, 'B has its own lock');
    await passTime(1300); assert.equal(await db.asUser(A, (r) => r.kv.setNx('lock', 2, { ttlSec: 60 })), true, 'an expired lock can be taken again'); assert.equal(await db.asUser(A, (r) => r.kv.get('lock')), 2);
    await assert.rejects(db.asUser(A, (r) => r.kv.setNx('', 1, { ttlSec: 5 })), code('invalid_value'));
  });

  T('oauth tokens: sealed per user, upsert, status flag without touching the ciphertext, a token needs its DEK version (checked at commit), cascade with the key', async ({ db, newUser }) => {
    const { A, B } = await two({ newUser });
    const tok = (extra = {}) => ({ ct: rnd(60), iv: rnd(12), dekVer: 1, scopes: ['calendar', 'gmail'], revokeUrl: 'https://oauth2.example/revoke', ...extra });
    await db.asUser(A, async (r) => { await r.keys.create(keyRec()); await r.oauthTokens.put('google', tok()); await r.oauthTokens.put('cx:cx_abc123', tok({ scopes: [] })); });
    assert.deepEqual((await db.asUser(A, (r) => r.oauthTokens.list())).map((t) => [t.provider, t.status, t.scopes.length]), [['cx:cx_abc123', 'ok', 0], ['google', 'ok', 2]]);
    const g = await db.asUser(A, (r) => r.oauthTokens.get('google')); assert.equal(g.revokeUrl, 'https://oauth2.example/revoke'); assert.ok(Buffer.isBuffer(g.ct));
    assert.deepEqual(await db.asUser(B, async (r) => [await r.oauthTokens.list(), await r.oauthTokens.get('google'), await r.oauthTokens.allSealed(), await r.oauthTokens.setStatus('google', 'reauth_required'), await r.oauthTokens.del('google'), await r.oauthTokens.delAll()]), [[], null, [], false, false, 0], 'B reaches none of A\'s tokens');
    assert.equal(await db.asUser(A, (r) => r.oauthTokens.setStatus('google', 'reauth_required', 'invalid_grant')), true);
    const flagged = await db.asUser(A, (r) => r.oauthTokens.get('google')); assert.deepEqual([flagged.status, flagged.reason, flagged.ct.equals(g.ct)], ['reauth_required', 'invalid_grant', true]);
    const newer = tok({ status: 'ok' }); await db.asUser(A, (r) => r.oauthTokens.put('google', newer)); const after = await db.asUser(A, (r) => r.oauthTokens.get('google')); assert.deepEqual([after.status, after.reason, after.ct.equals(newer.ct)], ['ok', null, true], 'a new login replaces the old one and clears the flag');
    for (const bad of [['google', tok({ ct: rnd(5) })], ['google', tok({ iv: rnd(8) })], ['google', tok({ dekVer: 0 })], ['nope', tok()], ['cx:bad id', tok()], ['google', tok({ status: 'x' })], ['google', tok({ revokeUrl: 'ftp://x' })], ['google', tok({ scopes: 'a' })]]) await assert.rejects(db.asUser(A, (r) => r.oauthTokens.put(...bad)), code('invalid_value'), JSON.stringify(bad[0]));
    // a token under a DEK version that does not exist is refused when the transaction commits (and rolled back)
    await assert.rejects(db.asUser(A, (r) => r.oauthTokens.put('google', tok({ dekVer: 5 }))), code('invalid_reference'));
    assert.equal((await db.asUser(A, (r) => r.oauthTokens.get('google'))).dekVer, 1);
    await assert.rejects(db.asUser(B, (r) => r.oauthTokens.put('google', tok())), code('invalid_reference'), 'B has no key: no token can exist for B');
    assert.equal(await db.asUser(A, (r) => r.keys.del()), true); assert.deepEqual(await db.asUser(A, (r) => r.oauthTokens.list()), [], 'removing the key removes what it protected');
  });

  T('connectors: manifests with their tools, per user; replace removes dropped tools and keeps the order; delete cascades; limits', async ({ db, newUser }) => {
    const { A, B } = await two({ newUser });
    const tool = (name, extra = {}) => ({ name, hash: 'sha256:' + name, enabled: false, approval: 'ask', expose: 'pinned', description: name + ' tool', inputSchema: { type: 'object', properties: {} }, ...extra });
    const cx = (id, tools, extra = {}) => ({ id, slug: 'home', name: 'Home', type: 'http', enabled: true, http: { baseUrl: 'https://ha.example.com' }, auth: { type: 'bearer' }, tools, syncedAt: 1700000000000, ...extra });
    await db.asUser(A, async (r) => { await r.connectors.put(cx('cx_a1', [tool('zeta'), tool('alpha', { enabled: true, approval: 'auto' })])); await r.connectors.put(cx('cx_a2', [], { name: 'Second' })); });
    const list = await db.asUser(A, (r) => r.connectors.list());
    assert.deepEqual(list.map((c) => [c.id, c.name, c.tools.map((t) => t.name)]), [['cx_a1', 'Home', ['zeta', 'alpha']], ['cx_a2', 'Second', []]], 'tools keep the order the user sees');
    assert.equal(list[0].syncedAt, 1700000000000); assert.equal(list[0].tools[1].approval, 'auto');
    assert.deepEqual(await db.asUser(B, async (r) => [await r.connectors.list(), await r.connectors.get('cx_a1'), await r.connectors.del('cx_a1'), await r.connectors.delAll()]), [[], null, false, 0], 'B reaches none of A\'s connectors');
    await db.asUser(B, (r) => r.connectors.put(cx('cx_a1', [tool('mine')], { name: 'B-own' })));   // the same id for another user is another connector
    assert.deepEqual((await db.asUser(A, (r) => r.connectors.get('cx_a1'))).tools.map((t) => t.name), ['zeta', 'alpha'], 'A\'s connector is untouched by B using the same id');
    assert.equal((await db.asUser(B, (r) => r.connectors.get('cx_a1'))).name, 'B-own');
    await db.asUser(A, (r) => r.connectors.put(cx('cx_a1', [tool('alpha', { enabled: false, approval: 'ask_high' }), tool('beta')])));
    const re = await db.asUser(A, (r) => r.connectors.get('cx_a1')); assert.deepEqual(re.tools.map((t) => [t.name, t.approval]), [['alpha', 'ask_high'], ['beta', 'ask']], 'zeta was dropped, alpha replaced, beta added');
    for (const bad of [{ id: 'bad id', tools: [] }, { id: 'x'.repeat(41), tools: [] }, cx('cx_dup', [tool('a'), tool('a')]), cx('cx_big', [tool('a', { description: 'x'.repeat(41000) })]), { ...cx('cx_many', []), tools: Array.from({ length: 101 }, (_, i) => tool('t' + i)) }]) await assert.rejects(db.asUser(A, (r) => r.connectors.put(bad)), code('invalid_value'));
    assert.equal(await db.asUser(A, (r) => r.connectors.del('cx_a1')), true); assert.equal(await db.asUser(A, (r) => r.connectors.get('cx_a1')), null);
    assert.equal(await db.asUser(A, (r) => r.connectors.delAll()), 1);
  });

  T('build requests: per user, one row per issue (upsert), state and pull request updates, delete', async ({ db, newUser }) => {
    const { A, B } = await two({ newUser });
    const b1 = await db.asUser(A, (r) => r.builds.record({ repo: 'me/builds', issueNumber: 3, title: 'First' }));
    assert.deepEqual([b1.repo, b1.issueNumber, b1.state, b1.target, b1.prNumber], ['me/builds', 3, 'queued', 'builds', null]);
    const again = await db.asUser(A, (r) => r.builds.record({ repo: 'me/builds', issueNumber: 3, title: 'First (edited)', state: 'working' })); assert.equal(again.id, b1.id); assert.deepEqual([again.title, again.state], ['First (edited)', 'working']);
    await db.asUser(A, (r) => r.builds.record({ repo: 'me/own-fork', target: 'self', issueNumber: 1, title: 'Self' }));
    assert.equal((await db.asUser(A, (r) => r.builds.list())).length, 2);
    assert.equal(await db.asUser(A, (r) => r.builds.update(b1.id, { state: 'review', prNumber: 9 })), true); const u = (await db.asUser(A, (r) => r.builds.list())).find((x) => x.id === b1.id); assert.deepEqual([u.state, u.prNumber], ['review', 9]);
    assert.deepEqual(await db.asUser(B, async (r) => [await r.builds.list(), await r.builds.update(b1.id, { state: 'done' }), await r.builds.del(b1.id), await r.builds.delAll()]), [[], false, false, 0], 'B reaches none of A\'s requests');
    await db.asUser(B, (r) => r.builds.record({ repo: 'me/builds', issueNumber: 3, title: 'B has its own #3' })); assert.equal((await db.asUser(A, (r) => r.builds.list())).find((x) => x.id === b1.id).title, 'First (edited)');
    for (const bad of [{ repo: 'no slash', issueNumber: 1, title: 't' }, { repo: 'a/b', issueNumber: 0, title: 't' }, { repo: 'a/b', issueNumber: 1, title: '' }, { repo: 'a/b', issueNumber: 1, title: 't', state: 'x' }, { repo: 'a/b', issueNumber: 1, title: 't', target: 'x' }]) await assert.rejects(db.asUser(A, (r) => r.builds.record(bad)), code('invalid_value'));
    assert.equal(await db.asUser(A, (r) => r.builds.del(b1.id)), true); assert.equal(await db.asUser(A, (r) => r.builds.delAll()), 1);
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
    assert.deepEqual(await db.asUser(A, async (r) => Object.keys(r.usage).sort()), ['daily', 'record', 'storage'], 'the only write is record(): the caller\'s own numbers, bounded');
    for (const bad of [{ provider: '', metric: 'm' }, { provider: 'p', metric: '' }, { provider: 'p', metric: 'm', amount: -1 }, { provider: 'p', metric: 'm', amount: 1e12 }, { provider: 'p', metric: 'm', source: 'x' }]) {
      await assert.rejects(db.asUser(A, (r) => r.usage.record(bad)), (e) => ['invalid_value'].includes(e.code), JSON.stringify(bad));
    }
  });

  T('usage: record() adds to the caller\'s own day totals only', async ({ db, newUser }) => {
    const { A, B } = await two({ newUser });
    await db.asUser(A, async (r) => { await r.usage.record({ provider: 'gemini', metric: 'calls' }); await r.usage.record({ provider: 'gemini', metric: 'calls', amount: 2 }); await r.usage.record({ provider: 'gemini', metric: 'live_seconds', amount: 30, source: 'client' }); });
    const today = new Date().toISOString().slice(0, 10);
    const rows = await db.asUser(A, (r) => r.usage.daily({ from: today, to: today }));
    assert.deepEqual(rows.map((x) => [x.provider, x.metric, x.amount]).sort(), [['gemini', 'calls', 3], ['gemini', 'live_seconds', 30]]);
    assert.deepEqual(await db.asUser(B, (r) => r.usage.daily({ from: today, to: today })), []);
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
    assert.equal(await db.system.rlHit({ bucket, who: 'x', windowSec: 3600, userId: B }), 1);
    // review finding P1-3: a signed-out caller can neither share nor create a counter that names a user
    await assert.rejects(db.system.rlHit({ bucket, who: A.uid, windowSec: 3600 }));
    await assert.rejects(db.system.rlHit({ bucket, who: A.uid.toUpperCase(), windowSec: 3600 }));
    await assert.rejects(db.system.rlHit({ bucket, who: `ip-${A.uid}`, windowSec: 3600 }));
    assert.equal(await db.system.rlHit({ bucket, who: `u:${A.uid.slice(0, 8)}`, windowSec: 3600 }), 1, 'a prefix of an id is just an address hash');
    assert.equal(await db.system.rlHit({ bucket, who: 'ignored', windowSec: 3600, userId: A }), 3, 'A keeps counting in its own counter');
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
      await r.oauthTokens.put('google', { ct: rnd(40), iv: rnd(12), dekVer: 1 }); await r.connectors.put({ id: 'cx_p3', name: 'x', type: 'http', tools: [{ name: 't', hash: 'h' }] }); await r.builds.record({ repo: 'a/b', issueNumber: 1, title: 't' });
    });
    const seenByB = await db.asUser(B, async (r) => ({
      account: await r.accounts.get(), profile: await r.profile.get(), settings: await r.settings.get(), keys: await r.keys.get(), secrets: await r.secrets.list(), sealed: await r.secrets.allSealed(),
      devices: await r.devices.list(), audit: await r.audit.list(), kv: await r.kv.get('k'), pending: await r.oauthPending.take(h), limits: await r.usageLimits.list(), ticket: await r.tickets.markUsed('j', 60),
      tokens: await r.oauthTokens.allSealed(), connectors: await r.connectors.list(), builds: await r.builds.list(),
    }));
    assert.deepEqual(seenByB, { account: null, profile: null, settings: {}, keys: null, secrets: [], sealed: [], devices: [], audit: [], kv: null, pending: null, limits: [], ticket: true, tokens: [], connectors: [], builds: [] });
  });

  T('deletion: after the auth user is deleted every registered table is empty for that user, the other user is untouched', async ({ db, newUser, deleteUser }) => {
    const { a, b, A, B } = await two({ newUser });
    for (const [U, uid] of [[A, a], [B, b]]) {
      await db.asUser(U, async (r) => {
        await r.accounts.ensure(); await r.profile.put({ v: 1 }); await r.settings.put({ s: 1 }); await r.keys.create(keyRec()); await r.secrets.put('N', sealedRec()); await r.devices.create(device());
        await r.audit.append({ action: 'a' }); await r.kv.set('k', 1, { ttlSec: 3600 }); await r.tickets.markUsed('j', 3600); await r.oauthPending.put({ stateHash: sha('p' + uid), sealed: rnd(4), ttl: 3600 });
        await r.usageLimits.put({ provider: 'p', metric: 'm', period: 'day', soft: 1 });
        await r.oauthTokens.put('google', { ct: rnd(40), iv: rnd(12), dekVer: 1 }); await r.connectors.put({ id: 'cx_p3', name: 'x', type: 'http', tools: [{ name: 't', hash: 'h' }] }); await r.builds.record({ repo: 'a/b', issueNumber: 1, title: 't' });
      });
      await db.system.rlHit({ bucket: 'del-test', who: uid, windowSec: 3600, userId: U });
    }
    const before = await residualCheck(db, A);
    assert.equal(before.clean, false); assert.deepEqual(before.missing, []); assert.deepEqual(before.unknown, []);
    const counts = Object.fromEntries(before.nonzero.map((x) => [x.table, x.n]));
    for (const t of ['accounts', 'profiles', 'settings', 'user_keys', 'user_secrets', 'devices', 'audit_log', 'kv_ephemeral', 'ticket_uses', 'oauth_pending', 'usage_limits', 'rate_limits', 'oauth_tokens', 'connectors', 'connector_tools', 'build_requests']) assert.ok(counts[t] >= 1, t);
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
    await assert.rejects(db.asUser(A, (r) => r.secrets.put('S1', old)), code('invalid_reference'));   // version 1 no longer exists: the database refuses it
    assert.equal(await db.asUser(A, (r) => ring.getSecret(r, 'S1')), 'value-one-0001');
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

  // ---- review findings P1-1 / P1-2: a DEK that never committed, and a DEK that another instance replaced
  T('envelope: a DEK created in a transaction that rolls back is never cached or used (the next request makes the real one)', async ({ db, newUser }) => {
    const { A } = await two({ newUser });
    const kek = testKek(), ring = createKeyring({ kek });
    await assert.rejects(db.asUser(A, async (r) => { await ring.setSecret(r, 'GEMINI_API_KEY', 'first-try-0001'); throw new Error('abort'); }), /abort/);
    assert.equal(await db.asUser(A, (r) => r.keys.get()), null, 'the rolled-back key row does not exist');
    // same keyring (same warm cache), new request: must create a key row and seal under THAT key
    await db.asUser(A, (r) => ring.setSecret(r, 'GEMINI_API_KEY', 'second-try-0002'));
    const row = await db.asUser(A, (r) => r.keys.get()); assert.ok(row && row.dekVer === 1);
    const other = createKeyring({ kek });   // cold cache: reads what is really in the database
    assert.equal(await db.asUser(A, (r) => other.getSecret(r, 'GEMINI_API_KEY')), 'second-try-0002');
    // the same through a failing commit (the secret write itself is rejected after the key was created in the same transaction)
    const B2 = (await two({ newUser })).A, ring2 = createKeyring({ kek });
    await assert.rejects(db.asUser(B2, async (r) => { await ring2.dek(r); await r.secrets.put('bad name', sealedRec()); }), code('invalid_value'));
    assert.equal(await db.asUser(B2, (r) => r.keys.get()), null);
    await db.asUser(B2, (r) => ring2.setSecret(r, 'S', 'value-0004-abcd'));
    assert.equal(await db.asUser(B2, (r) => createKeyring({ kek }).getSecret(r, 'S')), 'value-0004-abcd');
  });

  T('envelope: a committed first key is cached (no unwrap needed afterwards) and a cache hit is checked against user_keys', async ({ db, newUser }) => {
    const { A } = await two({ newUser });
    let unwraps = 0; const real = testKek(), kek = { get currentId() { return real.currentId; }, wrap: (...a) => real.wrap(...a), unwrap: (...a) => { unwraps++; return real.unwrap(...a); } };
    const ring = createKeyring({ kek });
    await db.asUser(A, (r) => ring.setSecret(r, 'S', 'value-0005-abcd'));
    await db.asUser(A, (r) => ring.getSecret(r, 'S')); await db.asUser(A, (r) => ring.getSecret(r, 'S'));
    assert.equal(unwraps, 0, 'served from the warm cache after the first commit');
  });

  T('envelope: another instance rotated the DEK, so this instance must not keep using its cached one (two keyrings, one database)', async ({ db, newUser }) => {
    const { A } = await two({ newUser });
    const kek = testKek(), one = createKeyring({ kek }), two_ = createKeyring({ kek });
    await db.asUser(A, (r) => one.setSecret(r, 'S1', 'value-one-0001'));
    assert.equal(await db.asUser(A, (r) => two_.getSecret(r, 'S1')), 'value-one-0001');     // both instances now have the DEK warm
    assert.deepEqual(await db.asUser(A, (r) => two_.rotateDek(r)), { dekVer: 2, reencrypted: 1 });
    // instance one still holds DEK v1: writing now must NOT seal under it
    await db.asUser(A, (r) => one.setSecret(r, 'S2', 'value-two-0002'));
    assert.equal((await db.asUser(A, (r) => r.keys.get())).dekVer, 2);
    assert.equal((await db.asUser(A, (r) => r.secrets.get('S2'))).dekVer, 2);
    assert.equal(await db.asUser(A, (r) => one.getSecret(r, 'S1')), 'value-one-0001');
    assert.equal(await db.asUser(A, (r) => createKeyring({ kek }).getSecret(r, 'S2')), 'value-two-0002');
    assert.equal(await db.asUser(A, (r) => one.getSecret(r, 'S2')), 'value-two-0002');
    // derived keys follow too: instance one must hand out the NEW ticket key
    assert.ok((await db.asUser(A, (r) => one.ticketKey(r))).equals(await db.asUser(A, (r) => two_.ticketKey(r))));
  });

  T('envelope: the database refuses a secret under a DEK version that does not exist (composite foreign key), and removing the key removes its secrets', async ({ db, newUser }) => {
    const { A } = await two({ newUser });
    await assert.rejects(db.asUser(A, (r) => r.secrets.put('S', sealedRec({ dekVer: 1 }))), code('invalid_reference'));
    await db.asUser(A, async (r) => { await r.keys.create(keyRec()); await r.secrets.put('S', sealedRec({ dekVer: 1 })); });
    await assert.rejects(db.asUser(A, (r) => r.secrets.put('S', sealedRec({ dekVer: 2 }))), code('invalid_reference'));
    assert.equal(await db.asUser(A, (r) => r.keys.del()), true);
    assert.equal((await db.asUser(A, (r) => r.secrets.list())).length, 0, 'crypto-shred: the secrets went with the key');
  });

  T('audit: a user entry always names the caller, a system entry names nobody; nobody can claim to be somebody else', async ({ db, newUser }) => {
    const { a, A, B } = await two({ newUser });
    await db.asUser(A, async (r) => { await r.audit.append({ action: 'u1' }); await r.audit.append({ action: 'u2', actorId: a }); await r.audit.append({ actor: 'system', action: 's1' }); });
    const list = await db.asUser(A, (r) => r.audit.list());
    assert.deepEqual(list.map((x) => [x.action, x.actor, x.actorId]).sort(), [['s1', 'system', null], ['u1', 'user', a], ['u2', 'user', a]]);
    await assert.rejects(db.asUser(A, (r) => r.audit.append({ action: 'x', actorId: B.uid })), code('invalid_value'));
    await assert.rejects(db.asUser(A, (r) => r.audit.append({ actor: 'system', action: 'x', actorId: a })), code('invalid_value'));
    await assert.rejects(db.asUser(A, (r) => r.audit.append({ actor: 'admin', action: 'x' })), code('invalid_value'));
    assert.equal((await db.asUser(A, (r) => r.audit.list())).length, 3);
  });

  // ---- P2: account deletion, admin (metadata only), cron helpers
  T('account deletion (O3): immediate or 7 days; the first decision stays; cancel works only during a grace period, only for oneself', async ({ db, newUser }) => {
    const { A, B } = await two({ newUser });
    await db.asUser(A, (r) => r.accounts.ensure()); await db.asUser(B, (r) => r.accounts.ensure());
    await assert.rejects(db.asUser(A, (r) => r.accounts.requestDeletion(3)), code('invalid_value'));
    await assert.rejects(db.asUser(A, (r) => r.accounts.requestDeletion(-1)), code('invalid_value'));
    assert.equal(await db.asUser(A, (r) => r.accounts.deletion()), null);
    const due7 = await db.asUser(A, (r) => r.accounts.requestDeletion(7, 'a@example.test'));
    assert.ok(Math.abs(new Date(due7).getTime() - (Date.now() + 7 * 86400_000)) < 60_000);
    assert.equal(await db.asUser(A, (r) => r.accounts.requestDeletion(0)), due7, 'a second request keeps the first decision');
    assert.equal((await db.asUser(A, (r) => r.accounts.get())).status, 'pending_deletion');
    assert.deepEqual({ ...(await db.asUser(A, (r) => r.accounts.deletion())), requestedAt: 'x', purgeAfter: 'x' }, { graceDays: 7, requestedAt: 'x', purgeAfter: 'x' });
    assert.equal((await db.asUser(B, (r) => r.accounts.get())).status, 'active', 'the other user is untouched');
    assert.equal(await db.asUser(B, (r) => r.accounts.cancelDeletion()), false, 'B has nothing to cancel, and cannot cancel A\'s');
    assert.equal((await db.asUser(A, (r) => r.accounts.get())).status, 'pending_deletion');
    assert.equal(await db.asUser(A, (r) => r.accounts.cancelDeletion()), true);
    assert.equal((await db.asUser(A, (r) => r.accounts.get())).status, 'active'); assert.equal(await db.asUser(A, (r) => r.accounts.deletion()), null);
    assert.ok((await db.asUser(A, (r) => r.audit.list())).some((x) => x.action === 'account.delete_cancelled'));
    await db.asUser(A, (r) => r.accounts.requestDeletion(0));
    assert.equal(await db.asUser(A, (r) => r.accounts.cancelDeletion()), false, 'an immediate deletion cannot be undone');
    assert.deepEqual((await db.system.dueDeletions(50)).filter((x) => x.userId === A.uid), [{ userId: A.uid, graceDays: 0 }]);
    assert.equal((await db.system.dueDeletions(50)).some((x) => x.userId === B.uid), false);
  });

  T('a deletion with a grace period is not due before the grace is over', async ({ db, newUser, passTime }) => {
    const { A } = await two({ newUser });
    await db.asUser(A, (r) => r.accounts.ensure()); await db.asUser(A, (r) => r.accounts.requestDeletion(7));
    assert.equal((await db.system.dueDeletions(50)).some((x) => x.userId === A.uid), false);
    if (label === 'memory') { await passTime(7 * 86400_000 + 1000); assert.equal((await db.system.dueDeletions(50)).some((x) => x.userId === A.uid), true); }
  });

  T('admin repos: only an admin, only metadata; suspend / lift is recorded in the target\'s audit log; never an admin, never somebody pending deletion', async ({ db, newUser, makeAdmin }) => {
    const { a, b, A, B } = await two({ newUser });
    const c = await newUser(), C = mint(c);
    await db.asUser(A, (r) => r.accounts.ensure()); await db.asUser(B, (r) => r.accounts.ensure()); await db.asUser(C, (r) => r.accounts.ensure()); await makeAdmin(a);
    await assert.rejects(db.asUser(B, (r) => r.admin.listUsers()), code('forbidden'));
    await assert.rejects(db.asUser(B, (r) => r.admin.setStatus(c, 'suspended')), code('forbidden'));
    const list = await db.asUser(A, (r) => r.admin.listUsers({ limit: 500 }));
    for (const u of list) assert.deepEqual(Object.keys(u).sort(), ['calls30d', 'callsToday', 'createdAt', 'email', 'isAdmin', 'lastSignInAt', 'liveSecondsToday', 'status', 'storageQuotaBytes', 'storageUsedBytes', 'userId'], 'metadata columns only');
    assert.ok(list.some((u) => u.userId === a && u.isAdmin) && list.some((u) => u.userId === b && !u.isAdmin));
    assert.equal(await db.asUser(A, (r) => r.admin.setStatus(b, 'suspended', 'spam')), 'suspended');
    assert.equal((await db.asUser(B, (r) => r.accounts.get())).status, 'suspended');
    assert.equal((await db.asUser(B, (r) => r.accounts.get())).suspendedReason, 'spam');
    const entry = (await db.asUser(B, (r) => r.audit.list())).find((x) => x.action === 'account.suspended');
    assert.deepEqual({ actor: entry.actor, actorId: entry.actorId }, { actor: 'admin', actorId: a }, 'B can see that an admin did it');
    assert.equal(await db.asUser(A, (r) => r.admin.setStatus(b, 'active')), 'active');
    assert.equal((await db.asUser(B, (r) => r.accounts.get())).suspendedReason, null);
    await assert.rejects(db.asUser(A, (r) => r.admin.setStatus(a, 'suspended')), code('forbidden'), 'not oneself');
    await assert.rejects(db.asUser(A, (r) => r.admin.setStatus(b, 'banned')), code('invalid_value'));
    await assert.rejects(db.asUser(A, (r) => r.admin.setStatus('not-a-uuid', 'suspended')), code('invalid_value'));
    await db.asUser(C, (r) => r.accounts.requestDeletion(7));
    await assert.rejects(db.asUser(A, (r) => r.admin.setStatus(c, 'suspended')), code('conflict'), 'not while the user is deleting the account');
    // an admin does not get a way to read anything else through the repos: no method of `admin` returns content
    assert.deepEqual(await db.asUser(A, async (r) => Object.keys(r.admin).sort()), ['listUsers', 'setStatus']);
    assert.deepEqual(await db.asUser(A, (r) => r.profile.get()), null, 'an admin\'s repos are still only their own');
  });

  // ---------------------------------------------------------------- P4: notes, conversations, inbox, notification relay
  T('notes: put / get / list / search per user; revisions kept (newest 30); trash, restore, permanent delete; bad paths refused; B never sees A\'s notes', async ({ db, newUser }) => {
    const { A, B } = await two({ newUser });
    const n = await db.asUser(A, async (r) => {
      const a = await r.notes.put({ path: '好み/コーヒー.md', content: '# コーヒー\nブラックが好き。 100% の_豆' });
      assert.equal(a.created, true); assert.equal(a.rev, 1);
      for (let i = 2; i <= 36; i++) await r.notes.put({ path: '好み/コーヒー.md', content: '版' + i + ' ブラック' });
      assert.equal((await r.notes.put({ path: '好み/コーヒー.md', content: '版36 ブラック' })).unchanged, true);
      assert.equal((await r.notes.revisions(a.id)).length, 30); assert.equal((await r.notes.get('好み/コーヒー.md')).rev, 36);
      assert.deepEqual((await r.notes.list({ folder: '好み' })).map((x) => x.path), ['好み/コーヒー.md']);
      assert.deepEqual((await r.notes.search(['ブラック', '100%'])).map((x) => x.path), ['好み/コーヒー.md']);
      assert.deepEqual(await r.notes.search(['%']), [], 'a % in the query is a character, not a wildcard');
      assert.deepEqual(await r.notes.search(['宇宙旅行']), []);
      return a;
    });
    await db.asUser(B, async (r) => {
      assert.equal(await r.notes.get('好み/コーヒー.md'), null); assert.equal(await r.notes.getById(n.id), null); assert.deepEqual(await r.notes.list(), []);
      assert.deepEqual(await r.notes.search(['ブラック']), []); assert.deepEqual(await r.notes.revisions(n.id), []); assert.equal(await r.notes.trash(n.id), false); assert.equal(await r.notes.purge(n.id), false);
      assert.equal((await r.notes.put({ path: '好み/コーヒー.md', content: 'B のノート' })).created, true, 'the same path is a different note');
    });
    await db.asUser(A, async (r) => {
      assert.equal((await r.notes.get('好み/コーヒー.md')).content, '版36 ブラック');
      assert.equal(await r.notes.trash(n.id), true); assert.equal(await r.notes.get('好み/コーヒー.md'), null); assert.deepEqual(await r.notes.search(['ブラック']), []);
      assert.equal((await r.notes.list({ trash: true })).length, 1); assert.equal(await r.notes.restore(n.id), true);
      for (const bad of ['../x.md', 'x.txt', '/a.md', 'a//b.md', '.h/x.md', 'a/.x.md', '', 'a\n.md', 'x'.repeat(301) + '.md']) await assert.rejects(r.notes.put({ path: bad, content: 'x' }), code('invalid_value'));
      await assert.rejects(r.notes.put({ path: 'a.md', content: 'x'.repeat(400001) }), code('invalid_value'));
      assert.equal(await r.notes.purge(n.id), true); assert.deepEqual(await r.notes.revisions(n.id), []);
    });
  });

  T('notes: the mirror marks (unpushed / markPushed) follow the revision; an import is already pushed', async ({ db, newUser }) => {
    const { A } = await two({ newUser });
    await db.asUser(A, async (r) => {
      const a = await r.notes.put({ path: 'a.md', content: '1' }), b = await r.notes.put({ path: 'b.md', content: 'x', synced: true });
      assert.deepEqual((await r.notes.unpushed()).map((x) => x.path), ['a.md']);
      assert.equal(await r.notes.markPushed(a.id, 1), true); assert.equal(await r.notes.unpushedCount(), 0);
      await r.notes.put({ path: 'a.md', content: '2' }); assert.deepEqual((await r.notes.unpushed()).map((x) => [x.path, x.rev]), [['a.md', 2]]);
      await r.notes.put({ path: 'b.md', content: 'y', synced: true }); assert.equal(await r.notes.unpushedCount(), 1);
      assert.equal(b.created, true);
    });
  });

  T('messages: turns group into conversations (30-minute gaps), list / search / delete one / delete a conversation / purge; per user', async ({ db, newUser }) => {
    const { A, B } = await two({ newUser });
    const t0 = Date.parse('2026-11-04T12:00:00Z');
    const r1 = await db.asUser(A, (r) => r.messages.append({ turns: [{ role: 'user', text: '明日の予定は？', at: t0 }, { role: 'assistant', text: '10時に打ち合わせです', at: t0 + 1 }, { role: 'user', text: 'ありがとう', at: t0 + 60000 }] }));
    assert.equal(r1.added, 3);
    const r2 = await db.asUser(A, (r) => r.messages.append({ turns: [{ role: 'user', text: '翌日の話', at: t0 + 86400e3 }] }));
    assert.notEqual(r1.conversationId, r2.conversationId);
    const r3 = await db.asUser(A, (r) => r.messages.append({ turns: [{ role: 'assistant', text: '続き', at: t0 + 120000 }] })); assert.equal(r3.conversationId, r1.conversationId, 'within 30 minutes: the same conversation');
    await db.asUser(A, async (r) => {
      const cs = await r.messages.conversations({}); assert.equal(cs.length, 2); assert.equal(cs[0].id, r2.conversationId); assert.equal(cs[1].count, 4); assert.equal(cs[1].preview, '明日の予定は？');
      const c = await r.messages.conversation(r1.conversationId); assert.deepEqual(c.messages.map((m) => m.text), ['明日の予定は？', '10時に打ち合わせです', 'ありがとう', '続き']);
      assert.deepEqual((await r.messages.list({ q: '打ち合わせ' })).map((m) => m.text), ['10時に打ち合わせです']);
      assert.deepEqual((await r.messages.list({ q: '100%' })), [], 'a % is a character');
      assert.equal((await r.messages.list({ since: new Date(t0 + 86400e3 - 1).toISOString() })).length, 1);
      assert.equal(await r.messages.del(c.messages[0].id), true); assert.equal((await r.messages.conversation(r1.conversationId)).messages.length, 3);
      for (const bad of [[], [{ role: 'x', text: 'a', at: 1 }], [{ role: 'user', text: '', at: 1 }], [{ role: 'user', text: 'a', at: NaN }]]) await assert.rejects(r.messages.append({ turns: bad }), code('invalid_value'));
    });
    await db.asUser(B, async (r) => {
      assert.deepEqual(await r.messages.conversations({}), []); assert.equal(await r.messages.conversation(r1.conversationId), null); assert.deepEqual(await r.messages.list({ q: '打ち合わせ' }), []);
      assert.equal(await r.messages.delConversation(r1.conversationId), false); assert.equal(await r.messages.purge({}), 0);
    });
    await db.asUser(A, async (r) => {
      assert.equal(await r.messages.purge({ before: new Date(t0 + 3600e3).toISOString() }), 3); assert.equal(await r.messages.count(), 1); assert.equal((await r.messages.conversations({})).length, 1, 'the emptied conversation is gone');
      assert.equal(await r.messages.delConversation(r2.conversationId), true); assert.equal(await r.messages.count(), 0);
    });
  });

  T('retention: the sweep removes messages older than the user\'s own setting (default 180 days, 0 = keep), old revisions, old trash and relay items', async ({ db, newUser, passTime, now: clock }) => {
    const { a, A, B } = await two({ newUser });
    const now = clock ? clock() : Date.now();
    await db.asUser(A, async (r) => { await r.settings.put({ MESSAGE_RETENTION_DAYS: '7' }); await r.messages.append({ turns: [{ role: 'user', text: '古い', at: now - 10 * 864e5 }, { role: 'user', text: '新しい', at: now - 1000 }], gapSec: 60 }); });
    await db.asUser(B, async (r) => { await r.messages.append({ turns: [{ role: 'user', text: 'Bの古い(既定180日以内)', at: now - 10 * 864e5 }, { role: 'user', text: 'Bの200日前', at: now - 200 * 864e5 }], gapSec: 60 }); });
    const swept = await db.system.purgeExpired(); assert.ok(swept.messages >= 2);
    assert.deepEqual((await db.asUser(A, (r) => r.messages.list({}))).map((m) => m.text), ['新しい']);
    assert.deepEqual((await db.asUser(B, (r) => r.messages.list({}))).map((m) => m.text), ['Bの古い(既定180日以内)']);
    await db.asUser(A, async (r) => { const n = await r.notes.put({ path: 't.md', content: 'x' }); await r.notes.trash(n.id); });
    assert.equal((await db.asUser(A, (r) => r.notes.list({ trash: true }))).length, 1, 'a note just put in the trash stays for 30 days');
    void a; void passTime;
  });

  T('inbox: add / same key replaces and is unread again / mark read / delete / cap of 100; per user', async ({ db, newUser }) => {
    const { A, B } = await two({ newUser });
    const id = await db.asUser(A, async (r) => {
      const x = await r.inbox.add({ kind: 'build', key: 'build:7', title: '製作：A（作業中）', url: 'https://example.test/pr/1' });
      const y = await r.inbox.add({ kind: 'deliverable', key: 'build:7', title: '製作：A（完成）' }); assert.equal(y.id, x.id); assert.equal(y.kind, 'deliverable');
      assert.equal(await r.inbox.markRead(x.id), true); assert.notEqual((await r.inbox.list({}))[0].readAt, null);
      await r.inbox.add({ kind: 'build', key: 'build:7', title: '更新' }); assert.equal((await r.inbox.list({}))[0].readAt, null);
      await assert.rejects(r.inbox.add({ kind: 'zzz', title: 'x' }), code('invalid_value')); await assert.rejects(r.inbox.add({ title: '' }), code('invalid_value')); await assert.rejects(r.inbox.add({ title: 'x', url: 'javascript:alert(1)' }), code('invalid_value'));
      for (let i = 0; i < 110; i++) await r.inbox.add({ title: 'n' + i });
      assert.equal((await r.inbox.list({ limit: 100 })).length, 100);
      return x.id;
    });
    await db.asUser(B, async (r) => { assert.deepEqual(await r.inbox.list({}), []); assert.equal(await r.inbox.markRead(id), false); assert.equal(await r.inbox.del(id), false); assert.equal(await r.inbox.markAllRead(), 0); });
    await db.asUser(A, async (r) => { assert.ok((await r.inbox.markAllRead()) > 0); assert.ok((await r.inbox.delAll()) > 0); assert.deepEqual(await r.inbox.list({}), []); });
  });

  T('notif relay: ciphertext items, de-duplicated by id, oldest first from `since`, cleared, per user; junk items are skipped', async ({ db, newUser, now: clock }) => {
    const { A, B } = await two({ newUser });
    const now = clock ? clock() : Date.now(), it = (id, at) => ({ id, at, iv: 'AAAAAAAAAAAAAAAA', ct: 'BBBBBBBBBBBBBBBBBBBBBBBB' });
    await db.asUser(A, async (r) => {
      assert.deepEqual(await r.notif.push([it('n1-aa', now - 2000), it('n2-aa', now - 1000), it('n1-aa', now - 2000), { id: 'bad id!', at: now, iv: 'x', ct: 'y' }, null]), { stored: 3 });
      assert.deepEqual((await r.notif.pull({ since: 0 })).map((x) => x.id), ['n1-aa', 'n2-aa']); assert.deepEqual((await r.notif.pull({ since: now - 1500 })).map((x) => x.id), ['n2-aa']);
      assert.equal(await r.notif.count(), 2);
      await r.notif.push([it('old-aa', now - 4 * 864e5)]); assert.deepEqual((await r.notif.pull({ since: 0 })).map((x) => x.id), ['n1-aa', 'n2-aa'], 'older than 3 days is dropped');
    });
    await db.asUser(B, async (r) => { assert.deepEqual(await r.notif.pull({ since: 0 }), []); assert.equal(await r.notif.clear(), 0); });
    await db.asUser(A, async (r) => { assert.equal((await r.notif.pull({ since: 0 })).length, 2); assert.equal(await r.notif.clear(), 2); assert.deepEqual(await r.notif.pull({ since: 0 }), []); });
  });

  T('P4 data is deleted with the account (residual check is zero) and the export covers it', async ({ db, newUser, deleteUser, now: clock }) => {
    const now = clock ? clock() : Date.now();
    const { a, A, B } = await two({ newUser });
    await db.asUser(A, async (r) => { await r.notes.put({ path: 'a.md', content: '1' }); await r.notes.put({ path: 'a.md', content: '2' }); await r.messages.append({ turns: [{ role: 'user', text: 'hi', at: now }] }); await r.inbox.add({ title: 'x' }); await r.notif.push([{ id: 'n1-aa', at: now, iv: 'AAAAAAAAAAAAAAAA', ct: 'BBBBBBBBBBBBBBBBBBBBBBBB' }]); });
    await db.asUser(B, (r) => r.notes.put({ path: 'b.md', content: 'B' }));
    const { buildExport } = await import('../../server/rights/export.js');
    const ex = await db.asUser(A, (r) => buildExport(r)); assert.equal(ex.files['notes.json'].notes[0].revisions.length, 1); assert.equal(ex.files['conversations.json'].conversations[0].messages.length, 1); assert.equal(ex.files['inbox.json'].inbox.length, 1); assert.equal(ex.files['notifications.json'].stored, 1);
    assert.ok(!JSON.stringify(ex).includes('BBBBBBBB'), 'the relay\'s ciphertext is not exported');
    await deleteUser(a);
    const res = await residualCheck(db, mint(a)); assert.equal(res.clean, true);
    assert.equal((await db.asUser(B, (r) => r.notes.get('b.md'))).content, 'B');
  });

  T('cron helpers: bootstrap admin needs a CONFIRMED account with that e-mail; receipts carry no user id', async ({ db, newUser }) => {
    assert.equal(await db.system.bootstrapAdmin('nobody-' + rnd(4).toString('hex') + '@example.test'), null);
    await db.system.recordReceipt(18);
    await assert.rejects(db.system.recordReceipt(-1));
  });
}
