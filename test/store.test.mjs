import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../server/store/memory.js';
import { FileStore } from '../server/store/file.js';
import { UpstashStore } from '../server/store/upstash.js';
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

test('TTL: an expired key reads as absent (memory and file), and incr keeps the first TTL', async () => {
  const s = new MemoryStore();
  await s.set('t', 1, { ttlSec: 1 }); s.data.t.x = Date.now() - 1; assert.equal(await s.get('t'), null);
  await s.incr('c', 1); s.data.c.x = Date.now() - 1; assert.equal(await s.incr('c', 1), 1, 'window restarts after expiry');
});

test('FileStore: contract, 0600 file, survives a restart, no temp files left, expired keys are dropped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elvar-store-'));
  try {
    const s = new FileStore(dir); await contract(s);
    await s.set('keep', { v: 1 }); await s.set('gone', 1, { ttlSec: 1 });
    const mode = fs.statSync(path.join(dir, 'store.json')).mode & 0o777;
    if (process.platform !== 'win32') assert.equal(mode, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['store.json']);
    const s2 = new FileStore(dir); assert.deepEqual(await s2.get('keep'), { v: 1 });
    s2.data.gone.x = Date.now() - 1; assert.equal(await s2.get('gone'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('FileStore tolerates a corrupt file (starts empty)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elvar-store-'));
  try { fs.writeFileSync(path.join(dir, 'store.json'), '{not json'); assert.equal(await new FileStore(dir).get('x'), null); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UpstashStore: sends the right REST commands (auth header, SET EX NX, Lua for incr/cas) and surfaces errors', async () => {
  const real = globalThis.fetch, sent = [], kv = new Map();
  globalThis.fetch = async (u, o) => {
    const cmds = JSON.parse(o.body); sent.push({ u: String(u), auth: o.headers.authorization, cmds });
    return { ok: true, status: 200, json: async () => cmds.map((c) => {
      const [op, key, ...a] = c;
      if (op === 'GET') return { result: kv.get(key) ?? null };
      if (op === 'SET') { if (a.includes('NX') && kv.has(key)) return { result: null }; kv.set(key, a[0]); return { result: 'OK' }; }
      if (op === 'DEL') return { result: kv.delete(c[1]) ? 1 : 0 };
      if (op === 'EVAL') { const [, k, ...r] = c; if (String(c[1]).includes('cjson')) { const cur = kv.get(c[3]); const v = cur ? JSON.parse(cur).ver || 0 : 0; if (v === Number(c[4])) { kv.set(c[3], c[5]); return { result: 1 }; } return { result: 0 }; } void k; void r; const n = (Number(kv.get(c[3])) || 0) + 1; kv.set(c[3], String(n)); return { result: n }; }
      return { result: null };
    }) };
  };
  try {
    const s = new UpstashStore('https://x.upstash.io/', 'tok');
    assert.equal(await s.set('k', { a: 1 }, { ttlSec: 30, nx: true }), true);
    assert.deepEqual(sent[0].cmds[0], ['SET', 'k', '{"a":1}', 'EX', '30', 'NX']); assert.equal(sent[0].u, 'https://x.upstash.io/pipeline'); assert.equal(sent[0].auth, 'Bearer tok');
    assert.equal(await s.set('k', { a: 2 }, { nx: true }), false);
    assert.deepEqual(await s.get('k'), { a: 1 });
    assert.equal(await s.incr('n', 60), 1); assert.equal(await s.incr('n', 60), 2);
    assert.equal(await s.cas('r', 0, { ver: 1 }), true); assert.equal(await s.cas('r', 0, { ver: 1 }), false);
    globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); };
    await assert.rejects(() => s.get('k'), (e) => e.status === 502 && /ENOTFOUND/.test(e.message));
  } finally { globalThis.fetch = real; }
});

test('store selection: memory > upstash > file > none', () => {
  assert.equal(storeKind({ ELVAR_STORE: 'memory', UPSTASH_REDIS_REST_URL: 'u', UPSTASH_REDIS_REST_TOKEN: 't' }), 'memory');
  assert.equal(storeKind({ UPSTASH_REDIS_REST_URL: 'u', UPSTASH_REDIS_REST_TOKEN: 't' }), 'upstash');
  assert.equal(storeKind({ KV_REST_API_URL: 'u', KV_REST_API_TOKEN: 't' }), 'upstash');
  assert.equal(storeKind({}), 'file');
  assert.equal(storeKind({ VERCEL: '1' }), 'none');
  assert.equal(getStore({ VERCEL: '1' }), null);
  resetStore();
});
