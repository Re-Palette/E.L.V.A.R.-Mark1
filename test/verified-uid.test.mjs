// VerifiedUid: the only way into asUser(). Who may create one is fixed by this test (R2 in docs/ELVAR_MULTIUSER.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mintVerifiedUid, isVerifiedUid, requireVerifiedUid, isUuid } from '../server/db/verified-uid.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const U = '3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';
const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', 'dist', '.git'].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(m?js|cjs)$/.test(e.name)) out.push(p); } return out; };

test('mint: only known sources and real uuids; the result is frozen, recognised, and prints as the id', () => {
  const v = mintVerifiedUid(U.toUpperCase(), 'jwt');
  assert.equal(v.uid, U); assert.equal(v.source, 'jwt'); assert.equal(String(v), U); assert.equal(JSON.stringify({ v }), `{"v":"${U}"}`); assert.ok(Object.isFrozen(v));
  assert.ok(isVerifiedUid(v)); assert.equal(requireVerifiedUid(v), U);
  for (const bad of ['', 'nope', U + 'x', '../' + U, null, undefined, 5]) assert.throws(() => mintVerifiedUid(bad, 'jwt'), /bad_uid/);
  for (const src of ['admin', 'user', '', undefined, 'JWT']) assert.throws(() => mintVerifiedUid(U, src), /bad_uid_source/);
  for (const src of ['jwt', 'device', 'oauth_pending', 'purge', 'migrate']) assert.equal(mintVerifiedUid(U, src).source, src);
});

test('copies and look-alikes are not verified (a spread, a clone, JSON round trip, a Proxy, a string)', () => {
  const v = mintVerifiedUid(U, 'jwt');
  for (const fake of [{ ...v }, structuredClone({ uid: U, source: 'jwt' }), JSON.parse(JSON.stringify(v)), Object.create(v), Object.freeze({ uid: U, source: 'jwt' }), new Proxy(v, {}), U, null, undefined, 0]) {
    assert.equal(isVerifiedUid(fake), false); assert.throws(() => requireVerifiedUid(fake), /unverified_uid/);
  }
});

test("the 'test' source is refused unless ELVAR_TEST_MODE=1 (production code cannot mint it by accident)", () => {
  const saved = process.env.ELVAR_TEST_MODE;
  try { delete process.env.ELVAR_TEST_MODE; assert.throws(() => mintVerifiedUid(U, 'test'), /bad_uid_source/); process.env.ELVAR_TEST_MODE = '1'; assert.equal(mintVerifiedUid(U, 'test').source, 'test'); }
  finally { if (saved === undefined) delete process.env.ELVAR_TEST_MODE; else process.env.ELVAR_TEST_MODE = saved; }
  assert.ok(isUuid(U) && !isUuid('x') && !isUuid(5));
});

test('only the identity-checking modules (and tests) import mintVerifiedUid', () => {
  const ALLOWED = new Set(['server/db/verified-uid.js', 'server/auth/jwt.js', 'server/auth/with-user.js', 'server/oauth/pending.js', 'scripts/migrate-owner.mjs']);   // scripts/migrate-owner.mjs: the operator's one-time import (source "migrate")   // + server/rights/* for the purge job (source "purge"); oauth/pending.js mints the user a single-use OAuth state belongs to
  const ALLOWED_DIRS = ['server/rights/', 'test/'];
  const users = walk(ROOT).map((f) => path.relative(ROOT, f)).filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('mintVerifiedUid'));
  const bad = users.filter((f) => !ALLOWED.has(f) && !ALLOWED_DIRS.some((d) => f.startsWith(d)));
  assert.deepEqual(bad, [], 'these files must not mint user identities');
  assert.ok(users.includes('server/auth/jwt.js') && users.includes('server/auth/with-user.js'));
});

test('asUser is only called with identities from the auth layer: no file outside server/auth, server/rights, server/db and tests calls db.asUser', () => {
  const callers = walk(ROOT).map((f) => path.relative(ROOT, f)).filter((f) => /\.asUser\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  const bad = callers.filter((f) => !['server/auth/', 'server/rights/', 'server/db/', 'test/'].some((d) => f.startsWith(d)) && f !== 'server/oauth/pending.js' && f !== 'scripts/migrate-owner.mjs');   // pending.js: the OAuth callback acts as the user who started the flow; migrate-owner.mjs: the operator's one-time import into the account they name
  assert.deepEqual(bad, [], 'handlers use ctx.db(fn) from withUser / the router, not asUser directly');
});
