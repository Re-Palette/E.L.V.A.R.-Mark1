import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MemoryStore } from '../server/store/memory.js';
import * as V from '../server/config/vault.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };   // cheap scrypt for tests; the default is 2^15
const PW = 'correct horse battery';
const fresh = async (opts = {}) => { const store = new MemoryStore(); const v = await V.createVault(store, { password: PW, deviceName: 'PC', kdf: FAST, ...opts }); return { store, ...v }; };

test('seal/open: round trip, fresh IV, and any change to key / data / AAD is rejected', () => {
  const key = crypto.randomBytes(32), a = V.seal(key, 'hello', 'k|v1'), b = V.seal(key, 'hello', 'k|v1');
  assert.notEqual(a.iv, b.iv); assert.notEqual(a.ct, b.ct);
  assert.equal(V.open(key, a, 'k|v1').toString(), 'hello');
  assert.throws(() => V.open(crypto.randomBytes(32), a, 'k|v1'));
  assert.throws(() => V.open(key, a, 'k|v2'), 'wrong AAD (rollback / swap)');
  const t = Buffer.from(a.ct, 'base64url'); t[0] ^= 1; assert.throws(() => V.open(key, { iv: a.iv, ct: t.toString('base64url') }, 'k|v1'));
  assert.throws(() => V.open(key, { iv: 'AAAA', ct: a.ct }, 'k|v1'), 'bad IV length');
});

test('device tokens: format, parsing, and nothing else parses', () => {
  const t = V.newDeviceToken(); assert.match(t.token, /^elv1\.[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(V.parseToken(t.token), { deviceId: t.deviceId, secret: t.secret });
  for (const bad of ['', 'elv1', 'elv1.zz.x', t.token + 'x', t.token.replace('elv1', 'elv2'), null, undefined, 42]) assert.equal(V.parseToken(bad), null);
});

test('createVault: the first device token and the password both open the vault; the DEK is never stored in the clear', async () => {
  const { store, token, dek } = await fresh();
  const meta = await V.loadMeta(store);
  assert.ok(!JSON.stringify(await store.get(V.META_KEY)).includes(dek.toString('base64url')) && !JSON.stringify(await store.get(V.META_KEY)).includes(dek.toString('hex')));
  assert.ok(!JSON.stringify(await store.get(V.DOC_KEY)).includes(dek.toString('base64url')));
  assert.deepEqual((await V.unlockWithToken(store, token)).dek, dek);
  assert.deepEqual((await V.unlockWithPassword(store, PW)).dek, dek);
  assert.equal(meta.kdf.N, FAST.N);
  const { doc } = await V.readDoc(store, dek); assert.ok(doc.notifSecret.length >= 40); assert.deepEqual(doc.secrets, {});
});

test('wrong or foreign tokens and wrong passwords open nothing', async () => {
  const a = await fresh(), b = await fresh();
  const t = V.parseToken(a.token);
  assert.equal(await V.unlockWithToken(a.store, a.token.slice(0, -2) + (a.token.endsWith('AA') ? 'BB' : 'AA')), null, 'wrong secret');
  assert.equal(await V.unlockWithToken(a.store, `elv1.${'0'.repeat(16)}.${t.secret}`), null, 'unknown device');
  assert.equal(await V.unlockWithToken(a.store, b.token), null, 'a token of another vault');
  assert.equal(await V.unlockWithToken(a.store, 'garbage'), null);
  assert.equal(await V.unlockWithPassword(a.store, 'wrong password!!'), null);
  assert.equal(await V.unlockWithPassword(a.store, ''), null);
  assert.equal(await V.unlockWithPassword(new MemoryStore(), PW), null, 'no vault yet');
});

test('createVault: password policy, and a second setup is refused (409) without touching the first', async () => {
  await assert.rejects(() => V.createVault(new MemoryStore(), { password: 'short', kdf: FAST }), /weak_password/);
  await assert.rejects(() => V.createVault(new MemoryStore(), { password: 'x'.repeat(201), kdf: FAST }), /weak_password/);
  const { store, dek } = await fresh();
  await assert.rejects(() => V.createVault(store, { password: 'another long password', kdf: FAST }), (e) => e.status === 409 && e.code === 'already_initialized');
  assert.deepEqual((await V.unlockWithPassword(store, PW)).dek, dek);
});

test('devices: add (a second token works), list (no secrets), revoke (that token stops working at once, others keep working)', async () => {
  const { store, dek, token, deviceId } = await fresh();
  const phone = await V.addDevice(store, dek, '<b>Phone</b>\n');
  assert.deepEqual((await V.unlockWithToken(store, phone.token)).dek, dek);
  const list = V.publicDevices(await V.loadMeta(store), deviceId);
  assert.equal(list.length, 2); assert.equal(list.find((d) => d.id === phone.deviceId).name, 'bPhone/b');
  assert.ok(!/<|>|\n/.test(list.find((d) => d.id === phone.deviceId).name), 'names are cleaned');
  assert.equal(list.find((d) => d.id === deviceId).current, true);
  assert.ok(!JSON.stringify(list).includes('wrap') && !JSON.stringify(list).includes(V.parseToken(phone.token).secret));
  assert.equal(await V.revokeDevice(store, dek, phone.deviceId), true);
  assert.equal(await V.unlockWithToken(store, phone.token), null, 'revoked');
  assert.deepEqual((await V.unlockWithToken(store, token)).dek, dek, 'the other device is unaffected');
  assert.equal(await V.revokeDevice(store, dek, phone.deviceId), false);
});

test('a revoked token cannot come back by replaying an old meta unless the store itself is rolled back', async () => {
  const { store, dek } = await fresh(); const phone = await V.addDevice(store, dek, 'p');
  const before = structuredClone(await store.get(V.META_KEY));
  await V.revokeDevice(store, dek, phone.deviceId);
  assert.equal(await V.unlockWithToken(store, phone.token), null);
  assert.ok(before.devices[phone.deviceId], 'sanity: the old meta did contain it (rollback of the store is outside the threat model: Redis access = vault ciphertext only)');
});

test('changePassword: the new password works, the old one does not, devices keep working', async () => {
  const { store, dek, token } = await fresh();
  await assert.rejects(() => V.changePassword(store, dek, 'short'), /weak_password/);
  await V.changePassword(store, dek, 'a brand new password');
  assert.equal(await V.unlockWithPassword(store, PW), null);
  assert.deepEqual((await V.unlockWithPassword(store, 'a brand new password')).dek, dek);
  assert.deepEqual((await V.unlockWithToken(store, token)).dek, dek);
});

test('doc: update merges through compare-and-set, bumps versions, retries on conflict, and survives concurrent writers', async () => {
  const { store, dek } = await fresh();
  const r1 = await V.updateDoc(store, dek, (d) => { d.secrets.GEMINI_API_KEY = 'AIzaFAKEKEY'; return d; });
  assert.equal(r1.ver, 2); assert.equal((await V.loadMeta(store)).docVer, 2);
  assert.ok(!JSON.stringify(await store.get(V.DOC_KEY)).includes('AIzaFAKEKEY'), 'ciphertext only');
  await Promise.all([1, 2, 3, 4].map((i) => V.updateDoc(store, dek, (d) => { d.settings['K' + i] = String(i); return d; })));
  const { doc, ver } = await V.readDoc(store, dek);
  assert.deepEqual(Object.keys(doc.settings).sort(), ['K1', 'K2', 'K3', 'K4']); assert.equal(doc.secrets.GEMINI_API_KEY, 'AIzaFAKEKEY'); assert.equal(ver, 6);
  assert.equal(await V.writeRecord(store, dek, V.DOC_KEY, doc, 1), false, 'a stale version is refused');
});

test('AAD binds a record to its key and version: swapping records or rolling back is detected', async () => {
  const { store, dek } = await fresh();
  await V.updateDoc(store, dek, (d) => { d.settings.A = '1'; return d; });
  const doc = await store.get(V.DOC_KEY);
  await V.writeRecord(store, dek, V.tokKey('google'), { refresh: 'r' }, 0);
  const tok = await store.get(V.tokKey('google'));
  await store.set(V.DOC_KEY, { ...tok, ver: tok.ver });   // the token record presented as the doc
  await assert.rejects(() => V.readDoc(store, dek), /vault_corrupt/);
  await store.set(V.DOC_KEY, { ...doc, ver: doc.ver - 1 });   // same ciphertext claiming an older version
  await assert.rejects(() => V.readDoc(store, dek), /vault_corrupt/);
  await store.set(V.DOC_KEY, doc); assert.equal((await V.readDoc(store, dek)).doc.settings.A, '1');
});

test('password KDF parameters read from the store are bounded (a hostile meta cannot request huge memory)', async () => {
  const { store } = await fresh();
  const m = await store.get(V.META_KEY); m.kdf.N = 2 ** 25; await store.set(V.META_KEY, m);
  assert.equal(await V.unlockWithPassword(store, PW), null);
});

test('safeEqual compares in constant time over equal-length digests and handles odd input', () => {
  assert.equal(V.safeEqual('abc', 'abc'), true); assert.equal(V.safeEqual('abc', 'abd'), false); assert.equal(V.safeEqual('abc', 'abcd'), false);
  assert.equal(V.safeEqual(undefined, ''), true); assert.equal(V.safeEqual(null, 'x'), false);
});

test('ticketKeyFromDek is deterministic per DEK and differs between vaults', async () => {
  const a = await fresh(), b = await fresh();
  assert.deepEqual(V.ticketKeyFromDek(a.dek), V.ticketKeyFromDek(a.dek)); assert.notDeepEqual(V.ticketKeyFromDek(a.dek), V.ticketKeyFromDek(b.dek));
});

test('production KDF parameters work (scrypt N=2^15 under the memory limit) and round-trip', async () => {
  const store = new MemoryStore(); const v = await V.createVault(store, { password: PW });
  assert.equal((await V.loadMeta(store)).kdf.N, 32768);
  assert.deepEqual((await V.unlockWithPassword(store, PW)).dek, v.dek);
});

test('rollback: an older doc record (replayed from a snapshot) is refused, even though its own AAD is valid', async () => {
  const { store, dek } = await fresh();
  await V.updateDoc(store, dek, (d) => { d.secrets.GEMINI_API_KEY = 'AIzaOLD-revoked-key'; return d; });
  const snapshot = structuredClone(await store.get(V.DOC_KEY));            // attacker with store access keeps a copy
  await V.updateDoc(store, dek, (d) => { d.secrets.GEMINI_API_KEY = 'AIzaNEW-current-key'; return d; });
  await V.updateDoc(store, dek, (d) => { d.settings.X = '1'; return d; });
  await store.set(V.DOC_KEY, snapshot);                                   // replay the old (genuine) record
  await assert.rejects(() => V.readDoc(store, dek), (e) => e.code === 'vault_rollback');
  await assert.rejects(() => V.updateDoc(store, dek, (d) => d), (e) => e.code === 'vault_rollback', 'and nothing is written on top of it');
});

test('meta is MAC-protected: lowering docVer (to allow a rollback), editing KDF or devices is detected after unwrap', async () => {
  const { store, dek, token } = await fresh();
  await V.updateDoc(store, dek, (d) => { d.settings.A = '1'; return d; });
  const snapshot = structuredClone(await store.get(V.DOC_KEY));
  await V.updateDoc(store, dek, (d) => { d.settings.A = '2'; return d; });
  const meta = await store.get(V.META_KEY);
  assert.ok(V.metaMacOk(dek, meta));
  // replay the old doc AND lower docVer in meta
  await store.set(V.DOC_KEY, snapshot); await store.set(V.META_KEY, { ...meta, docVer: snapshot.ver });
  assert.equal(await V.unlockWithToken(store, token), null, 'a token no longer unlocks a tampered meta');
  assert.equal(await V.unlockWithPassword(store, PW), null);
  await assert.rejects(() => V.readDoc(store, dek), (e) => e.code === 'vault_tampered');
  await store.set(V.META_KEY, { ...meta, kdf: { ...meta.kdf, N: 2048 } }); assert.equal(await V.unlockWithToken(store, token), null);
  await store.set(V.META_KEY, { ...meta, mac: undefined }); assert.equal(await V.unlockWithToken(store, token), null, 'a meta without MAC is refused');
  await store.set(V.META_KEY, meta); assert.ok(await V.unlockWithToken(store, token), 'the genuine meta still works');
});

test('createVault: a doc left from an earlier (reset) vault is replaced; a lost doc write rolls the meta back', async () => {
  const store = new MemoryStore();
  await store.set(V.DOC_KEY, { ver: 7, iv: 'x', ct: 'y' });   // stale doc of a vault whose meta was deleted
  const v = await V.createVault(store, { password: PW, kdf: FAST });
  assert.deepEqual((await V.readDoc(store, v.dek)).doc.secrets, {});
  const s2 = new MemoryStore(); const realCas = s2.cas.bind(s2);
  s2.cas = async (k, e, val) => (k === V.DOC_KEY ? false : realCas(k, e, val));
  await assert.rejects(() => V.createVault(s2, { password: PW, kdf: FAST }), (e) => e.code === 'conflict');
  assert.equal(await V.loadMeta(s2), null, 'no half-created vault is left behind');
});

test('password policy: common, sequential and low-variety passwords are refused', () => {
  for (const p of ['password123', '1234567890', 'abcdefghij', 'aaaaaaaaaaaa', 'abababababab', 'QWERTYUIOP', '9876543210']) assert.ok(V.checkPassword(p), p);
  for (const p of ['correct horse battery', 'Tr0ub4dor&3xyz']) assert.equal(V.checkPassword(p), '', p);
});
