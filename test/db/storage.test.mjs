// Row Level Security of Supabase Storage for the file vault (docs/ELVAR_MULTIUSER.md 3.3, migration 07), on the emulated storage schema
// (test/db/support/supabase-emulation.sql: storage.objects with RLS on, the grants Supabase gives, storage.foldername()), with two users:
//   the bucket is private; only the owner reads / deletes under users/<uid>/; a write needs a live reservation of exactly that path; nothing is ever overwritten.
// Plus the database half of the quota: the reservation is atomic (parallel requests cannot both fit), users cannot write app.files / storage_usage themselves,
// the triggers keep storage_usage equal to a recount, and the object path of a row can only be the one built from its owner, id and hash.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { admin, rawApp, asRole, newUser, deleteUser, appUrl } from './support/pg.mjs';
import { createPgDb } from '../../server/db/pool.js';
import { mintVerifiedUid } from '../../server/db/verified-uid.js';

const db = createPgDb(appUrl, { max: 6 }), app = rawApp(3);
test.after(async () => { await db.close(); await app.end({ timeout: 5 }); await admin.end({ timeout: 5 }); });

const a = await newUser(), b = await newUser(), A = mintVerifiedUid(a, 'test'), B = mintVerifiedUid(b, 'test');
const hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const reserve = (U, name, content, extra = {}) => db.asUser(U, (r) => r.files.reserve({ name, mime: 'text/plain', kind: 'text', size: Buffer.byteLength(content), sha256: hex(content), ...extra }));
const denied = async (p) => { try { await p; } catch (e) { assert.equal(e.code, '42501', `expected 42501 (denied), got ${e.code}: ${e.message}`); return; } assert.fail('the statement was allowed'); };
const objects = (sql, where = '') => sql.unsafe(`select name from storage.objects where bucket_id = 'user-files' ${where} order by name`).then((r) => r.map((x) => x.name));
const put = (tx, name, bucket = 'user-files') => tx`insert into storage.objects (bucket_id, name) values (${bucket}, ${name})`;

test('the bucket is private with a 60 MB limit (the migration creates it)', async () => {
  const [bk] = await admin`select id, public, file_size_limit from storage.buckets where id = 'user-files'`;
  assert.deepEqual({ id: bk.id, public: bk.public, limit: Number(bk.file_size_limit) }, { id: 'user-files', public: false, limit: 62914560 });
});

test('upload: only a path with a live reservation of the caller can be written, only inside their own prefix', async () => {
  const r = await reserve(A, 'a.txt', 'a-content-1'), p = r.objectPath;
  assert.equal(p, `users/${a}/files/${r.fileId}/${hex('a-content-1')}`);
  await denied(asRole(app, { uid: a }, (tx) => put(tx, `users/${a}/files/${crypto.randomUUID()}/${hex('x')}`)));   // no reservation for this path
  await denied(asRole(app, { uid: a }, (tx) => put(tx, `users/${a}/anything.txt`)));
  await denied(asRole(app, { uid: b }, (tx) => put(tx, p)));                                                       // B cannot write A's reserved path
  const rb = await reserve(B, 'b.txt', 'b-content-1');
  await denied(asRole(app, { uid: a }, (tx) => put(tx, rb.objectPath)));                                          // nor can A write B's reserved path
  await denied(asRole(app, { uid: b }, (tx) => put(tx, `users/${a}/files/x/${hex('b-writes-into-a')}`)));         // B cannot put anything into A's prefix
  await asRole(app, { uid: a }, (tx) => put(tx, p));                                                              // the one thing allowed
  assert.deepEqual(await objects(admin, `and name like 'users/${a}/%'`), [p]);
  // traversal and look-alike names are not paths with a reservation
  for (const sneaky of [`users/${a}/../${b}/files/x/y`, `users/${a.toUpperCase()}/files/x/${hex('u')}`, `users/${a}//files/x`, `${p}/extra`, `users/${a}`]) await denied(asRole(app, { uid: a }, (tx) => put(tx, sneaky)));
  // other buckets have no policy at all
  await admin`insert into storage.buckets (id, name, public) values ('user-exports', 'user-exports', false), ('user-cache', 'user-cache', false), ('public-stuff', 'public-stuff', true) on conflict do nothing`;
  for (const bucket of ['user-exports', 'user-cache', 'public-stuff']) await denied(asRole(app, { uid: a }, (tx) => put(tx, `users/${a}/x.txt`, bucket)));
});

test('a reservation that is finished, expired, being deleted or somebody else\'s no longer allows a write; an object is never overwritten', async () => {
  const content = 'a-content-2', r = await reserve(A, 'two.txt', content);
  await asRole(app, { uid: a }, (tx) => put(tx, r.objectPath));
  await assert.rejects(asRole(app, { uid: a }, (tx) => put(tx, r.objectPath)), (e) => e.code === '23505', 'a second write to the same name is a duplicate, never an overwrite');
  await db.asUser(A, (r2) => r2.files.finalize(r.fileId, { size: Buffer.byteLength(content), text: '' }));
  await admin`delete from storage.objects where name = ${r.objectPath}`;
  await denied(asRole(app, { uid: a }, (tx) => put(tx, r.objectPath)));                                           // the file is ready: the reservation is over
  const old = await reserve(A, 'old.txt', 'a-content-3'); await admin`update app.files set reserved_until = now() - interval '1 minute' where id = ${old.fileId}`;
  await denied(asRole(app, { uid: a }, (tx) => put(tx, old.objectPath)));                                         // expired
  const gone = await reserve(A, 'gone.txt', 'a-content-4'); await db.asUser(A, (r2) => r2.files.beginDelete(gone.fileId));
  await denied(asRole(app, { uid: a }, (tx) => put(tx, gone.objectPath)));                                        // cancelled
  // no update policy: an existing object can be neither renamed into another path nor replaced
  const live = await reserve(A, 'live.txt', 'a-content-5'); await asRole(app, { uid: a }, (tx) => put(tx, live.objectPath));
  assert.equal((await asRole(app, { uid: a }, (tx) => tx`update storage.objects set name = ${'users/' + a + '/renamed'} where name = ${live.objectPath}`)).count, 0);
  assert.equal((await asRole(app, { uid: a }, (tx) => tx`update storage.objects set metadata = '{"size":1}'::jsonb where name = ${live.objectPath}`)).count, 0);
  assert.deepEqual(await objects(admin, `and name = '${live.objectPath}'`), [live.objectPath]);
});

test('read and delete: the owner only, and (migration 20) only a READY object can be read and only a dead row\'s object deleted; B and anon and a caller without claims see and delete nothing of A\'s', async () => {
  await admin`delete from storage.objects where name like ${'users/' + a + '/%'}`;
  const content = 'a-content-6', r = await reserve(A, 'read.txt', content); await asRole(app, { uid: a }, (tx) => put(tx, r.objectPath));
  assert.deepEqual(await asRole(app, { uid: a }, (tx) => objects(tx)), [], 'a pending (unverified) object cannot be read, not even by its owner');
  assert.equal((await asRole(app, { uid: a }, (tx) => tx`delete from storage.objects where name = ${r.objectPath}`)).count, 0, 'and a live pending object cannot be deleted (no delete + upload again inside the reservation)');
  await assert.rejects(asRole(app, { uid: a }, (tx) => put(tx, r.objectPath)), (e) => e.code === '23505');
  await db.asUser(A, (r2) => r2.files.finalize(r.fileId, { size: Buffer.byteLength(content), text: '' }));
  assert.deepEqual(await asRole(app, { uid: a }, (tx) => objects(tx)), [r.objectPath], 'the owner reads their own READY object');
  assert.deepEqual(await asRole(app, { uid: b }, (tx) => objects(tx)), [], 'B sees nothing');
  assert.deepEqual(await asRole(app, {}, (tx) => objects(tx)), [], 'no claims: nothing');
  await denied(asRole(app, { uid: a, role: null }, (tx) => objects(tx)));                                          // not switched to authenticated: no privilege at all
  await denied(app.begin(async (tx) => { await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: a, role: 'anon' })}, true)`; try { await tx.unsafe('set local role anon'); } catch (err) { throw Object.assign(new Error(err.message), { code: '42501' }); } return objects(tx); }));
  assert.deepEqual(await admin.begin(async (tx) => { await tx.unsafe('set local role anon'); return objects(tx); }), [], 'anon (a superuser playing it): nothing, there is no policy for anon');
  assert.equal((await asRole(app, { uid: b }, (tx) => tx`delete from storage.objects where name = ${r.objectPath}`)).count, 0, 'B cannot delete A\'s object');
  assert.equal((await asRole(app, { uid: b }, (tx) => tx`delete from storage.objects where bucket_id = 'user-files'`)).count, 0, 'not even by deleting everything');
  assert.equal((await asRole(app, { uid: a }, (tx) => tx`delete from storage.objects where name = ${r.objectPath}`)).count, 0, 'the owner cannot delete a READY object behind the database (the row would stay counted)');
  assert.deepEqual(await objects(admin, `and name like 'users/${a}/%'`), [r.objectPath]);
  await db.asUser(A, (r2) => r2.files.beginDelete(r.fileId));
  assert.equal((await asRole(app, { uid: a }, (tx) => tx`delete from storage.objects where name = ${r.objectPath}`)).count, 1, 'once the row is deleting, the owner removes the object');
  assert.deepEqual(await objects(admin, `and name like 'users/${a}/%'`), []);
  await db.asUser(A, (r2) => r2.files.finishDelete(r.fileId));
});

test('an expired reservation: the owner can neither read nor delete the leftover object (the server removes it); a suspended account cannot write into a reservation it made earlier', async () => {
  const r = await reserve(A, 'exp.txt', 'a-content-exp');
  await admin`update app.accounts set status = 'suspended' where user_id = ${a}`;
  await denied(asRole(app, { uid: a }, (tx) => put(tx, r.objectPath)));
  await admin`update app.accounts set status = 'active' where user_id = ${a}`;
  await asRole(app, { uid: a }, (tx) => put(tx, r.objectPath));
  assert.equal((await asRole(app, { uid: a }, (tx) => tx`delete from storage.objects where name = ${r.objectPath}`)).count, 0, 'live: no');
  await admin`update app.files set reserved_until = now() - interval '1 minute' where user_id = ${a} and id = ${r.fileId}`;
  assert.equal((await asRole(app, { uid: a }, (tx) => tx`delete from storage.objects where name = ${r.objectPath}`)).count, 0, 'expired: no either, the server sweeps it with the service key');
  assert.deepEqual(await asRole(app, { uid: a }, (tx) => objects(tx, `and name = '${r.objectPath}'`)), [], 'and an expired, never verified object is not readable');
  await db.asUser(A, async (r2) => { await r2.files.beginDelete(r.fileId); await r2.files.finishDelete(r.fileId); });
});

test('the reservation lives 15 minutes; the platform per-file limit (platform_config) is enforced by reserve_file and the bucket limit follows it by trigger', async () => {
  const r = await reserve(A, 'ttl.txt', 'a-content-ttl'), [row] = await admin`select extract(epoch from reserved_until - now()) as s from app.files where id = ${r.fileId}`;
  assert.ok(Number(row.s) <= 900 && Number(row.s) > 840, `reservation lives ${row.s} s`);
  try {
    assert.equal(await db.system.maxFileBytes(), 62914560, 'default 60 MB');
    assert.equal(await db.system.setMaxFileBytes(52428800), 52428800);
    const [bk] = await admin`select file_size_limit from storage.buckets where id = 'user-files'`; assert.equal(Number(bk.file_size_limit), 52428800, 'the bucket limit follows');
    await assert.rejects(db.asUser(A, (r2) => r2.files.reserve({ name: 'big.txt', mime: 'text/plain', kind: 'text', size: 52428801, sha256: hex('big') })), (e) => e.code === 'file_too_large');
    await admin`update app.platform_config set value = 'not a number' where key = 'max_file_bytes'`;
    assert.equal(await db.system.maxFileBytes(), 62914560, 'a bad value falls back to the default');
    await assert.rejects(db.system.setMaxFileBytes(10));
  } finally { await admin`delete from app.platform_config where key = 'max_file_bytes'`; const [bk] = await admin`select file_size_limit from storage.buckets where id = 'user-files'`; assert.equal(Number(bk.file_size_limit), 62914560, 'removing the row restores the default on the bucket'); }
  await db.asUser(A, async (r2) => { await r2.files.beginDelete(r.fileId); await r2.files.finishDelete(r.fileId); });
});

test('B cannot make the database hand out A\'s path: a reservation is always built from B\'s own id; the path column cannot hold anything else', async () => {
  const rb = await reserve(B, 'b2.txt', 'a-content-6');   // the same content (hash) as A used: still B's own path
  assert.match(rb.objectPath, new RegExp(`^users/${b}/files/`));
  const id = crypto.randomUUID();
  for (const path of [`users/${a}/files/${id}/${hex('x')}`, `users/${b}/files/${id}/${'0'.repeat(64)}`, `users/${b}/files/other/${hex('x')}`]) {
    await assert.rejects(admin`insert into app.files (user_id, id, name, mime, kind, size_bytes, sha256, object_path) values (${b}, ${id}, 'x.txt', 'text/plain', 'text', 1, ${hex('x')}, ${path})`, (e) => e.code === '23514');
  }
});

test('users cannot write app.files, app.file_texts or storage_usage themselves: every change goes through the definer functions', async () => {
  const r = await reserve(A, 'direct.txt', 'a-content-7');
  for (const stmt of [
    (tx) => tx`insert into app.files (user_id, name, mime, kind, size_bytes, sha256, object_path, status) values (${a}, 'x.txt', 'text/plain', 'text', 1, ${hex('x')}, 'x', 'ready')`,
    (tx) => tx`update app.files set status = 'ready' where id = ${r.fileId}`, (tx) => tx`update app.files set size_bytes = 1 where id = ${r.fileId}`, (tx) => tx`delete from app.files where id = ${r.fileId}`,
    (tx) => tx`insert into app.file_texts (user_id, file_id, text) values (${a}, ${r.fileId}, 'x')`, (tx) => tx`update app.storage_usage set files_bytes = 0 where user_id = ${a}`,
    (tx) => tx`delete from app.storage_usage where user_id = ${a}`, (tx) => tx`insert into app.storage_usage (user_id) values (${crypto.randomUUID()})`,
  ]) await denied(asRole(app, { uid: a }, stmt));
  // and the definer functions act for the caller only
  await assert.rejects(asRole(app, { uid: b }, (tx) => tx`select app.finalize_file(${r.fileId}::uuid, 11::bigint, null, null, '{}'::text[], '', '{}'::jsonb, null, '')`), (e) => e.code === 'P0002');
  await assert.rejects(asRole(app, { uid: b }, (tx) => tx`select app.begin_delete_file(${r.fileId}::uuid)`), (e) => e.code === 'P0002');
  await assert.rejects(asRole(app, { uid: b }, (tx) => tx`select app.patch_file(${r.fileId}::uuid, '{"memo":"x"}'::jsonb)`), (e) => e.code === 'P0002');
  assert.equal((await asRole(app, { uid: b }, (tx) => tx`select app.finish_delete_file(${r.fileId}::uuid) as ok`))[0].ok, false);
  await assert.rejects(asRole(app, {}, (tx) => tx`select app.reserve_file('x.txt', 'text/plain', 'text', 1::bigint, ${hex('x')})`), (e) => e.code === '28000', 'no caller, no reservation');
  for (const call of ["app.stale_files(10)", "app.reconcile_storage()", `app.drop_stale_file('${a}', '${r.fileId}')`]) await denied(asRole(app, { uid: b }, (tx) => tx.unsafe(`select * from ${call}`)));
  await denied(asRole(app, { uid: b }, (tx) => tx.unsafe('select app._storage_track()')));
});

test('the quota check is atomic: two uploads that each fit alone cannot both be reserved at once', async () => {
  const c = await newUser(), C = mintVerifiedUid(c, 'test');
  await db.asUser(C, (r) => r.accounts.ensure()); await admin`update app.accounts set storage_quota_bytes = 1000 where user_id = ${c}`;
  const attempts = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => reserve(C, `p${i}.txt`, 'x'.repeat(600) + i)));
  assert.equal(attempts.filter((x) => x.status === 'fulfilled').length, 1, 'exactly one reservation of 601 bytes fits in 1000');
  assert.ok(attempts.filter((x) => x.status === 'rejected').every((x) => x.reason.code === 'storage_quota_exceeded'));
  assert.equal((await db.asUser(C, (r) => r.usage.storage())).reservedBytes, 601);
  await deleteUser(c);
});

test('storage_usage is kept by triggers (notes, versions, messages, files, texts) and a recount agrees; the daily reconciliation repairs a drifted counter', async () => {
  const c = await newUser(), C = mintVerifiedUid(c, 'test');
  await db.asUser(C, async (r) => {
    await r.notes.put({ path: 'n.md', content: '12345' }); await r.notes.put({ path: 'n.md', content: '1234567' }); await r.messages.append({ turns: [{ role: 'user', text: 'ab', at: Date.now() }] });
    const f = await r.files.reserve({ name: 'f.txt', mime: 'text/plain', kind: 'text', size: 11, sha256: hex('f'), textBytes: 3 }); await r.files.finalize(f.fileId, { size: 11, text: 'abc' });
  });
  const read = () => admin`select files_bytes, reserved_bytes, text_bytes, notes_bytes, messages_bytes from app.storage_usage where user_id = ${c}`.then((r) => ({ ...r[0] }));
  const exact = { files_bytes: '11', reserved_bytes: '0', text_bytes: '3', notes_bytes: '12', messages_bytes: '2' };
  const norm = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));
  assert.deepEqual(norm(await read()), exact);
  await db.asUser(C, async (r) => { await r.notes.purge((await r.notes.get('n.md')).id); });
  assert.equal(String((await read()).notes_bytes), '0', 'deleting a note (and its versions, by cascade) frees its bytes');
  await admin`update app.storage_usage set files_bytes = 999999, messages_bytes = 0 where user_id = ${c}`;
  assert.ok(Number(await admin`select app.reconcile_storage() as n`.then((r) => r[0].n)) >= 1);
  assert.deepEqual(norm(await read()), { ...exact, notes_bytes: '0' });
  await admin`update app.storage_usage set files_bytes = 5 where user_id = ${c}`;
  await asRole(app, { uid: c }, (tx) => tx`select app.recount_my_storage()`); assert.equal(String((await read()).files_bytes), '11', 'the owner can recount their own');
  await deleteUser(c);
  assert.equal((await admin`select count(*)::int as n from app.storage_usage where user_id = ${c}`)[0].n, 0, 'deleting the user leaves no counter behind (the triggers do not re-create it)');
});

test('deleting the auth user removes their files and texts; Storage objects are not touched by SQL (the purge job removes them with the service key)', async () => {
  const c = await newUser(), C = mintVerifiedUid(c, 'test'), f = await reserve(C, 'z.txt', 'zzz-' + c); await asRole(app, { uid: c }, (tx) => put(tx, f.objectPath));
  await db.asUser(C, (r) => r.files.finalize(f.fileId, { size: Buffer.byteLength('zzz-' + c), text: '' }));
  await deleteUser(c);
  assert.equal((await admin`select count(*)::int as n from app.files where user_id = ${c}`)[0].n, 0);
  assert.deepEqual(await objects(admin, `and name like 'users/${c}/%'`), [f.objectPath], 'the object is still there: only the Storage sweep can remove it');
  await admin`delete from storage.objects where name = ${f.objectPath}`;
});
