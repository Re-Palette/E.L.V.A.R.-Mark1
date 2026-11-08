// Generic OAuth flow (server/oauth/flow.js, pkce.js): state is random and single use, only a hash of it is in the store, the pending flow is encrypted,
// the code is exchanged on the server with the PKCE verifier, the app claims the result. No network: the token endpoint is a function.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MemoryStore } from '../server/store/memory.js';
import { startFlow, handleCallback, claimFlow, discardPending, PENDING_TTL } from '../server/oauth/flow.js';
import { newVerifier, challengeS256 } from '../server/oauth/pkce.js';

const SECRET = 'FAKE-SECRET-super-secret-client-value';
const base = (store) => ({ store, provider: 'google', authUrl: 'https://accounts.example/auth', tokenUrl: 'https://token.example/token', clientId: 'cid.apps.example', clientSecret: SECRET, redirectUri: 'https://app.example/api/google/callback', scopes: ['a', 'b'], createdBy: 'dev1', params: { access_type: 'offline' } });
function tokenEndpoint(reply) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, ...Object.fromEntries(new URLSearchParams(String(init.body))) }); const [status, body] = typeof reply === 'function' ? reply(calls.length) : reply; return { ok: status < 400, status, json: async () => body }; };
  fn.calls = calls; return fn;
}
const OK = [200, { access_token: 'AT', refresh_token: 'RT-secret', expires_in: 3599, scope: 'a b' }];

test('PKCE: the RFC 7636 example, and a fresh verifier is long and URL-safe', () => {
  assert.equal(challengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const v = newVerifier(); assert.match(v, /^[A-Za-z0-9_-]{43,128}$/); assert.notEqual(v, newVerifier());
});

test('start: authorize URL with PKCE S256 and a 32-byte state; the store holds only ciphertext under sha256(state)', async () => {
  const store = new MemoryStore();
  const f = await startFlow(base(store));
  const u = new URL(f.url);
  assert.equal(u.origin + u.pathname, 'https://accounts.example/auth');
  const q = Object.fromEntries(u.searchParams);
  assert.equal(q.client_id, 'cid.apps.example'); assert.equal(q.redirect_uri, 'https://app.example/api/google/callback'); assert.equal(q.response_type, 'code');
  assert.equal(q.scope, 'a b'); assert.equal(q.code_challenge_method, 'S256'); assert.equal(q.access_type, 'offline'); assert.equal(q.state, f.state);
  assert.match(f.state, /^[A-Za-z0-9_-]{43}$/); assert.equal(f.pendingId, crypto.createHash('sha256').update(f.state).digest('hex'));
  assert.ok(!f.url.includes(SECRET), 'the client secret is never in the browser URL');
  const keys = Object.keys(store.data); assert.deepEqual(keys, [`elvar:v1:pending:${f.pendingId}`]);
  const raw = JSON.stringify(store.data);
  for (const leak of [SECRET, f.state, q.code_challenge, 'cid.apps.example', 'app.example']) assert.ok(!raw.includes(leak), 'the pending record is encrypted: ' + leak.slice(0, 8));
  assert.ok(store.data[keys[0]].x - Date.now() <= PENDING_TTL * 1000 && store.data[keys[0]].x > Date.now(), 'it expires by itself (10 minutes)');
  assert.notEqual((await startFlow(base(store))).state, f.state);
});

test('callback: the code is exchanged on the server with the client secret and the PKCE verifier; the browser gets nothing', async () => {
  const store = new MemoryStore(), f = await startFlow(base(store)), ep = tokenEndpoint(OK);
  const r = await handleCallback({ store, state: f.state, code: 'THE-CODE', fetchImpl: ep });
  assert.deepEqual(r, { ok: true, provider: 'google' });
  assert.equal(ep.calls.length, 1); const c = ep.calls[0];
  assert.equal(c.url, 'https://token.example/token'); assert.equal(c.grant_type, 'authorization_code'); assert.equal(c.code, 'THE-CODE');
  assert.equal(c.client_id, 'cid.apps.example'); assert.equal(c.client_secret, SECRET); assert.equal(c.redirect_uri, 'https://app.example/api/google/callback');
  assert.equal(challengeS256(c.code_verifier), new URL(f.url).searchParams.get('code_challenge'), 'the verifier matches the challenge that was sent');
  assert.ok(!JSON.stringify(store.data).includes('RT-secret'), 'tokens parked in the store are encrypted too');
});

test('callback is single use: a replay and two parallel callbacks exchange the code exactly once', async () => {
  const store = new MemoryStore(), f = await startFlow(base(store));
  let n = 0; const slow = async () => { n++; await new Promise((r) => setTimeout(r, 20)); return { ok: true, status: 200, json: async () => OK[1] }; };
  const rs = await Promise.all([1, 2, 3].map(() => handleCallback({ store, state: f.state, code: 'c', fetchImpl: slow })));
  assert.equal(rs.filter((r) => r.ok).length, 1); assert.equal(n, 1);
  assert.ok(rs.filter((r) => !r.ok).every((r) => r.reason === 'used'));
  assert.equal((await handleCallback({ store, state: f.state, code: 'c', fetchImpl: slow })).reason, 'used'); assert.equal(n, 1);
});

test('callback refuses unknown, malformed, expired and other people\'s state without touching the token endpoint', async () => {
  const store = new MemoryStore(), f = await startFlow(base(store)), ep = tokenEndpoint(OK);
  for (const bad of ['', 'x', f.state + 'A', f.state.slice(0, -1), 'A'.repeat(43), null, undefined, { a: 1 }]) assert.notEqual((await handleCallback({ store, state: bad, code: 'c', fetchImpl: ep })).ok, true, String(bad));
  assert.equal((await handleCallback({ store, state: f.state, code: 'c', fetchImpl: ep, now: Date.now() + (PENDING_TTL + 5) * 1000 })).reason, 'unknown_state', 'expired');
  assert.equal(ep.calls.length, 0);
  assert.equal((await claimFlow({ store, state: crypto.randomBytes(32).toString('base64url') })).status, 'missing', 'another state finds nothing');
});

test('claim: pending until the callback has run, then the tokens once; the owner discards the record after storing them', async () => {
  const store = new MemoryStore(), f = await startFlow(base(store));
  assert.deepEqual(await claimFlow({ store, state: f.state }), { status: 'pending' });
  await handleCallback({ store, state: f.state, code: 'c', fetchImpl: tokenEndpoint(OK) });
  const c = await claimFlow({ store, state: f.state });
  assert.equal(c.status, 'ok'); assert.equal(c.tokens.refresh_token, 'RT-secret'); assert.deepEqual(c.scopes, ['a', 'b']); assert.equal(c.clientId, 'cid.apps.example');
  assert.equal((await claimFlow({ store, state: f.state })).status, 'ok', 'still there until discarded (the owner may retry a failed vault write)');
  await discardPending(store, f.state);
  assert.equal((await claimFlow({ store, state: f.state })).status, 'missing');
  assert.equal((await handleCallback({ store, state: f.state, code: 'c', fetchImpl: tokenEndpoint(OK) })).ok, false, 'a claimed flow cannot be replayed');
});

test('failures are parked for the app to report: denied, provider refusal, no refresh token, network', async () => {
  const run = async (cb) => { const store = new MemoryStore(), f = await startFlow(base(store)); const r = await handleCallback({ store, state: f.state, ...cb }); return { r, c: await claimFlow({ store, state: f.state }), store, f }; };
  let x = await run({ error: 'access_denied' }); assert.equal(x.r.reason, 'denied'); assert.deepEqual([x.c.status, x.c.error], ['error', 'access_denied']);
  assert.equal((await claimFlow({ store: x.store, state: x.f.state })).status, 'missing', 'an error is reported once, then cleared');
  x = await run({ code: 'c', fetchImpl: tokenEndpoint([400, { error: 'invalid_client', error_description: 'Unauthorized' }]) }); assert.equal(x.r.reason, 'exchange_failed'); assert.deepEqual([x.c.status, x.c.error, x.c.description], ['error', 'invalid_client', 'Unauthorized']);
  x = await run({ code: 'c', fetchImpl: tokenEndpoint([200, { access_token: 'AT' }]) }); assert.equal(x.r.reason, 'no_refresh_token'); assert.equal(x.c.error, 'no_refresh_token');
  x = await run({ code: 'c', fetchImpl: async () => { throw new Error('ECONNRESET secret-detail'); } }); assert.equal(x.r.reason, 'network'); assert.ok(!JSON.stringify(x).includes('secret-detail'));
  x = await run({ code: '', fetchImpl: tokenEndpoint(OK) }); assert.equal(x.r.reason, 'denied', 'no code = nothing to exchange');
});

test('nothing is logged: codes, tokens and secrets never reach the console', async () => {
  const logs = []; const real = { l: console.log, e: console.error, w: console.warn };
  console.log = console.error = console.warn = (...a) => logs.push(a.join(' '));
  try {
    const store = new MemoryStore(), f = await startFlow(base(store));
    await handleCallback({ store, state: f.state, code: 'SECRET-CODE-XYZ', fetchImpl: tokenEndpoint(OK) });
    await claimFlow({ store, state: f.state });
  } finally { Object.assign(console, { log: real.l, error: real.e, warn: real.w }); }
  for (const s of ['SECRET-CODE-XYZ', 'RT-secret', SECRET]) assert.ok(!logs.join('\n').includes(s));
});
