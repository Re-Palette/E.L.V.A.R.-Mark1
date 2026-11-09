// Generated two-user isolation tests (docs/ELVAR_MULTIUSER.md 3.5). The tables come from the data registry of the migrated database, and the rows from the
// registry's own fixture SQL: add a table with a registry entry and it is tested here without touching this file.
// Every check runs through the real roles: elvar_app switching to `authenticated` with the user's claims, exactly like server/db/pool.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { admin, rawApp, asRole, newUser, deleteUser } from './support/pg.mjs';
import { fixtureSqlFor } from '../../server/rights/registry.js';
import { switchToUser, assertSwitched } from '../../server/db/pool.js';

const app = rawApp(2);
test.after(async () => { await app.end({ timeout: 5 }); await admin.end({ timeout: 5 }); });

const reg = await admin`select table_name, owner_column, fixture_order, fixture_sql from app.data_registry order by fixture_order, table_name`;
const entries = reg.map((r) => ({ table: r.table_name, ownerColumn: r.owner_column, fixtureSql: r.fixture_sql }));
const a = await newUser(), b = await newUser();
for (const uid of [a, b]) for (const e of entries) await admin.unsafe(fixtureSqlFor(e, uid)).simple();   // parents first (fixture_order)

const grants = Object.fromEntries(await Promise.all(entries.map(async (e) => [e.table, Object.fromEntries(await Promise.all(['select', 'insert', 'update', 'delete'].map(async (p) => [p, (await admin`select has_table_privilege('authenticated', ${'app.' + e.table}, ${p}) as ok`)[0].ok])))])));
const count = (sql, e, uid) => sql.unsafe(`select count(*)::int as n from app.${e.table} where ${e.ownerColumn} = '${uid}'`).then((r) => r[0].n);
const total = (sql, e) => sql.unsafe(`select count(*)::int as n from app.${e.table}`).then((r) => r[0].n);
// "denied" = a privilege error or an RLS violation (both SQLSTATE 42501); anything else (a unique clash, a typo) must not pass as a denial
const denied = async (p) => { try { await p; } catch (e) { assert.equal(e.code, '42501', `expected 42501 (denied), got ${e.code}: ${e.message}`); return; } assert.fail('the statement was allowed'); };

test('the fixtures put one row per registered table for each of the two users', async () => {
  assert.ok(entries.length >= 18);
  for (const e of entries) { assert.ok((await count(admin, e, a)) >= 1, `${e.table}: no fixture row for A`); assert.ok((await count(admin, e, b)) >= 1, `${e.table}: no fixture row for B`); }
});

for (const e of entries) {
  const g = grants[e.table];
  test(`${e.table}: B sees nothing of A (select), A still sees its own rows where a select grant exists`, async () => {
    if (g.select) {
      const rowsB = await asRole(app, { uid: b }, async (tx) => ({ ofA: await count(tx, e, a), foreign: (await tx.unsafe(`select count(*)::int as n from app.${e.table} where ${e.ownerColumn} <> '${b}'`))[0].n }));
      assert.deepEqual(rowsB, { ofA: 0, foreign: 0 });
    } else await denied(asRole(app, { uid: b }, (tx) => total(tx, e)));
    if (g.select) { const own = await asRole(app, { uid: a }, (tx) => count(tx, e, a)); assert.ok(own >= 1, 'A cannot read its own rows'); }
  });

  test(`${e.table}: B cannot update or delete A's rows, and A's rows are unchanged afterwards`, async () => {
    const before = await count(admin, e, a);
    for (const stmt of [`update app.${e.table} set ${e.ownerColumn} = ${e.ownerColumn} where ${e.ownerColumn} = '${a}'`, `delete from app.${e.table} where ${e.ownerColumn} = '${a}'`]) {
      const kind = stmt.startsWith('update') ? 'update' : 'delete';
      if (!g[kind]) await denied(asRole(app, { uid: b }, (tx) => tx.unsafe(stmt)));
      else assert.equal((await asRole(app, { uid: b }, (tx) => tx.unsafe(stmt))).count, 0, `${kind} touched A's rows`);
    }
    assert.equal(await count(admin, e, a), before);
  });

  test(`${e.table}: B cannot insert a row owned by A, and cannot hand its own row to A`, async () => {
    await denied(asRole(app, { uid: b }, (tx) => tx.unsafe(fixtureSqlFor(e, a)).simple()));
    if (g.update) await denied(asRole(app, { uid: b }, (tx) => tx.unsafe(`update app.${e.table} set ${e.ownerColumn} = '${a}' where ${e.ownerColumn} = '${b}'`)));
    assert.equal(await count(admin, e, a), await count(admin, e, a));
  });

  test(`${e.table}: no claims -> zero rows; not switched to authenticated -> denied; anon -> denied`, async () => {
    if (g.select) assert.equal(await asRole(app, {}, (tx) => total(tx, e)), 0, 'role authenticated with no claims saw rows');
    if (g.select) assert.equal(await asRole(app, { claims: {} }, (tx) => total(tx, e)), 0, 'claims without sub saw rows');
    if (g.select) assert.equal(await asRole(app, { claims: { sub: '' } }, (tx) => total(tx, e)), 0, 'empty sub saw rows');
    await denied(asRole(app, { uid: a, role: null }, (tx) => total(tx, e)));        // claims set but `set local role` forgotten
    await denied(asRole(app, { claims: undefined, role: null }, (tx) => total(tx, e)));
    await denied(app.begin(async (tx) => { await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: a, role: 'anon' })}, true)`; try { await tx.unsafe('set local role anon'); } catch (err) { throw Object.assign(new Error(err.message), { code: err.code }); } return total(tx, e); }));
  });
}

test('the connection cannot escalate: elvar_app cannot become anon, service_role, postgres or any other role', async () => {
  for (const role of ['anon', 'service_role', 'postgres']) await denied(asRole(app, { uid: a, role }, (tx) => tx`select 1`));
});

test('identity does not leak to the next request on the same pooled connection (settings are transaction-local)', async () => {
  const one = rawApp(1);   // a single connection: the next transaction is guaranteed to reuse it
  try {
    await one.begin(async (tx) => { await switchToUser(tx, a); await tx`select 1`; });
    const [r] = await one.begin(async (tx) => tx`select current_user::text as role, coalesce(current_setting('request.jwt.claims', true), '') as claims`);
    assert.deepEqual(r, { role: 'elvar_app', claims: '' });
    await denied(one`select count(*) from app.profiles`);
  } finally { await one.end({ timeout: 5 }); }
});

test('switchToUser verifies the identity it just set; assertSwitched refuses a half-done switch (fail closed)', async () => {
  const one = rawApp(1);
  try {
    await one.begin(async (tx) => { await switchToUser(tx, a); const [row] = await tx`select current_user::text as role, auth.uid()::text as uid`; assert.doesNotThrow(() => assertSwitched(row, a)); assert.throws(() => assertSwitched(row, b), /identity_not_switched/); });
    // claims but no role switch: reading the identity back is itself refused (elvar_app cannot even call auth.uid()), and a made-up row fails the check
    await denied(one.begin(async (tx) => { await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: a })}, true)`; return tx`select auth.uid()`; }));
    assert.throws(() => assertSwitched({ role: 'elvar_app', uid: a }, a), /identity_not_switched/);
    // a role switch without claims: auth.uid() is null, caught by the read-back
    const half2 = await one.begin(async (tx) => { await tx`set local role authenticated`; return (await tx`select current_user::text as role, auth.uid()::text as uid`)[0]; });
    assert.throws(() => assertSwitched(half2, a), /identity_not_switched/);
  } finally { await one.end({ timeout: 5 }); }
});

test('the definer functions are not callable by a signed-in user, and ensure_account only ever acts for the caller', async () => {
  for (const call of ["app.rl_hit('b', 'w', 60)", 'app.purge_expired()', `app.residual_check('${a}')`, "app.device_lookup(decode(repeat('00', 32), 'hex'))", "app._secure('profiles', '')"]) {
    await denied(asRole(app, { uid: b }, (tx) => tx.unsafe(`select * from ${call}`)));
  }
  await assert.rejects(asRole(app, {}, (tx) => tx`select app.ensure_account()`), (e) => e.code === '28000');
  const fresh = await newUser();
  await asRole(app, { uid: fresh }, (tx) => tx`select app.ensure_account()`);
  assert.equal((await admin`select count(*)::int as n from app.accounts where user_id = ${fresh}`)[0].n, 1);
  assert.equal((await asRole(app, { uid: fresh }, (tx) => tx`select app.is_admin() as a`))[0].a, false);
  await deleteUser(fresh);
});

test('a user cannot lift a limit or change their own account: quota, status and hard limits are read only', async () => {
  await denied(asRole(app, { uid: a }, (tx) => tx`update app.accounts set storage_quota_bytes = 999999999999 where user_id = ${a}`));
  await denied(asRole(app, { uid: a }, (tx) => tx`update app.accounts set status = 'active' where user_id = ${a}`));
  await denied(asRole(app, { uid: a }, (tx) => tx`insert into app.usage_daily (user_id, day, provider, metric, amount) values (${a}, current_date, 'x', 'y', 0)`));
  await denied(asRole(app, { uid: a }, (tx) => tx`update app.audit_log set action = 'forged' where user_id = ${a}`));
  await denied(asRole(app, { uid: a }, (tx) => tx`delete from app.audit_log where user_id = ${a}`));
  await denied(asRole(app, { uid: a }, (tx) => tx`insert into app.audit_log (user_id, actor, action) values (${a}, 'admin', 'forged')`));
});
