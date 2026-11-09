// Per-user envelope encryption (server/crypto/envelope.js): AAD binds a secret to its user and name, the DEK to its user and version, keys rotate.
// The repository-level behaviour (stored ciphertext, races, rotation in a transaction) is in the shared database contract (db-memory.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as E from '../server/crypto/envelope.js';
import * as V from '../server/config/vault.js';
import { createMemoryDb } from '../server/db/memory.js';
import { mintVerifiedUid } from '../server/db/verified-uid.js';

const rnd = (n) => crypto.randomBytes(n);
const U1 = '11111111-1111-4111-8111-111111111111', U2 = '22222222-2222-4222-8222-222222222222';
const kekSpec = (id = 'k1') => `${id}:${rnd(32).toString('base64')}`;
const code = (c) => (e) => { assert.equal(e?.code, c, String(e?.code || e)); return true; };

test('the primitives moved out of the old vault are the same functions (one implementation)', () => {
  assert.equal(V.seal, E.seal); assert.equal(V.open, E.open); assert.equal(V.hkdf, E.hkdf); assert.equal(V.safeEqual, E.safeEqual);
});

test('sealBytes / openBytes: round trip, fresh IV each time, tamper / wrong key / wrong AAD / short input all fail', () => {
  const key = rnd(32), a = E.sealBytes(key, 'hello', 'aad'), b = E.sealBytes(key, 'hello', 'aad');
  assert.notDeepEqual(a.iv, b.iv); assert.notDeepEqual(a.ct, b.ct);
  assert.equal(E.openBytes(key, a, 'aad').toString(), 'hello');
  assert.throws(() => E.openBytes(key, a, 'other'));
  assert.throws(() => E.openBytes(rnd(32), a, 'aad'));
  const t = Buffer.from(a.ct); t[0] ^= 1; assert.throws(() => E.openBytes(key, { iv: a.iv, ct: t }, 'aad'));
  assert.throws(() => E.openBytes(key, { iv: a.iv.subarray(0, 8), ct: a.ct }, 'aad'), code('bad_record'));
  assert.throws(() => E.openBytes(key, { iv: a.iv, ct: Buffer.alloc(5) }, 'aad'), code('bad_record'));
  assert.throws(() => E.sealBytes(rnd(16), 'x', 'a'), code('bad_key'));
  assert.throws(() => E.sealBytes('not a buffer', 'x', 'a'), code('bad_key'));
  const s = E.seal(key, 'text', 'a'); assert.equal(E.open(key, s, 'a').toString(), 'text'); assert.equal(typeof s.ct, 'string');
});

test('KEK parsing: "<id>:<base64 of 32 bytes>" only', () => {
  const k = rnd(32), p = E.parseKek('prod-1:' + k.toString('base64'));
  assert.equal(p.id, 'prod-1'); assert.ok(p.key.equals(k));
  assert.ok(E.parseKek('a:' + k.toString('base64url')).key.equals(k), 'url-safe base64 too');
  for (const bad of ['', 'nokey', ':' + k.toString('base64'), 'id:', 'id:' + rnd(16).toString('base64'), 'id:' + rnd(33).toString('base64'), 'bad id:' + k.toString('base64'), 'x'.repeat(33) + ':' + k.toString('base64'), 'id:@@@@', undefined]) {
    assert.throws(() => E.parseKek(bad), code('kek_invalid'), String(bad));
  }
});

test('KekProvider: wraps with the current key; reads nothing until used; a missing key fails closed; unknown id is refused; PREV keys unwrap', async () => {
  assert.doesNotThrow(() => E.envKekProvider({}), 'creating a provider never throws');
  await assert.rejects(E.envKekProvider({}).wrap(rnd(32), 'a'), code('kek_missing'));
  assert.throws(() => E.envKekProvider({}).currentId, code('kek_missing'));
  const old = kekSpec('old'), cur = kekSpec('cur');
  const p0 = E.envKekProvider({ ELVAR_KEK: old }), w = await p0.wrap(rnd(32), 'x');
  assert.equal(w.kekId, 'old'); assert.equal(w.iv.length, 12); assert.equal(w.wrapped.length, 48);
  const p1 = E.envKekProvider({ ELVAR_KEK: cur, ELVAR_KEK_PREV: old });
  assert.equal(p1.currentId, 'cur'); assert.equal((await p1.unwrap(w, 'x')).length, 32);
  await assert.rejects(E.envKekProvider({ ELVAR_KEK: cur }).unwrap(w, 'x'), code('kek_unknown'));
  const clash = E.envKekProvider({ ELVAR_KEK: cur, ELVAR_KEK_PREV: 'cur:' + rnd(32).toString('base64') });
  await assert.rejects(clash.wrap(rnd(32), 'x'), code('kek_id_clash'));
  const multi = E.envKekProvider({ ELVAR_KEK: cur, ELVAR_KEK_PREV: `${old}, ${kekSpec('older')}` }); assert.equal((await multi.unwrap(w, 'x')).length, 32);
});

test('DEK wrap: bound to the user and the version (AAD); a wrap copied to another user or version does not open', async () => {
  const kek = E.envKekProvider({ ELVAR_KEK: kekSpec() }), dek = E.newDek();
  const rec = await E.wrapDek(kek, U1, 3, dek);
  assert.deepEqual({ kekId: rec.kekId, dekVer: rec.dekVer }, { kekId: 'k1', dekVer: 3 });
  assert.ok((await E.unwrapDek(kek, U1, rec)).equals(dek));
  await assert.rejects(E.unwrapDek(kek, U2, rec));
  await assert.rejects(E.unwrapDek(kek, U1, { ...rec, dekVer: 4 }));
  await assert.rejects(E.unwrapDek(kek, U1, { ...rec, kekId: 'nope' }), code('kek_unknown'));
  assert.equal(E.dekAad(U1, 3), `elvar:dek:v2|${U1}|3`);
  assert.throws(() => E.dekAad('not-a-uuid', 1), code('bad_user_id'));
});

test('secret AAD = user id + name + dek_ver: moved to another user, another name or another version it does not open', () => {
  const dek = E.newDek(), s = E.sealSecret(dek, U1, 'GEMINI_API_KEY', 2, 'AIza-secret-value');
  assert.equal(s.last4, 'alue'); assert.equal(s.dekVer, 2); assert.equal(s.iv.length, 12);
  assert.equal(E.openSecret(dek, U1, 'GEMINI_API_KEY', s), 'AIza-secret-value');
  assert.throws(() => E.openSecret(dek, U2, 'GEMINI_API_KEY', s), 'other user');
  assert.throws(() => E.openSecret(dek, U1, 'GROQ_API_KEY', s), 'other name');
  assert.throws(() => E.openSecret(dek, U1, 'GEMINI_API_KEY', { ...s, dekVer: 3 }), 'other version');
  assert.throws(() => E.openSecret(E.newDek(), U1, 'GEMINI_API_KEY', s), 'other DEK');
  assert.equal(E.secretAad(U1, 'a:b.c-d_e', 1), `elvar:sec:v2|${U1}|a:b.c-d_e|1`);
  for (const bad of ['', 'a|b', 'x'.repeat(81), 'a b', 'ü']) assert.throws(() => E.secretAad(U1, bad, 1), code('bad_secret_name'), bad);
  assert.equal(E.sealSecret(dek, U1, 'S', 1, 'short').last4, null, 'short values show no last4');
  assert.notDeepEqual(E.sealSecret(dek, U1, 'S', 1, 'same-value-xx').ct, E.sealSecret(dek, U1, 'S', 1, 'same-value-xx').ct);
});

test('derived keys: per user, per purpose, and gone when the DEK changes', () => {
  const dek = E.newDek();
  const t1 = E.ticketKey(dek, U1), c1 = E.connectorKey(dek, U1);
  assert.ok(t1.equals(E.ticketKey(dek, U1)) && c1.equals(E.connectorKey(dek, U1)));
  assert.ok(!t1.equals(c1) && !t1.equals(E.ticketKey(dek, U2)) && !t1.equals(E.ticketKey(E.newDek(), U1)));
  assert.equal(t1.length, 32);
});

test('rewrapDek: KEK rotation changes the wrapping key id and keeps the same DEK and version', async () => {
  const oldK = kekSpec('old'), newK = kekSpec('new'), dek = E.newDek();
  const rec = await E.wrapDek(E.envKekProvider({ ELVAR_KEK: oldK }), U1, 1, dek);
  const both = E.envKekProvider({ ELVAR_KEK: newK, ELVAR_KEK_PREV: oldK });
  const re = await E.rewrapDek(both, U1, rec);
  assert.equal(re.kekId, 'new'); assert.equal(re.dekVer, 1);
  assert.ok((await E.unwrapDek(E.envKekProvider({ ELVAR_KEK: newK }), U1, re)).equals(dek), 'opens with the new key alone');
  await assert.rejects(E.unwrapDek(E.envKekProvider({ ELVAR_KEK: oldK }), U1, re), code('kek_unknown'));
});

test('keyring: the decrypted DEK is cached for the TTL only, per user, and dropped on rotation', async () => {
  const db = createMemoryDb(); let t = 1_000_000; const U = mintVerifiedUid(db.testing.newUser(), 'test'), W = mintVerifiedUid(db.testing.newUser(), 'test');
  const kek = E.envKekProvider({ ELVAR_KEK: kekSpec() });
  let unwraps = 0; const counting = { currentId: kek.currentId, wrap: (...a) => kek.wrap(...a), unwrap: (...a) => { unwraps++; return kek.unwrap(...a); } };
  const ring = E.createKeyring({ kek: counting, now: () => t, cacheMs: 60_000 });
  const first = await db.asUser(U, (r) => ring.dek(r));   // creates the key: cached without an unwrap
  await db.asUser(U, (r) => ring.dek(r)); assert.equal(unwraps, 0);
  t += 61_000; const again = await db.asUser(U, (r) => ring.dek(r)); assert.equal(unwraps, 1, 'expired -> read and unwrapped again'); assert.ok(again.dek.equals(first.dek));
  assert.ok(!(await db.asUser(W, (r) => ring.dek(r))).dek.equals(first.dek), 'another user has another DEK');
  await db.asUser(U, (r) => ring.rotateDek(r));
  const rotated = await db.asUser(U, (r) => ring.dek(r)); assert.equal(rotated.dekVer, 2); assert.ok(!rotated.dek.equals(first.dek));
  // another instance rotated: a secret with a newer dek_ver forces a reload even inside the TTL
  const other = E.createKeyring({ kek });
  await db.asUser(U, (r) => other.setSecret(r, 'S', 'value-for-the-test-1234'));
  await db.asUser(U, (r) => other.rotateDek(r));
  assert.equal(await db.asUser(U, (r) => ring.getSecret(r, 'S')), 'value-for-the-test-1234');
});

test('keyring: setSecret validates; an unreadable DEK or secret fails with a code, never with the plaintext or a crash', async () => {
  const db = createMemoryDb(), U = mintVerifiedUid(db.testing.newUser(), 'test');
  const ring = E.createKeyring({ kek: E.envKekProvider({ ELVAR_KEK: kekSpec() }) });
  for (const bad of ['', undefined, 5, null]) await assert.rejects(db.asUser(U, (r) => ring.setSecret(r, 'S', bad)), code('bad_secret_value'));
  await assert.rejects(db.asUser(U, (r) => ring.setSecret(r, 'bad name', 'value-1234')), code('bad_secret_name'));
  await db.asUser(U, (r) => ring.setSecret(r, 'S', 'value-1234'));
  // the platform key changed without a rotation: the stored DEK cannot be unwrapped
  const wrong = E.createKeyring({ kek: E.envKekProvider({ ELVAR_KEK: kekSpec('k1') }) });   // same id, different key bytes
  await assert.rejects(db.asUser(U, (r) => wrong.getSecret(r, 'S')), code('dek_unreadable'));
  await assert.rejects(db.asUser(U, (r) => E.createKeyring({ kek: E.envKekProvider({}) }).getSecret(r, 'S')), code('kek_missing'));
});
