// P8 review round 2, Storage (migration 20, docs/ELVAR_MULTIUSER.md 19): the fake enforces the same policies as the real bucket after the tightening.
//   read    only an object whose row is READY (an unverified pending object cannot be read or signed by its owner)
//   delete  only an object whose row is deleting / whose reservation ran out (a live pending object cannot be deleted and uploaded again: the finalize race)
//   upload  only for an active account; the signed link is bound to its path; the reservation lives 15 minutes; the platform per-file limit is configurable
import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/api-harness.mjs';
import { getStorage } from '../server/storage/index.js';
import { browserUpload, pathOfUpload } from './helpers/upload.mjs';
import { _resetPlatformMax } from '../server/account/files.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let h, st, a, A;
test.before(async () => { h = await startHarness(); st = await getStorage(); a = h.mkUser('a@example.test'); A = await h.bearer(a, { email: 'a@example.test' }); await h.call('GET', '/api/elvar/session', A); });
test.after(() => h.stop());
const reserve = (bytes, name = 'x.txt', extra = {}) => h.call('POST', '/api/elvar/files/reserve', A, { name, size: bytes.length, sha256: sha(bytes), ...extra });

test('a pending (unverified) object cannot be read, signed or listed by its owner; once finalized it can', async () => {
  const bytes = Buffer.from('pending-read ' + crypto.randomUUID()), r = await reserve(bytes); assert.equal(r.status, 200);
  await browserUpload(st, a, r.body.upload, bytes);
  const u = st.forUser({ uid: a }), p = pathOfUpload(r.body.upload);
  assert.equal(await u.stat(p), null, 'stat'); assert.equal(await u.hash(p), null, 'hash');
  await assert.rejects(u.createDownloadUrl(p), (e) => e.status === 404, 'sign');
  assert.equal((await h.call('GET', `/api/elvar/files/${r.body.fileId}/download`, A)).status, 404);
  const f = await h.call('POST', `/api/elvar/files/${r.body.fileId}/finalize`, A, { text: '' }); assert.equal(f.status, 200, 'finalize reads the object with the service key');
  assert.equal((await u.stat(p)).size, bytes.length); assert.ok(await u.createDownloadUrl(p));
});

test('the owner cannot delete a live pending object and upload it again; a ready object cannot be deleted behind the database; a deleting one can', async () => {
  const bytes = Buffer.from('pending-del ' + crypto.randomUUID()), r = await reserve(bytes), p = pathOfUpload(r.body.upload), u = st.forUser({ uid: a });
  await browserUpload(st, a, r.body.upload, bytes);
  assert.equal(await u.remove([p]), 0, 'a live pending object stays'); assert.ok(st.testing.has(p));
  await assert.rejects(browserUpload(st, a, r.body.upload, Buffer.from('replacement')), (e) => e.status === 409, 'and cannot be written again');
  await h.call('POST', `/api/elvar/files/${r.body.fileId}/finalize`, A, { text: '' });
  assert.equal(await u.remove([p]), 0, 'a ready object stays: the row would still be counted'); assert.ok(st.testing.has(p));
  assert.equal((await h.call('DELETE', `/api/elvar/files/${r.body.fileId}`, A)).status, 200); assert.equal(st.testing.has(p), false, 'the delete route (begin delete, then remove) still works');
});

test('the object of an expired reservation is not the owner\'s to touch (the server removes it with the service key); a cancelled upload is removed', async () => {
  const b1 = Buffer.from('exp ' + crypto.randomUUID()), r = await reserve(b1), p = pathOfUpload(r.body.upload), u = st.forUser({ uid: a });
  await browserUpload(st, a, r.body.upload, b1);
  h.db.testing.advance(16 * 60_000);   // the reservation lives 15 minutes
  assert.equal(await u.remove([p]), 0); assert.equal(await u.stat(p), null);
  assert.equal((await h.call('GET', '/api/elvar/files', A)).status, 200); assert.equal(st.testing.has(p), false, 'the owner\'s own sweep removed it with the service key');
  const b2 = Buffer.from('cancel ' + crypto.randomUUID()), r2 = await reserve(b2); await browserUpload(st, a, r2.body.upload, b2);
  assert.equal((await h.call('POST', `/api/elvar/files/${r2.body.fileId}/cancel`, A, {})).status, 200); assert.equal(st.testing.has(pathOfUpload(r2.body.upload)), false);
});

test('the reservation lives 15 minutes', async () => {
  const r = await reserve(Buffer.from('ttl ' + crypto.randomUUID())), left = Date.parse(r.body.expiresAt) - h.db.testing.now();
  assert.ok(left <= 15 * 60_000 && left > 14 * 60_000, `expires in ${left} ms`);
});

test('a suspended account cannot write into a reservation it made earlier', async () => {
  const bytes = Buffer.from('susp ' + crypto.randomUUID()), r = await reserve(bytes);
  h.db.testing.setAccountStatus(a, 'suspended');
  await assert.rejects(browserUpload(st, a, r.body.upload, bytes), (e) => e.status === 403);
  h.db.testing.setAccountStatus(a, 'active'); await browserUpload(st, a, r.body.upload, bytes);
});

test('a finalize of an object bigger than the reservation is rejected and the object removed (service key)', async () => {
  const before = (await h.call('GET', '/api/elvar/files', A)).body.usage.reservedBytes;
  const bytes = Buffer.from('small'), r = await reserve(bytes), p = pathOfUpload(r.body.upload);
  st.testing.put(p, Buffer.from('this is not what was announced'));   // what a client that got around the byte count would leave in the bucket
  const f = await h.call('POST', `/api/elvar/files/${r.body.fileId}/finalize`, A, { text: '' });
  assert.equal(f.status, 422); assert.equal(st.testing.has(p), false); assert.equal((await h.call('GET', '/api/elvar/files', A)).body.usage.reservedBytes, before, 'the reserved size is released');
});

test('the fake signed link is bound to its object: the token of one path does not open another', async () => {
  const b1 = Buffer.from('bound-1 ' + crypto.randomUUID()), b2 = Buffer.from('bound-2 ' + crypto.randomUUID());
  const f1 = await (async () => { const r = await reserve(b1); await browserUpload(st, a, r.body.upload, b1); await h.call('POST', `/api/elvar/files/${r.body.fileId}/finalize`, A, { text: '' }); return r; })();
  const f2 = await (async () => { const r = await reserve(b2); await browserUpload(st, a, r.body.upload, b2); await h.call('POST', `/api/elvar/files/${r.body.fileId}/finalize`, A, { text: '' }); return r; })();
  const url = new URL((await h.call('GET', `/api/elvar/files/${f1.body.fileId}/download`, A)).body.url), tok = url.searchParams.get('token');
  const p1 = pathOfUpload(f1.body.upload), p2 = pathOfUpload(f2.body.upload);
  assert.deepEqual((await st.downloadWithToken(tok, { bucket: 'user-files', path: p1 })).bytes, b1);
  await assert.rejects(st.downloadWithToken(tok, { bucket: 'user-files', path: p2 }), (e) => e.status === 401);
  await assert.rejects(st.downloadWithToken(tok, { bucket: 'user-exports', path: p1 }), (e) => e.status === 401);
});

test('the platform per-file limit is configurable (database value, bucket follows) and the default stays 60 MB', async () => {
  _resetPlatformMax();
  const r0 = await h.call('GET', '/api/elvar/files', A); assert.equal(r0.body.usage.maxFileBytes, 62914560, 'default 60 MB');
  await h.db.system.setMaxFileBytes(50 * 1024 * 1024); _resetPlatformMax();
  assert.equal((await h.call('GET', '/api/elvar/files', A)).body.usage.maxFileBytes, 52428800);
  const big = await h.call('POST', '/api/elvar/files/reserve', A, { name: 'big.txt', size: 52428801, sha256: 'a'.repeat(64) });
  assert.equal(big.status, 413); assert.equal(big.body.error, 'file_too_large'); assert.equal(big.body.maxFileBytes, 52428800);
  await assert.rejects(h.db.system.setMaxFileBytes(10), (e) => e.code === 'invalid_value' || /need|invalid/i.test(e.message));
  await h.db.system.setMaxFileBytes(62914560); _resetPlatformMax();
});

test('the real client measures an object with the SERVICE key (streamed, stops at maxBytes), never with the owner\'s token', async () => {
  const { createSupabaseStorage } = await import('../server/storage/supabase.js');
  const uid = crypto.randomUUID(), p = `users/${uid}/files/${crypto.randomUUID()}/${'a'.repeat(64)}`, real = Buffer.from('some object content'), calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), auth: init.headers.authorization }); return { status: 200, ok: true, body: (async function* () { yield real.subarray(0, 5); yield real.subarray(5); })() }; };
  const s = createSupabaseStorage({ env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'pub', SUPABASE_SECRET_KEY: 'service-secret' }, fetchImpl });
  assert.deepEqual(await s.service.hash(p, { maxBytes: 100 }), { size: real.length, sha256: sha(real) });
  assert.deepEqual(await s.service.hash(p, { maxBytes: 8 }), { size: real.length, sha256: null, tooLarge: true });
  assert.ok(calls.every((c) => c.auth === 'Bearer service-secret' && c.url.includes(`/storage/v1/object/user-files/users/${uid}/`)));
  await assert.rejects(s.service.hash(`users/${uid}/../x`), (e) => e.code === 'bad_path');
});
