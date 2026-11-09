import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MemoryStore } from '../server/store/memory.js';
import { getStore, storeKind, resetStore } from '../server/store/index.js';

async function contract(s) {
  assert.equal(await s.get('a'), null);
  assert.equal(await s.set('a', { x: 1 }), true);
  assert.deepEqual(await s.get('a'), { x: 1 });
  assert.equal(await s.set('a', { x: 2 }, { nx: true }), false, 'nx does not overwrite');
  assert.deepEqual(await s.get('a'), { x: 1 });
  assert.equal(await s.del('a'), true); assert.equal(await s.get('a'), null);
  assert.equal(await s.incr('n', 60), 1); assert.equal(await s.incr('n', 60), 2);
  // compare-and-set on the record's `ver` (absent = 0)
  assert.equal(await s.cas('r', 0, { ver: 1, d: 'a' }), true);
  assert.equal(await s.cas('r', 0, { ver: 1, d: 'b' }), false, 'stale writer loses');
  assert.equal(await s.cas('r', 1, { ver: 2, d: 'c' }), true);
  assert.equal((await s.get('r')).d, 'c');
  // sorted-set subset used by the notification relay
  await s.cmd([['ZADD', 'z', '10', 'a'], ['ZADD', 'z', '20', 'b'], ['ZADD', 'z', '30', 'c']]);
  assert.deepEqual((await s.cmd([['ZRANGEBYSCORE', 'z', '15', '+inf', 'LIMIT', '0', '1']]))[0], ['b']);
  assert.equal((await s.cmd([['ZCARD', 'z']]))[0], 3);
  await s.cmd([['ZREMRANGEBYSCORE', 'z', '-inf', '10']]); assert.equal((await s.cmd([['ZCARD', 'z']]))[0], 2);
  await s.cmd([['ZREMRANGEBYRANK', 'z', '0', '-2']]); assert.deepEqual((await s.cmd([['ZRANGEBYSCORE', 'z', '-inf', '+inf']]))[0], ['c']);
  await s.cmd([['DEL', 'z']]); assert.equal((await s.cmd([['ZCARD', 'z']]))[0], 0);
}

test('MemoryStore satisfies the store contract', async () => { await contract(new MemoryStore()); });

test('TTL: an expired key reads as absent, and incr keeps the first TTL', async () => {
  const s = new MemoryStore();
  await s.set('t', 1, { ttlSec: 1 }); s.data.t.x = Date.now() - 1; assert.equal(await s.get('t'), null);
  await s.incr('c', 1); s.data.c.x = Date.now() - 1; assert.equal(await s.incr('c', 1), 1, 'window restarts after expiry');
});

test('incr accepts a negative step (a successful login gives its attempt back)', async () => {
  const s = new MemoryStore(); await s.incr('n', 60); await s.incr('n', 60); assert.equal(await s.incr('n', 60, -1), 1);
});

test('store selection: the in-memory store exists only for tests (ELVAR_STORE=memory); otherwise there is none, and Upstash / the local file store are gone', () => {
  assert.equal(storeKind({ ELVAR_STORE: 'memory' }), 'memory');
  for (const e of [{}, { VERCEL: '1' }, { UPSTASH_REDIS_REST_URL: 'u', UPSTASH_REDIS_REST_TOKEN: 't' }, { KV_REST_API_URL: 'u', KV_REST_API_TOKEN: 't' }]) { assert.equal(storeKind(e), 'none'); assert.equal(getStore(e), null); }
  assert.ok(getStore({ ELVAR_STORE: 'memory' }) instanceof MemoryStore);
  resetStore();
  for (const f of ['file.js', 'upstash.js']) assert.equal(fs.existsSync(new URL('../server/store/' + f, import.meta.url)), false, f + ' is removed');
});
