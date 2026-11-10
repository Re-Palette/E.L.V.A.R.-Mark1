// The signed-in user's endpoints end to end through the real router on MemoryDb with locally signed tokens: session, own keys and settings, profile,
// devices, usage, export, account deletion (grace and immediate), admin (metadata only, suspend) and cron. Cross-user behaviour is in routes-isolation.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startHarness } from './helpers/api-harness.mjs';
import { DEFAULT_PROFILE } from '../shared/profile.js';
import { REGISTRY } from '../server/rights/registry.js';
import { EXPORTERS, exportedFiles } from '../server/rights/export.js';

const withHarness = (fn) => async () => { const h = await startHarness(); try { await fn(h); } finally { await h.stop(); } };
const GEMINI = 'AIzaSyTESTKEY-for-unit-tests-0001';

test('GET /state is public and carries no secret: sign-up policy, captcha site key, where Auth lives', withHarness(async (h) => {
  process.env.ELVAR_TURNSTILE_SITE_KEY = '0x4AAAA-site-key'; process.env.ELVAR_SIGNUP = 'invite';
  try {
    const r = await h.call('GET', '/api/elvar/state');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['captchaSiteKey', 'configured', 'devAuth', 'googleSignIn', 'publishableKey', 'signup', 'supabaseUrl', 'version']);
    assert.equal(r.body.signup, 'invite'); assert.equal(r.body.captchaSiteKey, '0x4AAAA-site-key'); assert.equal(r.body.devAuth, false);
    assert.ok(!JSON.stringify(r.body).includes('service-key'));
  } finally { delete process.env.ELVAR_TURNSTILE_SITE_KEY; delete process.env.ELVAR_SIGNUP; }
}));

test('session: the account is created on first use; a per-user notification key is made once; the platform\'s own AI key never counts as the user\'s', withHarness(async (h) => {
  process.env.GEMINI_API_KEY = 'PLATFORM-OWNER-GEMINI-KEY-0000';
  try {
    const u = h.mkUser('alice@example.test'), hd = await h.bearer(u, { email: 'alice@example.test' });
    const a = await h.call('GET', '/api/elvar/session', hd), b = await h.call('GET', '/api/elvar/session', hd);
    assert.equal(a.status, 200); assert.equal(a.body.user.id, u); assert.equal(a.body.user.email, 'alice@example.test'); assert.equal(a.body.role, 'user');
    assert.deepEqual(a.body.missing, ['GEMINI_API_KEY'], 'the user has no key of their own, whatever the platform environment holds');
    assert.match(a.body.notifSecret, /^[A-Za-z0-9_-]{43}$/); assert.equal(b.body.notifSecret, a.body.notifSecret, 'made once');
    assert.equal(a.body.google.state, 'unconfigured', 'no Google client of their own yet'); assert.ok(!a.body.comingSoon.includes('google') && !a.body.comingSoon.includes('connectors'), 'Google and connected apps are on the platform');
    assert.deepEqual(a.body.profile, JSON.parse(JSON.stringify(DEFAULT_PROFILE)), 'a new user starts from the neutral defaults');
    assert.ok(!JSON.stringify(a.body).includes('PLATFORM-OWNER'));
    const other = h.mkUser(), s2 = await h.call('GET', '/api/elvar/session', await h.bearer(other));
    assert.notEqual(s2.body.notifSecret, a.body.notifSecret, 'another user has another one');
  } finally { delete process.env.GEMINI_API_KEY; }
}));

test('config: the user brings their own keys (write-only, encrypted); settings are validated; nothing platform-owned is shown as theirs', withHarness(async (h) => {
  process.env.GEMINI_API_KEY = 'PLATFORM-OWNER-GEMINI-KEY-0000'; process.env.GROQ_MODEL = 'platform-groq-model'; process.env.BRAIN_REPO = 'owner/private-notes';
  try {
    const u = h.mkUser(), hd = await h.bearer(u);
    const before = await h.call('GET', '/api/elvar/config', hd);
    assert.equal(before.body.secrets.GEMINI_API_KEY.set, false); assert.deepEqual(before.body.missing, ['GEMINI_API_KEY']);
    assert.equal(before.body.settings.GROQ_MODEL.source, 'env', 'a model name is a platform default, shown as such');
    assert.equal(before.body.settings.BRAIN_REPO.value, '', 'the owner\'s personal setting is not inherited');
    assert.ok('GOOGLE_CLIENT_SECRET' in before.body.secrets && 'GOOGLE_CLIENT_ID' in before.body.settings, 'every user enters their OWN Google client (decision O2)');
    assert.ok(!('GOOGLE_REFRESH_TOKEN' in before.body.secrets), 'the refresh token is never typed: it comes from the consent flow');
    assert.ok(!('NOTIF_SECRET' in before.body.secrets), 'internal material is not editable');

    const set = await h.call('PATCH', '/api/elvar/config', hd, { secrets: { GEMINI_API_KEY: ` "${GEMINI}" ` }, settings: { BRAIN_REPO: 'me/my-notes', GROQ_MODEL: 'openai/gpt-oss-20b' } });
    assert.equal(set.status, 200);
    assert.deepEqual({ set: set.body.secrets.GEMINI_API_KEY.set, source: set.body.secrets.GEMINI_API_KEY.source, last4: set.body.secrets.GEMINI_API_KEY.last4 }, { set: true, source: 'app', last4: GEMINI.slice(-4) });
    assert.equal(set.body.settings.BRAIN_REPO.value, 'me/my-notes'); assert.equal(set.body.settings.GROQ_MODEL.source, 'app');
    assert.ok(!JSON.stringify(set.body).includes(GEMINI), 'the key is never returned');
    const stored = await h.db.asUser((await import('../server/db/verified-uid.js')).mintVerifiedUid(u, 'test'), (r) => r.secrets.get('GEMINI_API_KEY'));
    assert.ok(!stored.ct.includes(Buffer.from(GEMINI)), 'stored as ciphertext');
    assert.equal((await h.call('GET', '/api/elvar/config', hd)).body.secrets.GEMINI_API_KEY.set, true);

    for (const [patch, key] of [[{ secrets: { NOT_A_KEY: 'x' } }, 'unknown_key'], [{ secrets: { NOTIF_SECRET: 'x'.repeat(20) } }, 'unknown_key'], [{ secrets: { GOOGLE_REFRESH_TOKEN: 'x'.repeat(20) } }, 'unknown_key'], [{ settings: { GOOGLE_CLIENT_ID: 'bad id with spaces' } }, 'bad_value'],
      [{ settings: { SARASHINA_BASE_URL: 'https://evil.example' } }, 'unknown_key'], [{ settings: { BRAIN_REPO: 'not a repo' } }, 'bad_value'], [{ secrets: { GEMINI_API_KEY: 'has space' } }, 'bad_value'], [{ secrets: { GEMINI_API_KEY: '' } }, 'bad_value']]) {
      const r = await h.call('PATCH', '/api/elvar/config', hd, patch); assert.equal(r.status, 400, JSON.stringify(patch)); assert.equal(r.body.error, key, JSON.stringify(patch));
    }
    assert.equal((await h.call('PATCH', '/api/elvar/config', hd, { settings: { BRAIN_REPO: null }, secrets: { GEMINI_API_KEY: null } })).body.secrets.GEMINI_API_KEY.set, false, 'removing a key removes it');
    assert.equal((await h.call('PATCH', '/api/elvar/config', hd, { settings: {} }, {})).status, 200);
  } finally { delete process.env.GEMINI_API_KEY; delete process.env.GROQ_MODEL; delete process.env.BRAIN_REPO; }
}));

test('config/test and live-token style calls use the USER\'S key, never the platform\'s', withHarness(async (h) => {
  process.env.GEMINI_API_KEY = 'PLATFORM-OWNER-GEMINI-KEY-0000';
  const real = globalThis.fetch, seen = [];
  globalThis.fetch = async (url, o = {}) => { seen.push({ url: String(url), key: o.headers?.['x-goog-api-key'] }); return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const u = h.mkUser(), hd = await h.bearer(u);
    assert.equal((await h.call('POST', '/api/elvar/config/test', hd, { name: 'GEMINI_API_KEY' })).body.status, 'fail', 'no key of their own: nothing is called');
    assert.equal(seen.length, 0, 'no call went out with the platform key');
    await h.call('PATCH', '/api/elvar/config', hd, { secrets: { GEMINI_API_KEY: GEMINI } });
    const t = await h.call('POST', '/api/elvar/config/test', hd, { name: 'GEMINI_API_KEY' });
    assert.equal(t.body.status, 'ok'); assert.deepEqual(seen.map((s) => s.key), [GEMINI]);
    assert.equal((await h.call('POST', '/api/elvar/config/test', hd, { name: 'GROQ_API_KEY' })).body.status, 'fail');
    assert.equal((await h.call('POST', '/api/elvar/config/test', hd, { name: 'NOT_A_KEY' })).status, 400);
    for (let i = 0; i < 12; i++) await h.call('POST', '/api/elvar/config/test', hd, { name: 'GEMINI_API_KEY' });
    assert.equal((await h.call('POST', '/api/elvar/config/test', hd, { name: 'GEMINI_API_KEY' })).status, 429, 'a per-user rate limit');
  } finally { globalThis.fetch = real; delete process.env.GEMINI_API_KEY; }
}));

test('profile: a user has their own persona (principle 2); invalid input is a 422 with field errors', withHarness(async (h) => {
  const u = h.mkUser(), hd = await h.bearer(u);
  const cur = (await h.call('GET', '/api/elvar/profile', hd)).body.profile;
  const next = structuredClone(cur); next.owner.name = 'Alice'; next.owner.address = 'アリス様'; next.assistant.displayName = 'ALICE-BOT'; next.assistant.voice = 'Puck';
  const put = await h.call('PUT', '/api/elvar/profile', hd, { profile: next });
  assert.equal(put.status, 200, JSON.stringify(put.body)); assert.equal(put.body.profile.assistant.displayName, 'ALICE-BOT');
  const s = (await h.call('GET', '/api/elvar/session', hd)).body;
  assert.equal(s.brand.name, 'ALICE-BOT'); assert.equal(s.brand.ownerAddress, 'アリス様'); assert.equal(s.profile.assistant.voice, 'Puck');
  const bad = structuredClone(cur); bad.locale.timeZone = 'Not/AZone';
  const r = await h.call('PUT', '/api/elvar/profile', hd, { profile: bad }); assert.equal(r.status, 422); assert.ok(r.body.errors);
  const b = await h.bearer(h.mkUser());
  assert.equal((await h.call('GET', '/api/elvar/profile', b)).body.profile.assistant.displayName, DEFAULT_PROFILE.assistant.displayName, 'another user keeps the defaults');
}));

test('devices: a token is shown once and only its hash is kept; scopes are validated; at most 10; revoke works', withHarness(async (h) => {
  const u = h.mkUser(), hd = await h.bearer(u);
  const made = await h.call('POST', '/api/elvar/devices', hd, { name: 'My phone', scopes: ['notif:push'] });
  assert.equal(made.status, 200); assert.match(made.body.token, /^elv2\.[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/); assert.deepEqual(made.body.scopes, ['notif:push']);
  const list = (await h.call('GET', '/api/elvar/devices', hd)).body.devices;
  assert.equal(list.length, 1); assert.ok(!JSON.stringify(list).includes(made.body.token.split('.')[2])); assert.deepEqual(Object.keys(list[0]).sort(), ['createdAt', 'id', 'lastSeenAt', 'name', 'scopes']);
  assert.equal((await h.call('POST', '/api/elvar/devices', hd, { name: '', scopes: ['notif:push'] })).status, 400);
  assert.equal((await h.call('POST', '/api/elvar/devices', hd, { name: 'x', scopes: ['everything'] })).status, 400);
  assert.equal((await h.call('POST', '/api/elvar/devices', hd, { name: 'x', scopes: [] })).status, 400);
  assert.equal((await h.call('DELETE', `/api/elvar/devices/${made.body.id}`, hd)).status, 200);
  assert.equal((await h.call('DELETE', `/api/elvar/devices/${made.body.id}`, hd)).status, 404);
  assert.equal((await h.call('DELETE', '/api/elvar/devices/not-an-id', hd)).status, 404);
  for (let i = 0; i < 10; i++) assert.equal((await h.call('POST', '/api/elvar/devices', hd, { name: 'd' + i })).status, 200);
  const eleventh = await h.call('POST', '/api/elvar/devices', hd, { name: 'one too many' }); assert.equal(eleventh.status, 409); assert.equal(eleventh.body.error, 'too_many_devices');
}));

test('usage: the user sees their own numbers only', withHarness(async (h) => {
  const { mintVerifiedUid } = await import('../server/db/verified-uid.js');
  const a = h.mkUser(), b = h.mkUser();
  await h.db.asUser(mintVerifiedUid(a, 'test'), async (r) => { await r.usage.record({ provider: 'gemini', metric: 'calls', amount: 3 }); await r.usage.record({ provider: 'gemini', metric: 'live_seconds', amount: 90, source: 'client' }); });
  const ua = (await h.call('GET', '/api/elvar/usage', await h.bearer(a))).body, ub = (await h.call('GET', '/api/elvar/usage', await h.bearer(b))).body;
  assert.deepEqual(ua.daily.map((x) => [x.metric, x.amount]).sort(), [['calls', 3], ['live_seconds', 90]]); assert.deepEqual(ub.daily, []);
  assert.equal(ua.quotaBytes, 524288000);
}));

test('export: needs a recent sign-in; one file per registry entry; no key values, ciphertext, hashes or tokens leave', withHarness(async (h) => {
  const u = h.mkUser('alice@example.test'), old = await h.bearer(u, { email: 'alice@example.test' }, { iat: Math.floor(Date.now() / 1000) - 3000 });
  const r0 = await h.call('GET', '/api/elvar/account/export', old); assert.deepEqual(r0, { status: 401, body: { error: 'reauth_required' } });
  const hd = await h.bearer(u, { email: 'alice@example.test' });
  await h.call('PATCH', '/api/elvar/config', hd, { secrets: { GEMINI_API_KEY: GEMINI }, settings: { BRAIN_REPO: 'me/notes' } });
  const dev = (await h.call('POST', '/api/elvar/devices', hd, { name: 'p' })).body;
  const r = await h.call('GET', '/api/elvar/account/export', hd);
  assert.equal(r.status, 200); assert.match(r.headers['content-disposition'], /attachment/);
  assert.deepEqual(Object.keys(r.body.files).sort(), exportedFiles());
  const text = JSON.stringify(r.body);
  for (const secret of [GEMINI, dev.token, dev.token.split('.')[2]]) assert.ok(!text.includes(secret), 'a secret left in the export');
  assert.ok(!/token_hash|"ct"|"iv"|wrapped/.test(text));
  assert.equal(r.body.files['settings.json'].settings.BRAIN_REPO, 'me/notes'); assert.equal(r.body.files['secrets.json'].secrets.find((s) => s.name === 'GEMINI_API_KEY').last4, GEMINI.slice(-4));
  assert.equal(r.body.user.email, 'alice@example.test');
  for (let i = 0; i < 2; i++) await h.call('GET', '/api/elvar/account/export', hd);
  assert.equal((await h.call('GET', '/api/elvar/account/export', hd)).status, 429, '3 a day');
}));

test('the exporter covers every registered table that is exported (a new table cannot be added without deciding what leaves with the user)', () => {
  const files = new Set(REGISTRY.map((e) => e.exportAs).filter((f) => f !== 'none'));
  assert.deepEqual([...files].sort(), Object.keys(EXPORTERS).sort(), 'registry exportAs files and exporters differ');
  for (const e of REGISTRY) if (e.exportAs === 'none') assert.ok(!files.has('none'));
});

test('delete with a 7-day grace period: pending at once, every session and device ends, signing in again offers to cancel; the grace period is honoured by cron', withHarness(async (h) => {
  const u = h.mkUser('alice@example.test'), hd = await h.bearer(u, { email: 'alice@example.test' });
  await h.call('GET', '/api/elvar/session', hd); await h.call('POST', '/api/elvar/devices', hd, { name: 'p' });
  assert.equal((await h.call('POST', '/api/elvar/account/delete', hd, { graceDays: 3 })).status, 422);
  assert.equal((await h.call('POST', '/api/elvar/account/delete', hd, {})).status, 422);
  const old = await h.bearer(u, {}, { iat: Math.floor(Date.now() / 1000) - 3000 });
  assert.equal((await h.call('POST', '/api/elvar/account/delete', old, { graceDays: 7 })).body.error, 'reauth_required');
  const r = await h.call('POST', '/api/elvar/account/delete', hd, { graceDays: 7 });
  assert.equal(r.status, 200); assert.equal(r.body.pending, true); assert.equal(r.body.graceDays, 7); assert.ok(new Date(r.body.purgeAfter) > new Date(Date.now() + 6 * 86400_000));
  assert.ok(h.calls.some((c) => /\/auth\/v1\/logout\?scope=global/.test(c.url)), 'global sign-out was requested');
  assert.deepEqual((await h.call('GET', '/api/elvar/devices', hd)).body, { error: 'account_pending_deletion' });
  assert.equal((await h.call('GET', '/api/elvar/session', hd)).body.error, 'account_pending_deletion');
  const st = await h.call('GET', '/api/elvar/account/deletion', hd); assert.equal(st.body.status, 'pending_deletion'); assert.equal(st.body.deletion.graceDays, 7);
  // an old session cannot cancel (review fix): it must sign in again first
  assert.equal((await h.call('POST', '/api/elvar/account/delete/cancel', old)).body.error, 'reauth_required');
  assert.equal((await h.call('GET', '/api/elvar/account/deletion', hd)).body.status, 'pending_deletion', 'still pending');
  // the user signs in again during the grace period and cancels
  assert.equal((await h.call('POST', '/api/elvar/account/delete/cancel', hd)).body.cancelled, true);
  assert.equal((await h.call('GET', '/api/elvar/session', hd)).status, 200);
  assert.equal((await h.call('POST', '/api/elvar/account/delete/cancel', hd)).status, 409, 'nothing left to cancel');
  assert.equal((await h.call('GET', '/api/elvar/devices', hd)).body.devices.length, 0, 'devices stay revoked');
  // delete again and let the grace period pass: cron purges (the Auth admin API is called, every row is gone, a receipt without user id is kept)
  await h.call('POST', '/api/elvar/account/delete', hd, { graceDays: 7 });
  const cron = { authorization: 'Bearer ' + 'c'.repeat(32) };
  assert.equal((await h.call('GET', '/api/elvar/cron/daily', cron)).body.purge.purged, 0, 'not due yet');
  h.db.testing.advance(7 * 86400_000 + 1000);
  const run = await h.call('GET', '/api/elvar/cron/daily', cron);
  assert.deepEqual(run.body.purge, { purged: 1, failed: 0 });
  assert.ok(h.calls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/auth/v1/admin/users/${u}`) && c.auth === 'Bearer service-key-for-tests'));
  assert.equal(h.db.testing.receipts().length, 1); assert.ok(!JSON.stringify(h.db.testing.receipts()).includes(u));
  assert.equal((await h.call('GET', '/api/elvar/session', await h.bearer(u))).body.error, 'account_deleted');
}));

test('delete immediately: the account, its keys and every row are gone before the answer; the other user is untouched', withHarness(async (h) => {
  const a = h.mkUser('a@example.test'), b = h.mkUser('b@example.test'), ha = await h.bearer(a, { email: 'a@example.test' }), hb = await h.bearer(b, { email: 'b@example.test' });
  for (const hd of [ha, hb]) { await h.call('PATCH', '/api/elvar/config', hd, { secrets: { GEMINI_API_KEY: GEMINI + Math.random() } }); await h.call('POST', '/api/elvar/devices', hd, { name: 'p' }); }
  const r = await h.call('POST', '/api/elvar/account/delete', ha, { graceDays: 0 });
  assert.deepEqual(r.body, { deleted: true });
  const { residualCheck } = await import('../server/rights/residual.js'), { mintVerifiedUid } = await import('../server/db/verified-uid.js');
  assert.equal((await residualCheck(h.db, mintVerifiedUid(a, 'purge'))).clean, true);
  assert.equal((await residualCheck(h.db, mintVerifiedUid(b, 'purge'))).clean, false, 'B still has data');
  assert.equal((await h.call('GET', '/api/elvar/config', hb)).body.secrets.GEMINI_API_KEY.set, true);
  assert.equal(h.db.testing.receipts().length, 1);
}));

test('admin: metadata only; needs the claim AND the table row; suspend / lift are recorded and enforced; never an admin, never oneself', withHarness(async (h) => {
  const admin = h.mkUser('root@example.test'), alice = h.mkUser('alice@example.test'), ha = await h.adminBearer(admin), hu = await h.bearer(alice, { email: 'alice@example.test' });
  await h.call('PATCH', '/api/elvar/config', hu, { secrets: { GEMINI_API_KEY: GEMINI } }); await h.call('GET', '/api/elvar/session', await h.bearer(admin, { app_metadata: { elvar_role: 'admin' } }));
  assert.equal((await h.call('GET', '/api/elvar/admin/users', hu)).status, 403, 'a user is not an admin');
  assert.equal((await h.call('GET', '/api/elvar/admin/users', await h.bearer(h.mkUser(), { app_metadata: { elvar_role: 'admin' } }))).status, 403, 'the claim alone is not enough');
  const list = (await h.call('GET', '/api/elvar/admin/users', ha)).body.users;
  const row = list.find((x) => x.userId === alice);
  assert.deepEqual(Object.keys(row).sort(), ['appliedLimits', 'calls30d', 'callsToday', 'createdAt', 'email', 'hardLimits', 'isAdmin', 'lastSignInAt', 'liveSecondsToday', 'status', 'storageQuotaBytes', 'storageUsedBytes', 'suspendedReason', 'userId']);
  assert.ok(!JSON.stringify(list).includes(GEMINI) && !/profile|settings|secret|ct|token/i.test(Object.keys(row).join(',')), 'no content, no secrets');
  assert.equal(row.email, 'alice@example.test'); assert.equal(row.status, 'active');
  const old = await h.adminBearer(admin); void old;
  const stale = await h.bearer(admin, { app_metadata: { elvar_role: 'admin' } }, { iat: Math.floor(Date.now() / 1000) - 3000 });
  assert.equal((await h.call('POST', `/api/elvar/admin/users/${alice}/suspend`, stale, { reason: 'x' })).body.error, 'reauth_required');
  const s = await h.call('POST', `/api/elvar/admin/users/${alice}/suspend`, ha, { reason: 'spam' });
  assert.deepEqual(s.body, { status: 'suspended', banApplied: true });
  assert.ok(h.calls.some((c) => c.method === 'PUT' && c.url.endsWith(`/admin/users/${alice}`) && c.body.ban_duration === '876000h'));
  assert.equal((await h.call('GET', '/api/elvar/session', hu)).body.error, 'account_suspended', 'enforced by the API at once on this instance');
  const log = await h.db.asUser((await import('../server/db/verified-uid.js')).mintVerifiedUid(alice, 'test'), (r) => r.audit.list());
  assert.ok(log.some((x) => x.action === 'account.suspended' && x.actor === 'admin' && x.actorId === admin), 'the user can see it');
  assert.equal((await h.call('POST', `/api/elvar/admin/users/${alice}/unsuspend`, ha)).body.status, 'active');
  assert.equal((await h.call('GET', '/api/elvar/session', hu)).status, 200);
  assert.equal((await h.call('POST', `/api/elvar/admin/users/${admin}/suspend`, ha, {})).body.error, 'not_yourself');
  const admin2 = h.mkUser('root2@example.test'); await h.adminBearer(admin2);
  assert.equal((await h.call('POST', `/api/elvar/admin/users/${admin2}/suspend`, ha, {})).status, 403, 'not another admin');
  assert.equal((await h.call('POST', '/api/elvar/admin/users/not-a-uuid/suspend', ha, {})).status, 404);
  assert.equal((await h.call('POST', `/api/elvar/admin/users/${crypto.randomUUID()}/suspend`, ha, {})).status, 404);
}));

test('cron: only with CRON_SECRET; sweeps expired rows; bootstrap admin needs the confirmed account with that e-mail', withHarness(async (h) => {
  const cron = { authorization: 'Bearer ' + 'c'.repeat(32) };
  assert.equal((await h.call('GET', '/api/elvar/cron/daily', {})).status, 401);
  assert.equal((await h.call('GET', '/api/elvar/cron/daily', { authorization: 'Bearer nope' + 'c'.repeat(28) })).status, 401);
  process.env.ELVAR_BOOTSTRAP_ADMIN_EMAIL = 'boss@example.test';
  try {
    const none = await h.call('GET', '/api/elvar/cron/daily', cron); assert.deepEqual(none.body.admin, { granted: false });
    const boss = h.mkUser('boss@example.test'); h.db.testing.setConfirmed(boss, false);
    assert.deepEqual((await h.call('GET', '/api/elvar/cron/daily', cron)).body.admin, { granted: false }, 'unconfirmed e-mail: no');
    h.db.testing.setConfirmed(boss, true);
    assert.deepEqual((await h.call('POST', '/api/elvar/cron/daily', cron)).body.admin, { granted: true });
    assert.ok(h.calls.some((c) => c.method === 'PUT' && c.url.endsWith(`/admin/users/${boss}`) && c.body.app_metadata?.elvar_role === 'admin'), 'the signed claim is set through the Auth admin API');
    const bossToken = await h.bearer(boss, { app_metadata: { elvar_role: 'admin' } });
    assert.equal((await h.call('GET', '/api/elvar/admin/users', bossToken)).status, 200);
  } finally { delete process.env.ELVAR_BOOTSTRAP_ADMIN_EMAIL; }
}));

test('P3 features answer for the caller only: a fresh user has no Google client and no connectors; the callbacks need a valid single-use state', withHarness(async (h) => {
  const hd = await h.bearer(h.mkUser());
  const st = await h.call('GET', '/api/elvar/connect/google/status', hd); assert.equal(st.status, 200); assert.equal(st.body.state, 'unconfigured'); assert.equal(st.body.configured, false); assert.equal(st.body.clientIdSet, false);
  assert.equal((await h.call('POST', '/api/elvar/connect/google/start', hd, {})).body.error, 'client_missing');
  assert.deepEqual((await h.call('GET', '/api/elvar/connectors', hd)).body.connectors, []);
  assert.equal((await h.call('GET', '/api/elvar/connectors/abc', hd)).status, 404);
  const cb = await h.call('GET', '/api/google/callback', {}); assert.equal(cb.status, 403); assert.match(cb.html, /無効/);
  assert.equal((await h.call('GET', '/api/elvar/oauth/callback', {}, {}, { state: 'x' })).status, 403);
  assert.equal((await h.call('POST', '/api/elvar/connectors', {})).status, 401, 'and they need a login like everything else');
}));

