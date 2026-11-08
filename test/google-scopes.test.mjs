// Scope selection per product, and the tools offered / allowed by the scopes Google actually granted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVICES, SERVICE_IDS, SCOPES, parseServices, scopesFor, googleToolAllowed, googleConfig, googleConfigured, googleReauthRequired, googleState } from '../server/google/config.js';
import { TOOLS, declarations } from '../server/google/tools.js';
import { executeGoogle } from '../server/google/index.js';
import { envConfig, runWithConfig } from '../server/config/resolve.js';
import { buildHudData } from '../server/hud-data.js';

const KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_API_MOCK_ORIGIN'];
async function withLogin(google, fn, env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs' }) {
  const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k]; Object.assign(process.env, env);
  try { return await runWithConfig({ ...envConfig(), google }, fn); }
  finally { for (const k of KEYS) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}
const login = (scopes, extra = {}) => ({ refreshToken: 'rt', clientId: 'cid', scopes, status: 'connected', ...extra });
const names = (opts) => declarations(opts).map((d) => d.name);

test('products -> scopes: full or read-only, in catalogue order; unknown ids are ignored; empty = everything', () => {
  assert.deepEqual(parseServices(''), SERVICE_IDS); assert.deepEqual(parseServices(undefined), SERVICE_IDS);
  assert.deepEqual(parseServices('tasks,calendar,evil'), ['calendar', 'tasks']);
  assert.deepEqual(scopesFor({ services: 'calendar,gmail' }), ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/gmail.modify']);
  assert.deepEqual(scopesFor({ services: ['calendar', 'gmail'], readonly: true }), ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/gmail.readonly']);
  assert.deepEqual(scopesFor({}), SCOPES);
  assert.equal(scopesFor({ services: 'contacts', readonly: true })[0], 'https://www.googleapis.com/auth/contacts.readonly');
});

test('every Google tool belongs to a product, and a write tool needs the FULL scope while a read tool also works with the read-only one', () => {
  const google = TOOLS.filter((t) => /^(calendar|gmail|drive|sheets|docs|tasks|contacts)_/.test(t.name));
  assert.ok(google.length >= 25);
  const ro = new Set(SERVICES.map((s) => s.read)), full = new Set(SERVICES.map((s) => s.write));
  for (const t of google) {
    assert.equal(googleToolAllowed(t, full), true, t.name);
    assert.equal(googleToolAllowed(t, ro), t.kind === 'read' || t.name.startsWith('contacts_'), `${t.name} (${t.kind}) with read-only scopes`);
    assert.equal(googleToolAllowed(t, new Set()), false, t.name + ' with nothing granted');
    assert.equal(googleToolAllowed(t, null), true, 'unknown scopes (env login) filter nothing');
  }
  for (const t of TOOLS.filter((x) => !google.includes(x))) assert.equal(googleToolAllowed(t, new Set()), true, t.name + ' is not a Google product tool');
});

test('declarations: only the tools of the granted products are offered to the voice model', async () => {
  await withLogin(login(['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/tasks.readonly']), () => {
    const n = names();
    assert.ok(n.includes('calendar_create_event') && n.includes('calendar_list_events') && n.includes('tasks_list'));
    assert.ok(!n.includes('tasks_create') && !n.includes('tasks_delete'), 'tasks are read-only');
    assert.ok(!n.some((x) => /^(gmail|drive|sheets|docs|contacts)_/.test(x)), 'products that were not granted are not offered');
    assert.ok(n.includes('current_datetime'), 'tools that are not Google products stay');
  });
  await withLogin(login(SCOPES), () => { assert.ok(['gmail_send', 'drive_share', 'sheets_update', 'docs_append_text', 'contacts_search'].every((x) => names().includes(x))); });
  await withLogin(null, () => { assert.ok(names().includes('gmail_send'), 'an environment-variable login (no scope list) offers everything'); }, { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REFRESH_TOKEN: 'rt' });
});

test('executeGoogle: a tool of a product that was not granted is refused with a clear message, before anything reaches Google', async () => {
  await withLogin(login(['https://www.googleapis.com/auth/calendar.readonly']), async () => {
    const r = await executeGoogle({ tool: 'gmail_search', args: { query: 'a' } }); assert.equal(r.status, 403); assert.match(r.body.error, /Gmail.*許可されていません/);
    const w = await executeGoogle({ tool: 'calendar_delete_event', args: { eventId: 'x' } }); assert.equal(w.status, 403, 'read-only calendar: writes are refused too'); assert.match(w.body.error, /カレンダー/);
  });
});

test('login state: client only / connected / reauth_required; a login issued for another client id is not used', async () => {
  await withLogin(null, () => { assert.equal(googleState(), 'client_only'); assert.equal(googleConfigured(), false); });
  await withLogin(null, () => assert.equal(googleState(), 'unconfigured'), {});
  await withLogin(login(SCOPES), () => { assert.equal(googleState(), 'connected'); assert.equal(googleConfig().refreshToken, 'rt'); assert.equal(googleConfig().fromVault, true); });
  await withLogin(login(SCOPES, { status: 'reauth_required', reason: 'invalid_grant' }), () => { assert.equal(googleState(), 'reauth_required'); assert.equal(googleReauthRequired(), true); });
  await withLogin(login(SCOPES, { clientId: 'old-client' }), () => { assert.equal(googleConfig().refreshToken, ''); assert.equal(googleState(), 'reauth_required'); assert.equal(googleConfig().reauthReason, 'client_changed'); });
  await withLogin(login(SCOPES, { clientId: 'old-client' }), () => { assert.equal(googleConfig().refreshToken, 'env-rt', 'the env token is used when the vault login belongs to another client'); assert.equal(googleState(), 'connected'); }, { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REFRESH_TOKEN: 'env-rt' });
});

test('hud data tells the app that a reconnect is needed', async () => {
  const real = globalThis.fetch; globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });
  try {
    await withLogin(login(SCOPES, { status: 'reauth_required' }), async () => { const d = await buildHudData({ now: Date.now() }); assert.equal(d.googleReauth, true); assert.equal(d.google, true); });
    await withLogin(login(SCOPES), async () => { assert.equal((await buildHudData({ now: Date.now() })).googleReauth, false); });
  } finally { globalThis.fetch = real; }
});
