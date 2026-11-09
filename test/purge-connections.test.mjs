// Deleting an account revokes what the user connected elsewhere (docs/ELVAR_MULTIUSER.md 7.4 step 1, principle 7): their Google refresh token at Google and their MCP logins at
// the authorization servers that published a revocation endpoint; then their key is shredded and every row goes. The residual check covers the new tables.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startHarness } from './helpers/api-harness.mjs';
import { startMcp } from './helpers/mock-mcp.mjs';
import { purgeAccount } from '../server/rights/purge.js';
import { revokeAll, revokeToken } from '../server/rights/revoke.js';
import { residualCheck } from '../server/rights/residual.js';
import { mintVerifiedUid } from '../server/db/verified-uid.js';
import { getKeyring } from '../server/auth/keyring.js';
import { REGISTRY } from '../server/rights/registry.js';

process.env.ELVAR_UNSAFE_TEST_NETWORK = 'loopback'; delete process.env.VERCEL; delete process.env.NODE_ENV;
const ORIGIN = 'https://elvar.example.test';
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

async function startGoogle() {
  const st = { revoked: [], n: 0 };
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), f = new URLSearchParams(await readBody(req)); res.writeHead(200, { 'content-type': 'application/json' });
    if (url.pathname === '/oauth') return res.end(JSON.stringify({ access_token: 'AT', refresh_token: `RT-${f.get('client_id')}`, expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar' }));
    if (url.pathname === '/revoke') { st.revoked.push(f.get('token')); return res.end('{}'); }
    res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { st, origin: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections?.(); return new Promise((r) => srv.close(r)); } };
}

test('deleting an account: the user\'s Google and MCP logins are revoked (only theirs), their key is shredded, every table of the registry is empty for them, nobody else is touched', async () => {
  const h = await startHarness(), g = await startGoogle(), mcp = await startMcp({ oauth: true });
  const saved = { ELVAR_PUBLIC_ORIGIN: process.env.ELVAR_PUBLIC_ORIGIN, ELVAR_DEV_AUTH: process.env.ELVAR_DEV_AUTH, GOOGLE_API_MOCK_ORIGIN: process.env.GOOGLE_API_MOCK_ORIGIN };
  Object.assign(process.env, { ELVAR_PUBLIC_ORIGIN: ORIGIN, ELVAR_DEV_AUTH: '1', GOOGLE_API_MOCK_ORIGIN: g.origin });
  const quiet = console.log; console.log = () => {};
  try {
    const a = h.mkUser('a@example.test'), b = h.mkUser('b@example.test'), A = await h.bearer(a, { email: 'a@example.test' }), B = await h.bearer(b, { email: 'b@example.test' });
    const setup = async (hd, client) => {
      await h.call('PATCH', '/api/elvar/config', hd, { settings: { GOOGLE_CLIENT_ID: client }, secrets: { GOOGLE_CLIENT_SECRET: 'secret-' + client } });
      const st = (await h.call('POST', '/api/elvar/connect/google/start', hd, {})).body; await h.call('GET', '/api/google/callback', {}, {}, { state: st.state, code: 'c' }); assert.equal((await h.call('POST', '/api/elvar/connect/google/claim', hd, { state: st.state })).body.claimed, true);
      const cx = (await h.call('POST', '/api/elvar/connectors', { ...hd, host: 'localhost:8787' }, { type: 'mcp', name: 'Cloud', mcp: { url: mcp.url }, auth: { type: 'oauth' } })).body.connector.id;
      const os = (await h.call('POST', `/api/elvar/connectors/${cx}/oauth/start`, { ...hd, host: 'localhost:8787' }, {})).body; const cb = mcp.authorize(os.url);
      await h.call('GET', '/api/elvar/oauth/callback', {}, {}, cb); assert.equal((await h.call('POST', `/api/elvar/connectors/${cx}/oauth/claim`, hd, { state: cb.state })).body.claimed, true);
      return cx;
    };
    const cxa = await setup(A, 'a-client-0001.apps.example'), cxb = await setup(B, 'b-client-0002.apps.example'); void cxb;
    await h.db.asUser(mintVerifiedUid(a, 'test'), (r) => r.builds.record({ repo: 'a/own', issueNumber: 1, title: 'A build' }));
    const va = mintVerifiedUid(a, 'purge'), vb = mintVerifiedUid(b, 'purge');
    const before = await residualCheck(h.db, va); const rows = Object.fromEntries(before.nonzero.map((x) => [x.table, x.n]));
    for (const t of ['oauth_tokens', 'connectors', 'build_requests', 'user_secrets', 'user_keys']) assert.ok(rows[t] >= 1, t + ' has rows to delete');
    const bBefore = await residualCheck(h.db, vb);
    const del = await h.call('POST', '/api/elvar/account/delete', A, { graceDays: 0 }); assert.deepEqual(del.body, { deleted: true });
    assert.deepEqual(g.st.revoked, ['RT-a-client-0001.apps.example'], 'Google: only A\'s refresh token was revoked at Google');
    assert.equal(mcp.st.revoked.length, 1, 'MCP: A\'s login was revoked at its server (B\'s was not)'); assert.match(mcp.st.revoked[0], /^rt-/); assert.equal(mcp.st.lastRevoke.token_type_hint, 'refresh_token');
    const after = await residualCheck(h.db, va); assert.deepEqual({ clean: after.clean, nonzero: after.nonzero, tablesChecked: after.tablesChecked }, { clean: true, nonzero: [], tablesChecked: REGISTRY.length });
    assert.deepEqual(await residualCheck(h.db, vb), bBefore, 'B is untouched');
    assert.equal((await h.call('GET', '/api/elvar/connectors', B)).body.connectors.length, 1); assert.equal((await h.call('GET', '/api/elvar/connect/google/status', B)).body.state, 'connected');
    assert.equal(h.db.testing.receipts().length, 1); assert.ok(!JSON.stringify(h.db.testing.receipts()).includes(a));
    void cxa;
  } finally { console.log = quiet; for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } await g.close(); await mcp.close(); await h.stop(); }
});

test('revocation is best effort and safe: a provider that is down does not stop the deletion; a connector\'s revoke URL goes through safeFetch (never a private address); nothing without a token is sent', async () => {
  const h = await startHarness(); const quiet = console.log, qe = console.error; console.log = () => {}; console.error = () => {};
  try {
    const a = h.mkUser('a@example.test'), va = mintVerifiedUid(a, 'test'), calls = [];
    const ring = getKeyring();
    await h.db.asUser(va, async (r) => {
      await ring.putToken(r, 'google', { refreshToken: 'RT-down', clientId: 'c' }, { revokeUrl: 'https://oauth2.example/revoke' });
      await ring.putToken(r, 'cx:cx_priv', { refresh_token: 'rt-priv', clientId: 'c' }, { revokeUrl: 'https://10.0.0.5/revoke' });
      await ring.putToken(r, 'cx:cx_none', { refresh_token: 'rt-none' }, {});   // a server without a revocation endpoint
    });
    const down = async (url) => { calls.push(String(url)); throw new Error('provider down'); };
    const res = await revokeAll(h.db, va, { fetchImpl: down }); assert.deepEqual(res, { google: false, connectors: 0, failed: 3 }); assert.deepEqual([...calls].sort(), ['https://10.0.0.5/revoke', 'https://oauth2.example/revoke'], 'nothing is sent for a connector without a revocation endpoint');
    // the real path (no injected fetch): an internal revoke URL is refused by safeFetch, so nothing leaves the process
    assert.equal(await revokeToken({ provider: 'cx:x', data: { refresh_token: 't' }, revokeUrl: 'https://10.0.0.5/revoke' }), false);
    assert.equal(await revokeToken({ provider: 'cx:x', data: {}, revokeUrl: 'https://x.example/revoke' }), false, 'no token, nothing to revoke');
    // the purge goes on although every revocation failed, and ends with a clean residual check
    const del = await purgeAccount(h.db, a, { deleteUser: async (uid) => h.db.testing.deleteUser(uid), fetchImpl: down }); assert.equal(del.tablesChecked, REGISTRY.length);
    assert.equal((await residualCheck(h.db, mintVerifiedUid(a, 'purge'))).clean, true);
  } finally { console.log = quiet; console.error = qe; await h.stop(); }
});
