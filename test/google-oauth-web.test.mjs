// In-browser Google login (no Node on the owner's PC). Mock Google token endpoint; real server process.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { SCOPES } from '../server/google/config.js';
import { signState, verifyState } from '../server/google/ticket.js';

let mode = 'ok';
const seen = [];
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const p = new URLSearchParams(b); seen.push(Object.fromEntries(p));
    res.writeHead(mode === 'denied' ? 400 : 200, { 'content-type': 'application/json' });
    if (mode === 'denied') return res.end(JSON.stringify({ error: 'invalid_client', error_description: 'Unauthorized' }));
    if (mode === 'norefresh') return res.end(JSON.stringify({ access_token: 'a' }));
    res.end(JSON.stringify({ access_token: 'a', refresh_token: mode === 'xss' ? '<script>alert(1)</script>"' : 'REFRESH-TOKEN-1', scope: 'x y z' }));
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));

async function startServer(extraEnv) {
  const port = 19000 + Math.floor(Math.random() * 900);
  const env = { ...process.env, PORT: String(port), GEMINI_API_KEY: 'x', ELVAR_ACCESS_TOKEN: 'web-secret', GOOGLE_API_MOCK_ORIGIN: `http://127.0.0.1:${mock.address().port}`, ...extraEnv };
  for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']) if (extraEnv[k] === undefined) delete env[k];
  const srv = spawn(process.execPath, ['server/index.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/api/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  return { srv, port, base: `http://127.0.0.1:${port}` };
}
const connect = (s, hdr = { 'x-elvar-token': 'web-secret' }) => fetch(`${s.base}/api/google/connect`, { method: 'POST', headers: hdr });
const get = (s, pathq, host) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: s.port, path: pathq, headers: host ? { host } : {} }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: d })); });
  r.on('error', reject); r.end();
});

test('connect: needs the access token, and the client id/secret on the server', async () => {
  const s = await startServer({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec' });
  const none = await startServer({});
  try {
    assert.equal((await connect(s, {})).status, 401);
    assert.equal((await connect(s, { 'x-elvar-token': 'nope' })).status, 401);
    assert.equal((await fetch(`${s.base}/api/google/connect`, { headers: { 'x-elvar-token': 'web-secret' } })).status, 405, 'GET is not allowed');
    const r = await connect(none); assert.equal(r.status, 503); assert.match((await r.json()).error, /GOOGLE_CLIENT_ID/);
    const ok = await connect(s); assert.equal(ok.status, 200);
    const j = await ok.json(); const u = new URL(j.url);
    assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(u.searchParams.get('client_id'), 'cid'); assert.equal(u.searchParams.get('access_type'), 'offline'); assert.equal(u.searchParams.get('prompt'), 'consent');
    assert.deepEqual(u.searchParams.get('scope').split(' '), SCOPES);
    assert.equal(u.searchParams.get('redirect_uri'), `${s.base}/api/google/callback`); assert.equal(j.redirectUri, `${s.base}/api/google/callback`);
    assert.ok(u.searchParams.get('state')); assert.ok(!j.url.includes('csec'), 'the client secret must never be in the browser URL');
  } finally { s.srv.kill(); none.srv.kill(); }
});

test('callback: exchanges the code on the server, shows the token once, refuses replay / tamper / wrong host', async () => {
  const s = await startServer({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec' });
  try {
    mode = 'ok'; seen.length = 0;
    const state = new URL((await (await connect(s)).json()).url).searchParams.get('state');
    const ok = await get(s, `/api/google/callback?code=THECODE&state=${encodeURIComponent(state)}`);
    assert.equal(ok.status, 200); assert.match(ok.text, /REFRESH-TOKEN-1/); assert.equal(ok.headers['cache-control'], 'no-store'); assert.equal(ok.headers['referrer-policy'], 'no-referrer');
    assert.equal(seen.length, 1); assert.equal(seen[0].grant_type, 'authorization_code'); assert.equal(seen[0].code, 'THECODE'); assert.equal(seen[0].client_secret, 'csec'); assert.equal(seen[0].redirect_uri, `${s.base}/api/google/callback`);
    // replay of the same state
    const replay = await get(s, `/api/google/callback?code=THECODE&state=${encodeURIComponent(state)}`);
    assert.equal(replay.status, 403); assert.doesNotMatch(replay.text, /REFRESH-TOKEN-1/); assert.equal(seen.length, 1, 'no second exchange');
    // tampered / missing / forged state
    for (const bad of ['', 'x.y', state.slice(0, -2) + 'AA']) assert.equal((await get(s, `/api/google/callback?code=c&state=${encodeURIComponent(bad)}`)).status, 403);
    // a valid state used from a different host (open-redirect style abuse) is refused
    const st2 = new URL((await (await connect(s)).json()).url).searchParams.get('state');
    assert.equal((await get(s, `/api/google/callback?code=c&state=${encodeURIComponent(st2)}`, 'evil.example')).status, 403);
    assert.equal(seen.length, 1, 'nothing was exchanged for the refused attempts');
  } finally { s.srv.kill(); }
});

test('callback: friendly messages and safe HTML', async () => {
  const s = await startServer({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec' });
  try {
    const fresh = async () => encodeURIComponent(new URL((await (await connect(s)).json()).url).searchParams.get('state'));
    mode = 'norefresh'; assert.match((await get(s, `/api/google/callback?code=c&state=${await fresh()}`)).text, /permissions/);
    mode = 'denied'; const d = await get(s, `/api/google/callback?code=c&state=${await fresh()}`); assert.equal(d.status, 400); assert.match(d.text, /ウェブ アプリケーション/);
    mode = 'xss'; const x = await get(s, `/api/google/callback?code=c&state=${await fresh()}`); assert.doesNotMatch(x.text, /<script>alert/); assert.match(x.text, /&lt;script&gt;/);
    const denied = await get(s, `/api/google/callback?error=access_denied`); assert.match(denied.text, /許可されませんでした/);
  } finally { s.srv.kill(); mode = 'ok'; }
});

test('state: expiry and single use (unit)', () => {
  const st = signState('http://x/api/google/callback', Date.now() - 700_000);
  assert.equal(verifyState(st).ok, false);
  const fresh = signState('http://x/api/google/callback');
  assert.equal(verifyState(fresh).ok, true); assert.equal(verifyState(fresh).ok, false);
});

test.after(() => mock.close());
