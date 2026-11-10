// 「私のデータ」 and the end of an account (docs/ELVAR_MULTIUSER.md 7.2, 7.4; principle 7): every registry table belongs to a kind shown to its owner, the owner can see the counts and
// remove what has no screen of its own, the audit log is the owner's, and a deletion leaves nothing behind - not in the tables, not in Storage (exports included), and not in
// rate_limits - and the optional confirmation hook gets the address once, only after the deletion was verified.
import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/api-harness.mjs';
import { runExport } from './helpers/export.mjs';
import { browserUpload } from './helpers/upload.mjs';
import { getStorage } from '../server/storage/index.js';
import { TYPES, typeTables } from '../server/rights/mydata-types.js';
import { REGISTRY } from '../server/rights/registry.js';
import { ROUTES } from '../server/router.js';
import { sendDeletionReceipt, purgeAccount } from '../server/rights/purge.js';
import { residualCheck } from '../server/rights/residual.js';
import { mintVerifiedUid } from '../server/db/verified-uid.js';

let h, st, a, A;
test.before(async () => { h = await startHarness(); st = await getStorage(); a = h.mkUser('a@example.test'); A = await h.bearer(a, { email: 'a@example.test' }); await h.call('GET', '/api/elvar/session', A); });
test.after(() => h.stop());

test('every registry table belongs to exactly one kind of the 私のデータ screen, and every action it offers exists', () => {
  assert.deepEqual([...typeTables()].sort(), REGISTRY.map((e) => e.table).sort(), 'a table without a kind (or a kind with a table that does not exist)');
  assert.equal(new Set(typeTables()).size, typeTables().length, 'a table in two kinds');
  const has = (m, p) => ROUTES.some((r) => r.method === m && r.path === p);
  for (const t of TYPES) {
    assert.ok(t.label && t.note, t.id);
    if (t.del?.route) assert.ok(has(t.del.route.method, t.del.route.path), `${t.id}: ${t.del.route.method} ${t.del.route.path}`);
    if (t.del?.type) assert.ok(['profile', 'settings', 'keys', 'builds', 'devices'].includes(t.del.type), t.id);
    if (t.open) assert.ok(t.open.tab ? ['account', 'keys', 'google', 'connectors', 'profile', 'features', 'memory', 'device', 'admin'].includes(t.open.tab) : ['brain', 'conversations', 'files', 'usage', 'audit'].includes(t.open.action), t.id);
  }
  for (const id of ['profile', 'settings', 'keys', 'google', 'connectors', 'notes', 'conversations', 'files', 'inbox', 'usage', 'devices', 'audit']) assert.ok(TYPES.some((t) => t.id === id), `the screen lists ${id}`);
});

test('GET /api/elvar/mydata: counts and sizes per kind, the finance / shift / course / project notes, the storage meter; remove what has no endpoint of its own; the audit log is mine', async () => {
  await h.call('PATCH', '/api/elvar/config', A, { secrets: { GEMINI_API_KEY: 'AIza-mydata-key-1234567890', GROQ_API_KEY: 'gsk-mydata-key-1234567890' }, settings: { BRAIN_REPO: 'me/x' } });
  await h.call('POST', '/api/elvar/notes', A, { path: '家計/2026-11.md', content: '# 家計' }); await h.call('POST', '/api/elvar/notes', A, { path: 'シフト/2026-11.md', content: '# シフト' }); await h.call('POST', '/api/elvar/notes', A, { path: 'メモ.md', content: 'x' });
  await h.call('POST', '/api/elvar/devices', A, { name: 'phone' }); await h.db.asUser(mintVerifiedUid(a, 'test'), (r) => r.builds.record({ repo: 'me/r', issueNumber: 1, title: 't' }));
  const m = (await h.call('GET', '/api/elvar/mydata', A)).body, by = Object.fromEntries(m.types.map((t) => [t.id, t]));
  assert.equal(by.notes.count, 3); assert.ok(by.notes.bytes > 0); assert.equal(by.keys.count, 2); assert.equal(by.devices.count, 1); assert.equal(by.builds.count, 1); assert.equal(by.google.detail, '未接続'); assert.equal(by.profile.deletable, true); assert.equal(by.usage.deletable, false); assert.equal(by.audit.deletable, false);
  assert.deepEqual(m.noteFolders.map((f) => [f.label, f.count]), [['家計', 1], ['シフト', 1], ['履修', 0], ['プロジェクト', 0]]); assert.equal(m.storage.quotaBytes, 524288000); assert.ok(m.storage.usedBytes > 0);
  assert.deepEqual(Object.keys(m.tables).sort(), REGISTRY.map((e) => e.table).sort());
  assert.equal(JSON.stringify(m).includes('AIza-mydata-key'), false, 'no secret values');
  // remove kinds
  assert.equal((await h.call('POST', '/api/elvar/mydata/keys/delete', A, {})).status, 400);
  assert.equal((await h.call('POST', '/api/elvar/mydata/keys/delete', A, { confirm: 'delete' })).body.deleted, 2); assert.equal((await h.call('GET', '/api/elvar/config', A)).body.secrets.GEMINI_API_KEY.set, false);
  assert.equal((await h.call('POST', '/api/elvar/mydata/devices/delete', A, { confirm: 'delete' })).body.deleted, 1); assert.equal((await h.call('POST', '/api/elvar/mydata/builds/delete', A, { confirm: 'delete' })).body.deleted, 1);
  await h.call('PUT', '/api/elvar/usage/limits', A, { provider: 'groq', metric: 'calls', period: 'day', soft: 5, softAction: 'warn' });
  assert.equal((await h.call('POST', '/api/elvar/mydata/settings/delete', A, { confirm: 'delete' })).body.deleted, 2, 'the settings and the usage limit'); assert.deepEqual((await h.call('GET', '/api/elvar/usage', A)).body.limits, []);
  const prof = structuredClone((await h.call('GET', '/api/elvar/profile', A)).body.profile); prof.assistant.displayName = 'CUSTOM-NAME'; await h.call('PUT', '/api/elvar/profile', A, { profile: prof });
  assert.equal((await h.call('POST', '/api/elvar/mydata/profile/delete', A, { confirm: 'delete' })).status, 200); assert.notEqual((await h.call('GET', '/api/elvar/profile', A)).body.profile.assistant.displayName, 'CUSTOM-NAME', 'back to the default persona');
  assert.equal((await h.call('POST', '/api/elvar/mydata/notes/delete', A, { confirm: 'delete' })).status, 404, 'notes have their own endpoint');
  const audit = (await h.call('GET', '/api/elvar/audit', A)).body.audit; assert.ok(audit.some((e) => e.action === 'mydata.keys.deleted'), 'what I removed is in my own log');
});

test('the confirmation hook: the address goes out once, only after a clean deletion; a failing hook never undoes it; nothing about the user is kept', async () => {
  const posts = [], fx = async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true }; };
  assert.equal(await sendDeletionReceipt('x@example.test', { env: {}, fetchImpl: fx }), false, 'no hook configured'); assert.equal(await sendDeletionReceipt('x@example.test', { env: { ELVAR_DELETION_RECEIPT_WEBHOOK: 'http://evil.example/hook' }, fetchImpl: fx }), false, 'plain http to a remote host is refused'); assert.equal(await sendDeletionReceipt('', { env: { ELVAR_DELETION_RECEIPT_WEBHOOK: 'https://h.example/x' }, fetchImpl: fx }), false);
  assert.equal(await sendDeletionReceipt('x@example.test', { env: { ELVAR_DELETION_RECEIPT_WEBHOOK: 'https://h.example/x' }, fetchImpl: fx }), true); assert.deepEqual([posts[0].url, posts[0].body.to, /削除が完了/.test(posts[0].body.text)], ['https://h.example/x', 'x@example.test', true]);
  assert.equal(await sendDeletionReceipt('x@example.test', { env: { ELVAR_DELETION_RECEIPT_WEBHOOK: 'https://h.example/x' }, fetchImpl: async () => { throw new Error('down'); } }), false, 'a failing hook is only a log line');
  // end to end: a user with data, an export in the private bucket, a held export link; the deletion leaves nothing; the hook gets the address after the check
  const u = h.mkUser('gone@example.test'), U = await h.bearer(u, { email: 'gone@example.test' }); await h.call('GET', '/api/elvar/session', U);
  const bytes = crypto.randomBytes(2000), r = await h.call('POST', '/api/elvar/files/reserve', U, { name: 'g.txt', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }); await browserUpload(st, u, r.body.upload, bytes); await h.call('POST', `/api/elvar/files/${r.body.fileId}/finalize`, U, {});
  await h.call('POST', '/api/elvar/notes', U, { path: 'n.md', content: 'gone soon' }); h.db.testing.setHardLimits(u, { exportsPerDay: 1000 }); await h.call('GET', '/api/elvar/config', U);
  const x = await runExport(h, U), link = x.job.downloads[0].url;
  await h.db.system.rlHit({ bucket: 'residue-check', who: u, windowSec: 60, userId: mintVerifiedUid(u, 'test') });   // a rate-limit counter that belongs to the user
  st.testing.put(`users/${u}/greetings/g.pcm`, Buffer.from('pcm'), { bucket: 'user-cache' });
  assert.ok(st.testing.list().filter((k) => k.includes(`users/${u}/`)).length >= 3);
  const mails = []; const res = await purgeAccount(h.db, u, { email: 'gone@example.test', notify: async (to) => { mails.push(to); return true; } });
  assert.deepEqual(mails, ['gone@example.test']); assert.equal(res.mailed, true);
  const check = await residualCheck(h.db, mintVerifiedUid(u, 'purge'), { storage: st }); assert.equal(check.clean, true, JSON.stringify(check)); assert.ok(check.tablesChecked >= REGISTRY.length); assert.deepEqual(check.nonzero, []);
  assert.equal(check.nonzero.find((n) => n.table === 'rate_limits'), undefined, 'no rate-limit residue'); assert.deepEqual(check.storage.map((s) => s.n), [0, 0, 0], 'no object in any bucket (files, exports, cache)');
  await assert.rejects(st.downloadWithToken(new URL(link).searchParams.get('token')), (e) => e.status === 404, 'the held export link finds nothing any more');
  assert.equal(h.db.testing.receipts?.().some((rc) => JSON.stringify(rc).includes(u) || JSON.stringify(rc).includes('gone@')) ?? false, false, 'the receipt names neither the user nor the address');
});
