// The local development login (server/dev/fake-auth.js): impossible to enable in production, and faithful enough to carry the whole sign-up -> session flow
// through the REAL token verification and the REAL router.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { devAuthEnabled, assertDevAuthAllowed, isLoopbackHost } from '../server/dev/dev-auth-guard.js';
import { platformState } from '../server/account/state.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OK = { ELVAR_DEV_AUTH: '1', ELVAR_DB: 'memory' };

test('the dev login needs ELVAR_DEV_AUTH=1 AND the in-memory database, and is refused on Vercel, in production, or with a database URL', () => {
  assert.equal(devAuthEnabled(OK), true);
  for (const bad of [{}, { ELVAR_DEV_AUTH: '1' }, { ELVAR_DB: 'memory' }, { ...OK, ELVAR_DEV_AUTH: 'true' }, { ...OK, VERCEL: '1' }, { ...OK, NODE_ENV: 'production' }, { ...OK, ELVAR_DB_URL: 'postgres://x' }, { ...OK, ELVAR_DB: 'pg' }]) {
    assert.equal(devAuthEnabled(bad), false, JSON.stringify(bad)); assert.throws(() => assertDevAuthAllowed(bad), /dev auth issuer/);
  }
  assert.ok(isLoopbackHost('127.0.0.1') && isLoopbackHost('localhost') && !isLoopbackHost('0.0.0.0') && !isLoopbackHost('192.168.1.5'));
});

test('the state page reports the dev login only when it is enabled; in production mode it can never point the app at /dev-supabase', () => {
  assert.equal(platformState({ ...OK }).devAuth, true); assert.equal(platformState({ ...OK }).supabaseUrl, '/dev-supabase');
  const prod = platformState({ ELVAR_DEV_AUTH: '1', ELVAR_DB: 'memory', VERCEL: '1', SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_PUBLISHABLE_KEY: 'k', ELVAR_DB_URL: 'postgres://u' });
  assert.equal(prod.devAuth, false); assert.equal(prod.supabaseUrl, 'https://x.supabase.co'); assert.equal(prod.publishableKey, 'k');
});

test('fake-auth.js refuses to even load on Vercel or in production (checked in a fresh process)', () => {
  for (const env of [{ VERCEL: '1' }, { NODE_ENV: 'production' }]) {
    const r = spawnSync(process.execPath, ['-e', "import('./server/dev/fake-auth.js').then(() => console.log('LOADED'), (e) => console.log('REFUSED: ' + e.message))"], { cwd: ROOT, env: { ...process.env, ELVAR_DEV_AUTH: '1', ELVAR_DB: 'memory', ...env }, encoding: 'utf8' });
    assert.match(r.stdout, /REFUSED: .*never run in production/, JSON.stringify(env));
  }
  const ok = spawnSync(process.execPath, ['-e', "import('./server/dev/fake-auth.js').then(() => console.log('LOADED'))"], { cwd: ROOT, env: { ...process.env, ELVAR_DEV_AUTH: '1', ELVAR_DB: 'memory', VERCEL: '', NODE_ENV: 'development' }, encoding: 'utf8' });
  assert.match(ok.stdout, /LOADED/);
});

test('only the local server imports the fake issuer: no Vercel function (api/), no other server module', () => {
  const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', 'dist', '.git'].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(m?js|cjs|json)$/.test(e.name)) out.push(p); } return out; };
  const users = walk(ROOT).map((f) => path.relative(ROOT, f)).filter((f) => /dev\/fake-auth/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepEqual(users.filter((f) => !f.startsWith('test/') && f !== 'server/index.js' && f !== 'server/dev/fake-auth.js' && f !== 'server/dev/dev-auth-guard.js'), [], 'who may mention the fake issuer');
  assert.ok(!users.some((f) => f.startsWith('api/')));
  const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.match(idx, /if \(DEV_AUTH\)[\s\S]*await import\('\.\/dev\/fake-auth\.js'\)/, 'imported only inside the DEV_AUTH branch');
  assert.match(idx, /isLoopbackHost\(HOST\)[\s\S]*process\.exit\(1\)/, 'refuses a non-loopback bind');
  assert.ok(!/dev-supabase/.test(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')));
});

// ---- the issuer, over real HTTP, through the real verifier and the real router
test('sign-up -> confirmation mail -> PKCE exchange -> the REAL verifier and router accept the token; sign-in rules; refresh rotation; recovery; Google; admin calls', async () => {
  process.env.ELVAR_DEV_AUTH = '1'; process.env.ELVAR_DB = 'memory'; process.env.ELVAR_DEV_CAPTCHA = '1'; delete process.env.VERCEL;
  const { resetDb, getDb } = await import('../server/db/index.js'); await resetDb(); const db = await getDb();
  const { createFakeAuth, DEV_PUBLISHABLE_KEY, DEV_SERVICE_KEY, DEV_CAPTCHA_OK } = await import('../server/dev/fake-auth.js');
  const { _clearVerifiers, _setVerifierForTests } = await import('../server/auth/jwt.js'); _clearVerifiers(); _setVerifierForTests(null);
  let fa; const server = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); fa.handle(req, res, u.pathname, Object.fromEntries(u.searchParams)).then((h) => { if (!h) { res.statusCode = 404; res.end(); } }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  fa = await createFakeAuth({ db, issuerBase: base, log: () => {} });
  const saved = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY };
  process.env.SUPABASE_URL = `${base}/dev-supabase`; process.env.SUPABASE_PUBLISHABLE_KEY = DEV_PUBLISHABLE_KEY; process.env.SUPABASE_SECRET_KEY = DEV_SERVICE_KEY;
  const api = `${base}/dev-supabase/auth/v1`, H = { 'content-type': 'application/json', apikey: DEV_PUBLISHABLE_KEY };
  const post = (p, body, h = H) => fetch(api + p, { method: 'POST', headers: h, body: JSON.stringify(body), redirect: 'manual' });
  const verifierOf = (m) => crypto.createHash('sha256').update(m).digest('base64url');
  const cap = { gotrue_meta_security: { captcha_token: DEV_CAPTCHA_OK } };
  try {
    const email = 'newbie@example.test', password = 'Str0ngPassw0rd!';
    // captcha, weak password, disposable domain
    assert.equal((await post('/signup', { email, password })).status, 400);
    assert.equal((await post('/signup', { email, password: 'short', ...cap })).status, 422);
    assert.equal((await post('/signup', { email: 'x@mailinator.com', password, ...cap })).status, 400);
    const verifier = 'v'.repeat(60), challenge = verifierOf(verifier);
    const su = await post('/signup?redirect_to=' + encodeURIComponent(base + '/'), { email, password, code_challenge: challenge, code_challenge_method: 's256', ...cap });
    assert.equal(su.status, 200); const created = await su.json(); assert.equal(created.email, email); assert.equal(created.email_confirmed_at, null);
    assert.equal((await post('/token?grant_type=password', { email, password, ...cap })).status, 400, 'not confirmed yet'); assert.equal((await (await post('/token?grant_type=password', { email, password, ...cap })).json()).error_code, 'email_not_confirmed');
    assert.equal((await (await post('/token?grant_type=password', { email, password: 'WrongPassw0rd!', ...cap })).json()).error_code, 'invalid_credentials');
    // an existing address looks the same from outside (no enumeration)
    const again = await post('/signup', { email, password, ...cap }); assert.equal(again.status, 200); assert.deepEqual((await again.json()).identities, []);
    assert.equal(fa.mailbox.filter((m) => m.to === email).length, 1, 'no second mail for a known address');
    // the confirmation link: redirects back with ?code, which only the holder of the verifier can exchange
    const mail = fa.mailbox.find((m) => m.to === email && m.type === 'signup'); assert.match(mail.subject, /確認/);
    const v = await fetch(mail.link, { redirect: 'manual' }); assert.equal(v.status, 302);
    const code = new URL(v.headers.get('location')).searchParams.get('code'); assert.ok(code);
    assert.equal((await post('/token?grant_type=pkce', { auth_code: code, code_verifier: 'wrong'.repeat(15) })).status, 400, 'wrong verifier');
    const v2 = await fetch(mail.link, { redirect: 'manual' }); assert.equal(new URL(v2.headers.get('location')).searchParams.get('error'), 'access_denied', 'a link works once');
    const ex = await post('/token?grant_type=pkce', { auth_code: code, code_verifier: verifier });
    assert.equal(ex.status, 400, 'the code was spent by the failed attempt (single use)');
    const mail2 = (await post('/resend', { type: 'signup', email }), null); void mail2;
    // sign in with the password now that the address is confirmed
    const si = await post('/token?grant_type=password', { email, password, ...cap }); assert.equal(si.status, 200); const s1 = await si.json();
    assert.equal(s1.user.email, email); assert.equal(s1.token_type, 'bearer');
    // the real verifier (JWKS over HTTP from the issuer) and the real router accept it, and the account is created
    const { routeElvar } = await import('../server/router.js');
    const call = (m, p, token, body = {}) => routeElvar({ method: m, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, socket: {} }, { pathname: p, body });
    const sess = await call('GET', '/api/elvar/session', s1.access_token); assert.equal(sess.status, 200, JSON.stringify(sess.body)); assert.equal(sess.body.user.email, email);
    const list = db.testing; assert.ok(list);
    // refresh rotation, and reuse of a spent refresh token ends the session
    const r1 = await (await post('/token?grant_type=refresh_token', { refresh_token: s1.refresh_token })).json(); assert.ok(r1.access_token && r1.refresh_token !== s1.refresh_token);
    assert.equal((await post('/token?grant_type=refresh_token', { refresh_token: s1.refresh_token })).status, 400);
    assert.equal((await post('/token?grant_type=refresh_token', { refresh_token: r1.refresh_token })).status, 400, 'the whole session was revoked on reuse');
    // password recovery
    const v3 = 'w'.repeat(60);
    await post('/recover?redirect_to=' + encodeURIComponent(base + '/'), { email, code_challenge: verifierOf(v3), code_challenge_method: 's256', ...cap });
    await post('/recover', { email: 'nobody@example.test', ...cap });
    assert.equal(fa.mailbox.filter((m) => m.type === 'recovery').length, 1, 'no mail for an unknown address, and no error either');
    const rec = fa.mailbox.find((m) => m.type === 'recovery'), rc = new URL((await fetch(rec.link, { redirect: 'manual' })).headers.get('location')).searchParams.get('code');
    const rs = await (await post('/token?grant_type=pkce', { auth_code: rc, code_verifier: v3 })).json();
    const put = await fetch(api + '/user', { method: 'PUT', headers: { ...H, authorization: 'Bearer ' + rs.access_token }, body: JSON.stringify({ password: 'N3wPassword-ok-1' }) }); assert.equal(put.status, 200);
    assert.equal((await post('/token?grant_type=password', { email, password, ...cap })).status, 400); assert.equal((await post('/token?grant_type=password', { email, password: 'N3wPassword-ok-1', ...cap })).status, 200);
    // Google (a fake account chooser): the page, then the redirect with a code for the same PKCE verifier
    const gv = 'g'.repeat(60);
    const page = await fetch(`${api}/authorize?provider=google&redirect_to=${encodeURIComponent(base + '/')}&code_challenge=${verifierOf(gv)}&code_challenge_method=s256`); assert.match(await page.text(), /開発用の偽物/);
    const gc = await fetch(`${base}/dev-supabase/auth/v1/dev/google-continue`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'g.user@example.test', redirect_to: base + '/', challenge: verifierOf(gv) }), redirect: 'manual' });
    const gcode = new URL(gc.headers.get('location')).searchParams.get('code'); const gs = await (await post('/token?grant_type=pkce', { auth_code: gcode, code_verifier: gv })).json();
    assert.equal(gs.user.app_metadata.provider, 'google'); assert.equal((await call('GET', '/api/elvar/session', gs.access_token)).status, 200);
    const gd = await fetch(`${base}/dev-supabase/auth/v1/dev/google-continue`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'x@yopmail.com', redirect_to: base + '/' }), redirect: 'manual' });
    assert.equal(new URL(gd.headers.get('location')).searchParams.get('error'), 'access_denied', 'the sign-up rules apply to Google sign-ups too');
    // the admin API (service key): ban, claim, delete; everything else is refused
    const AD = { 'content-type': 'application/json', apikey: DEV_SERVICE_KEY, authorization: `Bearer ${DEV_SERVICE_KEY}` };
    const uid = gs.user.id;
    assert.equal((await fetch(`${api}/admin/users/${uid}`, { method: 'PUT', headers: H, body: JSON.stringify({ ban_duration: '876000h' }) })).status, 401, 'the publishable key is not the service key');
    assert.equal((await fetch(`${api}/admin/users/${uid}`, { method: 'PUT', headers: AD, body: JSON.stringify({ ban_duration: '876000h', app_metadata: { elvar_role: 'admin' } }) })).status, 200);
    assert.equal((await post('/token?grant_type=refresh_token', { refresh_token: gs.refresh_token })).status, 400, 'a banned user cannot refresh');
    assert.equal((await fetch(`${api}/admin/users/${uid}`, { method: 'DELETE', headers: AD })).status, 200);
    // (a warm instance keeps the account status 30 s and the user's configuration 10 s: documented bounds; clearing them shows the steady state)
    (await import('../server/auth/with-user.js'))._clearAccountCache(); (await import('../server/auth/load-user-config.js'))._clearUserConfigCache();
    assert.equal((await call('GET', '/api/elvar/session', gs.access_token)).body.error, 'account_deleted', 'the token of a deleted user is a 401');
    assert.equal((await fetch(api + '/user', { headers: { ...H, authorization: 'Bearer ' + gs.access_token } })).status, 401, 'and /user (requireFresh) refuses it too');
    assert.equal((await fetch(`${base}/dev-supabase/dev/mailbox`)).status, 200);
  } finally {
    await new Promise((r) => server.close(r));
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    delete process.env.ELVAR_DEV_CAPTCHA; delete process.env.ELVAR_DEV_AUTH; _clearVerifiers(); await resetDb();
  }
});

test('review fix: the dev login answers only requests whose Host is this computer (DNS rebinding is refused)', async () => {
  const { isLoopbackHostHeader } = await import('../server/dev/dev-auth-guard.js');
  for (const ok of ['127.0.0.1:8787', 'localhost:5173', 'localhost', '[::1]:8787', 'LOCALHOST:80']) assert.equal(isLoopbackHostHeader(ok), true, ok);
  for (const bad of ['evil.example:8787', 'rebind.127.0.0.1.evil.com', '192.168.1.5:8787', '127.0.0.1.evil.com', '', undefined, 'localhost.evil.com', '127.0.0.1@evil.com']) assert.equal(isLoopbackHostHeader(bad), false, String(bad));
  const { createFakeAuth } = await import('../server/dev/fake-auth.js'); process.env.ELVAR_DEV_AUTH = '1'; process.env.ELVAR_DB = 'memory';
  const { resetDb, getDb } = await import('../server/db/index.js'); await resetDb();
  const fa = await createFakeAuth({ db: await getDb(), issuerBase: 'http://127.0.0.1:1', log: () => {} });
  const res = { statusCode: 0, setHeader() {}, end() {} };
  assert.equal(await fa.handle({ method: 'GET', headers: { host: 'evil.example' } }, res, '/dev-supabase/dev/mailbox', {}), true); assert.equal(res.statusCode, 421, 'the mailbox is not readable from another origin');
});
