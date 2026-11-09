// Request authentication (server/auth/with-user.js) end to end on MemoryDb with locally signed tokens: user, admin, device:<scope>, cron, the router's auth kinds,
// account status, the 30 s status cache, requireFresh, and the rule that a user's secrets never come from the platform environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as jose from 'jose';
import { getDb, resetDb } from '../server/db/index.js';
import { createJwtVerifier, _setVerifierForTests, AuthError } from '../server/auth/jwt.js';
import { authenticate, requireFresh, invalidateAccount, _clearAccountCache, withUser, withAdmin, withDevice, withCron } from '../server/auth/with-user.js';
import { newDeviceToken, parseDeviceToken, deviceTokenFrom } from '../server/auth/device-token.js';
import { createRouter, ROUTES, isUserAuth } from '../server/router.js';
import { env, runWithConfig, envConfig } from '../server/config/resolve.js';
import { makeKey, jwksOf, signToken, SUPABASE_URL } from './helpers/jwt-keys.mjs';

const key = await makeKey('k1');
const verifier = createJwtVerifier({ supabaseUrl: SUPABASE_URL, getKey: jose.createLocalJWKSet(jwksOf(key)) });
const J = { 'content-type': 'application/json' };
const req = (method, headers = {}) => ({ method, headers: { ...J, ...headers }, socket: { remoteAddress: '203.0.113.9' } });
const bearer = async (sub, claims = {}, opts) => ({ authorization: 'Bearer ' + await signToken(key, { sub, ...claims }, opts) });
const sealed = () => ({ ct: crypto.randomBytes(40), iv: crypto.randomBytes(12), dekVer: 1, last4: null });

// A test route table exercising every auth kind through the real router.
const TEST_ROUTES = [
  { method: 'GET', path: '/api/elvar/t/me', auth: 'user', handler: async ({ user }) => ({ status: 200, body: { uid: user.uid.uid, account: await user.db((r) => r.accounts.get()), source: user.uid.source } }) },
  { method: 'PUT', path: '/api/elvar/t/secret/:name', auth: 'user', handler: ({ user, params }) => user.db(async (r) => { await r.secrets.put(params.name, sealed()); return { status: 200, body: { ok: true } }; }) },
  { method: 'GET', path: '/api/elvar/t/secret/:name', auth: 'user', handler: ({ user, params }) => user.db(async (r) => ((await r.secrets.get(params.name)) ? { status: 200, body: { found: true } } : { status: 404, body: { error: 'not_found' } })) },
  { method: 'POST', path: '/api/elvar/t/devices', auth: 'user', handler: ({ user, body }) => user.db(async (r) => { const t = newDeviceToken(); await r.devices.create({ id: t.deviceId, name: 'phone', tokenHash: t.hash, scopes: body.scopes || ['notif:push'] }); return { status: 200, body: { token: t.token, id: t.deviceId } }; }) },
  { method: 'DELETE', path: '/api/elvar/t/devices/:id', auth: 'user', handler: ({ user, params }) => user.db(async (r) => ((await r.devices.revoke(params.id)) ? { status: 200, body: { ok: true } } : { status: 404, body: { error: 'not_found' } })) },
  { method: 'GET', path: '/api/elvar/t/cancel', auth: 'user', authOpts: { allowPendingDeletion: true }, handler: ({ user }) => ({ status: 200, body: { status: user.account.status } }) },
  { method: 'GET', path: '/api/elvar/t/admin', auth: 'admin', handler: ({ user }) => ({ status: 200, body: { role: user.role } }) },
  { method: 'POST', path: '/api/elvar/t/notif', auth: 'device:notif:push', handler: ({ user }) => ({ status: 200, body: { uid: user.uid.uid, device: user.deviceId, source: user.uid.source } }) },
  { method: 'POST', path: '/api/elvar/t/cron', auth: 'cron', handler: ({ user }) => ({ status: 200, body: { kind: user.kind, ops: Object.keys(user.system).sort() } }) },
  { method: 'GET', path: '/api/elvar/t/key', auth: 'user', handler: () => ({ status: 200, body: { gemini: env('GEMINI_API_KEY') ?? null, model: env('GROQ_MODEL') ?? null } }) },
  { method: 'GET', path: '/api/elvar/t/typo', auth: 'usr', handler: () => ({ status: 200, body: { leaked: true } }) },
  { method: 'GET', path: '/api/elvar/t/public', auth: 'none', handler: () => ({ status: 200, body: { ok: true } }) },
];
const route = createRouter(TEST_ROUTES);
const call = (method, pathname, headers, body = {}) => route(req(method, headers), { pathname, body });

async function fresh(fn) {
  await resetDb(); _clearAccountCache(); _setVerifierForTests(verifier);
  const saved = { CRON_SECRET: process.env.CRON_SECRET, GEMINI_API_KEY: process.env.GEMINI_API_KEY, GROQ_MODEL: process.env.GROQ_MODEL };
  try { return await fn(await getDb()); }
  finally { _setVerifierForTests(null); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } await resetDb(); _clearAccountCache(); }
}

test('user routes: no token -> 401, a bad token -> 401, a good token -> the caller\'s own account (created on first use)', () => fresh(async (db) => {
  const uid = db.testing.newUser();
  assert.deepEqual((await call('GET', '/api/elvar/t/me', {})).body, { error: 'login_required' });
  assert.equal((await call('GET', '/api/elvar/t/me', { authorization: 'Bearer abc.def.ghi' })).status, 401);
  assert.equal((await call('GET', '/api/elvar/t/me', { authorization: 'Basic abc' })).status, 401);
  const r = await call('GET', '/api/elvar/t/me', await bearer(uid));
  assert.equal(r.status, 200); assert.equal(r.body.uid, uid); assert.equal(r.body.source, 'jwt'); assert.equal(r.body.account.status, 'active'); assert.equal(r.body.account.storageQuotaBytes, 524288000);
  assert.equal((await call('GET', '/api/elvar/t/me', await bearer(uid, { role: 'service_role' }))).status, 401);
  assert.equal((await call('GET', '/api/elvar/t/me', await bearer(uid, {}, { exp: Math.floor(Date.now() / 1000) - 120, iat: Math.floor(Date.now() / 1000) - 7200 }))).body.error, 'token_expired');
}));

test('a route with an unknown auth kind is refused, never served unauthenticated; the public route still works', () => fresh(async () => {
  const r = await call('GET', '/api/elvar/t/typo', {}); assert.deepEqual(r, { status: 500, body: { error: 'bad_auth_kind' } });
  assert.equal((await call('GET', '/api/elvar/t/public', {})).status, 200);
  assert.equal(isUserAuth('usr'), false); for (const k of ['user', 'admin', 'cron', 'device:notif:push', 'device:notif:pull']) assert.equal(isUserAuth(k), true, k);
  for (const k of ['owner', 'none', 'state', 'device:', 'device:A', 'devices:x', undefined]) assert.equal(isUserAuth(k), false, String(k));
}));

test('API isolation: B\'s token never reaches A\'s secrets or devices, even with A\'s names and ids', () => fresh(async (db) => {
  const a = db.testing.newUser(), b = db.testing.newUser(), hA = await bearer(a), hB = await bearer(b);
  assert.equal((await call('PUT', '/api/elvar/t/secret/GEMINI_API_KEY', hA)).status, 200);
  assert.equal((await call('GET', '/api/elvar/t/secret/GEMINI_API_KEY', hA)).status, 200);
  assert.equal((await call('GET', '/api/elvar/t/secret/GEMINI_API_KEY', hB)).status, 404, 'B has no such secret');
  const dev = (await call('POST', '/api/elvar/t/devices', hA)).body;
  assert.equal((await call('DELETE', `/api/elvar/t/devices/${dev.id}`, hB)).status, 404, 'B cannot revoke A\'s device');
  assert.equal((await call('DELETE', `/api/elvar/t/devices/${dev.id}`, hA)).status, 200);
  assert.equal((await call('GET', '/api/elvar/t/me', hB)).body.uid, b);
}));

test('suspended and pending-deletion accounts get 403; the deletion-cancel route may admit pending_deletion', () => fresh(async (db) => {
  const uid = db.testing.newUser(), h = await bearer(uid);
  assert.equal((await call('GET', '/api/elvar/t/me', h)).status, 200);
  db.testing.setAccountStatus(uid, 'suspended'); invalidateAccount(uid);
  assert.deepEqual((await call('GET', '/api/elvar/t/me', h)).body, { error: 'account_suspended' }); assert.equal((await call('GET', '/api/elvar/t/cancel', h)).status, 403);
  db.testing.setAccountStatus(uid, 'pending_deletion'); invalidateAccount(uid);
  assert.deepEqual((await call('GET', '/api/elvar/t/me', h)).body, { error: 'account_pending_deletion' });
  assert.deepEqual((await call('GET', '/api/elvar/t/cancel', h)).body, { status: 'pending_deletion' });
  db.testing.setAccountStatus(uid, 'active'); invalidateAccount(uid);
  assert.equal((await call('GET', '/api/elvar/t/me', h)).status, 200);
}));

test('the account status is cached for 30 seconds per instance, then re-read', () => fresh(async (db) => {
  const uid = db.testing.newUser(), h = await bearer(uid), t0 = Date.now();
  const ask = (now) => authenticate('user', req('GET', h), { now });
  assert.equal((await ask(t0)).ok, true);
  db.testing.setAccountStatus(uid, 'suspended');
  assert.equal((await ask(t0 + 29_000)).ok, true, 'inside the window the cached status is used');
  const late = await ask(t0 + 31_000); assert.deepEqual({ ok: late.ok, status: late.status, error: late.error }, { ok: false, status: 403, error: 'account_suspended' });
}));

test('admin: needs the signed claim AND a row in app.admins', () => fresh(async (db) => {
  const claim = { app_metadata: { elvar_role: 'admin' } };
  const a = db.testing.newUser(), b = db.testing.newUser(), c = db.testing.newUser(), d = db.testing.newUser();
  db.testing.makeAdmin(a); db.testing.makeAdmin(c);
  assert.equal((await call('GET', '/api/elvar/t/admin', await bearer(a, claim))).status, 200, 'claim + row');
  assert.equal((await call('GET', '/api/elvar/t/admin', await bearer(b, claim))).status, 403, 'claim only');
  assert.equal((await call('GET', '/api/elvar/t/admin', await bearer(c))).status, 403, 'row only');
  assert.equal((await call('GET', '/api/elvar/t/admin', await bearer(d))).status, 403, 'neither');
  assert.equal((await call('GET', '/api/elvar/t/admin', await bearer(c, { user_metadata: { elvar_role: 'admin' } }))).status, 403, 'user_metadata is not trusted');
  assert.equal((await call('GET', '/api/elvar/t/admin', {})).status, 401);
}));

test('device tokens: only on routes that ask for the scope, per user, revocable, and only the elv2 form', () => fresh(async (db) => {
  const a = db.testing.newUser(), hA = await bearer(a);
  const push = (await call('POST', '/api/elvar/t/devices', hA, { scopes: ['notif:push'] })).body, pull = (await call('POST', '/api/elvar/t/devices', hA, { scopes: ['notif:pull'] })).body;
  const viaHeader = (t) => ({ 'x-elvar-token': t });
  const ok = await call('POST', '/api/elvar/t/notif', viaHeader(push.token));
  assert.deepEqual(ok, { status: 200, body: { uid: a, device: push.id, source: 'device' } });
  assert.equal((await call('POST', '/api/elvar/t/notif', { authorization: 'Bearer ' + push.token })).status, 200, 'Authorization: Bearer works too');
  assert.equal((await call('POST', '/api/elvar/t/notif', viaHeader(pull.token))).status, 401, 'a pull-only token is refused where push is required');
  const tampered = push.token.slice(0, -1) + (push.token.endsWith('A') ? 'B' : 'A'); assert.equal((await call('POST', '/api/elvar/t/notif', viaHeader(tampered))).status, 401);
  const wrongId = `elv2.${'0'.repeat(16)}.${push.token.split('.')[2]}`; assert.equal((await call('POST', '/api/elvar/t/notif', viaHeader(wrongId))).status, 401, 'right secret, wrong device id');
  for (const t of ['elv1.' + 'a'.repeat(16) + '.' + 'b'.repeat(43), 'garbage', '']) assert.equal((await call('POST', '/api/elvar/t/notif', viaHeader(t))).status, 401, t);
  assert.equal((await call('POST', '/api/elvar/t/notif', hA)).status, 401, 'a user JWT is not a device token');
  assert.equal((await call('GET', '/api/elvar/t/me', viaHeader(push.token))).status, 401, 'a device token does not open user routes');
  assert.equal((await call('GET', '/api/elvar/t/me', { authorization: 'Bearer ' + push.token })).status, 401);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok((await db.asUser((await authenticate('user', req('GET', hA))).ctx.uid, (r) => r.devices.list())).find((d) => d.id === push.id).lastSeenAt, 'last seen is recorded');
  db.testing.setAccountStatus(a, 'suspended'); invalidateAccount(a);
  assert.equal((await call('POST', '/api/elvar/t/notif', viaHeader(push.token))).body.error, 'account_suspended');
  db.testing.setAccountStatus(a, 'active'); invalidateAccount(a);
  assert.equal((await call('DELETE', `/api/elvar/t/devices/${push.id}`, hA)).status, 200);
  assert.equal((await call('POST', '/api/elvar/t/notif', viaHeader(push.token))).status, 401, 'revoked');
}));

test('device token format and parsing', () => {
  const t = newDeviceToken(); assert.match(t.token, /^elv2\.[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/);
  const p = parseDeviceToken(t.token); assert.deepEqual({ deviceId: p.deviceId, secret: p.secret }, { deviceId: t.deviceId, secret: t.secret }); assert.ok(p.hash.equals(t.hash)); assert.equal(t.hash.length, 32);
  assert.notEqual(newDeviceToken().token, t.token);
  for (const bad of [null, undefined, '', 'elv2.x.y', t.token + 'x', t.token.replace('elv2', 'elv1')]) assert.equal(parseDeviceToken(bad), null);
  assert.equal(deviceTokenFrom({ headers: { 'x-elvar-token': t.token } }), t.token); assert.equal(deviceTokenFrom({ headers: { authorization: 'Bearer ' + t.token } }), t.token);
  assert.equal(deviceTokenFrom({ headers: { 'x-elvar-token': 'elv1.old' } }), null);
});

test('cron: fails closed without a strong CRON_SECRET; needs the exact bearer; a user token is not a cron token', () => fresh(async (db) => {
  const secret = crypto.randomBytes(24).toString('hex');
  delete process.env.CRON_SECRET;
  assert.deepEqual(await call('POST', '/api/elvar/t/cron', { authorization: 'Bearer anything-goes-here' }), { status: 503, body: { error: 'cron_unconfigured' } });
  process.env.CRON_SECRET = 'short'; assert.equal((await call('POST', '/api/elvar/t/cron', { authorization: 'Bearer short' })).status, 503);
  process.env.CRON_SECRET = secret;
  assert.equal((await call('POST', '/api/elvar/t/cron', {})).status, 401);
  assert.equal((await call('POST', '/api/elvar/t/cron', { authorization: 'Bearer ' + secret + 'x' })).status, 401);
  assert.equal((await call('POST', '/api/elvar/t/cron', await bearer(db.testing.newUser()))).status, 401);
  const ok = await call('POST', '/api/elvar/t/cron', { authorization: 'Bearer ' + secret });
  assert.deepEqual(ok, { status: 200, body: { kind: 'cron', ops: ['deviceLookup', 'purgeExpired', 'residualCheck', 'rlHit'] } });
}));

test('a signed-in user\'s API keys never come from the platform environment (M5); settings may fall back to platform defaults', () => fresh(async (db) => {
  process.env.GEMINI_API_KEY = 'platform-paid-key-should-never-be-used'; process.env.GROQ_MODEL = 'platform-default-model';
  const r = await call('GET', '/api/elvar/t/key', await bearer(db.testing.newUser()));
  assert.deepEqual(r.body, { gemini: null, model: 'platform-default-model' });
  assert.equal(await runWithConfig(envConfig(), () => env('GEMINI_API_KEY')), 'platform-paid-key-should-never-be-used', 'the old single-owner mode is unchanged');
}));

test('requireFresh: the token must be recent AND Supabase Auth must still accept it for the same user', async () => {
  const uid = crypto.randomUUID(), now = Date.now(), ctx = { uid: { uid }, jwt: { iat: Math.floor(now / 1000) - 60, token: 'tok' } };
  const env2 = { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: 'pub-key' };
  const ok = (id = uid, status = 200) => async (url, init) => { ok.calls.push({ url, init }); return { ok: status < 400, status, json: async () => ({ id }) }; };
  ok.calls = [];
  await requireFresh(ctx, 600, { fetchImpl: ok(), env: env2, now });
  assert.equal(ok.calls[0].url, `${SUPABASE_URL}/auth/v1/user`); assert.equal(ok.calls[0].init.headers.authorization, 'Bearer tok'); assert.equal(ok.calls[0].init.headers.apikey, 'pub-key');
  const code = (c, s) => (e) => { assert.ok(e instanceof AuthError); assert.deepEqual([e.code, e.status], [c, s]); return true; };
  await assert.rejects(requireFresh({ ...ctx, jwt: { iat: Math.floor(now / 1000) - 601, token: 'tok' } }, 600, { fetchImpl: ok(), env: env2, now }), code('reauth_required', 401));
  await assert.rejects(requireFresh(ctx, 600, { fetchImpl: ok(uid, 401), env: env2, now }), code('reauth_required', 401), 'revoked session');
  await assert.rejects(requireFresh(ctx, 600, { fetchImpl: ok(crypto.randomUUID()), env: env2, now }), code('reauth_required', 401), 'token of somebody else');
  await assert.rejects(requireFresh(ctx, 600, { fetchImpl: ok(uid, 503), env: env2, now }), code('auth_unavailable', 503));
  await assert.rejects(requireFresh(ctx, 600, { fetchImpl: async () => { throw new Error('down'); }, env: env2, now }), code('auth_unavailable', 503));
  await assert.rejects(requireFresh(ctx, 600, { fetchImpl: ok(), env: {}, now }), code('auth_unconfigured', 503));
  await assert.rejects(requireFresh({ uid: { uid }, jwt: null }, 600, { fetchImpl: ok(), env: env2, now }), code('reauth_required', 401), 'device contexts are never fresh');
});

// ---- Vercel-style wrappers
const fakeRes = () => { const r = { headers: {}, statusCode: 0, body: '' }; r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; }; r.end = (b) => { r.body = b; }; return r; };
test('withUser / withAdmin / withDevice / withCron: the same checks for api/*.js style handlers; a failing handler answers 500 without leaking', () => fresh(async (db) => {
  const uid = db.testing.newUser(), h = await bearer(uid);
  let seen = null;
  const handler = async (rq, res, ctx) => { seen = ctx; res.statusCode = 200; res.end(JSON.stringify({ uid: ctx.uid.uid })); };
  let res = fakeRes(); await withUser(handler)(req('GET', {}), res); assert.equal(res.statusCode, 401); assert.equal(seen, null);
  res = fakeRes(); await withUser(handler)(req('GET', h), res); assert.equal(res.statusCode, 200); assert.equal(seen.uid.uid, uid);
  assert.equal(typeof seen.db, 'function'); assert.equal(await seen.db((r) => r.uid), uid);
  res = fakeRes(); await withAdmin(handler)(req('GET', h), res); assert.equal(res.statusCode, 403);
  res = fakeRes(); await withDevice('notif:push')(handler)(req('POST', h), res); assert.equal(res.statusCode, 401);
  res = fakeRes(); await withCron(handler)(req('POST', {}), res); assert.ok([401, 503].includes(res.statusCode));
  const boom = async () => { throw new Error('secret internals: password=hunter2'); };
  res = fakeRes(); const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
  try { await withUser(boom)(req('GET', h), res); } finally { console.error = orig; }
  assert.equal(res.statusCode, 500); assert.deepEqual(JSON.parse(res.body), { error: 'internal_error' });
}));

test('no database configured: authenticated routes answer 503 db_unavailable, public ones are unaffected', async () => {
  const saved = process.env.ELVAR_DB; delete process.env.ELVAR_DB; await resetDb(); _setVerifierForTests(verifier);
  const orig = console.error; console.error = () => {};
  try {
    const r = await call('GET', '/api/elvar/t/me', await bearer(crypto.randomUUID()));
    assert.deepEqual(r, { status: 503, body: { error: 'db_unavailable' } });
    assert.equal((await call('GET', '/api/elvar/t/public', {})).status, 200);
  } finally { console.error = orig; process.env.ELVAR_DB = saved; _setVerifierForTests(null); await resetDb(); }
});

// ---- the real route table
test('the real route table: every route has a known auth kind; user-facing kinds need a cross-user case; the old owner routes do not grow', () => {
  const CROSS_USER_CASES = new Set([]);   // "METHOD /path": add the route and a "B calls with A's id" case to this file (API isolation, see the test above) when a user / admin / device route is added
  const known = (a) => ['none', 'owner', 'state'].includes(a) || isUserAuth(a);
  assert.deepEqual(ROUTES.filter((r) => !known(r.auth)).map((r) => `${r.method} ${r.path}`), []);
  const userFacing = ROUTES.filter((r) => isUserAuth(r.auth) && r.auth !== 'cron');
  assert.deepEqual(userFacing.filter((r) => !CROSS_USER_CASES.has(`${r.method} ${r.path}`)).map((r) => `${r.method} ${r.path}`), [], 'a new user route needs a cross-user test');
  assert.equal(ROUTES.filter((r) => r.auth === 'owner').length, 24, 'P1 keeps the old owner routes as they are and adds none; they are removed in P2');
});
