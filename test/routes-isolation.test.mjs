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
// P4: A's notes (with an older version), conversation, notification box and relay item
const A_NOTE_PATH = 'A-PRIVATE-FOLDER/secret-plan.md', A_NOTE_TEXT = 'A-PRIVATE-NOTE-BODY-12345', A_NOTE_OLD = 'A-PRIVATE-OLDER-VERSION-777', A_MSG = 'A-PRIVATE-MESSAGE-WORDS', A_INBOX = 'A-PRIVATE-INBOX-TITLE', A_RELAY_CT = 'QUFBQS1SRUxBWS1DSVBIRVJURVhU';
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
  const mem = await h.db.asUser(mintVerifiedUid(a, 'test'), async (r) => {
    await r.notes.put({ path: A_NOTE_PATH, content: A_NOTE_OLD }); const note = await r.notes.put({ path: A_NOTE_PATH, content: A_NOTE_TEXT });
    const trashed = await r.notes.put({ path: 'A-PRIVATE-FOLDER/trashed.md', content: 'A-TRASHED-BODY' }); await r.notes.trash(trashed.id);
    const c = await r.messages.append({ turns: [{ role: 'user', text: A_MSG, at: Date.now() }] });
    const msg = (await r.messages.conversation(c.conversationId)).messages[0];
    const inbox = await r.inbox.add({ title: A_INBOX, body: 'A-INBOX-BODY' });
    await r.notif.push([{ id: 'n1-aaaa', at: Date.now(), iv: 'AAAAAAAAAAAAAAAA', ct: A_RELAY_CT }]);
    return { noteId: note.id, trashedId: trashed.id, convId: c.conversationId, msgId: msg.id, inboxId: inbox.id };
  });
  const snapshotA = async () => JSON.stringify([(await h.call('GET', '/api/elvar/config', A)).body, (await h.call('GET', '/api/elvar/profile', A)).body, (await h.call('GET', '/api/elvar/devices', A)).body, (await h.call('GET', '/api/elvar/usage', A)).body,
    (await h.call('GET', '/api/elvar/connect/google/status', A)).body, (await h.call('GET', '/api/elvar/connectors', A)).body, (await h.call('GET', '/api/elvar/builds', A)).body,
    await h.db.asUser(mintVerifiedUid(a, 'test'), async (r) => [await r.notes.list(), await r.notes.list({ trash: true }), await r.notes.revisions(mem.noteId), await r.messages.conversations({}), await r.messages.count(), await r.inbox.list({}), await r.notif.pull({ since: 0 })])]);
  return { a, b, A, B, dev, snapshotA, cx: cx.body.connector, build, mem };
}
const noA = (value, w) => {
  const t = typeof value === 'string' ? value : JSON.stringify(value);
  for (const s of [A_KEY, A_NAME, 'Alice-Secret-Name', 'a-user/private-notes', 'a-phone', w.dev.id, w.dev.token, w.a, A_CLIENT, A_GSECRET, A_REFRESH, A_CX_NAME, A_CX_TOKEN, A_CX_HOST, A_BUILD, A_BUILD_REPO, w.cx.id, w.build.id, A_NOTE_PATH, A_NOTE_TEXT, A_NOTE_OLD, A_MSG, A_INBOX, A_RELAY_CT, 'A-TRASHED-BODY', 'A-INBOX-BODY', w.mem.noteId, w.mem.convId, w.mem.inboxId]) assert.ok(!t.includes(s), `B's answer contains ${s}`);
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

// ---- P4: notes, conversation log, notification box, GitHub mirror. B calls each route with A's ids and A's words and reaches nothing of A's.
const U = (id) => id;
Object.assign(CASES, {
  'GET /api/elvar/notes': async (h, w) => {
    const r = await h.call('GET', '/api/elvar/notes', w.B); assert.deepEqual(r.body.notes, []); noA(r.body, w);
    assert.deepEqual((await h.call('GET', '/api/elvar/notes', w.B, {}, { trash: '1' })).body.notes, [], 'A\'s trash is not B\'s trash');
    const q = await h.call('GET', '/api/elvar/notes', w.B, {}, { q: 'A-PRIVATE-NOTE-BODY-12345 secret-plan' }); assert.deepEqual(q.body.results, [], 'B\'s search finds nothing of A\'s'); noA(q.body, w);
    assert.equal((await h.call('GET', '/api/elvar/notes', w.A, {}, { q: 'A-PRIVATE-NOTE-BODY-12345' })).body.results.length, 1, 'and A finds their own');
  },
  'POST /api/elvar/notes': async (h, w) => {
    const before = await w.snapshotA();
    const r = await h.call('POST', '/api/elvar/notes', w.B, { path: A_NOTE_PATH, content: 'B writes the same path' }); assert.equal(r.status, 200); assert.ok(!JSON.stringify(r.body).includes(A_NOTE_TEXT) && !JSON.stringify(r.body).includes(A_NOTE_OLD)); assert.notEqual(r.body.note.id, w.mem.noteId, 'the same path is a different note');
    assert.equal(await w.snapshotA(), before, 'A\'s note at that path is untouched');
    assert.equal((await h.call('POST', '/api/elvar/notes', w.B, { path: A_NOTE_PATH, content: 'again' })).status, 409);
  },
  'GET /api/elvar/notes/graph': async (h, w) => { const r = await h.call('GET', '/api/elvar/notes/graph', w.B); assert.deepEqual(r.body.nodes, []); noA(r.body, w); },
  'GET /api/elvar/notes/projects': async (h, w) => { const r = await h.call('GET', '/api/elvar/notes/projects', w.B); assert.deepEqual(r.body.projects, []); noA(r.body, w); },
  'POST /api/elvar/notes/trash/empty': async (h, w) => {
    const before = await w.snapshotA(); const r = await h.call('POST', '/api/elvar/notes/trash/empty', w.B, {}); assert.equal(r.body.deleted, 0); assert.equal(await w.snapshotA(), before, 'A\'s trash is untouched');
  },
  'POST /api/elvar/notes/delete-all': async (h, w) => {
    assert.equal((await h.call('POST', '/api/elvar/notes/delete-all', w.B, {})).status, 400, 'needs the confirmation');
    const before = await w.snapshotA(); const r = await h.call('POST', '/api/elvar/notes/delete-all', w.B, { confirm: 'delete' }); assert.equal(r.body.deleted, 0); assert.equal(await w.snapshotA(), before, 'A\'s notes survive B\'s delete-all');
  },
  'GET /api/elvar/notes/:id': async (h, w) => { for (const id of [w.mem.noteId, w.mem.trashedId]) { const r = await h.call('GET', `/api/elvar/notes/${id}`, w.B); assert.equal(r.status, 404); noA(r.body, w); } assert.equal((await h.call('GET', `/api/elvar/notes/${w.mem.noteId}`, w.A)).status, 200); },
  'PUT /api/elvar/notes/:id': async (h, w) => {
    const before = await w.snapshotA(); const r = await h.call('PUT', `/api/elvar/notes/${w.mem.noteId}`, w.B, { content: 'B OVERWRITES A' }); assert.equal(r.status, 404); assert.equal(await w.snapshotA(), before, 'A\'s note is unchanged');
  },
  'DELETE /api/elvar/notes/:id': async (h, w) => {
    const before = await w.snapshotA();
    for (const q of [{}, { permanent: '1' }]) assert.equal((await h.call('DELETE', `/api/elvar/notes/${w.mem.noteId}`, w.B, {}, q)).status, 404);
    assert.equal((await h.call('DELETE', `/api/elvar/notes/${w.mem.trashedId}`, w.B, {}, { permanent: '1' })).status, 404);
    assert.equal(await w.snapshotA(), before, 'A\'s notes are still there');
  },
  'POST /api/elvar/notes/:id/restore': async (h, w) => { const before = await w.snapshotA(); assert.equal((await h.call('POST', `/api/elvar/notes/${w.mem.trashedId}/restore`, w.B, {})).status, 404); assert.equal(await w.snapshotA(), before, 'A\'s trashed note is still in the trash'); },
  'GET /api/elvar/notes/:id/revisions/:rev': async (h, w) => { const r = await h.call('GET', `/api/elvar/notes/${w.mem.noteId}/revisions/1`, w.B); assert.equal(r.status, 404); noA(r.body, w); assert.equal((await h.call('GET', `/api/elvar/notes/${w.mem.noteId}/revisions/1`, w.A)).body.revision.content, A_NOTE_OLD); },
  'POST /api/elvar/notes/:id/revisions/:rev/restore': async (h, w) => { const before = await w.snapshotA(); assert.equal((await h.call('POST', `/api/elvar/notes/${w.mem.noteId}/revisions/1/restore`, w.B, {})).status, 404); assert.equal(await w.snapshotA(), before); },
  'POST /api/elvar/messages': async (h, w) => {
    const before = await w.snapshotA();
    const r = await h.call('POST', '/api/elvar/messages', w.B, { turns: [{ at: Date.now(), user: 'Bの発言 パスワードは hunter2xyz9', model: 'Bへの返事' }] }); assert.equal(r.status, 200); assert.notEqual(r.body.conversationId, w.mem.convId, 'B never joins A\'s conversation');
    assert.equal(await w.snapshotA(), before, 'nothing was added to A\'s log');
    assert.ok(!JSON.stringify((await h.call('GET', '/api/elvar/messages', w.B)).body).includes('hunter2xyz9'), 'secrets are masked before they are stored');
    assert.equal((await h.call('POST', '/api/elvar/messages', w.B, { turns: [] })).status, 400);
  },
  'GET /api/elvar/messages': async (h, w) => {
    const r = await h.call('GET', '/api/elvar/messages', w.B); assert.deepEqual(r.body.messages, []); noA(r.body, w);
    assert.deepEqual((await h.call('GET', '/api/elvar/messages', w.B, {}, { q: 'A-PRIVATE-MESSAGE-WORDS' })).body.messages, [], 'B\'s search finds nothing of A\'s');
    assert.equal((await h.call('GET', '/api/elvar/messages', w.A, {}, { q: 'A-PRIVATE-MESSAGE-WORDS' })).body.messages.length, 1);
  },
  'POST /api/elvar/messages/purge': async (h, w) => {
    const before = await w.snapshotA();
    assert.equal((await h.call('POST', '/api/elvar/messages/purge', w.B, { all: true })).body.deleted, 0);
    assert.equal((await h.call('POST', '/api/elvar/messages/purge', w.B, { before: new Date(Date.now() + 864e5).toISOString() })).body.deleted, 0);
    assert.equal(await w.snapshotA(), before, 'A\'s messages survive B\'s purge');
  },
  'DELETE /api/elvar/messages/:id': async (h, w) => { const before = await w.snapshotA(); assert.equal((await h.call('DELETE', `/api/elvar/messages/${w.mem.msgId}`, w.B)).status, 404); assert.equal(await w.snapshotA(), before); },
  'GET /api/elvar/conversations': async (h, w) => { const r = await h.call('GET', '/api/elvar/conversations', w.B); assert.deepEqual(r.body.conversations, []); noA(r.body, w); },
  'GET /api/elvar/conversations/:id': async (h, w) => { const r = await h.call('GET', `/api/elvar/conversations/${w.mem.convId}`, w.B); assert.equal(r.status, 404); noA(r.body, w); assert.equal((await h.call('GET', `/api/elvar/conversations/${w.mem.convId}`, w.A)).body.conversation.messages[0].text, A_MSG); },
  'DELETE /api/elvar/conversations/:id': async (h, w) => { const before = await w.snapshotA(); assert.equal((await h.call('DELETE', `/api/elvar/conversations/${w.mem.convId}`, w.B)).status, 404); assert.equal(await w.snapshotA(), before); },
  'GET /api/elvar/inbox': async (h, w) => { const r = await h.call('GET', '/api/elvar/inbox', w.B); assert.deepEqual(r.body.items, []); noA(r.body, w); },
  'POST /api/elvar/inbox': async (h, w) => {
    const before = await w.snapshotA(); const r = await h.call('POST', '/api/elvar/inbox', w.B, { title: 'B-INBOX', key: 'x' }); assert.equal(r.status, 200); assert.equal(await w.snapshotA(), before);
    assert.equal((await h.call('POST', '/api/elvar/inbox', w.B, { title: '', kind: 'zzz' })).status, 400);
  },
  'DELETE /api/elvar/inbox': async (h, w) => { const before = await w.snapshotA(); assert.equal((await h.call('DELETE', '/api/elvar/inbox', w.B)).body.deleted, 0); assert.equal(await w.snapshotA(), before, 'A\'s box is not cleared by B'); },
  'POST /api/elvar/inbox/read-all': async (h, w) => { const before = await w.snapshotA(); assert.equal((await h.call('POST', '/api/elvar/inbox/read-all', w.B, {})).body.marked, 0); assert.equal(await w.snapshotA(), before, 'A\'s items stay unread'); },
  'PATCH /api/elvar/inbox/:id': async (h, w) => { const before = await w.snapshotA(); assert.equal((await h.call('PATCH', `/api/elvar/inbox/${w.mem.inboxId}`, w.B, { read: true })).status, 404); assert.equal(await w.snapshotA(), before); },
  'DELETE /api/elvar/inbox/:id': async (h, w) => { const before = await w.snapshotA(); assert.equal((await h.call('DELETE', `/api/elvar/inbox/${w.mem.inboxId}`, w.B)).status, 404); assert.equal(await w.snapshotA(), before); },
  'GET /api/elvar/brain-sync/status': async (h, w) => {
    await h.call('PATCH', '/api/elvar/config', w.A, { settings: { BRAIN_REPO: 'a-user/private-notes' }, secrets: { BRAIN_GITHUB_TOKEN: 'ghp_A_PRIVATE_TOKEN_0000000000' } });
    const r = await h.call('GET', '/api/elvar/brain-sync/status', w.B); assert.deepEqual(r.body, { configured: false, repo: null, mirror: false, unpushed: 0 }); noA(r.body, w);
    const a = await h.call('GET', '/api/elvar/brain-sync/status', w.A); assert.equal(a.body.configured, true); assert.equal(a.body.unpushed, 1, 'A\'s notes are waiting to be mirrored; B sees nothing of it');
  },
  'POST /api/elvar/brain-sync/import': async (h, w) => {
    await h.call('PATCH', '/api/elvar/config', w.A, { settings: { BRAIN_REPO: 'a-user/private-notes' }, secrets: { BRAIN_GITHUB_TOKEN: 'ghp_A_PRIVATE_TOKEN_0000000000' } });
    const real = globalThis.fetch, seen = []; globalThis.fetch = async (u, o = {}) => { seen.push([String(u), o.headers?.authorization]); throw new Error('no network'); };
    try { const r = await h.call('POST', '/api/elvar/brain-sync/import', w.B, {}); assert.equal(r.status, 400); assert.equal(r.body.error, 'not_configured'); assert.deepEqual(seen, [], 'B has no repository and no token: nothing was called, and A\'s token was never used'); } finally { globalThis.fetch = real; }
  },
  'POST /api/elvar/brain-sync/push': async (h, w) => {
    await h.call('PATCH', '/api/elvar/config', w.A, { settings: { BRAIN_REPO: 'a-user/private-notes' }, secrets: { BRAIN_GITHUB_TOKEN: 'ghp_A_PRIVATE_TOKEN_0000000000' } });
    const real = globalThis.fetch, seen = []; globalThis.fetch = async (u, o = {}) => { seen.push([String(u), o.headers?.authorization]); throw new Error('no network'); };
    try { const r = await h.call('POST', '/api/elvar/brain-sync/push', w.B, { force: true }); assert.equal(r.status, 400); assert.deepEqual(seen, []); } finally { globalThis.fetch = real; }
    assert.equal((await w.snapshotA()).includes('ghp_A_PRIVATE'), false);
  },
});
void U;


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
