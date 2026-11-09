// The Storage layer (docs/ELVAR_MULTIUSER.md 3.3): the fake that stands in for it in `npm test` and the dev stack enforces the same policies as the real bucket,
// and the Supabase REST client sends what the Storage API expects, with the user's own token for everything a user may do and the service key only for the sweeps.
import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../server/storage/memory.js';
import { createSupabaseStorage, storageConfig } from '../server/storage/supabase.js';
import { pathOwner, requireOwnPath, userStorage, getStorage, _setStorageForTests } from '../server/storage/index.js';

const A = crypto.randomUUID(), B = crypto.randomUUID();
const path = (uid, id = crypto.randomUUID()) => `users/${uid}/files/${id}/${'a'.repeat(64)}`;
const bytes = Buffer.from('hello storage');
const tokenOf = (url) => new URL(url).searchParams.get('token');

test('pathOwner: only users/<uuid>/<segments> is an owner path; traversal, empty and dot segments, other prefixes, long paths are nobody\'s', () => {
  assert.equal(pathOwner(`users/${A}/files/x/y`), A);
  for (const p of [`users/${A.toUpperCase()}/files/x`, `users/${A}`, `users/${A}/`, `users/${A}/../${B}/x`, `users/${A}//x`, `users/${A}/./x`, `other/${A}/x`, `users/not-a-uuid/x`, `/users/${A}/x`, `users/${A}/x y`, `users/${A}/` + 'x'.repeat(500), '', null, 5]) assert.equal(pathOwner(p), null, String(p));
  const mine = path(A); assert.throws(() => requireOwnPath(A, path(B)), /storage_forbidden/); assert.equal(requireOwnPath(A, mine), mine);
});

test('the fake: a user can write only a path that has a live reservation and only inside their own prefix; no overwrite; the link is bound to its path', async () => {
  let reserved = new Set();
  const s = createMemoryStorage({ canInsert: (uid, p) => reserved.has(`${uid}|${p}`), baseUrl: () => 'https://x.supabase.test' });
  const a = s.forUser({ uid: A }), b = s.forUser({ uid: B }), p = path(A);
  await assert.rejects(a.createUploadUrl(p), (e) => e.status === 403, 'no reservation, no upload');
  reserved.add(`${A}|${p}`);
  await assert.rejects(b.createUploadUrl(p), (e) => e.status === 403, 'B cannot get a link for A\'s path even if A has a reservation');
  reserved.add(`${B}|${p}`); await assert.rejects(b.createUploadUrl(p), (e) => e.status === 403, 'nor with a reservation of their own for it: the path is not in B\'s prefix');
  const up = await a.createUploadUrl(p); assert.match(up.url, /^https:\/\/x\.supabase\.test\/storage\/v1\/object\/upload\/sign\/user-files\/users\//); assert.equal(up.method, 'PUT');
  await s.uploadWithToken(tokenOf(up.url), bytes, { contentType: 'text/plain' });
  await assert.rejects(s.uploadWithToken(tokenOf(up.url), bytes), (e) => e.status === 401, 'a link is used once');
  await assert.rejects(a.createUploadUrl(p), (e) => e.status === 409, 'an object is never overwritten');
  assert.deepEqual(await a.stat(p), { size: bytes.length, contentType: 'text/plain' });
  assert.deepEqual(await a.hash(p), { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  assert.deepEqual(await a.hash(p, { maxBytes: 3 }), { size: bytes.length, sha256: null, tooLarge: true });
  // B: nothing of A's exists for B
  assert.equal(await b.stat(p), null); assert.equal(await b.hash(p), null); await assert.rejects(b.createDownloadUrl(p), (e) => e.status === 404); assert.equal(await b.remove([p]), 0);
  assert.ok(s.testing.has(p), 'A\'s object survived B\'s delete');
  const dl = await a.createDownloadUrl(p, { name: 'メモ.txt' }); assert.match(dl, /download=%E3%83%A1%E3%83%A2\.txt/);
  assert.deepEqual((await s.downloadWithToken(tokenOf(dl))).bytes, bytes);
  assert.equal(await a.remove([p, path(B)]), 1, 'a delete only ever touches the caller\'s own paths'); assert.equal(s.testing.has(p), false);
});

test('the fake: 60 MB per object, expiring links, buckets are private (no public URL exists), the sweeps see everything', async () => {
  let t = 1_000_000; const s = createMemoryStorage({ now: () => t, maxObjectBytes: 10, baseUrl: () => 'https://x.supabase.test' });
  const a = s.forUser({ uid: A }), p = path(A), up = await a.createUploadUrl(p);
  await assert.rejects(s.uploadWithToken(tokenOf(up.url), Buffer.alloc(11)), (e) => e.status === 413);
  t += 31 * 60_000; await assert.rejects(s.uploadWithToken(tokenOf(up.url), bytes), (e) => e.status === 401, 'the link expired');
  const up2 = await a.createUploadUrl(p); await s.uploadWithToken(tokenOf(up2.url), Buffer.alloc(10));
  const dl = await a.createDownloadUrl(p, { expiresInSec: 5 }); t += 6000; await assert.rejects(s.downloadWithToken(tokenOf(dl)), (e) => e.status === 401);
  s.testing.put(`users/${A}/exports/j/part-1.zip`, Buffer.from('z'), { bucket: 'user-exports' }); s.testing.put(path(B), Buffer.from('b'));
  assert.equal((await s.service.list(`users/${A}/`)).length, 1); assert.equal(await s.service.count(`users/${A}/`, { bucket: 'user-exports' }), 1);
  assert.equal(await s.service.count(`users/${A}/`, { bucket: 'user-cache' }), 0);
  await s.service.remove(await s.service.list(`users/${A}/`)); assert.equal(await s.service.count(`users/${B}/`), 1, 'only what was named is removed');
});

test('userStorage: a request without an access token (a device token) cannot reach the vault; the memory storage refuses to load in production', async () => {
  await assert.rejects(userStorage({ uid: { uid: A }, jwt: null }), (e) => e.status === 403);
  const { createMemoryStorage: c } = await import('../server/storage/memory.js'); assert.equal(typeof c, 'function');
  const src = (await import('node:fs')).readFileSync(new URL('../server/storage/memory.js', import.meta.url), 'utf8'); assert.match(src, /process\.env\.VERCEL \|\| process\.env\.NODE_ENV === 'production'\) throw/);
  _setStorageForTests(null); assert.equal((await getStorage()).kind, 'memory');
});

// ---------------------------------------------------------------- the REST client
const ENV = { SUPABASE_URL: 'https://proj.supabase.test', SUPABASE_PUBLISHABLE_KEY: 'sb-publishable-key', SUPABASE_SECRET_KEY: 'sb-SERVICE-secret' };
function stub(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => { calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect }); return handler(String(url), init, calls.length - 1); };
  return { calls, fetchImpl };
}
const json = (status, body) => ({ status, ok: status < 400, text: async () => JSON.stringify(body), json: async () => body });

test('storageConfig: https only (plain http only to this computer), and both values are needed', () => {
  assert.deepEqual(storageConfig(ENV), { url: 'https://proj.supabase.test', key: 'sb-publishable-key' });
  for (const bad of [{}, { SUPABASE_URL: ENV.SUPABASE_URL }, { ...ENV, SUPABASE_URL: 'http://proj.supabase.test' }, { ...ENV, SUPABASE_URL: 'nonsense' }]) assert.throws(() => storageConfig(bad), /storage_unconfigured/);
  assert.equal(storageConfig({ ...ENV, SUPABASE_URL: 'http://127.0.0.1:54321/' }).url, 'http://127.0.0.1:54321');
});

test('REST client, as the user: signed upload / info / signed download / remove carry the USER\'S token and the publishable key, never the service key; a foreign path never reaches the network', async () => {
  const p = path(A), enc = p.split('/').map(encodeURIComponent).join('/');
  const { calls, fetchImpl } = stub((url) => {
    if (url.includes('/object/upload/sign/')) return json(200, { url: `/object/upload/sign/user-files/${enc}?token=UP` });
    if (url.includes('/object/info/')) return json(200, { size: 13, content_type: 'text/plain' });
    if (url.includes('/object/sign/')) return json(200, { signedURL: `/object/sign/user-files/${enc}?token=DL` });
    if (url.includes('/object/user-files')) return json(200, [{ name: p }]);
    throw new Error('unexpected ' + url);
  });
  const u = createSupabaseStorage({ env: ENV, fetchImpl }).forUser({ uid: A, token: 'USER-JWT' });
  const up = await u.createUploadUrl(p); assert.deepEqual(up, { url: `https://proj.supabase.test/storage/v1/object/upload/sign/user-files/${enc}?token=UP`, method: 'PUT', expiresInSec: 7200 });
  assert.deepEqual(await u.stat(p), { size: 13, contentType: 'text/plain' });
  assert.equal(await u.createDownloadUrl(p, { name: 'a b.txt', expiresInSec: 120 }), `https://proj.supabase.test/storage/v1/object/sign/user-files/${enc}?token=DL&download=a%20b.txt`);
  assert.equal(await u.remove([p]), 1);
  assert.deepEqual(calls.map((c) => [c.method, c.url.replace('https://proj.supabase.test/storage/v1', '').split('?')[0].replace(enc, '<path>')]),
    [['POST', '/object/upload/sign/user-files/<path>'], ['GET', '/object/info/user-files/<path>'], ['POST', '/object/sign/user-files/<path>'], ['DELETE', '/object/user-files']]);
  for (const c of calls) { assert.equal(c.headers.authorization, 'Bearer USER-JWT'); assert.equal(c.headers.apikey, 'sb-publishable-key'); assert.equal(c.redirect, 'error'); assert.ok(!JSON.stringify(c).includes('SERVICE')); }
  assert.deepEqual(calls[2].body, { expiresIn: 120 }); assert.deepEqual(calls[3].body, { prefixes: [p] });
  const n = calls.length;
  await assert.rejects(u.createUploadUrl(path(B)), /storage_forbidden/); await assert.rejects(u.createDownloadUrl(path(B)), /storage_forbidden/); await assert.rejects(u.remove([path(B)]), /storage_forbidden/);
  assert.equal(await u.stat(path(B)), null); assert.equal(await u.hash(path(B)), null); assert.equal(calls.length, n, 'no request was made for another user\'s path');
});

test('REST client: errors map (401/403 -> forbidden, 409 -> conflict, 5xx -> storage_failed, network -> unreachable); a missing object is null; a download that is too big stops early', async () => {
  const p = path(A);
  const mk = (handler) => createSupabaseStorage({ env: ENV, fetchImpl: stub(handler).fetchImpl }).forUser({ uid: A, token: 'T' });
  await assert.rejects(mk(() => json(403, {})).createUploadUrl(p), (e) => e.code === 'storage_forbidden' && e.status === 403);
  await assert.rejects(mk(() => json(409, {})).createUploadUrl(p), (e) => e.code === 'storage_conflict' && e.status === 409);
  await assert.rejects(mk(() => json(500, {})).createUploadUrl(p), (e) => e.code === 'storage_failed' && e.status === 502);
  await assert.rejects(mk(() => json(200, { nope: 1 })).createUploadUrl(p), (e) => e.code === 'storage_failed');
  await assert.rejects(mk(() => { throw new Error('net'); }).createUploadUrl(p), (e) => e.code === 'storage_unreachable' && e.status === 502);
  assert.equal(await mk(() => json(404, {})).stat(p), null);
  const body = (chunks) => ({ status: 200, ok: true, body: (async function* () { for (const c of chunks) yield c; })() });
  const real = Buffer.from('some object content'), h = await mk(() => body([real.subarray(0, 5), real.subarray(5)])).hash(p, { maxBytes: 100 });
  assert.deepEqual(h, { size: real.length, sha256: crypto.createHash('sha256').update(real).digest('hex') });
  assert.deepEqual(await mk(() => body([real.subarray(0, 5), real.subarray(5)])).hash(p, { maxBytes: 8 }), { size: real.length, sha256: null, tooLarge: true }, 'it stops as soon as the running size passes the limit');
  assert.equal(await mk(() => ({ status: 404, ok: false, body: null })).hash(p), null);
  await assert.rejects(createSupabaseStorage({ env: {}, fetchImpl: () => {} }).forUser({ uid: A, token: 'T' }).createUploadUrl(p), (e) => e.code === 'storage_unconfigured', 'unconfigured is an error, never a silent no-op');
});

test('REST client, the sweeps: the SERVICE key, only under users/<uuid>/, folders are walked, 1000 per request, a missing bucket is empty', async () => {
  const calls = []; const pages = new Map([
    [`users/${A}`, [{ name: 'files', id: null }, { name: 'loose.bin', id: 'o1' }]],
    [`users/${A}/files`, [{ name: 'f1', id: null }]],
    [`users/${A}/files/f1`, [{ name: 'abc', id: 'o2' }, { name: 'def', id: 'o3' }]],
  ]);
  const fetchImpl = async (url, init) => { const b = init.body ? JSON.parse(init.body) : undefined; calls.push({ url: String(url), method: init.method, headers: init.headers, body: b }); if (String(url).includes('/object/list/user-cache')) return json(404, {}); if (init.method === 'POST') return json(200, pages.get(b.prefix) || []); return json(200, []); };
  const svc = createSupabaseStorage({ env: ENV, fetchImpl }).service;
  assert.deepEqual((await svc.list(`users/${A}/`)).sort(), [`users/${A}/files/f1/abc`, `users/${A}/files/f1/def`, `users/${A}/loose.bin`]);
  for (const c of calls) { assert.equal(c.headers.authorization, 'Bearer sb-SERVICE-secret'); assert.equal(c.headers.apikey, 'sb-SERVICE-secret'); }
  assert.deepEqual(await svc.list(`users/${A}/`, { bucket: 'user-cache' }), [], 'a bucket that does not exist has nothing');
  await assert.rejects(svc.list('users/'), /bad_path/); await assert.rejects(svc.list(`other/${A}/`), /bad_path/); await assert.rejects(svc.list(`users/${A}/`, { bucket: '../x' }), /bad_bucket/);
  const before = calls.length, many = Array.from({ length: 2100 }, (_, i) => `users/${A}/files/${i}/x`);
  await svc.remove(many); const dels = calls.slice(before); assert.deepEqual(dels.map((c) => [c.method, c.body.prefixes.length]), [['DELETE', 1000], ['DELETE', 1000], ['DELETE', 100]]);
  const n = calls.length;
  for (const bad of [`users/${B}/../${A}/x`, 'users/x', `other/${A}/x`, `users/${A}/`]) await assert.rejects(svc.remove([bad]), /bad_path/, bad);
  assert.equal(calls.length, n, 'a path outside users/<uuid>/ never reaches the network with the service key');
});
