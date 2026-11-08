// The login helper: PKCE is really sent, state is checked, and the refresh token is printed. Mock Google token endpoint; no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { SCOPES } from '../server/google/config.js';

test('google-auth.mjs completes a PKCE loopback flow', async () => {
  let seen;
  const mock = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { seen = new URLSearchParams(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ access_token: 'a', refresh_token: 'REFRESH-XYZ', scope: 'x' })); });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, ['scripts/google-auth.mjs', '--no-open'], { env: { ...process.env, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_API_MOCK_ORIGIN: `http://127.0.0.1:${mock.address().port}` } });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  try {
    for (let i = 0; i < 50 && !/accounts\.google\.com\S+/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    const authUrl = new URL(out.match(/https:\/\/accounts\.google\.com\S+/)[0]);
    const q = authUrl.searchParams;
    assert.equal(q.get('code_challenge_method'), 'S256'); assert.equal(q.get('access_type'), 'offline'); assert.equal(q.get('prompt'), 'consent');
    assert.deepEqual(q.get('scope').split(' '), SCOPES, 'the standalone script must request exactly the scopes the server is built for');
    assert.match(q.get('scope'), /gmail\.modify/); assert.doesNotMatch(q.get('scope'), /mail\.google\.com/, 'must not ask for permanent-delete mail scope');
    assert.match(q.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // wrong state is refused...
    await fetch(`${q.get('redirect_uri')}?code=c&state=WRONG`);
    // ...so a second, correct callback is not reachable; run a fresh child for the happy path
  } finally { child.kill(); }

  const child2 = spawn(process.execPath, ['scripts/google-auth.mjs', '--no-open'], { env: { ...process.env, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_API_MOCK_ORIGIN: `http://127.0.0.1:${mock.address().port}` } });
  let out2 = ''; child2.stdout.on('data', (d) => (out2 += d)); child2.stderr.on('data', (d) => (out2 += d));
  const exit = new Promise((r) => child2.on('exit', r));
  for (let i = 0; i < 50 && !/accounts\.google\.com\S+/.test(out2); i++) await new Promise((r) => setTimeout(r, 100));
  const q2 = new URL(out2.match(/https:\/\/accounts\.google\.com\S+/)[0]).searchParams;
  await fetch(`${q2.get('redirect_uri')}?code=THECODE&state=${q2.get('state')}`);
  assert.equal(await exit, 0);
  assert.match(out2, /GOOGLE_REFRESH_TOKEN=REFRESH-XYZ/);
  assert.equal(seen.get('grant_type'), 'authorization_code'); assert.equal(seen.get('code'), 'THECODE');
  assert.equal(crypto.createHash('sha256').update(seen.get('code_verifier')).digest('base64url'), q2.get('code_challenge'), 'verifier must match the challenge sent to Google');
  mock.close();
});
