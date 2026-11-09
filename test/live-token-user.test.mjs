// Gemini Live ephemeral tokens are minted with the signed-in USER'S OWN key (never the platform's), counted per user, and limited per user.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/api-harness.mjs';
import liveToken from '../api/live-token.js';
import health from '../api/health.js';
import { mintVerifiedUid } from '../server/db/verified-uid.js';

const KEY_A = 'AIzaSy-LIVE-KEY-OF-USER-A-0001', KEY_B = 'AIzaSy-LIVE-KEY-OF-USER-B-0002', PLATFORM = 'AIzaSy-PLATFORM-OWNER-KEY-9999';
const fakeRes = () => { const r = { headers: {}, statusCode: 0, body: '' }; r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; }; r.end = (b) => { r.body = b; }; return r; };
const post = async (headers, url = '/api/live-token') => { const res = fakeRes(); await liveToken({ method: 'POST', url, headers: { 'content-type': 'application/json', ...headers }, socket: {}, body: {} }, res); return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }; };

test('the token is minted with the caller\'s own Gemini key; no key of their own -> setup_required and no call at all; the platform key is never used', async () => {
  const h = await startHarness(); process.env.GEMINI_API_KEY = PLATFORM;
  const real = globalThis.fetch, keys = [];
  globalThis.fetch = async (url, init = {}) => {
    const hd = new Headers(init.headers); keys.push(hd.get('x-goog-api-key'));
    return new Response(JSON.stringify({ name: 'auth_tokens/dev-token-' + keys.length }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const a = h.mkUser(), b = h.mkUser(), c = h.mkUser(), hA = await h.bearer(a), hB = await h.bearer(b), hC = await h.bearer(c);
    await h.call('PATCH', '/api/elvar/config', hA, { secrets: { GEMINI_API_KEY: KEY_A } }); await h.call('PATCH', '/api/elvar/config', hB, { secrets: { GEMINI_API_KEY: KEY_B } });
    const ra = await post(hA), rb = await post(hB);
    assert.equal(ra.status, 200, JSON.stringify(ra.body)); assert.match(ra.body.token, /^auth_tokens\//); assert.equal(rb.status, 200);
    assert.deepEqual(keys, [KEY_A, KEY_B], 'each user\'s own key reached Google, nobody else\'s');
    const rc = await post(hC); assert.deepEqual(rc, { status: 503, body: { error: 'setup_required', missing: ['GEMINI_API_KEY'] } });
    assert.equal(keys.length, 2, 'without a key of their own nothing was sent (not even with the platform key)');
    assert.ok(!keys.includes(PLATFORM));
    // metered per user
    const day = new Date().toISOString().slice(0, 10);
    const usage = (uid) => h.db.asUser(mintVerifiedUid(uid, 'test'), (r) => r.usage.daily({ from: day, to: day }));
    assert.deepEqual((await usage(a)).map((x) => [x.metric, x.amount]), [['live_sessions', 1]]); assert.deepEqual(await usage(c), []);
    // the session config is the caller's own persona (instruction text goes into the locked token constraints)
  } finally { globalThis.fetch = real; delete process.env.GEMINI_API_KEY; await h.stop(); }
});

test('at most 30 tokens an hour PER USER: one user hitting the limit does not touch another', async () => {
  const h = await startHarness();
  const real = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ name: 'auth_tokens/t' }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const a = h.mkUser(), b = h.mkUser(), hA = await h.bearer(a), hB = await h.bearer(b);
    for (const hd of [hA, hB]) await h.call('PATCH', '/api/elvar/config', hd, { secrets: { GEMINI_API_KEY: 'AIzaSy-key-' + Math.random() } });
    for (let i = 0; i < 30; i++) assert.equal((await post(hA)).status, 200, 'token ' + (i + 1));
    assert.deepEqual(await post(hA), { status: 429, body: { error: 'rate_limited' } });
    assert.equal((await post(hB)).status, 200, 'B is not affected by A\'s limit');
  } finally { globalThis.fetch = real; await h.stop(); }
});

test('the live-token endpoint needs a login; the health endpoint is public and says nothing about any user or key', async () => {
  const h = await startHarness();
  try {
    assert.equal((await post({})).status, 401);
    const res = fakeRes(); health({ method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, 200); assert.deepEqual(Object.keys(JSON.parse(res.body)).sort(), ['ok', 'version']);
  } finally { await h.stop(); }
});
