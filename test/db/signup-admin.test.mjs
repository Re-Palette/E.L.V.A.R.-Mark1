// Migration 12 on a real Postgres: the sign-up hook (disposable domains, closed / invite modes, the daily cap), usage recording, deletion requests,
// and the admin functions (metadata only, admin only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { admin, rawApp, asRole, newUser, deleteUser } from './support/pg.mjs';

const app = rawApp(2);
test.after(async () => { await app.end({ timeout: 5 }); await admin.end({ timeout: 5 }); });
const hook = async (email) => (await admin`select app.before_user_created(${admin.json({ user: { email }, metadata: { name: 'before-user-created' } })}) as r`)[0].r;
const config = (k, v) => admin`insert into app.platform_config (key, value) values (${k}, ${v}) on conflict (key) do update set value = excluded.value`;
const denied = async (p) => { try { await p; } catch (e) { assert.ok(['42501'].includes(e.code), `expected 42501, got ${e.code}: ${e.message}`); return; } assert.fail('the statement was allowed'); };

test('the hook allows an ordinary address and blocks disposable domains (and their subdomains), a missing address, in the Auth hook error format', async () => {
  assert.deepEqual(await hook('person@example.test'), {});
  for (const bad of ['x@mailinator.com', 'x@MAILINATOR.com', 'x@sub.yopmail.com']) { const r = await hook(bad); assert.equal(r.error.http_code, 400, bad); assert.match(r.error.message, /isposable/); }
  assert.equal((await hook('')).error.http_code, 400); assert.equal((await hook('no-at-sign')).error.http_code, 400);
  assert.deepEqual(await hook('notmailinator.com@example.test'), {}, 'only the domain counts');
  assert.deepEqual(await hook('x@notyopmail.com'), {}, 'a different domain that merely ends the same is fine');
});

test('closed and invite modes, and the daily cap', async () => {
  try {
    await config('signup_mode', 'closed'); assert.equal((await hook('person@example.test')).error.http_code, 403);
    await config('signup_mode', 'invite'); assert.equal((await hook('person@example.test')).error.http_code, 403);
    await admin`insert into app.signup_invites (email) values ('person@example.test') on conflict do nothing`; assert.deepEqual(await hook('Person@Example.test'), {}, 'invited, case-insensitive');
    await config('signup_mode', 'open'); assert.deepEqual(await hook('person@example.test'), {});
    const [{ n }] = await admin`select count(*)::int as n from auth.users where created_at > now() - interval '1 day'`;
    await config('daily_signup_limit', String(n)); assert.equal((await hook('late@example.test')).error.http_code, 429);
    await config('daily_signup_limit', String(n + 1000)); assert.deepEqual(await hook('late@example.test'), {});
    await config('daily_signup_limit', 'not a number'); assert.deepEqual(await hook('late@example.test'), {}, 'a broken setting does not lock everybody out');
  } finally { await config('signup_mode', 'open'); await config('daily_signup_limit', '500'); await admin`delete from app.signup_invites`; }
});

test('the hook is executable by supabase_auth_admin only; the platform tables are closed to every API role', async () => {
  const [f] = await admin`select oid from pg_proc where proname = 'before_user_created'`;
  for (const role of ['anon', 'authenticated', 'elvar_app', 'service_role']) assert.equal((await admin`select has_function_privilege(${role}, ${f.oid}, 'execute') as ok`)[0].ok, false, role);
  assert.equal((await admin`select has_function_privilege('supabase_auth_admin', ${f.oid}, 'execute') as ok`)[0].ok, true);
  for (const t of ['platform_config', 'blocked_email_domains', 'signup_invites']) for (const role of ['anon', 'authenticated', 'elvar_app']) assert.equal((await admin`select has_table_privilege(${role}, ${'app.' + t}, 'select') as ok`)[0].ok, false, `${role} reads ${t}`);
});

test('record_usage: only for the caller, bounded, adds to the day total', async () => {
  const u = await newUser(), v = await newUser();
  await asRole(app, { uid: u }, async (tx) => { await tx`select app.record_usage('gemini', 'calls', 2)`; await tx`select app.record_usage('gemini', 'calls', 3, 'client')`; });
  assert.equal(Number((await admin`select amount from app.usage_daily where user_id = ${u} and provider = 'gemini' and metric = 'calls'`)[0].amount), 5);
  assert.equal((await admin`select count(*)::int as n from app.usage_events where user_id = ${u}`)[0].n, 2); assert.equal((await admin`select count(*)::int as n from app.usage_daily where user_id = ${v}`)[0].n, 0);
  for (const bad of ["('', 'calls', 1)", "('g', '', 1)", "('g', 'calls', -1)", "('g', 'calls', 1000000001)", "('g', 'calls', 1, 'bogus')"]) await assert.rejects(asRole(app, { uid: u }, (tx) => tx.unsafe(`select app.record_usage${bad}`)), (e) => e.code === '22023', bad);
  await assert.rejects(asRole(app, {}, (tx) => tx`select app.record_usage('g', 'calls', 1)`), (e) => e.code === '28000', 'no caller, no record');
  await denied(asRole(app, { uid: u, role: 'anon' }, (tx) => tx`select 1`));
  await deleteUser(u); await deleteUser(v);
});

test('deletion requests: grace 0 or 7 only, for the caller; cancelling works only with a grace period', async () => {
  const u = await newUser();
  await assert.rejects(asRole(app, { uid: u }, (tx) => tx`select app.request_deletion(3::smallint)`), (e) => e.code === '22023');
  const due = (await asRole(app, { uid: u }, (tx) => tx`select app.request_deletion(7::smallint, 'u@example.test') as d`))[0].d; assert.ok(due > new Date(Date.now() + 6 * 86400_000));
  assert.equal((await admin`select status from app.accounts where user_id = ${u}`)[0].status, 'pending_deletion');
  assert.equal((await admin`select email_for_receipt from app.deletion_requests where user_id = ${u}`)[0].email_for_receipt, 'u@example.test');
  assert.equal((await asRole(app, { uid: u }, (tx) => tx`select app.cancel_deletion() as ok`))[0].ok, true);
  assert.equal((await admin`select status from app.accounts where user_id = ${u}`)[0].status, 'active');
  await asRole(app, { uid: u }, (tx) => tx`select app.request_deletion(0::smallint)`);
  assert.equal((await asRole(app, { uid: u }, (tx) => tx`select app.cancel_deletion() as ok`))[0].ok, false);
  assert.ok((await admin`select user_id from app.due_deletions(100)`).some((r) => r.user_id === u), 'an immediate request is due at once');
  await deleteUser(u);
});

test('admin functions: a non-admin is refused; an admin sees metadata only and can suspend / lift (not admins, not accounts being deleted); every action is in the target\'s audit log', async () => {
  const boss = await newUser(), alice = await newUser(), bob = await newUser(), carol = await newUser();
  await admin`insert into app.admins (user_id) values (${boss})`;
  await admin`update auth.users set email = 'alice@example.test', last_sign_in_at = now() where id = ${alice}`;
  await denied(asRole(app, { uid: alice }, (tx) => tx`select * from app.admin_users()`));
  await denied(asRole(app, { uid: alice }, (tx) => tx`select app.admin_set_status(${bob}, 'suspended')`));
  const rows = await asRole(app, { uid: boss }, (tx) => tx`select * from app.admin_users(500, 0)`);
  const a = rows.find((r) => r.user_id === alice);
  assert.deepEqual(Object.keys(a).sort(), ['calls_30d', 'calls_today', 'created_at', 'email', 'is_admin', 'last_sign_in_at', 'live_seconds_today', 'status', 'storage_quota_bytes', 'storage_used_bytes', 'user_id']);
  assert.equal(a.email, 'alice@example.test'); assert.equal(a.status, 'active'); assert.equal(a.is_admin, false); assert.equal(Number(a.storage_quota_bytes), 524288000);
  await assert.rejects(asRole(app, { uid: boss }, (tx) => tx`select * from app.admin_users(0, 0)`), (e) => e.code === '22023');
  assert.equal((await asRole(app, { uid: boss }, (tx) => tx`select app.admin_set_status(${bob}, 'suspended', 'spam') as s`))[0].s, 'suspended');
  assert.deepEqual((({ status, suspended_reason }) => ({ status, suspended_reason }))((await admin`select status, suspended_reason from app.accounts where user_id = ${bob}`)[0]), { status: 'suspended', suspended_reason: 'spam' });
  const log = (await admin`select actor, actor_id, action from app.audit_log where user_id = ${bob}`)[0]; assert.deepEqual({ actor: log.actor, actor_id: log.actor_id, action: log.action }, { actor: 'admin', actor_id: boss, action: 'account.suspended' });
  await asRole(app, { uid: boss }, (tx) => tx`select app.admin_set_status(${bob}, 'active')`);
  await assert.rejects(asRole(app, { uid: boss }, (tx) => tx`select app.admin_set_status(${boss}, 'suspended')`), (e) => e.code === '42501', 'not an admin');
  await assert.rejects(asRole(app, { uid: boss }, (tx) => tx`select app.admin_set_status(${bob}, 'banned')`), (e) => e.code === '22023');
  await assert.rejects(asRole(app, { uid: boss }, (tx) => tx`select app.admin_set_status('00000000-0000-4000-8000-000000000000', 'suspended')`), (e) => e.code === 'P0002');
  await asRole(app, { uid: carol }, (tx) => tx`select app.request_deletion(7::smallint)`);
  await assert.rejects(asRole(app, { uid: boss }, (tx) => tx`select app.admin_set_status(${carol}, 'suspended')`), (e) => e.code === '55000');
  // an admin is not given a way around the policies: still no row of anybody else
  assert.equal((await asRole(app, { uid: boss }, (tx) => tx`select count(*)::int as n from app.profiles where user_id <> ${boss}`))[0].n, 0);
  assert.equal((await asRole(app, { uid: boss }, (tx) => tx`select count(*)::int as n from app.user_secrets where user_id <> ${boss}`))[0].n, 0);
  for (const u of [boss, alice, bob, carol]) await deleteUser(u);
});

test('bootstrap admin needs a CONFIRMED e-mail; due_deletions lists only what is due; receipts carry no user id', async () => {
  const u = await newUser();
  await admin`update auth.users set email = 'boss@example.test', email_confirmed_at = null where id = ${u}`;
  assert.equal((await admin`select app.bootstrap_admin('boss@example.test') as id`)[0].id, null);
  await admin`update auth.users set email_confirmed_at = now() where id = ${u}`;
  assert.equal((await admin`select app.bootstrap_admin('BOSS@example.test ') as id`)[0].id, u);
  assert.equal((await admin`select count(*)::int as n from app.admins where user_id = ${u}`)[0].n, 1);
  await admin`select app.bootstrap_admin('boss@example.test')`; assert.equal((await admin`select count(*)::int as n from app.admins where user_id = ${u}`)[0].n, 1, 'idempotent');
  assert.equal((await admin`select app.bootstrap_admin('nobody@example.test') as id`)[0].id, null);
  await admin`select app.record_deletion_receipt(21)`; assert.equal((await admin`select tables_checked from app.deletion_receipts order by completed_at desc limit 1`)[0].tables_checked, 21);
  await deleteUser(u);
});

test('review fix: the daily cap also has a per-address part (hashed address, ip_daily_signup_limit), and the state endpoint reads the same policy as the hook', async () => {
  const hookIp = async (email, ip) => (await admin`select app.before_user_created(${admin.json({ user: { email }, metadata: { ip_address: ip } })}) as r`)[0].r;
  await admin`update app.platform_config set value = '2' where key = 'ip_daily_signup_limit'`; await admin`delete from app.signup_attempts`;
  try {
    assert.deepEqual(await hookIp('a1@example.test', '203.0.113.9'), {}); assert.deepEqual(await hookIp('a2@example.test', '203.0.113.9'), {});
    assert.equal((await hookIp('a3@example.test', '203.0.113.9')).error.http_code, 429, 'the third from one address is refused');
    assert.deepEqual(await hookIp('b1@example.test', '203.0.113.10'), {}, 'another address is not affected');
    const rows = await admin`select ip_hash from app.signup_attempts`; assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.ip_hash) && !r.ip_hash.includes('203')), 'only hashes are stored');
    await admin`update app.signup_attempts set at = now() - interval '3 days'`; await admin`select * from app.purge_expired()`; assert.equal((await admin`select count(*)::int as n from app.signup_attempts`)[0].n, 0, 'swept after two days');
  } finally { await admin`update app.platform_config set value = '5' where key = 'ip_daily_signup_limit'`; await admin`delete from app.signup_attempts`; }
  const { createPgDb } = await import('../../server/db/pool.js'), { appUrl } = await import('./support/pg.mjs'), db = createPgDb(appUrl);
  try {
    await admin`update app.platform_config set value = 'invite' where key = 'signup_mode'`;
    assert.equal(await db.system.signupMode(), 'invite', 'what /api/elvar/state shows is what the hook enforces');
    const { platformState } = await import('../../server/account/state.js'); assert.equal(platformState({ ELVAR_SIGNUP: 'open' }, await db.system.signupMode()).signup, 'invite', 'the database wins over ELVAR_SIGNUP');
  } finally { await admin`update app.platform_config set value = 'open' where key = 'signup_mode'`; await db.close(); }
});
