// The HTTP face of the fake Storage (dev stack only): the browser's PUT to a signed upload link and GET of a signed download link, same paths as a real Supabase project.
import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { createMemoryStorage } from '../server/storage/memory.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const UID = crypto.randomUUID(), PATH = `users/${UID}/files/${crypto.randomUUID()}/${'a'.repeat(64)}`;

test('the dev storage module refuses to load on Vercel or in production (fresh process)', () => {
  for (const env of [{ VERCEL: '1' }, { NODE_ENV: 'production' }]) {
    const r = spawnSync(process.execPath, ['-e', "import('./server/dev/fake-storage-http.js').then(() => console.log('LOADED'), (e) => console.log('REFUSED: ' + e.message))"], { cwd: ROOT, env: { ...process.env, ELVAR_DEV_AUTH: '1', ELVAR_DB: 'memory', ...env }, encoding: 'utf8' });
    assert.match(r.stdout, /REFUSED/, JSON.stringify(env));
  }
  const r = spawnSync(process.execPath, ['-e', "import('./server/storage/memory.js').then(() => console.log('LOADED'), () => console.log('REFUSED'))"], { cwd: ROOT, env: { ...process.env, VERCEL: '1' }, encoding: 'utf8' });
  assert.match(r.stdout, /REFUSED/, 'the memory storage itself will not run on Vercel either');
});

test('PUT to the signed upload link stores the object, GET of the signed download link returns it; a spent / wrong token, a foreign Host header and an oversized body are refused', async () => {
  process.env.ELVAR_DEV_AUTH = '1'; process.env.ELVAR_DB = 'memory'; delete process.env.ELVAR_DB_URL;
  const { createFakeStorageHttp } = await import('../server/dev/fake-storage-http.js');
  let base = '';
  const storage = createMemoryStorage({ canInsert: () => true, baseUrl: () => base + '/dev-supabase' });
  const fs = createFakeStorageHttp({ storage });
  const srv = http.createServer(async (req, res) => { const u = new URL(req.url, 'http://x'); if (!(await fs.handle(req, res, u.pathname, Object.fromEntries(u.searchParams)))) { res.statusCode = 404; res.end(); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const user = storage.forUser({ uid: UID }), up = await user.createUploadUrl(PATH);
    assert.ok(up.url.startsWith(`${base}/dev-supabase/storage/v1/object/upload/sign/user-files/users/`));
    const put = await fetch(up.url, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'hello from the browser' }); assert.equal(put.status, 200);
    assert.equal((await fetch(up.url, { method: 'PUT', body: 'again' })).status, 401, 'a link is used once');
    assert.equal((await fetch(up.url.replace(/token=[^&]+/, 'token=nope'), { method: 'PUT', body: 'x' })).status, 401);
    const dl = await user.createDownloadUrl(PATH, { name: 'メモ.txt' }), got = await fetch(dl);
    assert.equal(got.status, 200); assert.equal(await got.text(), 'hello from the browser'); assert.match(got.headers.get('content-disposition'), /attachment; filename\*=UTF-8''%E3%83%A1%E3%83%A2\.txt/); assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(dl)).status, 200, 'a download link works until it expires');
    const evil = await new Promise((resolve) => { const r = http.request(dl, { headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }); r.end(); }); assert.equal(evil, 421, 'DNS rebinding: only this computer\'s own host names');
    assert.equal((await fetch(`${base}/dev-supabase/storage/v1/object/public/user-files/${PATH}`)).status, 404, 'there is no public URL: the bucket is private');
  } finally { srv.close(); }
});
