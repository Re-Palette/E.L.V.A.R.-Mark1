// The deletion / export registry skeleton: structure checks, fixture safety, redaction, export plan, and the residual check's strictness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY, registryTables, entryFor, fixtureOrder, fixtureSqlFor, redactRow, exportPlan, validateRegistry } from '../server/rights/registry.js';
import { residualCheck } from '../server/rights/residual.js';
import { createMemoryDb } from '../server/db/memory.js';
import { mintVerifiedUid } from '../server/db/verified-uid.js';

const U = '3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';

test('the registry is valid, frozen, unique, and every table fixture targets its own table', () => {
  assert.deepEqual(validateRegistry(), []);
  assert.equal(new Set(registryTables()).size, REGISTRY.length); assert.ok(Object.isFrozen(REGISTRY) && Object.isFrozen(REGISTRY[0]) && Object.isFrozen(REGISTRY[0].exportExclude));
  assert.equal(entryFor('profiles').exportAs, 'profile.json'); assert.equal(entryFor('nope'), null);
  for (const e of REGISTRY) { assert.equal(e.ownerColumn, 'user_id', e.table); assert.equal(e.deleteVia, e.table === 'oauth_tokens' ? 'cascade+external' : 'cascade', e.table + ': only the tokens need an external revocation'); }
});

test('validateRegistry catches a broken entry', () => {
  const good = REGISTRY[0];
  const probs = validateRegistry([good, { ...good }, { ...good, table: 'Bad-Name', fixtureSql: 'select 1' }, { ...good, table: 'x', exportAs: '', fixtureSql: 'insert into app.other ({{uid}})' }, { ...good, table: 'y', exportAs: 'none', exportExclude: ['a'], fixtureSql: 'insert into app.y ({{uid}})', deleteVia: 'shred' }]);
  for (const re of [/duplicate table/, /bad table name/, /does not use \{\{uid\}\}/, /does not insert into app\.x/, /exportAs is empty/, /not exported/, /bad deleteVia/]) assert.ok(probs.some((p) => re.test(p)), String(re) + ' in ' + probs.join(' | '));
});

test('fixtures: the user id is validated and inserted as a uuid literal only (no SQL injection through the id)', () => {
  const e = entryFor('profiles');
  const sql = fixtureSqlFor(e, U.toUpperCase()); assert.ok(sql.includes(`'${U}'::uuid`)); assert.ok(!sql.includes('{{uid}}'));
  for (const bad of ["x'); drop table app.accounts; --", '', null, undefined, U + "'", '../' + U]) assert.throws(() => fixtureSqlFor(e, bad), /bad_uid/);
  assert.ok(!REGISTRY.some((x) => /\$\d|\$\{/.test(x.fixtureSql)));
  const order = fixtureOrder().map((x) => x.table); assert.ok(order.indexOf('accounts') < order.indexOf('profiles'));
});

test('export plan and redaction: ciphertext, token hashes and key material never leave the database', () => {
  const plan = exportPlan(), files = Object.fromEntries(plan.map((f) => [f.file, f.tables.map((t) => t.table)]));
  assert.deepEqual(files['secrets.json'], ['user_secrets']); assert.deepEqual(files['profile.json'], ['profiles']);
  for (const never of ['user_keys', 'kv_ephemeral', 'rate_limits', 'ticket_uses', 'oauth_pending', 'export_jobs']) assert.ok(!plan.some((f) => f.tables.some((t) => t.table === never)), never + ' is not exported');
  assert.deepEqual(plan.find((f) => f.file === 'secrets.json').tables[0].exclude, ['ct', 'iv']);
  assert.deepEqual(redactRow(entryFor('user_secrets'), { name: 'GEMINI_API_KEY', ct: Buffer.alloc(3), iv: Buffer.alloc(3), last4: 'abcd', dek_ver: 1 }), { name: 'GEMINI_API_KEY', last4: 'abcd', dek_ver: 1 });
  assert.deepEqual(redactRow(entryFor('devices'), { id: 'x', tokenHash: 'h', token_hash: 'h', scopes: [] }), { id: 'x', scopes: [] }, 'camelCase and snake_case');
  for (const e of REGISTRY.filter((x) => x.exportAs !== 'none')) { assert.ok(/\.json$/.test(e.exportAs), e.table); }
  for (const t of ['user_secrets', 'devices']) assert.ok(entryFor(t).exportExclude.length > 0, t);
});

test('residualCheck: clean only when every registered table is reported and empty', async () => {
  const db = createMemoryDb(), uid = db.testing.newUser(), U1 = mintVerifiedUid(uid, 'test');
  assert.deepEqual(await residualCheck(db, U1), { clean: true, nonzero: [], missing: [], unknown: [], tablesChecked: REGISTRY.length });
  await db.asUser(U1, (r) => r.profile.put({ a: 1 }));
  const dirty = await residualCheck(db, U1); assert.equal(dirty.clean, false); assert.deepEqual(dirty.nonzero, [{ table: 'profiles', n: 1 }]);
  db.testing.deleteUser(uid); assert.equal((await residualCheck(db, U1)).clean, true);
  const fake = (rows) => ({ system: { residualCheck: async () => rows } });
  const all = REGISTRY.map((e) => ({ table: e.table, n: 0 }));
  assert.equal((await residualCheck(fake(all.slice(1)), U1)).clean, false, 'a table missing from the answer is a failure');
  assert.deepEqual((await residualCheck(fake(all.slice(1)), U1)).missing, [all[0].table]);
  assert.equal((await residualCheck(fake([...all, { table: 'surprise', n: 0 }]), U1)).clean, false);
  assert.equal((await residualCheck(fake([]), U1)).clean, false);
  assert.equal((await residualCheck(fake(all), U1)).clean, true);
});
