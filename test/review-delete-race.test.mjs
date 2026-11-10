// P8 review round 2, blocker 1 (docs/ELVAR_MULTIUSER.md 19): an immediate deletion must leave nothing in Storage even when an export step (or an upload) is in flight.
// The deletion request cascades away with the Auth user, so "retry next run" does not exist: the window is closed by (1) a purge lock + failed jobs, (2) a second sweep after the Auth
// user is deleted, (3) a step that removes its own part when its job is gone, and (4) a daily orphan sweep of every bucket.
import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/api-harness.mjs';
import { getStorage } from '../server/storage/index.js';
import { _setExportOptions } from '../server/account/exports.js';
import { purgeAccount, sweepOrphanStorage } from '../server/rights/purge.js';
import { dailyCron } from '../server/admin/cron.js';
import { mintVerifiedUid } from '../server/db/verified-uid.js';

let h, st;
test.before(async () => { h = await startHarness(); st = await getStorage(); });
test.after(async () => { _setExportOptions(null); await h.stop(); });
const mk = async (email) => { const u = h.mkUser(email), W = await h.bearer(u, { email }); await h.call('GET', '/api/elvar/session', W); return { u, W }; };
const leftOf = (u) => st.testing.list().filter((k) => k.includes(u));

test('an export step that is uploading its part while the account is deleted immediately leaves nothing behind (reviewer reproduction)', async () => {
  const { u, W } = await mk('d@example.test');
  for (let i = 0; i < 5; i++) await h.call('POST', '/api/elvar/notes', W, { path: `n/${i}.md`, content: 'x'.repeat(3000) + i });
  _setExportOptions({ partBytes: 2000 });
  const first = await h.call('POST', '/api/elvar/export', W, {}); assert.equal(first.status, 200); assert.equal(first.body.job.status, 'running');
  const origPut = st.service.put.bind(st.service);
  st.service.put = async (...a) => { await new Promise((r) => setTimeout(r, 150)); return origPut(...a); };   // the upload of the part takes a moment
  try {
    const step = h.call('POST', `/api/elvar/export/${first.body.job.id}/step`, W, {});   // in flight
    await new Promise((r) => setTimeout(r, 30));
    const del = await h.call('POST', '/api/elvar/account/delete', W, { graceDays: 0 }); assert.equal(del.status, 200, JSON.stringify(del.body));
    const s = await step; assert.ok([200, 404, 401, 403].includes(s.status), `the step ends cleanly (${s.status})`);
  } finally { st.service.put = origPut; _setExportOptions(null); }
  assert.deepEqual(leftOf(u), [], 'no object of the deleted user is left in any bucket');
  assert.deepEqual((await h.db.system.dueDeletions(20)).filter((d) => d.userId === u), [], 'and no deletion request is left waiting');
});

test('purgeAccount: the second sweep after the Auth user is deleted removes what landed in between; the purge lock and failed jobs stop export steps', async () => {
  const { u, W } = await mk('p@example.test'); await h.call('POST', '/api/elvar/notes', W, { path: 'a.md', content: 'a' });
  _setExportOptions({ partBytes: 100 }); const job = (await h.call('POST', '/api/elvar/export', W, {})).body.job; _setExportOptions(null); assert.equal(job.status, 'running');
  const V = mintVerifiedUid(u, 'test'); let lockSeen = null, jobSeen = null;
  const deleteUser = async (uid) => {   // what the Auth admin API does, with a late write racing it
    lockSeen = await h.db.asUser(V, (r) => r.kv.get('purge-lock')); jobSeen = (await h.db.asUser(V, (r) => r.exportJobs.get(job.id))).status;
    h.db.testing.deleteUser(uid); st.testing.put(`users/${uid}/exports/${job.id}/part-9.zip`, Buffer.from('late'), { bucket: 'user-exports' }); st.testing.put(`users/${uid}/files/x/late`, Buffer.from('late'));
    return true;
  };
  const res = await purgeAccount(h.db, u, { deleteUser, revoke: [], storage: st });
  assert.ok(lockSeen, 'the purge lock was set before the account went'); assert.equal(jobSeen, 'failed', 'and the running export job was failed');
  assert.ok(res.tablesChecked > 0); assert.deepEqual(leftOf(u), [], 'the late objects were removed by the second sweep, so the residual check is clean');
});

test('the daily orphan sweep removes objects of an owner that is no longer an account, in every bucket, and never touches a live account', async () => {
  const { u: live } = await mk('live@example.test'), gone = crypto.randomUUID();
  st.testing.put(`users/${gone}/files/a/b`, Buffer.from('x')); st.testing.put(`users/${gone}/exports/j/part-1.zip`, Buffer.from('x'), { bucket: 'user-exports' }); st.testing.put(`users/${gone}/greetings/g.pcm`, Buffer.from('x'), { bucket: 'user-cache' });
  st.testing.put(`users/${live}/files/keep/me`, Buffer.from('keep'));
  const r = await sweepOrphanStorage(h.db, st); assert.equal(r.orphans, 1); assert.equal(r.removed, 3);
  assert.deepEqual(leftOf(gone), []); assert.equal(leftOf(live).length, 1, 'a live account\'s object stays');
  // the cron runs it (and the other steps keep going)
  st.testing.put(`users/${gone}/files/c/d`, Buffer.from('x'));
  const out = await dailyCron({ user: { system: h.db.system } }, { purge: async () => ({ purged: 0, failed: 0 }) }); assert.equal(out.body.orphans.orphans, 1); assert.deepEqual(leftOf(gone), []);
  assert.deepEqual(out.body.errors, []);
});

test('a step whose job is gone removes the part it just wrote (the job was removed while the step was building it)', async () => {
  const { u, W } = await mk('g@example.test'); for (let i = 0; i < 4; i++) await h.call('POST', '/api/elvar/notes', W, { path: `n/${i}.md`, content: 'y'.repeat(2000) + i });
  _setExportOptions({ partBytes: 1500 }); const job = (await h.call('POST', '/api/elvar/export', W, {})).body.job; _setExportOptions({ partBytes: 1500 });
  const origPut = st.service.put.bind(st.service);
  st.service.put = async (...a) => { await h.call('DELETE', `/api/elvar/export/${job.id}`, W, {}); return origPut(...a); };   // the user removes the export just as the part is being written
  try { const s = await h.call('POST', `/api/elvar/export/${job.id}/step`, W, {}); assert.equal(s.status, 404); } finally { st.service.put = origPut; _setExportOptions(null); }
  assert.deepEqual(leftOf(u).filter((k) => k.startsWith('user-exports/')), [], 'no part of a job that does not exist');
});
