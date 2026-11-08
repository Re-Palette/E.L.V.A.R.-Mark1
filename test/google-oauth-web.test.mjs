// Google login inside the app, in VAULT mode, against a real server process and a mock Google (token, revoke and API endpoints).
// The callback arrives with NO device token (the browser comes back from Google): this is the case the old signed-state design could not handle.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { SCOPES, SERVICES } from '../server/google/config.js';
import { redirectUriFor } from '../server/google/connect.js';
import { TOOLS } from '../server/google/tools.js';

// ---------------------------------------------------------------- mock Google
const M = { exchange: 'ok', refresh: 'ok', seen: [], refreshes: [], revokes: [], api: [] };
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const url = new URL(req.url, 'http://x'), p = new URLSearchParams(b), json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/oauth') {
      const f = Object.fromEntries(p);
      if (f.grant_type === 'authorization_code') {
        M.seen.push(f);
        if (M.exchange === 'denied') return json(400, { error: 'invalid_client', error_description: 'Unauthorized' });
        if (M.exchange === 'norefresh') return json(200, { access_token: 'a', expires_in: 3599 });
        return json(200, { access_token: 'ACCESS-0', refresh_token: 'REFRESH-TOKEN-1', expires_in: 3599, scope: M.scope || 'x' });
      }
      M.refreshes.push(f);
      if (M.refresh === 'invalid_grant') return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      return json(200, { access_token: 'ACCESS-' + M.refreshes.length, expires_in: 1 });   // expires at once: every call refreshes
    }
    if (url.pathname === '/revoke') { M.revokes.push(Object.fromEntries(p)); return json(200, {}); }
    M.api.push({ method: req.method, path: url.pathname, auth: req.headers.authorization });
    json(200, { items: [] });
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const reset = () => { Object.assign(M, { exchange: 'ok', refresh: 'ok', scope: '', seen: [], refreshes: [], revokes: [], api: [] }); };

// ---------------------------------------------------------------- server + owner
const PW = 'correct horse battery staple', CODE = 'TEST-CODE-0001', SECRET = 'FAKE-SECRET-vault-mode-secret-9876', CID = '123456789-abcdefg.apps.googleusercontent.com';
const procs = [];
async function boot(extraEnv = {}) {
  const port = 19000 + Math.floor(Math.random() * 900);
  const env = { ...process.env, PORT: String(port), GEMINI_API_KEY: 'x', ELVAR_SETUP_CODE: CODE, GOOGLE_API_MOCK_ORIGIN: `http://127.0.0.1:${mock.address().port}`, ...extraEnv };
  for (const k of ['ELVAR_ACCESS_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'VERCEL']) if (extraEnv[k] === undefined) delete env[k];
  const srv = spawn(process.execPath, ['server/index.js'], { env, stdio: 'ignore' }); procs.push(srv);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { await fetch(`${base}/api/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const claim = await fetch(`${base}/api/elvar/setup/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupCode: CODE, password: PW, deviceName: 'テスト' }) });
  const { token } = await claim.json();
  const call = (method, path, body, tok = token) => fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(tok ? { 'x-elvar-token': tok } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  return { srv, base, port, token, call };
}
// a raw GET (the callback: no token; optionally another Host header)
const get = (s, pathq, host) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: s.port, path: pathq, headers: host ? { host } : {} }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: d })); });
  r.on('error', reject); r.end();
});
const G = '/api/elvar/connect/google';
const configure = (s, extra = {}) => s.call('PATCH', '/api/elvar/config', { secrets: { GOOGLE_CLIENT_SECRET: SECRET }, settings: { GOOGLE_CLIENT_ID: CID, ...extra } });
const startUrl = async (s) => { const r = await s.call('POST', G + '/start', {}); assert.equal(r.status, 200, JSON.stringify(r.body)); return { ...r.body, u: new URL(r.body.url) }; };
const cb = (s, state, code = 'THECODE') => get(s, `/api/google/callback?code=${code}&state=${encodeURIComponent(state)}`);

test('start needs the owner and the saved client id/secret; the authorize URL is correct (PKCE, offline, consent, chosen scopes, fixed redirect URI)', async () => {
  const s = await boot(); reset();
  try {
    for (const [m, p] of [['POST', '/start'], ['POST', '/claim'], ['POST', '/disconnect'], ['GET', '/status']]) {
      assert.equal((await s.call(m, G + p, m === 'POST' ? {} : undefined, '')).status, 401, p);
      assert.equal((await s.call(m, G + p, m === 'POST' ? {} : undefined, s.token.slice(0, -2) + 'AA')).status, 401, p);
    }
    const none = await s.call('POST', G + '/start', {}); assert.equal(none.status, 400); assert.equal(none.body.error, 'client_missing');
    const st0 = await s.call('GET', G + '/status'); assert.equal(st0.body.state, 'unconfigured'); assert.equal(st0.body.redirectUri, `${s.base}/api/google/callback`);
    const saved = await configure(s, { GOOGLE_SERVICES: 'calendar,tasks' }); assert.equal(saved.status, 200);
    assert.equal((await s.call('GET', G + '/status')).body.state, 'client_only');
    const f = await startUrl(s), q = f.u.searchParams;
    assert.equal(f.u.origin + f.u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(q.get('client_id'), CID); assert.equal(q.get('response_type'), 'code'); assert.equal(q.get('access_type'), 'offline'); assert.equal(q.get('prompt'), 'consent');
    assert.deepEqual(q.get('scope').split(' '), ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/tasks']);
    assert.equal(q.get('redirect_uri'), `${s.base}/api/google/callback`); assert.equal(f.redirectUri, `${s.base}/api/google/callback`);
    assert.equal(q.get('code_challenge_method'), 'S256'); assert.match(q.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/); assert.match(q.get('state'), /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!f.url.includes(SECRET) && !f.url.includes('FAKE-SECRET'), 'the client secret never appears in the browser URL');
    assert.equal((await s.call('GET', '/api/elvar/session')).body.google.state, 'client_only');
  } finally { s.srv.kill(); }
});

test('VAULT MODE: the unauthenticated callback exchanges the code on the server; the app claims; the login works; secrets never leave the server', async () => {
  const s = await boot(); reset();
  try {
    await configure(s, { GOOGLE_SERVICES: 'calendar,tasks' });
    const f = await startUrl(s), state = f.u.searchParams.get('state');
    M.scope = 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks';

    const ok = await cb(s, state);   // no x-elvar-token: the browser comes back from Google
    assert.equal(ok.status, 200); assert.match(ok.text, /CONNECTED/);
    assert.equal(ok.headers['cache-control'], 'no-store'); assert.equal(ok.headers['referrer-policy'], 'no-referrer'); assert.match(ok.headers['content-security-policy'], /default-src 'none'/);
    assert.doesNotMatch(ok.text, /REFRESH-TOKEN-1|ACCESS-0|FAKE-SECRET|THECODE/, 'no token, secret or code in the page');
    assert.equal(M.seen.length, 1); const x = M.seen[0];
    assert.equal(x.code, 'THECODE'); assert.equal(x.client_secret, SECRET); assert.equal(x.client_id, CID); assert.equal(x.redirect_uri, `${s.base}/api/google/callback`);
    assert.equal(crypto.createHash('sha256').update(x.code_verifier).digest('base64url'), f.u.searchParams.get('code_challenge'), 'PKCE verifier matches');

    // not connected until the app claims
    assert.equal((await s.call('GET', G + '/status')).body.state, 'client_only');
    // replay / garbage / other hosts: refused, no second exchange
    assert.equal((await cb(s, state)).status, 403); assert.equal(M.seen.length, 1);
    for (const bad of ['', 'x.y', state.slice(0, -2) + 'AA', 'A'.repeat(43)]) assert.equal((await cb(s, bad)).status, 403, bad);
    assert.equal((await get(s, `/api/google/callback?code=c&state=${encodeURIComponent(state)}`, 'evil.example')).status, 403);
    assert.equal(M.seen.length, 1);
    // the callback never redirects anywhere
    assert.equal(ok.headers.location, undefined);

    const c1 = await s.call('POST', G + '/claim', { state }); assert.deepEqual([c1.status, c1.body.ok, c1.body.claimed, c1.body.state], [200, true, true, 'connected']);
    const c2 = await s.call('POST', G + '/claim', { state }); assert.deepEqual([c2.body.claimed, c2.body.state], [false, 'connected'], 'claiming twice is harmless');
    assert.equal((await s.call('POST', G + '/claim', { state: 'nope' })).status, 400);

    const st = (await s.call('GET', G + '/status?probe=1')).body;
    assert.equal(st.state, 'connected'); assert.equal(st.authenticated, true); assert.equal(st.source, 'app'); assert.equal(st.selectionApplied, true);
    assert.deepEqual(st.services.map((v) => v.id), ['calendar', 'tasks']); assert.ok(st.connectedAt > 0 && st.verifiedAt > 0);
    assert.ok(st.tools > 0 && st.tools < TOOLS.length, 'tools are filtered by the granted scopes');

    // the stored login drives the tools: refresh token -> access token -> API (calendar is granted, Gmail is not)
    const exec = (tool, args = {}, ticket) => s.call('POST', '/api/google/execute', { tool, args, ticket });
    M.refreshes.length = 0; M.api.length = 0;
    const cal = await exec('calendar_list_events'); assert.equal(cal.status, 200, JSON.stringify(cal.body));
    assert.equal(M.refreshes[0].refresh_token, 'REFRESH-TOKEN-1'); assert.equal(M.refreshes[0].client_secret, SECRET);
    assert.match(M.api.at(-1).path, /^\/calendar\//); assert.match(M.api.at(-1).auth, /^Bearer ACCESS-\d+$/);
    const mail = await exec('gmail_search', { query: 'x' }); assert.equal(mail.status, 403); assert.match(mail.body.error, /Gmail/);
    // approval cards keep working exactly as before: a write without a ticket only previews
    const pre = await exec('calendar_delete_event', { eventId: 'e1' }); assert.equal(pre.body.needsApproval, true); assert.ok(pre.body.ticket);
    assert.equal(M.api.filter((a) => a.method === 'DELETE').length, 0, 'nothing is deleted before the owner approves');
    assert.equal((await exec('calendar_delete_event', { eventId: 'OTHER' }, pre.body.ticket)).status, 403, 'a ticket only covers the exact args that were approved');
    assert.equal((await exec('calendar_delete_event', { eventId: 'e1' }, pre.body.ticket)).status, 200);
    assert.equal(M.api.filter((a) => a.method === 'DELETE').length, 1);

    const everything = JSON.stringify([st, c1.body, (await s.call('GET', '/api/elvar/config')).body, (await s.call('GET', '/api/elvar/session')).body]) + ok.text;
    assert.ok(!/REFRESH-TOKEN-1|ACCESS-|FAKE-SECRET|vault-mode-secret/.test(everything), 'no response carries a token or the client secret');
  } finally { s.srv.kill(); }
});

test('invalid_grant (revoked, or a "Testing" token after 7 days): marked reauth_required once, tools stop calling Google, reconnecting clears it', async () => {
  const s = await boot(); reset();
  try {
    await configure(s);
    const connect = async () => { const f = await startUrl(s), state = f.u.searchParams.get('state'); assert.equal((await cb(s, state)).status, 200); return (await s.call('POST', G + '/claim', { state })).body; };
    M.scope = SCOPES.join(' ');
    assert.equal((await connect()).state, 'connected');
    M.refresh = 'invalid_grant'; M.refreshes.length = 0;
    const r1 = await s.call('POST', '/api/google/execute', { tool: 'calendar_list_events', args: {} });
    assert.equal(r1.status, 401); assert.match(r1.body.error, /Googleと連携/);
    assert.equal(M.refreshes.length, 1);
    const st = (await s.call('GET', G + '/status')).body; assert.equal(st.state, 'reauth_required'); assert.equal(st.reauthReason, 'invalid_grant');
    assert.equal((await s.call('GET', '/api/elvar/session')).body.google.state, 'reauth_required', 'the app shows the reconnect prompt from the session');
    const r2 = await s.call('POST', '/api/google/execute', { tool: 'calendar_list_events', args: {} });
    assert.equal(r2.status, 401); assert.equal(r2.body.reauthRequired, true); assert.equal(M.refreshes.length, 1, 'Google is not asked again');
    M.refresh = 'ok';
    assert.equal((await connect()).state, 'connected', 'connecting again clears it');
    assert.equal((await s.call('POST', '/api/google/execute', { tool: 'calendar_list_events', args: {} })).status, 200);
  } finally { s.srv.kill(); }
});

test('changing the client id after connecting asks for a reconnect (a login belongs to the client it was issued for)', async () => {
  const s = await boot(); reset();
  try {
    await configure(s); const f = await startUrl(s), state = f.u.searchParams.get('state'); M.scope = SCOPES.join(' ');
    await cb(s, state); await s.call('POST', G + '/claim', { state });
    assert.equal((await s.call('GET', G + '/status')).body.state, 'connected');
    await s.call('PATCH', '/api/elvar/config', { settings: { GOOGLE_CLIENT_ID: '999-other.apps.googleusercontent.com' } });
    assert.equal((await s.call('GET', G + '/status')).body.state, 'reauth_required');
  } finally { s.srv.kill(); }
});

test('disconnect: revokes at Google and removes the login from the vault', async () => {
  const s = await boot(); reset();
  try {
    await configure(s); const f = await startUrl(s), state = f.u.searchParams.get('state'); M.scope = SCOPES.join(' ');
    await cb(s, state); await s.call('POST', G + '/claim', { state });
    const d = await s.call('POST', G + '/disconnect', {}); assert.deepEqual([d.status, d.body.ok, d.body.revoked, d.body.disconnected], [200, true, true, true]);
    assert.deepEqual(M.revokes, [{ token: 'REFRESH-TOKEN-1' }]);
    assert.equal((await s.call('GET', G + '/status')).body.state, 'client_only');
    assert.equal((await s.call('POST', '/api/google/execute', { tool: 'calendar_list_events', args: {} })).status, 503);
    assert.equal((await s.call('POST', G + '/disconnect', {})).body.disconnected, false, 'nothing left to disconnect');
    assert.equal(M.revokes.length, 1);
  } finally { s.srv.kill(); }
});

test('Google problems are reported to the app: refused (invalid_client), denied on the consent screen, no refresh token', async () => {
  const s = await boot(); reset();
  try {
    await configure(s);
    const run = async (mode, query) => {
      M.exchange = mode; const f = await startUrl(s), state = f.u.searchParams.get('state');
      const page = await get(s, `/api/google/callback?${query ?? 'code=c'}&state=${encodeURIComponent(state)}`);
      return { page, claim: (await s.call('POST', G + '/claim', { state })).body };
    };
    let r = await run('denied'); assert.equal(r.page.status, 400); assert.match(r.page.text, /ウェブ アプリケーション/); assert.equal(r.claim.ok, false); assert.match(r.claim.message, /invalid_client/);
    r = await run('norefresh'); assert.match(r.page.text, /permissions/); assert.match(r.claim.message, /permissions/);
    r = await run('ok', 'error=access_denied'); assert.equal(r.page.status, 400); assert.match(r.page.text, /許可されませんでした/); assert.match(r.claim.message, /許可されませんでした/);
    assert.equal((await s.call('GET', G + '/status')).body.state, 'client_only');
    const html = (await run('ok', 'error=%3Cscript%3Ealert(1)%3C%2Fscript%3E')).page.text; assert.doesNotMatch(html, /<script>alert/);
  } finally { s.srv.kill(); }
});

test('redirect URI comes from configuration, not from the request Host', async () => {
  const req = (host, extra = {}) => ({ headers: { host, ...extra } });
  // local: loopback only
  assert.equal(redirectUriFor(req('localhost:8787'), {}).uri, 'http://localhost:8787/api/google/callback');
  assert.equal(redirectUriFor(req('127.0.0.1:19000'), {}).uri, 'http://127.0.0.1:19000/api/google/callback');
  assert.equal(redirectUriFor(req('evil.example'), {}).ok, false);
  assert.equal(redirectUriFor(req('evil.example', { 'x-forwarded-host': 'evil.example' }), {}).ok, false);
  // a configured public origin wins over any Host; it must be https (or loopback)
  assert.equal(redirectUriFor(req('evil.example'), { ELVAR_PUBLIC_ORIGIN: 'https://elvar.example.com/' }).uri, 'https://elvar.example.com/api/google/callback');
  assert.equal(redirectUriFor(req('localhost:1'), { ELVAR_PUBLIC_ORIGIN: 'http://elvar.example.com' }).ok, false);
  assert.equal(redirectUriFor(req('x'), { ELVAR_PUBLIC_ORIGIN: 'https://user:pw@evil.example' }).ok, false);
  assert.equal(redirectUriFor(req('x'), { ELVAR_PUBLIC_ORIGIN: 'javascript:alert(1)' }).ok, false);
  // Vercel: the deployment's own hosts only; anything else falls back to the production URL
  const V = { VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'my-elvar.vercel.app', VERCEL_URL: 'my-elvar-abc123.vercel.app', VERCEL_BRANCH_URL: 'my-elvar-git-main.vercel.app' };
  assert.equal(redirectUriFor(req('my-elvar.vercel.app'), V).uri, 'https://my-elvar.vercel.app/api/google/callback');
  assert.equal(redirectUriFor(req('MY-ELVAR-abc123.vercel.app'), V).uri, 'https://my-elvar-abc123.vercel.app/api/google/callback');
  assert.equal(redirectUriFor(req('evil.example', { 'x-forwarded-host': 'evil.example' }), V).uri, 'https://my-elvar.vercel.app/api/google/callback', 'a spoofed Host cannot choose the redirect URI');
  assert.equal(redirectUriFor(req('evil.example'), { VERCEL: '1', VERCEL_URL: 'x-1.vercel.app' }).uri === undefined, true, 'no production URL known and a foreign Host: refused');
  // and the server really refuses to start a flow for a foreign Host
  const s = await boot(); reset();
  try {
    await configure(s);
    const r = await new Promise((resolve, reject) => { const q = http.request({ host: '127.0.0.1', port: s.port, path: G + '/start', method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json', 'x-elvar-token': s.token } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) })); }); q.on('error', reject); q.end('{}'); });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'origin_unknown'); assert.equal(r.body.url, undefined);
  } finally { s.srv.kill(); }
});

test('every product has a full and a read-only scope, and SCOPES lists the full ones', () => {
  assert.deepEqual(SCOPES, SERVICES.map((v) => v.write));
  for (const v of SERVICES) { assert.match(v.write, /^https:\/\/www\.googleapis\.com\/auth\//); assert.match(v.read, /^https:\/\/www\.googleapis\.com\/auth\//); }
  assert.equal(SERVICES.length, 7);
});

test.after(() => { for (const p of procs) p.kill(); mock.close(); });
