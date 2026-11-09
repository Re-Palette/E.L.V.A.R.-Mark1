// Deleting the auth user removes every registered table's rows for that user and nobody else's (docs 7.4, principle 7); the check is generated from the registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { admin, rawApp, newUser, deleteUser } from './support/pg.mjs';
import { fixtureSqlFor } from '../../server/rights/registry.js';
import { createPgDb } from '../../server/db/pool.js';
import { mintVerifiedUid } from '../../server/db/verified-uid.js';
import { residualCheck } from '../../server/rights/residual.js';
import { appUrl } from './support/pg.mjs';

const db = createPgDb(appUrl);
test.after(async () => { await db.close(); await admin.end({ timeout: 5 }); });

test('every table: fixtures for two users, delete one, residual_check is zero for it and unchanged for the other', async () => {
  const reg = await admin`select table_name, owner_column, fixture_sql from app.data_registry order by fixture_order, table_name`;
  const entries = reg.map((r) => ({ table: r.table_name, ownerColumn: r.owner_column, fixtureSql: r.fixture_sql }));
  const a = await newUser(), b = await newUser(), A = mintVerifiedUid(a, 'purge'), B = mintVerifiedUid(b, 'purge');
  for (const uid of [a, b]) for (const e of entries) await admin.unsafe(fixtureSqlFor(e, uid)).simple();
  const before = await residualCheck(db, A);
  assert.equal(before.clean, false); assert.deepEqual(before.missing, []); assert.deepEqual(before.unknown, []);
  assert.deepEqual(before.nonzero.map((r) => r.table).sort(), entries.map((e) => e.table).sort(), 'every table had a row to delete');
  const bBefore = await residualCheck(db, B);
  await deleteUser(a);
  const after = await residualCheck(db, A);
  assert.deepEqual({ clean: after.clean, nonzero: after.nonzero, tablesChecked: after.tablesChecked }, { clean: true, nonzero: [], tablesChecked: entries.length });
  assert.deepEqual(await residualCheck(db, B), bBefore);
  for (const e of entries) assert.equal((await admin.unsafe(`select count(*)::int as n from app.${e.table} where ${e.ownerColumn} = '${a}'`))[0].n, 0, e.table);
  await deleteUser(b);
});

test('residual_check cannot be fooled: a registry row for a table it cannot count raises instead of being skipped', async () => {
  const uid = await newUser();
  await admin`insert into app.data_registry (table_name, export_as, editable, counts_storage, fixture_sql) values ('no_such_table', 'none', false, false, 'select 1 -- {{uid}} app.no_such_table')`;
  try { await assert.rejects(db.system.residualCheck(mintVerifiedUid(uid, 'purge'))); }
  finally { await admin`delete from app.data_registry where table_name = 'no_such_table'`; await deleteUser(uid); }
});

test('expired short-lived rows are swept, live ones stay, for all four tables', async () => {
  const u = await newUser();
  await admin`insert into app.kv_ephemeral (user_id, key, value, expires_at) values (${u}, 'old', '1', now() - interval '1 minute'), (${u}, 'new', '1', now() + interval '1 hour')`;
  await admin`insert into app.rate_limits (bucket, who, window_start, n, user_id, expires_at) values ('sw', ${u}, now() - interval '1 day', 1, ${u}, now() - interval '1 minute'), ('sw', ${u}, now(), 1, ${u}, now() + interval '1 hour')`;
  await admin`insert into app.ticket_uses (user_id, jti, exp) values (${u}, 'old', now() - interval '1 minute'), (${u}, 'new', now() + interval '1 hour')`;
  await admin`insert into app.oauth_pending (state_hash, user_id, sealed, expires_at) values (sha256('o1'), ${u}, decode('00', 'hex'), now() - interval '1 minute'), (sha256('o2'), ${u}, decode('00', 'hex'), now() + interval '1 hour')`;
  const res = await db.system.purgeExpired();
  for (const t of ['kv_ephemeral', 'rate_limits', 'ticket_uses', 'oauth_pending']) assert.ok(res[t] >= 1, t);
  for (const t of ['kv_ephemeral', 'rate_limits', 'ticket_uses', 'oauth_pending']) assert.equal((await admin.unsafe(`select count(*)::int as n from app.${t} where user_id = '${u}'`))[0].n, 1, t + ' keeps exactly the live row');
  await deleteUser(u);
});
