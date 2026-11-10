// P8 review round 2, database side (migrations 20 and 21; docs/ELVAR_MULTIUSER.md 19): the quota check of notes and messages is serialised per user (like reserve_file), the orphan
// sweep's helper, and the Storage probes of the review (owner-only paths) on a real Postgres.
import test from 'node:test';
import assert from 'node:assert/strict';
import { admin, rawApp, asRole, newUser, deleteUser, appUrl } from './support/pg.mjs';
import { createPgDb } from '../../server/db/pool.js';
import { mintVerifiedUid } from '../../server/db/verified-uid.js';

const db = createPgDb(appUrl, { max: 12 }), app = rawApp(3);
test.after(async () => { await db.close(); await app.end({ timeout: 5 }); await admin.end({ timeout: 5 }); });

test('parallel note writes cannot pass the storage quota together (the check takes the account lock)', async () => {
  const u = await newUser(), U = mintVerifiedUid(u, 'test');
  await db.asUser(U, (r) => r.accounts.ensure()); await admin`update app.accounts set storage_quota_bytes = 1000 where user_id = ${u}`;
  const res = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => db.asUser(U, async (r) => { const out = await r.notes.put({ path: `q/${i}.md`, content: String(i % 10).repeat(300) }); await new Promise((x) => setTimeout(x, 60)); return out; })));
  const ok = res.filter((x) => x.status === 'fulfilled').length, refused = res.filter((x) => x.status === 'rejected' && x.reason.code === 'storage_quota_exceeded').length;
  assert.equal(ok, 3, `300 B x 3 fits in 1000 B, a fourth does not (got ${ok})`); assert.equal(refused, 9);
  const [used] = await admin`select notes_bytes from app.storage_usage where user_id = ${u}`; assert.ok(Number(used.notes_bytes) <= 1000, `the counter stays within the quota (${used.notes_bytes})`);
  await deleteUser(u);
});

test('parallel message appends cannot pass the storage quota together either', async () => {
  const u = await newUser(), U = mintVerifiedUid(u, 'test');
  await db.asUser(U, (r) => r.accounts.ensure()); await admin`update app.accounts set storage_quota_bytes = 1000 where user_id = ${u}`;
  const at = Date.now();
  const res = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => db.asUser(U, async (r) => { const out = await r.messages.append({ turns: [{ role: 'user', text: 'm'.repeat(300), at: at + i * 4 * 3600_000 }] }); await new Promise((x) => setTimeout(x, 60)); return out; })));
  assert.equal(res.filter((x) => x.status === 'fulfilled').length, 3);
  await deleteUser(u);
});

test('lock_my_account locks only the caller\'s own row and needs a signed-in caller', async () => {
  const a = await newUser(), b = await newUser(); await db.asUser(mintVerifiedUid(a, 'test'), (r) => r.accounts.ensure()); await db.asUser(mintVerifiedUid(b, 'test'), (r) => r.accounts.ensure());
  await assert.rejects(asRole(app, {}, (tx) => tx`select app.lock_my_account()`), (e) => e.code === '28000');
  await asRole(app, { uid: a }, async (tx) => { await tx`select app.lock_my_account()`; await db.asUser(mintVerifiedUid(b, 'test'), (r) => r.accounts.ensure()); /* b is not blocked by a's lock */ });
  await deleteUser(a); await deleteUser(b);
});

test('existing_users answers with the ids that are accounts (elvar_app only)', async () => {
  const a = await newUser(), gone = (await admin`select gen_random_uuid() as id`)[0].id;
  assert.deepEqual(await db.system.existingUsers([a, gone]), [a]); assert.deepEqual(await db.system.existingUsers([]), []);
  await assert.rejects(asRole(app, { uid: a }, (tx) => tx`select app.existing_users(array[${a}]::uuid[])`), (e) => e.code === '42501');
  await deleteUser(a);
});

const hook = async (email) => (await admin`select app.before_user_created(${admin.json({ user: { email }, metadata: { name: 'before-user-created' } })}) as r`)[0].r;
test('platform caps (P8): max_accounts stops sign-ups at the ceiling; max_total_storage_bytes stops file reservations of everybody', async () => {
  const [{ n }] = await admin`select count(*)::int as n from auth.users`;
  try {
    await admin`insert into app.platform_config (key, value) values ('max_accounts', ${String(n)}) on conflict (key) do update set value = excluded.value`;
    const denied = await hook(`cap-${Date.now()}@example.test`); assert.equal(denied.error?.http_code, 403); assert.match(denied.error.message, /full/i);
    await admin`update app.platform_config set value = ${String(n + 5)} where key = 'max_accounts'`;
    assert.deepEqual(await hook(`cap2-${Date.now()}@example.test`), {}, 'below the ceiling a sign-up is allowed');
    await admin`update app.platform_config set value = 'not a number' where key = 'max_accounts'`;
    assert.deepEqual(await hook(`cap3-${Date.now()}@example.test`), {}, 'a bad value means no ceiling');
  } finally { await admin`delete from app.platform_config where key = 'max_accounts'`; }
  const u = await newUser(), U = mintVerifiedUid(u, 'test'), reserve = (c) => db.asUser(U, (r) => r.files.reserve({ name: 'c.txt', mime: 'text/plain', kind: 'text', size: Buffer.byteLength(c), sha256: require_hex(c) }));
  try {
    const [{ total }] = await admin`select coalesce(sum(files_bytes + text_bytes + notes_bytes + messages_bytes + reserved_bytes), 0)::bigint as total from app.storage_usage`;
    await admin`insert into app.platform_config (key, value) values ('max_total_storage_bytes', ${String(Number(total) + 10)}) on conflict (key) do update set value = excluded.value`;
    await assert.rejects(reserve('x'.repeat(50)), (e) => e.code === 'platform_storage_full' && e.status === 413);
    const ok = await reserve('y'.repeat(5)); assert.ok(ok.fileId, 'a reservation that fits under the ceiling is accepted');
    await db.asUser(U, async (r) => { await r.files.beginDelete(ok.fileId); await r.files.finishDelete(ok.fileId); });
  } finally { await admin`delete from app.platform_config where key = 'max_total_storage_bytes'`; await deleteUser(u); }
});
import crypto from 'node:crypto';
const require_hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
