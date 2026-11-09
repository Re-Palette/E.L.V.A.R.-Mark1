// Cross-user tests for EVERY route (docs/ELVAR_MULTIUSER.md 3.5): B calls each route with A's identifiers and must reach nothing of A's, and must not
// change anything of A's. The last test fails when a user / admin route exists without a case here, so a new route cannot ship without one.
import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/api-harness.mjs';
import { ROUTES, isUserAuth } from '../server/router.js';
import { mintVerifiedUid } from '../server/db/verified-uid.js';

const A_KEY = 'AIzaSy-USER-A-SECRET-KEY-aaaa1111', B_KEY = 'AIzaSy-USER-B-SECRET-KEY-bbbb2222';
const A_NAME = 'A-PRIVATE-PERSONA-NAME';
// P3: A's own Google client (decision O2), Google login, connector and build request
const A_CLIENT = 'a-private-client-0001.apps.googleusercontent.com', B_CLIENT = 'b-own-client-0002.apps.googleusercontent.com', A_GSECRET = 'google-secret-A-PRIVATE-0001', B_GSECRET = 'google-secret-B-OWN-0002';
const A_REFRESH = 'A-GOOGLE-REFRESH-TOKEN-xyz', A_CX_NAME = 'A-PRIVATE-CONNECTOR', A_CX_TOKEN = 'A-CONNECTOR-BEARER-TOKEN-777', A_CX_HOST = 'a-private.example.com', A_BUILD = 'A-PRIVATE-BUILD', A_BUILD_REPO = 'a-user/private-builds';
const ORIGIN = 'https://elvar.example.test';

/** A stand-in for Google's token and revoke endpoints (the only network the Google routes use here). */
function googleNet() {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    calls.push({ url: u, ...body });
    if (u === 'https://oauth2.googleapis.com/token') return { ok: true, status: 200, json: async () => ({ access_token: 'AT-' + (body.client_id || 'x'), refresh_token: body.client_id === A_CLIENT ? A_REFRESH : 'B-REFRESH', expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.modify' }) };
    if (u === 'https://oauth2.googleapis.com/revoke') return { ok: true, status: 200, json: async () => ({}) };
    throw new Error('unexpected network call in a route test: ' + u);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const cxDraft = (name, token, host = A_CX_HOST) => ({ type: 'http', name, http: { baseUrl: 'https://' + host }, auth: { type: 'bearer', secret: token },
  tools: [{ name: 'ping', method: 'GET', path: '/ping', readOnly: true, approval: 'auto', description: 'ping', inputSchema: { type: 'object', properties: {} } }] });
/** Google client + a finished consent flow for `who` (the callback comes back with no token; the user's app claims it). */
async function connectGoogle(h, who, client, secret) {
  await h.call('PATCH', '/api/elvar/config', who, { settings: { GOOGLE_CLIENT_ID: client, GOOGLE_SERVICES: 'calendar,gmail' }, secrets: { GOOGLE_CLIENT_SECRET: secret } });
  const st = (await h.call('POST', '/api/elvar/connect/google/start', who, {})).body; assert.ok(st.state, 'start: ' + JSON.stringify(st));
  const cb = await h.call('GET', '/api/google/callback', {}, {}, { state: st.state, code: 'the-code' }); assert.equal(cb.status, 200);
  const cl = await h.call('POST', '/api/elvar/connect/google/claim', who, { state: st.state }); assert.equal(cl.body.claimed, true);
  return st;
}

/** Two users with data: A has a key, a setting, a persona, a device, usage, a Google login of their own client, a connector and a build request. */
async function world(h) {
  process.env.ELVAR_PUBLIC_ORIGIN = ORIGIN;
  const a = h.mkUser('a@example.test'), b = h.mkUser('b@example.test');
  const A = await h.bearer(a, { email: 'a@example.test' }), B = await h.bearer(b, { email: 'b@example.test' });
  await h.call('PATCH', '/api/elvar/config', A, { secrets: { GEMINI_API_KEY: A_KEY }, settings: { BRAIN_REPO: 'a-user/private-notes' } });
  const prof = structuredClone((await h.call('GET', '/api/elvar/profile', A)).body.profile); prof.assistant.displayName = A_NAME; prof.owner.name = 'Alice-Secret-Name';
  await h.call('PUT', '/api/elvar/profile', A, { profile: prof });
  const dev = (await h.call('POST', '/api/elvar/devices', A, { name: 'a-phone' })).body;
  await h.db.asUser(mintVerifiedUid(a, 'test'), (r) => r.usage.record({ provider: 'gemini', metric: 'calls', amount: 7 }));
  await h.call('GET', '/api/elvar/session', A); await h.call('GET', '/api/elvar/session', B);
  const g = googleNet();
  try { await connectGoogle(h, A, A_CLIENT, A_GSECRET); } finally { g.restore(); }
  const cx = (await h.call('POST', '/api/elvar/connectors', A, cxDraft(A_CX_NAME, A_CX_TOKEN))); assert.equal(cx.status, 200, JSON.stringify(cx.body));
  const build = await h.db.asUser(mintVerifiedUid(a, 'test'), (r) => r.builds.record({ repo: A_BUILD_REPO, issueNumber: 7, title: A_BUILD }));
  const snapshotA = async () => JSON.stringify([(await h.call('GET', '/api/elvar/config', A)).body, (await h.call('GET', '/api/elvar/profile', A)).body, (await h.call('GET', '/api/elvar/devices', A)).body, (await h.call('GET', '/api/elvar/usage', A)).body,
    (await h.call('GET', '/api/elvar/connect/google/status', A)).body, (await h.call('GET', '/api/elvar/connectors', A)).body, (await h.call('GET', '/api/elvar/builds', A)).body]);
  return { a, b, A, B, dev, snapshotA, cx: cx.body.connector, build };
}
const noA = (value, w) => {
  const t = typeof value === 'string' ? value : JSON.stringify(value);
  for (const s of [A_KEY, A_NAME, 'Alice-Secret-Name', 'a-user/private-notes', 'a-phone', w.dev.id, w.dev.token, w.a, A_CLIENT, A_GSECRET, A_REFRESH, A_CX_NAME, A_CX_TOKEN, A_CX_HOST, A_BUILD, A_BUILD_REPO, w.cx.id, w.build.id]) assert.ok(!t.includes(s), `B's answer contains ${s}`);
};

// "METHOD /path" -> async (h, w) => void
export const CASES = {
  'GET /api/elvar/session': async (h, w) => { const r = await h.call('GET', '/api/elvar/session', w.B); assert.equal(r.body.user.id, w.b); noA(r.body, w); assert.equal(r.body.profile.assistant.displayName, 'E.L.V.A.R.'); },
  'GET /api/elvar/config': async (h, w) => { const r = await h.call('GET', '/api/elvar/config', w.B); noA(r.body, w); assert.equal(r.body.secrets.GEMINI_API_KEY.set, false); assert.equal(r.body.settings.BRAIN_REPO.value, ''); },
  'PATCH /api/elvar/config': async (h, w) => {
    const before = await w.snapshotA();
    const r = await h.call('PATCH', '/api/elvar/config', w.B, { secrets: { GEMINI_API_KEY: B_KEY, GROQ_API_KEY: null }, settings: { BRAIN_REPO: null } }); assert.equal(r.status, 200); noA(r.body, w);
    assert.equal(await w.snapshotA(), before, 'A\'s configuration is unchanged');
    assert.equal((await h.call('PATCH', '/api/elvar/config', w.B, { secrets: { GEMINI_API_KEY: null } })).body.secrets.GEMINI_API_KEY.set, false);
    assert.equal((await h.call('GET', '/api/elvar/config', w.A)).body.secrets.GEMINI_API_KEY.set, true, 'B deleting its key did not delete A\'s');
  },
  'POST /api/elvar/config/test': async (h, w) => {
    const real = globalThis.fetch, keys = []; globalThis.fetch = async (u, o = {}) => { keys.push(o.headers?.['x-goog-api-key']); return { ok: true, status: 200, json: async () => ({}) }; };
    try { await h.call('PATCH', '/api/elvar/config', w.B, { secrets: { GEMINI_API_KEY: B_KEY } }); const r = await h.call('POST', '/api/elvar/config/test', w.B, { name: 'GEMINI_API_KEY' }); assert.equal(r.body.status, 'ok'); assert.deepEqual(keys, [B_KEY], 'only B\'s own key is used'); noA(r.body, w); }
    finally { globalThis.fetch = real; }
  },
  'GET /api/elvar/profile': async (h, w) => { const r = await h.call('GET', '/api/elvar/profile', w.B); noA(r.body, w); },
  'PUT /api/elvar/profile': async (h, w) => {
    const before = await w.snapshotA(), p = structuredClone((await h.call('GET', '/api/elvar/profile', w.B)).body.profile); p.assistant.displayName = 'B-BOT';
    assert.equal((await h.call('PUT', '/api/elvar/profile', w.B, { profile: p })).status, 200);
    assert.equal(await w.snapshotA(), before); assert.equal((await h.call('GET', '/api/elvar/profile', w.A)).body.profile.assistant.displayName, A_NAME);
  },
  'GET /api/elvar/devices': async (h, w) => { const r = await h.call('GET', '/api/elvar/devices', w.B); assert.deepEqual(r.body.devices, []); noA(r.body, w); },
  'POST /api/elvar/devices': async (h, w) => { const r = await h.call('POST', '/api/elvar/devices', w.B, { name: 'b-phone' }); assert.equal(r.status, 200); assert.equal((await h.call('GET', '/api/elvar/devices', w.A)).body.devices.length, 1, 'A\'s list did not grow'); },
  'DELETE /api/elvar/devices/:id': async (h, w) => {
    assert.equal((await h.call('DELETE', `/api/elvar/devices/${w.dev.id}`, w.B)).status, 404, 'B cannot revoke A\'s device by its id');
    assert.equal((await h.call('GET', '/api/elvar/devices', w.A)).body.devices.length, 1);
  },
  'GET /api/elvar/usage': async (h, w) => { const r = await h.call('GET', '/api/elvar/usage', w.B); assert.deepEqual(r.body.daily, []); noA(r.body, w); },
  'GET /api/elvar/account/deletion': async (h, w) => { await h.call('POST', '/api/elvar/account/delete', w.A, { graceDays: 7 }); const r = await h.call('GET', '/api/elvar/account/deletion', w.B); assert.deepEqual(r.body, { status: 'active', deletion: null }); },
  'GET /api/elvar/account/export': async (h, w) => { const r = await h.call('GET', '/api/elvar/account/export', w.B); assert.equal(r.status, 200); noA(r.body, w); assert.equal(r.body.user.id, w.b); },
  'POST /api/elvar/account/delete': async (h, w) => {
    assert.equal((await h.call('POST', '/api/elvar/account/delete', w.B, { graceDays: 7 })).status, 200);
    assert.equal((await h.call('GET', '/api/elvar/session', w.A)).status, 200, 'A is still active'); assert.equal((await h.call('GET', '/api/elvar/session', w.B)).body.error, 'account_pending_deletion');
  },
  'POST /api/elvar/account/delete/cancel': async (h, w) => {
    await h.call('POST', '/api/elvar/account/delete', w.A, { graceDays: 7 });
    assert.equal((await h.call('POST', '/api/elvar/account/delete/cancel', w.B)).status, 409, 'B has nothing to cancel');
    assert.equal((await h.call('GET', '/api/elvar/session', w.A)).body.error, 'account_pending_deletion', 'and A\'s request is still pending');
  },
  'GET /api/elvar/admin/users': async (h, w) => { const r = await h.call('GET', '/api/elvar/admin/users', w.B); assert.equal(r.status, 403); noA(r.body, w); const c = await h.bearer(w.b, { app_metadata: { elvar_role: 'admin' } }); assert.equal((await h.call('GET', '/api/elvar/admin/users', c)).status, 403, 'a forged-looking claim without the table row'); },
  'POST /api/elvar/admin/users/:id/suspend': async (h, w) => { assert.equal((await h.call('POST', `/api/elvar/admin/users/${w.a}/suspend`, w.B, {})).status, 403); assert.equal((await h.call('GET', '/api/elvar/session', w.A)).status, 200); },
  'POST /api/elvar/admin/users/:id/unsuspend': async (h, w) => { assert.equal((await h.call('POST', `/api/elvar/admin/users/${w.a}/unsuspend`, w.B, {})).status, 403); },
};
// ---- P3: Google, connectors and build requests. B calls each route with A's identifiers (A's connector id, A's OAuth state) and must reach nothing of A's.
Object.assign(CASES, {
  'GET /api/elvar/connect/google/status': async (h, w) => {
    const r = await h.call('GET', '/api/elvar/connect/google/status', w.B); assert.equal(r.status, 200); noA(r.body, w);
    assert.deepEqual([r.body.state, r.body.clientIdSet, r.body.clientSecretSet, r.body.configured, r.body.scopes], ['unconfigured', false, false, false, null], 'B has no Google connection of their own');
    const own = googleNet(); try { await connectGoogle(h, w.B, B_CLIENT, B_GSECRET); } finally { own.restore(); }
    const rb = await h.call('GET', '/api/elvar/connect/google/status', w.B); assert.equal(rb.body.state, 'connected'); assert.equal(rb.body.clientId, B_CLIENT); noA(rb.body, w);
    assert.equal((await h.call('GET', '/api/elvar/connect/google/status', w.A)).body.clientId, A_CLIENT, 'and A\'s own client is still A\'s');
  },
  'POST /api/elvar/connect/google/start': async (h, w) => {
    const none = await h.call('POST', '/api/elvar/connect/google/start', w.B, {}); assert.equal(none.body.error, 'client_missing'); noA(none.body, w);
    await h.call('PATCH', '/api/elvar/config', w.B, { settings: { GOOGLE_CLIENT_ID: B_CLIENT }, secrets: { GOOGLE_CLIENT_SECRET: B_GSECRET } });
    const r = await h.call('POST', '/api/elvar/connect/google/start', w.B, {}); assert.equal(r.status, 200); noA(r.body, w);
    const u = new URL(r.body.url); assert.equal(u.searchParams.get('client_id'), B_CLIENT, 'B\'s flow uses B\'s own client, never A\'s'); assert.equal(u.searchParams.get('redirect_uri'), ORIGIN + '/api/google/callback', 'the platform\'s single callback');
  },
  'POST /api/elvar/connect/google/claim': async (h, w) => {
    // A has a finished flow waiting for their claim; B presents A's state
    const g = googleNet();
    try {
      const st = (await h.call('POST', '/api/elvar/connect/google/start', w.A, {})).body;
      assert.equal((await h.call('GET', '/api/google/callback', {}, {}, { state: st.state, code: 'c2' })).status, 200);
      const stolen = await h.call('POST', '/api/elvar/connect/google/claim', w.B, { state: st.state }); assert.equal(stolen.body.claimed, false, 'B cannot take A\'s result'); noA(stolen.body, w);
      assert.equal((await h.call('GET', '/api/elvar/connect/google/status', w.B)).body.state, 'unconfigured', 'nothing was bound to B');
      assert.equal((await h.call('POST', '/api/elvar/connect/google/claim', w.A, { state: st.state })).body.claimed, true, 'A\'s claim still works afterwards');
    } finally { g.restore(); }
  },
  'POST /api/elvar/connect/google/disconnect': async (h, w) => {
    const g = googleNet();
    try {
      const r = await h.call('POST', '/api/elvar/connect/google/disconnect', w.B, {}); assert.deepEqual(r.body, { ok: true, revoked: false, disconnected: false }); assert.equal(g.calls.length, 0, 'nothing was revoked at Google');
      assert.equal((await h.call('GET', '/api/elvar/connect/google/status', w.A)).body.state, 'connected', 'A is still connected');
    } finally { g.restore(); }
  },
  'GET /api/elvar/connectors': async (h, w) => { const r = await h.call('GET', '/api/elvar/connectors', w.B); assert.deepEqual(r.body.connectors, []); noA(r.body, w); },
  'POST /api/elvar/connectors': async (h, w) => {
    const before = await w.snapshotA();
    const r = await h.call('POST', '/api/elvar/connectors', w.B, cxDraft('B-OWN-CONNECTOR', 'B-OWN-TOKEN', 'b-own.example.com')); assert.equal(r.status, 200); noA(r.body, w); assert.notEqual(r.body.connector.id, w.cx.id);
    assert.equal(await w.snapshotA(), before, 'A\'s connectors are unchanged (connectors and slugs never clash across users)');
    assert.equal((await h.call('GET', '/api/elvar/connectors', w.B)).body.connectors.length, 1);
  },
  'GET /api/elvar/connectors/export': async (h, w) => { const r = await h.call('GET', '/api/elvar/connectors/export', w.B); assert.deepEqual(r.body.connectors, []); noA(r.body, w); },
  'POST /api/elvar/connectors/delete-all': async (h, w) => {
    const r = await h.call('POST', '/api/elvar/connectors/delete-all', w.B, { confirm: 'delete' }); assert.equal(r.status, 200); assert.equal(r.body.connectors, 0);
    assert.equal((await h.call('GET', '/api/elvar/connectors', w.A)).body.connectors.length, 1, 'A\'s connector survived B\'s delete-all');
  },
  'GET /api/elvar/connectors/:id': async (h, w) => { const r = await h.call('GET', `/api/elvar/connectors/${w.cx.id}`, w.B); assert.equal(r.status, 404); noA(r.body, w); },
  'PATCH /api/elvar/connectors/:id': async (h, w) => {
    const before = await w.snapshotA();
    const r = await h.call('PATCH', `/api/elvar/connectors/${w.cx.id}`, w.B, { name: 'hijacked', enabled: false, auth: { secret: 'B-REPLACES-A-SECRET' } }); assert.equal(r.status, 404);
    assert.equal(await w.snapshotA(), before, 'A\'s connector (and its secret) is unchanged');
  },
  'DELETE /api/elvar/connectors/:id': async (h, w) => {
    assert.equal((await h.call('DELETE', `/api/elvar/connectors/${w.cx.id}`, w.B)).status, 404);
    assert.equal((await h.call('GET', '/api/elvar/connectors', w.A)).body.connectors.length, 1);
  },
  'POST /api/elvar/connectors/:id/sync': async (h, w) => {
    const real = globalThis.fetch; let touched = 0; globalThis.fetch = async () => { touched++; throw new Error('no network'); };
    try { assert.equal((await h.call('POST', `/api/elvar/connectors/${w.cx.id}/sync`, w.B, {})).status, 404); assert.equal(touched, 0, 'no request went to A\'s host with A\'s secret'); } finally { globalThis.fetch = real; }
  },
  'POST /api/elvar/connectors/:id/oauth/start': async (h, w) => { assert.equal((await h.call('POST', `/api/elvar/connectors/${w.cx.id}/oauth/start`, w.B, {})).status, 404); },
  'POST /api/elvar/connectors/:id/oauth/claim': async (h, w) => { assert.equal((await h.call('POST', `/api/elvar/connectors/${w.cx.id}/oauth/claim`, w.B, { state: 'A'.repeat(43) })).status, 404); },
  'GET /api/elvar/builds': async (h, w) => { const r = await h.call('GET', '/api/elvar/builds', w.B); assert.deepEqual(r.body.builds, []); noA(r.body, w); },
  'DELETE /api/elvar/builds/:id': async (h, w) => {
    assert.equal((await h.call('DELETE', `/api/elvar/builds/${w.build.id}`, w.B)).status, 404);
    assert.equal((await h.call('GET', '/api/elvar/builds', w.A)).body.builds.length, 1, 'A\'s build request is still there');
  },
});

const keyOf = (r) => `${r.method} ${r.path}`;
const testable = ROUTES.filter((r) => isUserAuth(r.auth) && r.auth !== 'cron');
for (const r of testable) {
  test(`cross-user: ${keyOf(r)}`, async () => {
    const c = CASES[keyOf(r)]; assert.ok(c, `no cross-user case for ${keyOf(r)}: add one to test/routes-isolation.test.mjs`);
    const h = await startHarness();
    try { await c(h, await world(h)); } finally { delete process.env.ELVAR_PUBLIC_ORIGIN; await h.stop(); }
  });
}

test('the real route table: every route has a known auth kind; every user / admin route has a cross-user case above; no stale cases; the owner routes are gone', () => {
  const known = (a) => ['none', 'state'].includes(a) || isUserAuth(a);
  assert.deepEqual(ROUTES.filter((r) => !known(r.auth)).map(keyOf), [], 'unknown auth kinds (the old owner kind is gone)');
  assert.deepEqual(testable.filter((r) => !CASES[keyOf(r)]).map(keyOf), [], 'a new user route needs a cross-user test');
  assert.deepEqual(Object.keys(CASES).filter((k) => !ROUTES.some((r) => keyOf(r) === k)), [], 'cases for routes that no longer exist');
  assert.equal(ROUTES.filter((r) => r.auth === 'owner').length, 0);
  assert.ok(ROUTES.filter((r) => r.auth === 'none').every((r) => r.path === '/api/elvar/state'), 'the only public API route is the state page');
  const dup = ROUTES.map(keyOf); assert.equal(new Set(dup).size, dup.length, 'duplicate routes');
});

test('every user / admin route refuses a request without a token and a token of a user that does not exist', async () => {
  const h = await startHarness();
  try {
    const ghost = await h.bearer(crypto.randomUUID());
    for (const r of testable) {
      const path = r.path.replace(':id', '0123456789abcdef');
      assert.equal((await h.call(r.method, path, {}, {})).status, 401, keyOf(r));
      assert.equal((await h.call(r.method, path, ghost, {})).status, 401, keyOf(r) + ' (deleted user)');
    }
  } finally { await h.stop(); }
});
