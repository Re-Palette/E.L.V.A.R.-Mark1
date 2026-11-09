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

/** Two users with data: A has a key, a setting, a persona, a device, usage. */
async function world(h) {
  const a = h.mkUser('a@example.test'), b = h.mkUser('b@example.test');
  const A = await h.bearer(a, { email: 'a@example.test' }), B = await h.bearer(b, { email: 'b@example.test' });
  await h.call('PATCH', '/api/elvar/config', A, { secrets: { GEMINI_API_KEY: A_KEY }, settings: { BRAIN_REPO: 'a-user/private-notes' } });
  const prof = structuredClone((await h.call('GET', '/api/elvar/profile', A)).body.profile); prof.assistant.displayName = A_NAME; prof.owner.name = 'Alice-Secret-Name';
  await h.call('PUT', '/api/elvar/profile', A, { profile: prof });
  const dev = (await h.call('POST', '/api/elvar/devices', A, { name: 'a-phone' })).body;
  await h.db.asUser(mintVerifiedUid(a, 'test'), (r) => r.usage.record({ provider: 'gemini', metric: 'calls', amount: 7 }));
  await h.call('GET', '/api/elvar/session', A); await h.call('GET', '/api/elvar/session', B);
  const snapshotA = async () => JSON.stringify([(await h.call('GET', '/api/elvar/config', A)).body, (await h.call('GET', '/api/elvar/profile', A)).body, (await h.call('GET', '/api/elvar/devices', A)).body, (await h.call('GET', '/api/elvar/usage', A)).body]);
  return { a, b, A, B, dev, snapshotA };
}
const noA = (value, w) => { const t = typeof value === 'string' ? value : JSON.stringify(value); for (const s of [A_KEY, A_NAME, 'Alice-Secret-Name', 'a-user/private-notes', 'a-phone', w.dev.id, w.dev.token, w.a]) assert.ok(!t.includes(s), `B's answer contains ${s}`); };

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
// the not-yet-available features: B calling with A-looking ids gets the same fixed answer, no data
for (const [m, p] of [['GET', '/api/elvar/connect/google/status'], ['POST', '/api/elvar/connect/google/start'], ['POST', '/api/elvar/connect/google/claim'], ['POST', '/api/elvar/connect/google/disconnect'],
  ['GET', '/api/elvar/connectors'], ['POST', '/api/elvar/connectors'], ['GET', '/api/elvar/connectors/export'], ['POST', '/api/elvar/connectors/delete-all'], ['GET', '/api/elvar/connectors/:id'], ['PATCH', '/api/elvar/connectors/:id'],
  ['DELETE', '/api/elvar/connectors/:id'], ['POST', '/api/elvar/connectors/:id/sync'], ['POST', '/api/elvar/connectors/:id/oauth/start'], ['POST', '/api/elvar/connectors/:id/oauth/claim']]) {
  CASES[`${m} ${p}`] = async (h, w) => { const r = await h.call(m, p.replace(':id', 'a-connector-id'), w.B, {}); assert.ok([200, 503].includes(r.status)); assert.ok(r.body.comingSoon || r.body.error === 'coming_soon', p); noA(r.body, w); };
}

const keyOf = (r) => `${r.method} ${r.path}`;
const testable = ROUTES.filter((r) => isUserAuth(r.auth) && r.auth !== 'cron');
for (const r of testable) {
  test(`cross-user: ${keyOf(r)}`, async () => {
    const c = CASES[keyOf(r)]; assert.ok(c, `no cross-user case for ${keyOf(r)}: add one to test/routes-isolation.test.mjs`);
    const h = await startHarness();
    try { await c(h, await world(h)); } finally { await h.stop(); }
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
