// Google per user (docs/ELVAR_MULTIUSER.md 8.3, decision O2): every user enters their OWN OAuth client id / secret, connects in their own consent flow, and their refresh token is
// sealed under THEIR data key in THEIR row. Through the real router with MemoryDb, two signed-in users and a mock Google server (token, revoke and API endpoints):
// the consent URL, the token-less callback that binds the result to the user who started it, the claim, scope selection and the tools it allows, invalid_grant -> a flag for
// that user only, client change, disconnect (revoke at Google), DEK rotation, and that nothing of A is ever used for B.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startHarness } from './helpers/api-harness.mjs';
import { authenticate } from '../server/auth/with-user.js';
import { runWithConfig } from '../server/config/resolve.js';
import { executeTool } from '../server/tools/execute.js';
import { declarations, googleConfigured } from '../server/google/index.js';
import { getKeyring } from '../server/auth/keyring.js';
import { mintVerifiedUid } from '../server/db/verified-uid.js';
import { resetTokenCache } from '../server/google/http.js';

const G = '/api/elvar/connect/google';
const ORIGIN = 'https://elvar.example.test';
const CAL = 'https://www.googleapis.com/auth/calendar', CALRO = 'https://www.googleapis.com/auth/calendar.readonly', GML = 'https://www.googleapis.com/auth/gmail.modify';
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

/** A mock Google: /oauth (authorization_code + refresh_token), /revoke, and a calendar list that says whose token it saw. */
async function startGoogle() {
  const st = { calls: [], revoked: [], refused: new Set(), grants: new Map() };   // grants: refresh token -> { clientId, scope }
  let n = 0;
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), raw = await body(req), f = new URLSearchParams(raw);
    st.calls.push({ method: req.method, path: url.pathname, form: Object.fromEntries(f), auth: req.headers.authorization });
    const send = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/oauth') {
      if (f.get('grant_type') === 'authorization_code') {
        const rt = `RT-${f.get('client_id')}-${++n}`, scope = st.scopeFor?.(f.get('client_id')) ?? `${CAL} ${GML}`;
        st.grants.set(rt, { clientId: f.get('client_id'), scope, secret: f.get('client_secret') }); return send({ access_token: 'AT0', refresh_token: rt, expires_in: 3600, scope });
      }
      const g = st.grants.get(f.get('refresh_token'));
      if (!g || st.refused.has(f.get('refresh_token')) || g.clientId !== f.get('client_id') || g.secret !== f.get('client_secret')) return send({ error: 'invalid_grant' }, 400);
      return send({ access_token: `AT-for-${f.get('refresh_token')}`, expires_in: 3600 });
    }
    if (url.pathname === '/revoke') { st.revoked.push(f.get('token')); st.grants.delete(f.get('token')); return send({}); }
    if (url.pathname === '/calendar/calendars/primary/events') return send({ items: [{ id: 'e1', summary: `event seen with ${req.headers.authorization}`, start: { dateTime: '2026-11-02T10:00:00+09:00' }, end: { dateTime: '2026-11-02T11:00:00+09:00' } }] });
    send({ error: { message: 'nope' } }, 404);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { st, origin: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections?.(); return new Promise((r) => srv.close(r)); } };
}

async function withWorld(fn) {
  const h = await startHarness(), g = await startGoogle(), saved = { o: process.env.ELVAR_PUBLIC_ORIGIN, d: process.env.ELVAR_DEV_AUTH, m: process.env.GOOGLE_API_MOCK_ORIGIN };
  Object.assign(process.env, { ELVAR_PUBLIC_ORIGIN: ORIGIN, ELVAR_DEV_AUTH: '1', GOOGLE_API_MOCK_ORIGIN: g.origin }); resetTokenCache();
  const logs = []; const real = { l: console.log, e: console.error }; console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  try {
    const a = h.mkUser('a@example.test'), b = h.mkUser('b@example.test'), A = await h.bearer(a), B = await h.bearer(b);
    const as = (hd, uid) => ({ uid, hd, call: (m, p, bd, q) => h.call(m, p, hd, bd, q),
      async inCfg(f2) { const r = await authenticate('user', { headers: hd, socket: { remoteAddress: '203.0.113.7' } }); assert.ok(r.ok); await r.ctx.loadConfig({ fresh: true }); return runWithConfig(r.ctx.cfg, () => f2(r.ctx.cfg)); },
      run: (tool, args, ticket) => as(hd, uid).inCfg(() => executeTool({ tool, args, ticket })),
      configure: (client, secret, settings = {}) => h.call('PATCH', '/api/elvar/config', hd, { settings: { GOOGLE_CLIENT_ID: client, ...settings }, secrets: { GOOGLE_CLIENT_SECRET: secret } }),
      /** the whole consent flow: start, (Google redirects the browser back with no token), claim */
      async connect(callbackQuery = {}) {
        const st = (await h.call('POST', `${G}/start`, hd, {})).body; assert.ok(st.state, JSON.stringify(st));
        const cb = await h.call('GET', '/api/google/callback', {}, {}, { state: st.state, code: 'the-code', ...callbackQuery });
        return { st, cb, claim: () => h.call('POST', `${G}/claim`, hd, { state: st.state }) };
      } });
    return await fn({ h, g, a, b, A: as(A, a), B: as(B, b), logs, uid: (u) => mintVerifiedUid(u, 'test') });
  } finally {
    Object.assign(console, { log: real.l, error: real.e });
    for (const [k, v] of Object.entries({ ELVAR_PUBLIC_ORIGIN: saved.o, ELVAR_DEV_AUTH: saved.d, GOOGLE_API_MOCK_ORIGIN: saved.m })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await g.close(); await h.stop(); resetTokenCache();
  }
}

test('every user connects with THEIR OWN client: the consent URL carries their client id, PKCE, the platform\'s single redirect URI and their product choice; nothing is shared', () => withWorld(async ({ A, B, g }) => {
  assert.equal((await A.call('GET', `${G}/status`)).body.state, 'unconfigured');
  assert.equal((await A.call('POST', `${G}/start`, {})).body.error, 'client_missing', 'no client of their own, no flow (there is no platform client to fall back to)');
  await A.configure('a-client-0001.apps.example', 'a-secret-aaaaaaaa', { GOOGLE_SERVICES: 'calendar,gmail' }); await B.configure('b-client-0002.apps.example', 'b-secret-bbbbbbbb', { GOOGLE_SERVICES: 'calendar', GOOGLE_READONLY: '1' });
  const sa = (await A.call('GET', `${G}/status`)).body; assert.deepEqual([sa.state, sa.clientIdSet, sa.clientSecretSet, sa.redirectUri], ['client_only', true, true, ORIGIN + '/api/google/callback']);
  const ua = new URL((await A.call('POST', `${G}/start`, {})).body.url), ub = new URL((await B.call('POST', `${G}/start`, {})).body.url);
  assert.equal(ua.origin + ua.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual([ua.searchParams.get('client_id'), ua.searchParams.get('redirect_uri'), ua.searchParams.get('code_challenge_method'), ua.searchParams.get('access_type'), ua.searchParams.get('scope')], ['a-client-0001.apps.example', ORIGIN + '/api/google/callback', 'S256', 'offline', `${CAL} ${GML}`]);
  assert.deepEqual([ub.searchParams.get('client_id'), ub.searchParams.get('scope')], ['b-client-0002.apps.example', CALRO], 'B chose calendar, read-only');
  assert.ok(!ua.toString().includes('a-secret-aaaaaaaa'), 'the client secret never goes to the browser'); assert.notEqual(ua.searchParams.get('state'), ub.searchParams.get('state'));
  assert.equal(g.st.calls.length, 0, 'starting talks to nobody');
}));

test('the callback has no token: it finds the flow by the single-use state, exchanges the code with the user\'s own client, and the result can only be claimed by the user who started it', () => withWorld(async ({ A, B, h, g, a, uid }) => {
  await A.configure('a-client-0001.apps.example', 'a-secret-aaaaaaaa'); await B.configure('b-client-0002.apps.example', 'b-secret-bbbbbbbb');
  const fa = await A.connect(); assert.equal(fa.cb.status, 200); assert.match(fa.cb.html, /CONNECTED/); assert.ok(!fa.cb.html.includes('the-code') && !fa.cb.html.includes('RT-'), 'no code or token in the page');
  assert.equal(fa.cb.headers['content-security-policy'].includes("default-src 'none'"), true);
  const ex = g.st.calls.find((c) => c.form.grant_type === 'authorization_code'); assert.deepEqual([ex.form.client_id, ex.form.client_secret, ex.form.code, ex.form.redirect_uri], ['a-client-0001.apps.example', 'a-secret-aaaaaaaa', 'the-code', ORIGIN + '/api/google/callback']); assert.ok(ex.form.code_verifier.length >= 43);
  assert.equal((await h.call('GET', '/api/google/callback', {}, {}, { state: fa.st.state, code: 'again' })).status, 403, 'the state is single use');
  // B knows A's state (it leaked) and claims: nothing is bound to B
  const stolen = await h.call('POST', `${G}/claim`, B.hd, { state: fa.st.state }); assert.equal(stolen.body.claimed, false);
  assert.equal((await B.call('GET', `${G}/status`)).body.state, 'client_only', 'B is still not connected');
  // before A claims, A has no token row; after, it is sealed
  assert.deepEqual(await h.db.asUser(uid(a), (r) => r.oauthTokens.list()), []);
  const c = await fa.claim(); assert.deepEqual([c.body.ok, c.body.claimed, c.body.state], [true, true, 'connected']);
  const row = await h.db.asUser(uid(a), (r) => r.oauthTokens.get('google')); assert.ok(!row.ct.includes(Buffer.from('RT-a-client')), 'sealed, not readable'); assert.deepEqual(row.scopes, [CAL, GML]); assert.equal(row.revokeUrl, g.origin + '/revoke');
  assert.equal((await fa.claim()).body.claimed, false, 'claimed once');
  // a refused / denied flow is reported to its own user
  const den = await B.connect({ code: '', error: 'access_denied' }); assert.equal(den.cb.status, 400); const dc = await den.claim(); assert.deepEqual([dc.body.ok, dc.body.error], [false, 'access_denied']); assert.match(dc.body.message, /許可/);
  // a foreign provider's flow cannot be claimed as a Google login (an MCP flow and a Google flow share the pending table)
  assert.equal((await h.call('GET', '/api/google/callback', {}, {}, { state: 'A'.repeat(43), code: 'x' })).status, 403);
  assert.equal((await h.call('GET', '/api/google/callback', {}, {}, { state: 'short' })).status, 403);
}));

test('status shows only the caller\'s own connection: granted products, tools by scope; the tools offered to the model follow the scopes the user granted', () => withWorld(async ({ A, B, g }) => {
  g.st.scopeFor = (cid) => (cid.startsWith('a-') ? `${CAL} https://www.googleapis.com/auth/tasks.readonly` : `${CAL} ${GML}`);
  await A.configure('a-client-0001.apps.example', 'a-secret-aaaaaaaa'); await B.configure('b-client-0002.apps.example', 'b-secret-bbbbbbbb');
  await (await A.connect()).claim(); assert.equal((await B.call('GET', `${G}/status`)).body.connected, undefined);
  const sa = (await A.call('GET', `${G}/status`)).body;
  assert.deepEqual([sa.state, sa.configured, sa.source, sa.services.map((s) => [s.id, s.write])], ['connected', true, 'app', [['calendar', true], ['tasks', false]]]);
  assert.ok(sa.tools > 0 && sa.write > 0);
  // what the Live token / chat offer: the always-on tools only until the user is connected (live-token-core.js, chat-api.js), then the granted products
  const namesOf = (u) => u.inCfg(() => declarations({ alwaysOnly: !googleConfigured() }).map((d) => d.name));
  const na = await namesOf(A); assert.ok(na.includes('calendar_create_event') && na.includes('tasks_list') && !na.includes('tasks_create') && !na.some((x) => /^(gmail|drive)_/.test(x)));
  const nb0 = await namesOf(B); assert.ok(!nb0.some((x) => /^(calendar|gmail|drive)_/.test(x)), 'B has not connected: no Google tool is offered (and A\'s are not B\'s)'); assert.equal(await B.inCfg(() => googleConfigured()), false); assert.equal(await A.inCfg(() => googleConfigured()), true);
  assert.equal((await B.run('calendar_list_events', {})).status, 503); assert.match((await B.run('calendar_list_events', {})).body.error, /連携していません/);
  const refused = await A.run('gmail_search', { query: 'x' }); assert.equal(refused.status, 403); assert.match(refused.body.error, /Gmail.*許可されていません/);
  assert.equal((await A.run('tasks_create', { title: 'x' })).status, 403, 'tasks were granted read-only: writes are refused');
  const sb = await (await B.connect()).claim(); assert.equal(sb.body.claimed, true);
  const nb = await namesOf(B); assert.ok(nb.includes('gmail_send') && nb.includes('calendar_create_event'));
  assert.ok(!(await namesOf(A)).includes('gmail_send'), 'and B\'s grant did not widen A\'s');
}));

test('tool calls use THEIR OWN login: A\'s refresh token and client never serve B (and the access token cache is per user)', () => withWorld(async ({ A, B, g }) => {
  await A.configure('a-client-0001.apps.example', 'a-secret-aaaaaaaa'); await B.configure('b-client-0002.apps.example', 'b-secret-bbbbbbbb');
  await (await A.connect()).claim(); await (await B.connect()).claim();
  const ra = await A.run('calendar_list_events', {}), rb = await B.run('calendar_list_events', {});
  assert.equal(ra.status, 200, JSON.stringify(ra.body)); assert.equal(rb.status, 200, JSON.stringify(rb.body));
  assert.match(JSON.stringify(ra.body), /AT-for-RT-a-client-0001/); assert.match(JSON.stringify(rb.body), /AT-for-RT-b-client-0002/); assert.ok(!JSON.stringify(rb.body).includes('RT-a-client'));
  const refreshes = g.st.calls.filter((c) => c.form.grant_type === 'refresh_token');
  assert.deepEqual(refreshes.map((r) => [r.form.client_id, r.form.refresh_token.slice(0, 12)]).sort(), [['a-client-0001.apps.example', 'RT-a-client-'], ['b-client-0002.apps.example', 'RT-b-client-']]);
  await A.run('calendar_list_events', {}); assert.equal(g.st.calls.filter((c) => c.form.grant_type === 'refresh_token').length, 2, 'the access token is cached per user: no second refresh');
}));

test('invalid_grant flags the reconnect for THAT user only; the client id changing does too; reconnecting clears it', () => withWorld(async ({ A, B, g, h, a, b, uid }) => {
  await A.configure('a-client-0001.apps.example', 'a-secret-aaaaaaaa'); await B.configure('b-client-0002.apps.example', 'b-secret-bbbbbbbb');
  await (await A.connect()).claim(); await (await B.connect()).claim();
  g.st.refused.add([...g.st.grants.keys()].find((k) => k.startsWith('RT-a-client')));   // Google refuses A's refresh token (revoked, or a 7-day "Testing" token)
  const r = await A.run('calendar_list_events', {}); assert.equal(r.status, 401); assert.equal(r.body.error.includes('接続が切れました'), true);
  assert.equal((await A.call('GET', `${G}/status`)).body.state, 'reauth_required'); assert.equal((await h.db.asUser(uid(a), (x) => x.oauthTokens.get('google'))).status, 'reauth_required');
  assert.equal((await A.run('calendar_list_events', {})).body.reauthRequired, true, 'later calls do not ask Google again');
  assert.equal((await B.call('GET', `${G}/status`)).body.state, 'connected', 'B is unaffected'); assert.equal((await B.run('calendar_list_events', {})).status, 200); assert.equal((await h.db.asUser(uid(b), (x) => x.oauthTokens.get('google'))).status, 'ok');
  assert.equal((await A.call('GET', '/api/elvar/session')).body.google.state, 'reauth_required', 'the session tells the app to ask the user to connect again');
  await (await A.connect()).claim(); assert.equal((await A.call('GET', `${G}/status`)).body.state, 'connected'); assert.equal((await A.run('calendar_list_events', {})).status, 200);
  await A.configure('a-other-client-3.apps.example', 'a-secret-aaaaaaaa'); const s = (await A.call('GET', `${G}/status`)).body;
  assert.deepEqual([s.state, s.reauthReason], ['reauth_required', 'client_changed'], 'a login belongs to the client it was issued for');
}));

test('disconnect revokes at Google and deletes the token; only the caller\'s own; the account export lists the connection without the token', () => withWorld(async ({ A, B, g, h, a, uid }) => {
  await A.configure('a-client-0001.apps.example', 'a-secret-aaaaaaaa'); await B.configure('b-client-0002.apps.example', 'b-secret-bbbbbbbb');
  await (await A.connect()).claim(); await (await B.connect()).claim();
  const ex = (await A.call('GET', '/api/elvar/account/export')).body; assert.deepEqual(ex.files['connections.json'].connections.map((c) => [c.provider, c.status]), [['google', 'ok']]); assert.ok(!JSON.stringify(ex).includes('RT-a-client') && !JSON.stringify(ex).includes('a-secret-aaaaaaaa'));
  const d = await A.call('POST', `${G}/disconnect`, {}); assert.deepEqual([d.body.ok, d.body.revoked, d.body.disconnected], [true, true, true]);
  assert.deepEqual(g.st.revoked.map((t) => t.slice(0, 12)), ['RT-a-client-'], 'only A\'s token was revoked at Google');
  assert.equal(await h.db.asUser(uid(a), (r) => r.oauthTokens.get('google')), null); assert.equal((await A.call('GET', `${G}/status`)).body.state, 'client_only');
  assert.equal((await B.run('calendar_list_events', {})).status, 200, 'B is still connected');
  assert.deepEqual((await A.call('POST', `${G}/disconnect`, {})).body, { ok: true, revoked: false, disconnected: false });
}));

test('DEK rotation re-encrypts the Google token and the MCP tokens with the new key; the login keeps working', () => withWorld(async ({ A, h, a, uid }) => {
  await A.configure('a-client-0001.apps.example', 'a-secret-aaaaaaaa'); await (await A.connect()).claim();
  const before = await h.db.asUser(uid(a), (r) => r.oauthTokens.get('google'));
  const res = await h.db.asUser(uid(a), (r) => getKeyring().rotateDek(r)); assert.ok(res.reencrypted >= 2 && res.dekVer === 2);
  const after = await h.db.asUser(uid(a), (r) => r.oauthTokens.get('google')); assert.equal(after.dekVer, 2); assert.ok(!after.ct.equals(before.ct), 'a new ciphertext under the new key');
  assert.equal((await A.run('calendar_list_events', {})).status, 200); assert.match(JSON.stringify((await A.run('calendar_list_events', {})).body), /AT-for-RT-a-client/);
}));

test('nothing secret is logged: codes, tokens and client secrets never reach the console', () => withWorld(async ({ A, logs }) => {
  await A.configure('a-client-0001.apps.example', 'a-secret-aaaaaaaa'); await (await A.connect()).claim(); await A.run('calendar_list_events', {}); await A.call('POST', `${G}/disconnect`, {});
  const text = logs.join('\n'); for (const s of ['a-secret-aaaaaaaa', 'the-code', 'RT-a-client', 'AT-for-']) assert.ok(!text.includes(s), s);
  assert.match(text, /google-connected/); assert.match(text, /google-disconnected/);
}));

test('there is no platform Google client or login: Google variables in the server environment never serve a user (decision O2)', () => withWorld(async ({ A, B }) => {
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'platform-client.apps.example', GOOGLE_CLIENT_SECRET: 'platform-secret', GOOGLE_REFRESH_TOKEN: 'platform-refresh' });
  try {
    for (const u of [A, B]) {
      const s = (await u.call('GET', `${G}/status`)).body; assert.deepEqual([s.state, s.clientIdSet, s.clientSecretSet, s.configured, s.source], ['unconfigured', false, false, false, 'none']);
      assert.equal((await u.call('POST', `${G}/start`, {})).body.error, 'client_missing'); assert.equal((await u.run('calendar_list_events', {})).status, 503);
      assert.equal(await u.inCfg(() => googleConfigured()), false);
    }
    assert.equal((await A.call('GET', '/api/elvar/config')).body.settings.GOOGLE_CLIENT_ID.value, '', 'the platform value is not shown as the user\'s');
  } finally { for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']) delete process.env[k]; }
}));

test('the callback and the claim are rate limited; a state of nobody\'s answers a plain page without touching any user', () => withWorld(async ({ h }) => {
  let last;
  for (let i = 0; i < 31; i++) last = await h.call('GET', '/api/google/callback', {}, {}, { state: 'B'.repeat(43), code: 'x' });
  assert.equal(last.status, 429); assert.match(last.html, /多すぎ/);
}));
