// The service-role key bypasses every policy, so who may touch it is fixed here (docs/ELVAR_MULTIUSER.md 3.4). Also: only server/db/pool.js knows
// the Postgres URL and the driver, and nothing of the Supabase secret can end up in the browser bundle sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as S from '../server/db/service.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'build', '.gradle']);
const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (SKIP_DIRS.has(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(m?js|cjs|ts|kt|java|json|html)$/.test(e.name)) out.push(p); } return out; };
const files = walk(ROOT).map((f) => path.relative(ROOT, f)).filter((f) => f !== 'package-lock.json');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const hits = (re) => files.filter((f) => re.test(read(f)));

// Files that may import server/db/service.js. P1 has none besides the tests; each later phase adds its module here on purpose
// (server/rights/purge.js, server/admin/*, the cron handlers for the storage sweep and reconciliation).
const SERVICE_IMPORTERS = new Set(['server/rights/purge.js', 'server/admin/api.js', 'server/admin/cron.js']);   // purge: delete the Auth user; admin: ban / unban; cron: grant the admin claim
const SERVICE_OK_DIRS = ['test/'];
const KEY_READERS = new Set(['server/db/service.js', 'server/config/keys.js', 'server/index.js']);   // keys.js only names it in the ledger; index.js SETS a made-up one for the local dev login (never reads a real one)

test('only server/db/service.js reads the service-role key (SUPABASE_SECRET_KEY / service_role)', () => {
  const readers = hits(/SUPABASE_SECRET_KEY|SERVICE_ROLE_KEY|service_role/).filter((f) => !f.startsWith('test/') && !f.startsWith('supabase/') && !f.startsWith('docs/') && !KEY_READERS.has(f));
  assert.deepEqual(readers, []);
  assert.ok(read('server/db/service.js').includes('SUPABASE_SECRET_KEY'));
});

test('only listed modules import server/db/service.js', () => {
  const importers = hits(/from\s+['"][^'"]*db\/service\.js['"]|import\(\s*['"][^'"]*db\/service\.js['"]\s*\)/);
  assert.deepEqual(importers.filter((f) => !SERVICE_IMPORTERS.has(f) && !SERVICE_OK_DIRS.some((d) => f.startsWith(d))), [], 'add the module to SERVICE_IMPORTERS on purpose, after review');
});

test('the browser side (web/, extension/, desktop/, android/) never mentions the service key or the database URL', () => {
  const client = files.filter((f) => /^(web|extension|desktop|android)\//.test(f));
  assert.ok(client.length > 50);
  assert.deepEqual(client.filter((f) => /SUPABASE_SECRET_KEY|service_role|ELVAR_DB_URL|ELVAR_KEK/.test(read(f))), []);
});

test('only server/db/pool.js imports the Postgres driver or reads ELVAR_DB_URL (and tests / the test:db runner)', () => {
  const ok = (f) => f === 'server/db/pool.js' || f.startsWith('test/') || f === 'scripts/test-db.mjs' || f === 'scripts/migrate-owner.mjs';   // the migration script only names the variable in its usage text (it connects through getDb)
  assert.deepEqual(hits(/from\s+['"]postgres['"]|require\(\s*['"]postgres['"]\s*\)|import\(\s*['"]postgres['"]\s*\)/).filter((f) => !ok(f)), []);
  assert.deepEqual(hits(/ELVAR_DB_URL/).filter((f) => !ok(f) && !['server/db/index.js', 'server/config/keys.js', 'server/dev/dev-auth-guard.js'].includes(f)), []);
});

test('the browser never receives table access: the Data API exposes only public and graphql_public, never app', () => {
  const cfg = read('supabase/config.toml');
  const m = /^\s*schemas\s*=\s*\[([^\]]*)\]/m.exec(cfg);
  assert.ok(m, 'api.schemas is set');
  assert.deepEqual(m[1].split(',').map((s) => s.trim().replace(/["']/g, '')).filter(Boolean), ['public', 'graphql_public']);
  assert.ok(!/extra_search_path\s*=.*\bapp\b/.test(cfg));
});

test('service.js: the key never leaves over plain http to a remote host; calls carry the key, validate the id, and map failures', async () => {
  const UID = '3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';
  const env = { SUPABASE_URL: 'https://proj.supabase.test/', SUPABASE_SECRET_KEY: 'sb-secret-for-test' };
  const calls = []; const fx = (status = 200, body = '{}') => async (url, init) => { calls.push({ url, init }); return { status, ok: status < 400, text: async () => body }; };
  assert.deepEqual(S.serviceConfig(env), { url: 'https://proj.supabase.test', key: 'sb-secret-for-test' });
  for (const bad of [{}, { SUPABASE_URL: env.SUPABASE_URL }, { SUPABASE_SECRET_KEY: 'k' }, { ...env, SUPABASE_URL: 'http://proj.supabase.test' }, { ...env, SUPABASE_URL: 'nonsense' }]) assert.throws(() => S.serviceConfig(bad), /service_unconfigured/);
  assert.equal(S.serviceConfig({ ...env, SUPABASE_URL: 'http://127.0.0.1:54321' }).url, 'http://127.0.0.1:54321');
  assert.equal(await S.deleteAuthUser(UID, { env, fetchImpl: fx(200, '{}') }), true);
  assert.deepEqual([calls[0].url, calls[0].init.method, calls[0].init.headers.apikey, calls[0].init.headers.authorization, calls[0].init.redirect], [`https://proj.supabase.test/auth/v1/admin/users/${UID}`, 'DELETE', 'sb-secret-for-test', 'Bearer sb-secret-for-test', 'error']);
  assert.equal(await S.deleteAuthUser(UID, { env, fetchImpl: fx(404, '') }), false, 'already gone');
  await S.setBan(UID, '876000h', { env, fetchImpl: fx() }); assert.deepEqual([calls[2].init.method, JSON.parse(calls[2].init.body)], ['PUT', { ban_duration: '876000h' }]);
  await S.setAppMetadata(UID, { elvar_role: 'admin' }, { env, fetchImpl: fx() }); assert.deepEqual(JSON.parse(calls[3].init.body), { app_metadata: { elvar_role: 'admin' } });
  const before = calls.length;
  for (const bad of ['', 'x', UID + '/../..', '../admin']) await assert.rejects(S.deleteAuthUser(bad, { env, fetchImpl: fx() }), /bad_uid/);
  assert.equal(calls.length, before, 'a bad id never reaches the network');
  await assert.rejects(S.deleteAuthUser(UID, { env, fetchImpl: fx(500) }), (e) => e.code === 'auth_admin_failed' && e.status === 502);
  await assert.rejects(S.deleteAuthUser(UID, { env, fetchImpl: async () => { throw new Error('net'); } }), (e) => e.code === 'auth_admin_unreachable');
});

test('the Vercel function budget: api/ keeps its 9 functions (limit 12); new endpoints go through the router', () => {
  const n = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js')).length;
  assert.ok(n <= 12, `${n} functions`); assert.equal(n, 9);
});
