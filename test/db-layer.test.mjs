// The database layer's selection, error mapping and the identity read-back (the Postgres behaviour itself is in test/db/ and the shared contract).
import test from 'node:test';
import assert from 'node:assert/strict';
import { dbKind, dbConfigured, getDb, resetDb } from '../server/db/index.js';
import { DbError, mapPgError, isDriverError, dbError } from '../server/db/errors.js';
import { createMemoryDb } from '../server/db/memory.js';

test('database selection: ELVAR_DB=memory > ELVAR_DB_URL > none; none fails with a 503 instead of guessing', async () => {
  assert.equal(dbKind({ ELVAR_DB: 'memory', ELVAR_DB_URL: 'postgres://x' }), 'memory');
  assert.equal(dbKind({ ELVAR_DB_URL: 'postgres://x' }), 'pg'); assert.equal(dbKind({}), 'none'); assert.equal(dbKind({ ELVAR_DB: 'sqlite' }), 'none');
  assert.equal(dbConfigured({}), false); assert.equal(dbConfigured({ ELVAR_DB: 'memory' }), true);
  await assert.rejects(getDb({}), (e) => e instanceof DbError && e.code === 'db_unavailable' && e.status === 503);
  await resetDb();
  const a = await getDb({ ELVAR_DB: 'memory' }), b = await getDb({ ELVAR_DB: 'memory' });
  assert.equal(a, b, 'one database per process'); assert.equal(a.kind, 'memory');
  await resetDb(); assert.notEqual(await getDb({ ELVAR_DB: 'memory' }), a, 'reset gives a fresh one'); await resetDb();
});

test('the Postgres driver is only loaded when a URL is configured; a malformed URL is refused up front', async () => {
  await resetDb();
  await assert.rejects(getDb({ ELVAR_DB_URL: 'mysql://x' }), (e) => e.code === 'db_url_invalid');
  await resetDb();
});

test('Postgres errors map to stable codes; other errors are not swallowed', () => {
  const pg = (code) => Object.assign(new Error('x'), { name: 'PostgresError', code });
  const cases = { 23505: ['conflict', 409], 23514: ['invalid_value', 400], '22P02': ['invalid_value', 400], 23502: ['invalid_value', 400], 23503: ['invalid_reference', 409], 42501: ['forbidden', 403], 57014: ['db_timeout', 503], '08006': ['db_unavailable', 503], 53300: ['db_unavailable', 503], XX000: ['db_error', 500] };
  for (const [c, [code, status]] of Object.entries(cases)) { const e = mapPgError(pg(c)); assert.deepEqual([e.code, e.status], [code, status], c); assert.ok(e instanceof DbError); }
  const conn = mapPgError(Object.assign(new Error('x'), { code: 'CONNECTION_CLOSED' })); assert.deepEqual([conn.code, conn.status], ['db_unavailable', 503]);
  const already = dbError('conflict', 409); assert.equal(mapPgError(already), already);
  assert.equal(isDriverError(pg('23505')), true); assert.equal(isDriverError(Object.assign(new Error('x'), { code: 'CONNECTION_ENDED' })), true);
  for (const ours of [new Error('boom'), Object.assign(new Error('x'), { code: 'secret_unreadable' }), dbError('conflict', 409), null, undefined]) assert.equal(isDriverError(ours), false);
  assert.ok(!/row|value|secret/i.test(mapPgError(Object.assign(new Error('Key (user_id)=(abc) already exists'), { name: 'PostgresError', code: '23505' })).message), 'the client-visible message carries no row data');
});

test('MemoryDb creates exactly the registry tables, and a test clock moves time without sleeping', async () => {
  const { REGISTRY } = await import('../server/rights/registry.js');
  const db = createMemoryDb(); const uid = db.testing.newUser();
  const { mintVerifiedUid } = await import('../server/db/verified-uid.js'); const U = mintVerifiedUid(uid, 'test');
  const res = await db.system.residualCheck(U); assert.deepEqual(res.map((r) => r.table).sort(), REGISTRY.map((e) => e.table).sort());
  await db.asUser(U, (r) => r.kv.set('k', 1, { ttlSec: 5 })); db.testing.advance(6000);
  assert.equal(await db.asUser(U, (r) => r.kv.get('k')), null);
});
