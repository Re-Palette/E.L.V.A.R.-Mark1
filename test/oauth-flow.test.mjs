// Generic OAuth flow (server/oauth/flow.js, pkce.js, pending.js) on the platform: state is random and single use, only a hash of it is in the database, the pending flow is
// sealed under a key derived from the state, the code is exchanged on the server with the PKCE verifier, and the callback (no token) binds the result to the user
// who started the flow: only THAT user can claim it. No network: the token endpoint is a function; the database is MemoryDb.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createMemoryDb } from '../server/db/memory.js';
import { mintVerifiedUid } from '../server/db/verified-uid.js';
import { startFlow, handleCallback, claimFlow, discardPending, stateHashOf, PENDING_TTL } from '../server/oauth/flow.js';
import { pendingFor, openPendingByState } from '../server/oauth/pending.js';
import { newVerifier, challengeS256 } from '../server/oauth/pkce.js';

const SECRET = 'FAKE-SECRET-super-secret-client-value';
/** Two users in one database; `pa` / `pb` are their pending interfaces (what cfg.db gives a request). */
function world() {
  const db = createMemoryDb(), a = db.testing.newUser(), b = db.testing.newUser(), A = mintVerifiedUid(a, 'test'), B = mintVerifiedUid(b, 'test');
  return { db, a, b, A, B, pa: pendingFor((fn) => db.asUser(A, fn)), pb: pendingFor((fn) => db.asUser(B, fn)), open: openPendingByState(db, PROV) };
}
const PROV = 'google';
const base = (pending) => ({ pending, provider: 'google', authUrl: 'https://accounts.example/auth', tokenUrl: 'https://token.example/token', clientId: 'cid.apps.example', clientSecret: SECRET, redirectUri: 'https://app.example/api/google/callback', scopes: ['a', 'b'], params: { access_type: 'offline' } });
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

test('start: authorize URL with PKCE S256 and a 32-byte state; the database holds only ciphertext under sha256(state), in the user\'s own row', async () => {
  const w = world(), f = await startFlow(base(w.pa)), u = new URL(f.url);
  assert.equal(u.origin + u.pathname, 'https://accounts.example/auth');
  const q = Object.fromEntries(u.searchParams);
  assert.equal(q.client_id, 'cid.apps.example'); assert.equal(q.redirect_uri, 'https://app.example/api/google/callback'); assert.equal(q.response_type, 'code');
  assert.equal(q.scope, 'a b'); assert.equal(q.code_challenge_method, 'S256'); assert.equal(q.access_type, 'offline'); assert.equal(q.state, f.state);
  assert.match(f.state, /^[A-Za-z0-9_-]{43}$/); assert.equal(f.pendingId, crypto.createHash('sha256').update(f.state).digest('hex'));
  assert.ok(!f.url.includes(SECRET), 'the client secret is never in the browser URL');
  const rec = await w.pa.get(stateHashOf(f.state)); assert.equal(rec.phase, 'started');
  for (const leak of [SECRET, f.state, q.code_challenge, 'cid.apps.example', 'app.example']) assert.ok(!rec.sealed.includes(Buffer.from(leak)), 'the pending record is encrypted: ' + leak.slice(0, 8));
  assert.equal(await w.pb.get(stateHashOf(f.state)), null, 'another user does not see it');
  assert.equal(await w.open(stateHashOf(f.state)) !== null, true, 'the callback finds it by the hash of the state');
  assert.notEqual((await startFlow(base(w.pa))).state, f.state);
});

test('callback: no token, only the state: the code is exchanged on the server with the client secret and the PKCE verifier; the browser gets nothing', async () => {
  const w = world(), f = await startFlow(base(w.pa)), ep = tokenEndpoint(OK);
  const r = await handleCallback({ expectProvider: PROV, openPending: w.open, state: f.state, code: 'THE-CODE', fetchImpl: ep });
  assert.deepEqual(r, { ok: true, provider: 'google' });
  assert.equal(ep.calls.length, 1); const c = ep.calls[0];
  assert.equal(c.url, 'https://token.example/token'); assert.equal(c.grant_type, 'authorization_code'); assert.equal(c.code, 'THE-CODE');
  assert.equal(c.client_id, 'cid.apps.example'); assert.equal(c.client_secret, SECRET); assert.equal(c.redirect_uri, 'https://app.example/api/google/callback');
  assert.equal(challengeS256(c.code_verifier), new URL(f.url).searchParams.get('code_challenge'), 'the verifier matches the challenge that was sent');
  const rec = await w.pa.get(stateHashOf(f.state)); assert.equal(rec.phase, 'done'); assert.ok(!rec.sealed.includes(Buffer.from('RT-secret')), 'tokens parked in the database are sealed too');
});

test('the result is bound to the user who started the flow: only they can claim it; another user\'s claim with the same state finds nothing and cannot disturb it', async () => {
  const w = world(), f = await startFlow(base(w.pa));
  await handleCallback({ expectProvider: PROV, openPending: w.open, state: f.state, code: 'c', fetchImpl: tokenEndpoint(OK) });
  assert.deepEqual(await claimFlow({ pending: w.pb, state: f.state }), { status: 'missing' }, 'B knows the state (e.g. it leaked) and still gets nothing');
  assert.equal(await discardPending(w.pb, f.state), false, 'B cannot discard it either');
  const c = await claimFlow({ pending: w.pa, state: f.state }); assert.equal(c.status, 'ok'); assert.equal(c.tokens.refresh_token, 'RT-secret');
});

test('callback is single use: a replay and two parallel callbacks exchange the code exactly once', async () => {
  const w = world(), f = await startFlow(base(w.pa));
  let n = 0; const slow = async () => { n++; await new Promise((r) => setTimeout(r, 20)); return { ok: true, status: 200, json: async () => OK[1] }; };
  const rs = await Promise.all([1, 2, 3].map(() => handleCallback({ expectProvider: PROV, openPending: w.open, state: f.state, code: 'c', fetchImpl: slow })));
  assert.equal(rs.filter((r) => r.ok).length, 1); assert.equal(n, 1);
  assert.ok(rs.filter((r) => !r.ok).every((r) => r.reason === 'used'));
  assert.equal((await handleCallback({ expectProvider: PROV, openPending: w.open, state: f.state, code: 'c', fetchImpl: slow })).reason, 'used'); assert.equal(n, 1);
});

test('callback refuses unknown, malformed, expired and other people\'s state without touching the token endpoint', async () => {
  const w = world(), f = await startFlow(base(w.pa)), ep = tokenEndpoint(OK);
  for (const bad of ['', 'x', f.state + 'A', f.state.slice(0, -1), 'A'.repeat(43), null, undefined, { a: 1 }]) assert.notEqual((await handleCallback({ expectProvider: PROV, openPending: w.open, state: bad, code: 'c', fetchImpl: ep })).ok, true, String(bad));
  w.db.testing.advance((PENDING_TTL + 5) * 1000);
  assert.equal((await handleCallback({ expectProvider: PROV, openPending: w.open, state: f.state, code: 'c', fetchImpl: ep })).reason, 'unknown_state', 'expired');
  assert.equal(ep.calls.length, 0);
  assert.equal((await claimFlow({ pending: w.pa, state: crypto.randomBytes(32).toString('base64url') })).status, 'missing', 'another state finds nothing');
});

test('claim: pending until the callback has run, then the tokens; the user discards the record after storing them', async () => {
  const w = world(), f = await startFlow(base(w.pa));
  assert.deepEqual(await claimFlow({ pending: w.pa, state: f.state }), { status: 'pending' });
  await handleCallback({ expectProvider: PROV, openPending: w.open, state: f.state, code: 'c', fetchImpl: tokenEndpoint(OK) });
  const c = await claimFlow({ pending: w.pa, state: f.state });
  assert.equal(c.status, 'ok'); assert.equal(c.tokens.refresh_token, 'RT-secret'); assert.deepEqual(c.scopes, ['a', 'b']); assert.equal(c.clientId, 'cid.apps.example'); assert.equal(c.provider, 'google');
  assert.equal((await claimFlow({ pending: w.pa, state: f.state })).status, 'ok', 'still there until discarded (the user may retry a failed save)');
  await discardPending(w.pa, f.state);
  assert.equal((await claimFlow({ pending: w.pa, state: f.state })).status, 'missing');
  assert.equal((await handleCallback({ expectProvider: PROV, openPending: w.open, state: f.state, code: 'c', fetchImpl: tokenEndpoint(OK) })).ok, false, 'a claimed flow cannot be replayed');
});

test('failures are parked for the app to report: denied, provider refusal, no refresh token, network', async () => {
  const run = async (cb) => { const w = world(), f = await startFlow(base(w.pa)); const r = await handleCallback({ expectProvider: PROV, openPending: w.open, state: f.state, ...cb }); return { r, c: await claimFlow({ pending: w.pa, state: f.state }), w, f }; };
  let x = await run({ error: 'access_denied' }); assert.equal(x.r.reason, 'denied'); assert.deepEqual([x.c.status, x.c.error], ['error', 'access_denied']);
  assert.equal((await claimFlow({ pending: x.w.pa, state: x.f.state })).status, 'missing', 'an error is reported once, then cleared');
  x = await run({ code: 'c', fetchImpl: tokenEndpoint([400, { error: 'invalid_client', error_description: 'Unauthorized' }]) }); assert.equal(x.r.reason, 'exchange_failed'); assert.deepEqual([x.c.status, x.c.error, x.c.description], ['error', 'invalid_client', 'Unauthorized']);
  x = await run({ code: 'c', fetchImpl: tokenEndpoint([200, { access_token: 'AT' }]) }); assert.equal(x.r.reason, 'no_refresh_token'); assert.equal(x.c.error, 'no_refresh_token');
  x = await run({ code: 'c', fetchImpl: async () => { throw new Error('ECONNRESET secret-detail'); } }); assert.equal(x.r.reason, 'network'); assert.ok(!JSON.stringify([x.r, x.c]).includes('secret-detail'));
  x = await run({ code: '', fetchImpl: tokenEndpoint(OK) }); assert.equal(x.r.reason, 'denied', 'no code = nothing to exchange');
});

test('a long token (an MCP server\'s JWT) still fits the 8 KB column', async () => {
  const w = world(), f = await startFlow({ ...base(w.pa), provider: 'mcp', requireRefresh: false });
  const big = 'x'.repeat(3500);
  assert.equal((await handleCallback({ expectProvider: 'mcp', openPending: openPendingByState(w.db, 'mcp'), state: f.state, code: 'c', fetchImpl: tokenEndpoint([200, { access_token: big, refresh_token: big, expires_in: 60, scope: 'a' }]) })).ok, true);
  assert.equal((await claimFlow({ pending: w.pa, state: f.state })).tokens.access_token, big);
});

test('nothing is logged: codes, tokens and secrets never reach the console', async () => {
  const logs = []; const real = { l: console.log, e: console.error, w: console.warn };
  console.log = console.error = console.warn = (...a) => logs.push(a.join(' '));
  try {
    const w = world(), f = await startFlow(base(w.pa));
    await handleCallback({ expectProvider: PROV, openPending: w.open, state: f.state, code: 'SECRET-CODE-XYZ', fetchImpl: tokenEndpoint(OK) });
    await claimFlow({ pending: w.pa, state: f.state });
  } finally { Object.assign(console, { log: real.l, error: real.e, warn: real.w }); }
  for (const s of ['SECRET-CODE-XYZ', 'RT-secret', SECRET]) assert.ok(!logs.join('\n').includes(s));
});

test('review fix: a flow of one kind is invisible to the callback of the other kind - zero network calls, the state is not consumed, no token URL of a stranger is ever called', async () => {
  for (const [started, wrong, right] of [['mcp', 'google', 'mcp'], ['google', 'mcp', 'google']]) {
    const w = world(), f = await startFlow({ ...base(w.pa), provider: started, tokenUrl: 'http://169.254.169.254/latest/token', requireRefresh: false });
    let calls = 0; const net = async () => { calls++; return { ok: true, status: 200, json: async () => ({ access_token: 'x', refresh_token: 'y' }) }; };
    const r = await handleCallback({ expectProvider: wrong, openPending: openPendingByState(w.db, wrong), state: f.state, code: 'c', fetchImpl: net });
    assert.deepEqual([r.ok, r.reason, calls], [false, 'unknown_state', 0], `${started} state at the ${wrong} callback`);
    assert.equal((await w.pa.get(stateHashOf(f.state))).phase, 'started', 'not consumed: the right callback still works');
    const ok = await handleCallback({ expectProvider: right, openPending: openPendingByState(w.db, right), tokenUrl: 'https://token.example/token', state: f.state, code: 'c', fetchImpl: async (url) => { calls++; assert.equal(url, 'https://token.example/token', 'a pinned token URL wins over the stored one'); return { ok: true, status: 200, json: async () => ({ access_token: 'x', refresh_token: 'y', expires_in: 60 }) }; } });
    assert.equal(ok.ok, true); assert.equal(calls, 1);
  }
  await assert.rejects(handleCallback({ openPending: async () => null, state: 'A'.repeat(43) }), /expectProvider/);
});
