// Migration 19 on a real Postgres (docs/ELVAR_MULTIUSER.md 7.3): the export jobs are written only by the server's functions (one active job per account, forward-only progress,
// stalled jobs failed, expired ones listed, drop), the user reads their own jobs and nobody else's and cannot write progress; the private `user-exports` bucket can be read
// by its owner only and written by nobody but the service key; and the deletion list carries the confirmation address.
import test from 'node:test';
import assert from 'node:assert/strict';
import { admin, rawApp, asRole, newUser, deleteUser, appUrl } from './support/pg.mjs';
import { createPgDb } from '../../server/db/pool.js';
import { mintVerifiedUid } from '../../server/db/verified-uid.js';

const db = createPgDb(appUrl, { max: 4 }), app = rawApp(2);
test.after(async () => { await db.close(); await app.end({ timeout: 5 }); await admin.end({ timeout: 5 }); });
const denied = async (p, codes = ['42501']) => { try { await p; } catch (e) { assert.ok(codes.includes(e.code), `expected ${codes}, got ${e.code}: ${e.message}`); return; } assert.fail('the statement was allowed'); };

test('export jobs: one active job at a time, forward-only progress, readable by the owner only, not writable by anybody but the server functions', async () => {
  const a = await newUser(), b = await newUser(), A = mintVerifiedUid(a, 'test'), B = mintVerifiedUid(b, 'test');
  try {
    const id = await db.system.createExportJob(A);
    await assert.rejects(db.system.createExportJob(A), (e) => e.code === 'conflict', 'a second job while one is queued');
    assert.equal((await db.asUser(A, (r) => r.exportJobs.get(id))).status, 'queued'); assert.equal(await db.asUser(B, (r) => r.exportJobs.get(id)), null, 'B cannot see it'); assert.deepEqual(await db.asUser(B, (r) => r.exportJobs.list()), []);
    assert.equal(await db.system.updateExportJob(A, id, { status: 'running', cursor: { stage: 'data' }, parts: 1, bytes: 10 }), true);
    assert.equal(await db.system.updateExportJob(B, id, { status: 'failed' }), false, 'a job is changed only through its own owner id');
    assert.equal(await db.system.updateExportJob(A, id, { status: 'done', cursor: { stage: 'done' }, parts: 2, bytes: 99, expiresAt: new Date(Date.now() + 86400_000).toISOString() }), true);
    assert.equal(await db.system.updateExportJob(A, id, { status: 'failed' }), false, 'a finished job never changes again');
    const j = await db.asUser(A, (r) => r.exportJobs.get(id)); assert.deepEqual([j.status, j.parts, j.bytes], ['done', 2, 99]); assert.ok(j.expiresAt);
    assert.ok((await db.asUser(A, (r) => r.audit.list())).some((e) => e.action === 'export.completed' && e.actor === 'system'));
    // the user cannot write jobs or progress themselves
    await denied(asRole(app, { uid: a }, (tx) => tx`update app.export_jobs set status = 'queued', expires_at = null where id = ${id}`));
    await denied(asRole(app, { uid: a }, (tx) => tx`delete from app.export_jobs where id = ${id}`));
    await denied(asRole(app, { uid: a }, (tx) => tx`insert into app.export_jobs (user_id, status, parts) values (${a}, 'done', 5)`), ['42501', '23514']);
    for (const fn of ['export_job_create', 'export_job_update', 'export_jobs_expired', 'export_job_drop']) assert.equal((await admin`select has_function_privilege('authenticated', p.oid, 'execute') as ok from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = ${fn}`)[0].ok, false, fn);
    // expired / stalled / failed
    assert.ok(!(await db.system.expiredExportJobs()).some((x) => x.id === id), 'not expired yet');
    await admin`update app.export_jobs set expires_at = now() - interval '1 minute' where id = ${id}`; assert.ok((await db.system.expiredExportJobs()).some((x) => x.id === id && x.userId === a));
    assert.equal(await db.system.dropExportJob(a, id), true); assert.equal(await db.system.dropExportJob(a, id), false);
    const id2 = await db.system.createExportJob(A); await admin`update app.export_jobs set updated_at = now() - interval '31 minutes' where id = ${id2}`; await db.system.expiredExportJobs();
    assert.deepEqual([(await db.asUser(A, (r) => r.exportJobs.get(id2))).status, (await db.asUser(A, (r) => r.exportJobs.get(id2))).error], ['failed', 'stalled']);
    await admin`update app.export_jobs set updated_at = now() - interval '3 days' where id = ${id2}`; assert.ok((await db.system.expiredExportJobs()).some((x) => x.id === id2)); await db.system.dropExportJob(a, id2);
    await assert.rejects(db.system.createExportJob(mintVerifiedUid('00000000-0000-4000-8000-000000000000', 'test')), (e) => e.code === 'not_found');
    const cnt = await db.asUser(A, (r) => r.rights.counts()); assert.equal(typeof cnt.notes, 'number'); assert.ok('export_jobs' in cnt && 'files' in cnt && 'usage_daily' in cnt);
  } finally { await deleteUser(a); await deleteUser(b); }
});

test('the user-exports bucket is private, readable only inside the owner\'s prefix, writable by nobody (the service key writes it)', async () => {
  const [bk] = await admin`select id, public from storage.buckets where id = 'user-exports'`; assert.deepEqual({ id: bk.id, public: bk.public }, { id: 'user-exports', public: false });
  const a = await newUser(), b = await newUser();
  try {
    await admin.unsafe(`insert into storage.objects (bucket_id, name) values ('user-exports', 'users/${a}/exports/job/part-1.zip'), ('user-exports', 'users/${b}/exports/job/part-1.zip')`);
    const seen = (u) => asRole(app, { uid: u }, (tx) => tx`select name from storage.objects where bucket_id = 'user-exports' order by name`).then((r) => r.map((x) => x.name));
    assert.deepEqual(await seen(a), [`users/${a}/exports/job/part-1.zip`]); assert.deepEqual(await seen(b), [`users/${b}/exports/job/part-1.zip`]);
    await denied(asRole(app, { uid: a }, (tx) => tx`insert into storage.objects (bucket_id, name) values ('user-exports', ${`users/${a}/exports/job/part-2.zip`})`));
    assert.equal((await asRole(app, { uid: a }, (tx) => tx`delete from storage.objects where bucket_id = 'user-exports' returning name`)).length, 0, 'the owner cannot delete an export either: only the service key does');
    assert.equal((await asRole(app, { uid: a }, (tx) => tx`update storage.objects set name = name where bucket_id = 'user-exports' returning name`)).length, 0);
  } finally { await admin`delete from storage.objects where bucket_id = 'user-exports'`; await deleteUser(a); await deleteUser(b); }
});

test('due deletions carry the confirmation address (read once; it goes with the request row)', async () => {
  const u = await newUser();
  try {
    await asRole(app, { uid: u }, (tx) => tx`select app.request_deletion(0::smallint, 'gone@example.test')`);
    const due = (await db.system.dueDeletions(100)).find((d) => d.userId === u); assert.deepEqual([due.graceDays, due.email], [0, 'gone@example.test']);
  } finally { await deleteUser(u); assert.equal((await admin`select count(*)::int as n from app.deletion_requests where email_for_receipt = 'gone@example.test'`)[0].n, 0, 'the address died with the account'); }
});
