// Migration 18 on a real Postgres: record_usage by the user's own day, hard limits only through the admin function, the admin's usage view without per-tool counts,
// and the retention of raw usage events (90 days) and daily totals (2 years).
import test from 'node:test';
import assert from 'node:assert/strict';
import { admin, rawApp, asRole, newUser, deleteUser } from './support/pg.mjs';

const app = rawApp(2);
test.after(async () => { await app.end({ timeout: 5 }); await admin.end({ timeout: 5 }); });
const denied = async (p, codes = ['42501']) => { try { await p; } catch (e) { assert.ok(codes.includes(e.code), `expected ${codes}, got ${e.code}: ${e.message}`); return; } assert.fail('the statement was allowed'); };

test('record_usage: the user\'s own day within the database date +-1, a far day / a bad value refused, the daily total adds up; nobody can write the tables directly', async () => {
  const u = await newUser();
  try {
    const rec = (p, m, n, src = 'server', day = null) => asRole(app, { uid: u }, (tx) => tx`select app.record_usage(${p}, ${m}, ${n}, ${src}, ${day}::date)`);
    await rec('gemini', 'calls', 1); await rec('gemini', 'calls', 2, 'server', (await admin`select current_date::text as d`)[0].d); await rec('gemini', 'live_seconds', 30, 'client', (await admin`select (current_date + 1)::text as d`)[0].d);
    await denied(rec('gemini', 'calls', 1, 'server', (await admin`select (current_date - 3)::text as d`)[0].d), ['22023']); await denied(rec('gemini', 'calls', 1, 'server', (await admin`select (current_date + 3)::text as d`)[0].d), ['22023']);
    await denied(rec('gemini', 'calls', -1), ['22023']); await denied(rec('gemini', 'calls', 1, 'nobody'), ['22023']);
    const rows = await asRole(app, { uid: u }, (tx) => tx`select day::text as day, provider, metric, amount::float as amount from app.usage_daily order by day, provider, metric`);
    assert.deepEqual(rows.map((r) => [r.provider, r.metric, r.amount]), [['gemini', 'calls', 3], ['gemini', 'live_seconds', 30]]);
    await denied(asRole(app, { uid: u }, (tx) => tx`insert into app.usage_daily (day, provider, metric, amount) values (current_date, 'gemini', 'calls', 1)`));
    await denied(asRole(app, { uid: u }, (tx) => tx`update app.accounts set hard_limits = '{"maxNotes": 1}'`));
  } finally { await deleteUser(u); }
});

test('admin_set_limits / admin_user_usage: admin only, the catalog only, whole numbers, null removes; the admin sees numbers per provider but no per-tool counts', async () => {
  const boss = await newUser(), a = await newUser(), c = await newUser();
  await admin`insert into app.admins (user_id) values (${boss})`;
  try {
    const set = (who, target, l) => asRole(app, { uid: who }, (tx) => tx`select app.admin_set_limits(${target}, ${tx.json(l)}::jsonb) as l`);
    await denied(set(a, a, { maxNotes: 5 })); await denied(set(c, a, { maxNotes: 5 }));
    assert.deepEqual((await set(boss, a, { geminiCallsPerDay: 100, maxNotes: 5 }))[0].l, { geminiCallsPerDay: 100, maxNotes: 5 });
    assert.deepEqual((await set(boss, a, { maxNotes: null }))[0].l, { geminiCallsPerDay: 100 });
    for (const bad of [{ nope: 1 }, { maxNotes: -1 }, { maxNotes: 1.5 }, { maxNotes: '5' }, { maxNotes: 3000000000 }, { maxFileBytes: 62914561 }, [1]]) await denied(set(boss, a, bad), ['22023']);
    await denied(set(boss, '00000000-0000-4000-8000-000000000000', { maxNotes: 5 }), ['P0002']);
    assert.deepEqual((await admin`select hard_limits from app.accounts where user_id = ${c}`).map((r) => r.hard_limits), [], 'C has no account row: nothing was written for them');
    assert.equal((await admin`select count(*)::int as n from app.audit_log where user_id = ${a} and actor = 'admin' and action = 'account.limits_changed'`)[0].n, 2);
    await asRole(app, { uid: a }, async (tx) => { await tx`select app.record_usage('groq', 'calls', 4)`; await tx`select app.record_usage('tool', 'secret_tool', 9, 'client')`; });
    const u = await asRole(app, { uid: boss }, (tx) => tx`select provider, metric, amount::float as amount from app.admin_user_usage(${a}, 14)`);
    assert.deepEqual(u.map((r) => [r.provider, r.metric, r.amount]), [['groq', 'calls', 4]]);
    await denied(asRole(app, { uid: c }, (tx) => tx`select * from app.admin_user_usage(${a}, 14)`));
    await denied(asRole(app, { uid: boss }, (tx) => tx`select * from app.admin_user_usage(${a}, 0)`), ['22023']); await denied(asRole(app, { uid: boss }, (tx) => tx`select * from app.admin_user_usage('00000000-0000-4000-8000-000000000000', 14)`), ['P0002']);
    const row = (await asRole(app, { uid: boss }, (tx) => tx`select * from app.admin_users(500, 0)`)).find((r) => r.user_id === a);
    assert.deepEqual(row.hard_limits, { geminiCallsPerDay: 100 }); assert.equal(Number(row.calls_today), 4);
  } finally { for (const x of [boss, a, c]) await deleteUser(x); }
});

test('the hard-limit keys of admin_set_limits are exactly the catalog of server/usage-limits.js', async () => {
  const { HARD_LIMIT_KEYS_JS } = await import('../../server/usage-limits.js');
  const fs = await import('node:fs'), sql = fs.readFileSync(new URL('../../supabase/migrations/20261110000018_usage_limits_admin.sql', import.meta.url), 'utf8');
  const m = /allowed text\[\] := array\[([^\]]+)\]/.exec(sql); assert.ok(m); const keys = [...m[1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1]);
  assert.deepEqual([...keys].sort(), [...HARD_LIMIT_KEYS_JS].sort());
});

test('purge_expired: raw usage events older than 90 days and daily totals older than 2 years go, recent ones stay (the usage_daily rollup keeps the history)', async () => {
  const u = await newUser();
  try {
    await admin`insert into app.usage_events (user_id, at, provider, metric, amount, source) values (${u}, now() - interval '91 days', 'gemini', 'calls', 1, 'server'), (${u}, now() - interval '5 days', 'gemini', 'calls', 1, 'server')`;
    await admin`insert into app.usage_daily (user_id, day, provider, metric, amount) values (${u}, current_date - 800, 'gemini', 'calls', 1), (${u}, current_date - 100, 'gemini', 'calls', 1)`;
    await admin`select * from app.purge_expired()`;
    assert.equal((await admin`select count(*)::int as n from app.usage_events where user_id = ${u}`)[0].n, 1); assert.equal((await admin`select count(*)::int as n from app.usage_daily where user_id = ${u}`)[0].n, 1);
  } finally { await deleteUser(u); }
});
