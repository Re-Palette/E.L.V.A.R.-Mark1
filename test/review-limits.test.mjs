// P8 review round 2: abuse limits and what a user's request context can reach (docs/ELVAR_MULTIUSER.md 19).
//   a user / device ctx.system is narrowed to that user (no cross-user functions like dueDeletions); device-token requests and notification pushes are rate limited.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/api-harness.mjs';
import { authenticate, DEVICE_REQ_PER_MIN } from '../server/auth/with-user.js';
import { handleNotif, PUSH_PER_MIN } from '../server/notif-relay.js';
import { mintVerifiedUid } from '../server/db/verified-uid.js';

let h, a, b, A, B;
test.before(async () => {
  h = await startHarness(); a = h.mkUser('a@example.test'); b = h.mkUser('b@example.test'); A = await h.bearer(a, { email: 'a@example.test' }); B = await h.bearer(b, { email: 'b@example.test' });
  for (const w of [A, B]) await h.call('GET', '/api/elvar/session', w);
});
test.after(() => h.stop());
const req = (headers, addr = '203.0.113.50') => ({ method: 'POST', headers, socket: { remoteAddress: addr } });

test('a user context cannot reach the cross-user system functions; the ones it has are bound to it', async () => {
  const ctx = (await authenticate('user', req(A))).ctx;
  assert.deepEqual(Object.keys(ctx.system).sort(), ['createExportJob', 'dropExportJob', 'maxFileBytes', 'rlHit', 'updateExportJob']);
  for (const f of ['dueDeletions', 'staleFiles', 'purgeExpired', 'deviceLookup', 'expiredExportJobs', 'residualCheck', 'recordReceipt', 'bootstrapAdmin', 'existingUsers', 'setMaxFileBytes', 'dropStaleFile', 'reconcileStorage']) assert.equal(ctx.system[f], undefined, f);
  const V = (id) => mintVerifiedUid(id, 'test');
  await assert.rejects(ctx.system.createExportJob(V(b)), (e) => e.status === 403);
  const bj = await h.db.system.createExportJob(V(b));
  await assert.rejects(ctx.system.updateExportJob(V(b), bj, { status: 'failed' }), (e) => e.status === 403);
  await assert.rejects(ctx.system.dropExportJob(b, bj), (e) => e.status === 403, 'A cannot drop B\'s export job');
  assert.equal((await h.db.asUser(V(b), (r) => r.exportJobs.get(bj))).status, 'queued', 'B\'s job is untouched');
  assert.equal(await ctx.system.maxFileBytes(), 62914560);
  // the counter is always the caller's own, whatever `who` says
  assert.equal(await ctx.system.rlHit({ bucket: 'mine', who: b, windowSec: 60 }), 1); assert.equal(await h.db.system.rlHit({ bucket: 'mine', who: 'x', windowSec: 60, userId: V(b) }), 1, 'B\'s counter was not touched');
  const cron = (await authenticate('cron', { method: 'POST', headers: { authorization: 'Bearer ' + 'c'.repeat(32) }, socket: {} })).ctx;
  assert.equal(typeof cron.system.dueDeletions, 'function', 'cron has the whole system');
  await h.db.system.dropExportJob(b, bj);
});

test('device-token requests are rate limited per address before anything is looked up', async () => {
  const dev = (await h.call('POST', '/api/elvar/devices', A, { name: 'phone', scopes: ['notif:push'] })).body, tok = dev.token;
  const hit = (addr) => authenticate('device:notif:push', req({ 'x-elvar-token': tok }, addr));
  let last = null;
  for (let i = 0; i < DEVICE_REQ_PER_MIN; i++) last = await hit('198.51.100.9');
  assert.equal(last.ok, true, 'up to the limit it works');
  const over = await hit('198.51.100.9'); assert.equal(over.ok, false); assert.equal(over.status, 429); assert.equal(over.error, 'rate_limited');
  assert.equal((await hit('198.51.100.10')).ok, true, 'another address is not affected');
  // garbage tokens count too (they are what a guesser sends)
  for (let i = 0; i < DEVICE_REQ_PER_MIN; i++) await authenticate('device:notif:push', req({ 'x-elvar-token': 'garbage' }, '198.51.100.20'));
  assert.equal((await authenticate('device:notif:push', req({ 'x-elvar-token': 'garbage' }, '198.51.100.20'))).status, 429);
});

test('notification pushes are rate limited per user', async () => {
  const ctx = (await authenticate('user', req(A))).ctx;
  let last = null; for (let i = 0; i < PUSH_PER_MIN; i++) last = await handleNotif({ user: ctx, method: 'POST', body: { items: [] } });
  assert.equal(last.status, 200);
  assert.equal((await handleNotif({ user: ctx, method: 'POST', body: { items: [] } })).status, 429);
  assert.equal((await handleNotif({ user: (await authenticate('user', req(B))).ctx, method: 'POST', body: { items: [] } })).status, 200, 'B has a counter of their own');
  assert.equal((await handleNotif({ user: ctx, method: 'GET', query: { status: '1' } })).status, 200, 'reading the status is not a push');
});

test('the usage heartbeat records only tool names of the server catalog (or the user\'s own connector tools) and a bounded number of different names a day', async () => {
  const { _setToolNameCap } = await import('../server/account/usage.js'), { _clearUsageCache } = await import('../server/usage.js');
  const E = await h.bearer(h.mkUser('hb@example.test'), { email: 'hb@example.test' }); await h.call('GET', '/api/elvar/session', E);
  const toolsOf = async () => Object.fromEntries((await h.call('GET', '/api/elvar/usage', E)).body.tools.map((t) => [t.name, t.count]));
  const r1 = await h.call('POST', '/api/elvar/usage/report', E, { tools: { weather: 2, made_up_tool_1: 5, 'x.y:z': 1, news: 1 } }); assert.equal(r1.status, 200);
  assert.deepEqual(await toolsOf(), { weather: 2, news: 1 }, 'names the catalog does not know are dropped, not stored');
  try {
    _setToolNameCap(2); _clearUsageCache();
    await h.call('POST', '/api/elvar/usage/report', E, { tools: { news: 1, current_datetime: 1, web_search: 1 } });
    const t = await toolsOf(); assert.equal(Object.keys(t).length, 2, `at most 2 different names a day: ${JSON.stringify(t)}`); assert.equal(t.weather, 2); assert.equal(t.news, 2, 'a name already counted today keeps counting');
  } finally { _setToolNameCap(null); }
});

test('the browser sends its token only to the configured Supabase origin (a wrong upload.url is refused and the reservation given back)', async () => {
  const { createFileStore, uploadTargetAllowed } = await import('../web/src/file-store.js'), { getStorage } = await import('../server/storage/index.js'), st = await getStorage();
  const o = 'https://abc.supabase.co';
  assert.equal(uploadTargetAllowed(`${o}/storage/v1/object/user-files/users/x`, o), true);
  for (const bad of ['https://evil.example/storage/v1/object/user-files/x', 'http://abc.supabase.co/storage/v1/x', 'https://abc.supabase.co.evil.example/x', `https://user:pw@abc.supabase.co/x`, 'javascript:alert(1)']) assert.equal(uploadTargetAllowed(bad, o), false, bad);
  assert.equal(uploadTargetAllowed('http://127.0.0.1:8787/dev-supabase/storage/v1/x', 'http://127.0.0.1:8787/dev-supabase'), true, 'the local dev stack');
  assert.equal(uploadTargetAllowed(`${o}/x`, ''), false, 'no configured origin: nothing is trusted');
  const api = async (path, { method = 'GET', body } = {}) => { const u = new URL(path, 'http://x'), r = await h.call(method, u.pathname, A, body ?? {}, Object.fromEntries(u.searchParams)); return { status: r.status, body: r.body }; };
  let sent = null;
  const evilApi = async (path, o2) => { const r = await api(path, o2); if (path.endsWith('/files/reserve') && r.status === 200 && r.body.upload) r.body.upload.url = 'https://evil.example/steal'; return r; };
  const s = createFileStore({ api: evilApi, idb: null, storage: null, upload: async (up) => { sent = up.url; }, download: null, uploadOrigin: () => o });
  const blob = new Blob([`origin-pin ${Date.now()}`], { type: 'text/plain' });
  await assert.rejects(s.put({ name: 'pin.txt', type: 'text/plain', kind: 'text', size: blob.size, addedAt: Date.now(), source: 'drop' }, blob, { status: 'ok', tags: [], keywords: [] }, ''), (e) => e.code === 'upload_target_untrusted');
  assert.equal(sent, null, 'no byte and no token went to the wrong address'); void st;
  assert.equal((await h.call('GET', '/api/elvar/files', A)).body.usage.reservedBytes, 0, 'the reservation was given back');
});

test('repository names with a . or .. segment are refused everywhere a repository goes into an API path with a token', async () => {
  const V = await import('../server/db/validate.js');
  for (const bad of ['../x', './x', 'a/..', 'a/.', '../..', '.a/b', 'a/b/c', 'a b/c']) assert.equal(V.REPO_RE.test(bad), false, bad);
  for (const good of ['me/notes', 'me/.github', 'a.b/c-d_e', 'me/a..b']) assert.equal(V.REPO_RE.test(good), true, good);
  assert.throws(() => V.buildInput({ repo: '../..', issueNumber: 1, title: 't' }));
  const r = await h.call('PATCH', '/api/elvar/config', A, { settings: { BRAIN_REPO: '../..' } }); assert.equal(r.status >= 400 && r.status < 500, true, JSON.stringify(r.body));
  const ok = await h.call('PATCH', '/api/elvar/config', A, { settings: { BRAIN_REPO: 'me/notes' } }); assert.equal(ok.status, 200);
  const saved = process.env.BRAIN_REPO, savedT = process.env.BRAIN_GITHUB_TOKEN; process.env.BRAIN_GITHUB_TOKEN = 'ghp_x'; process.env.BRAIN_REPO = '../..';
  try { const { syncConfigured } = await import('../server/brain-sync.js'); assert.equal(syncConfigured(), false); process.env.BRAIN_REPO = 'me/notes'; assert.equal(syncConfigured(), true); }
  finally { if (saved === undefined) delete process.env.BRAIN_REPO; else process.env.BRAIN_REPO = saved; if (savedT === undefined) delete process.env.BRAIN_GITHUB_TOKEN; else process.env.BRAIN_GITHUB_TOKEN = savedT; }
});
