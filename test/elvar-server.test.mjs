// The real local server process (server/index.js) with the memory store: setup flow over HTTP, gates on the owner endpoints, setup code in the log only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

async function start(extra = {}) {
  const port = 19900 + Math.floor(Math.random() * 90);
  const env = { ...process.env, PORT: String(port), ELVAR_STORE: 'memory', ...extra };
  for (const k of ['ELVAR_ACCESS_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'ELVAR_SETUP_CODE', 'VERCEL']) if (extra[k] === undefined) delete env[k];
  const srv = spawn(process.execPath, ['server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { await fetch(`${base}/api/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  return { srv, base, log: () => log };
}
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const post = (s, p, body, token, method = 'POST') => fetch(s.base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { 'x-elvar-token': token } : {}) }, body: JSON.stringify(body || {}) }).then(j);
const get = (s, p, token) => fetch(s.base + p, { headers: token ? { 'x-elvar-token': token } : {} }).then(j);

test('local server: fresh instance -> setup (loopback, no code) -> owner endpoints need the device token -> saved key applies', async () => {
  const s = await start();
  try {
    const st = await get(s, '/api/elvar/state'); assert.deepEqual([st.body.initialized, st.body.storage, st.body.setupCodeRequired, st.body.local], [false, 'memory', false, true]);
    assert.match(s.log(), /ELVAR SETUP CODE: [A-Z0-9]{4}-[A-Z0-9]{4}/, 'printed in the server log');
    const code = s.log().match(/SETUP CODE: ([A-Z0-9-]{9})/)[1];
    assert.ok(!JSON.stringify(st).includes(code.replace('-', '')));
    // before setup a loopback caller is the owner (fail-closed to this machine only)
    assert.equal((await get(s, '/api/health')).body.geminiConfigured, false);
    const claim = await post(s, '/api/elvar/setup/claim', { password: 'correct horse battery', deviceName: 'Test PC' }); assert.equal(claim.status, 200);
    const token = claim.body.token;
    // after setup: no token = no access, even from loopback
    for (const p of ['/api/system/check', '/api/hud/data', '/api/google/status', '/api/notif?status=1', '/api/elvar/session']) assert.equal((await get(s, p)).status, 401, p);
    assert.equal((await post(s, '/api/live-token', {})).status, 401); assert.equal((await post(s, '/api/chat', {})).status, 401); assert.equal((await post(s, '/api/agent/run', {})).status, 401); assert.equal((await post(s, '/api/google/execute', {})).status, 401);
    assert.equal((await post(s, '/api/live-token', {}, token)).status, 503, 'no Gemini key yet -> setup_required');
    assert.deepEqual((await post(s, '/api/live-token', {}, token)).body, { error: 'setup_required', missing: ['GEMINI_API_KEY'] });
    const put = await post(s, '/api/elvar/config', { secrets: { GEMINI_API_KEY: 'AIzaFAKE-server-KEY-1234' } }, token, 'PATCH'); assert.equal(put.status, 200); assert.equal(put.body.secrets.GEMINI_API_KEY.last4, '1234');
    const health = await get(s, '/api/health', token); assert.equal(health.body.geminiConfigured, true, 'the saved key applies to the next request');
    assert.ok(!s.log().includes('AIzaFAKE-server-KEY'), 'the key never reaches the log');
    assert.equal((await get(s, '/api/health')).body.geminiConfigured, false, 'and only for the owner');
    const nf = await get(s, '/api/elvar/nothing'); assert.equal(nf.status, 404);
    const session = await get(s, '/api/elvar/session', token); assert.equal(session.status, 200); assert.equal(session.body.mode, 'vault');
  } finally { s.srv.kill(); }
});

test('local server: env mode (ELVAR_ACCESS_TOKEN) keeps working for the existing owner endpoints until the vault exists', async () => {
  const s = await start({ ELVAR_ACCESS_TOKEN: 'env-secret-1' });
  try {
    assert.equal((await get(s, '/api/system/check')).status, 401);
    assert.equal((await get(s, '/api/google/status', 'wrong')).status, 401);
    assert.equal((await get(s, '/api/google/status', 'env-secret-1')).status, 200);
    const st = await get(s, '/api/elvar/state'); assert.equal(st.body.envMode, true);
    assert.equal((await get(s, '/api/elvar/config', 'env-secret-1')).body.mode, 'env');
  } finally { s.srv.kill(); }
});

test('local server: a store failure at request time is a clean 5xx, not a crash (getConfig runs inside the try)', async () => {
  // ELVAR_STORE unset + Upstash env pointing at a dead port -> every store call fails
  const s = await start({ ELVAR_STORE: '', UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:1', UPSTASH_REDIS_REST_TOKEN: 't' });
  try {
    const r1 = await get(s, '/api/hud/data', 'elv1.0000000000000000.' + 'A'.repeat(43)); assert.equal(r1.status, 503); assert.equal(r1.body.error, 'store_unavailable');
    const r2 = await get(s, '/api/health'); assert.equal(r2.status, 200, 'unauthenticated endpoints still answer');
    const r3 = await get(s, '/api/health'); assert.equal(r3.status, 200, 'and the process is still up');
  } finally { s.srv.kill(); }
});
