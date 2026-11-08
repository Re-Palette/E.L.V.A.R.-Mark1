// The /api/elvar/* router and handlers, driven the way the Vercel function / local server drive them. Memory store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetStore, getStore } from '../server/store/index.js';
import { routeElvar, ROUTES } from '../server/router.js';
import { _setKdfForTests } from '../server/config/auth.js';
import { _clearWarmCache } from '../server/config/resolve.js';
import { DEFAULT_PROFILE } from '../server/profile/defaults.js';
import handler from '../api/elvar.js';
import { startFlow } from '../server/oauth/flow.js';

_setKdfForTests({ N: 2 ** 10, r: 8, p: 1 });
const PW = 'correct horse battery';
const TOUCH = ['ELVAR_ACCESS_TOKEN', 'ELVAR_SETUP_CODE', 'VERCEL', 'GEMINI_API_KEY', 'GROQ_API_KEY'];
const CODE = 'TEST-CODE-0001';   // a fixed setup code (ELVAR_SETUP_CODE) for the tests that do not read it from the log

async function fresh(fn, env0 = {}) {
  const old = Object.fromEntries(TOUCH.map((k) => [k, process.env[k]]));
  for (const k of TOUCH) delete process.env[k];
  Object.assign(process.env, { ELVAR_SETUP_CODE: CODE }, env0);
  for (const [k, v] of Object.entries(env0)) if (v === undefined) delete process.env[k];
  resetStore(); _clearWarmCache();
  const logs = []; const realLog = console.log; console.log = (...a) => logs.push(a.join(' '));
  try { return await fn({ logs }); }
  finally { console.log = realLog; for (const k of TOUCH) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } resetStore(); _clearWarmCache(); }
}
const mk = (method, token, ip = '127.0.0.1', extra = {}) => ({ method, headers: { host: 'localhost:8787', ...(['POST', 'PUT', 'PATCH'].includes(method) ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-elvar-token': token } : {}), ...extra }, socket: { remoteAddress: ip } });
const call = (method, pathname, { token, body, query, ip, headers } = {}) => routeElvar(mk(method, token, ip, headers), { pathname, body, query });
async function owner() { const r = await call('POST', '/api/elvar/setup/claim', { body: { setupCode: CODE, password: PW, deviceName: 'PC' } }); assert.equal(r.status, 200); return r.body.token; }

test('route table: unknown path 404, wrong method 405, every route is registered once', () => fresh(async () => {
  assert.equal((await call('GET', '/api/elvar/nope')).status, 404);
  assert.equal((await call('POST', '/api/elvar/state')).status, 405);
  assert.equal((await call('GET', '/api/elvar/devices/abc')).status, 405);
  const keys = ROUTES.map((r) => r.method + ' ' + r.path); assert.equal(new Set(keys).size, keys.length);
  for (const must of ['GET /api/elvar/state', 'POST /api/elvar/setup/claim', 'POST /api/elvar/auth/login', 'GET /api/elvar/config', 'PATCH /api/elvar/config', 'GET /api/elvar/profile', 'PUT /api/elvar/profile', 'GET /api/elvar/session', 'DELETE /api/elvar/devices/:id']) assert.ok(keys.includes(must), must);
}));

test('owner routes answer 401 without a valid device token; open routes need none', () => fresh(async () => {
  const token = await owner();
  for (const [m, p] of [['GET', '/api/elvar/config'], ['PATCH', '/api/elvar/config'], ['GET', '/api/elvar/profile'], ['PUT', '/api/elvar/profile'], ['GET', '/api/elvar/session'], ['GET', '/api/elvar/devices'], ['POST', '/api/elvar/auth/logout']]) {
    assert.equal((await call(m, p, { ip: '203.0.113.5' })).status, 401, `${m} ${p} without a token`);
    assert.equal((await call(m, p, { token: token.slice(0, -2) + 'AA', ip: '203.0.113.5' })).status, 401, `${m} ${p} with a wrong token`);
    assert.equal((await call(m, p, { ip: '127.0.0.1' })).status, 401, `${m} ${p} from loopback after setup`);
  }
  assert.equal((await call('GET', '/api/elvar/state', { ip: '203.0.113.5' })).status, 200);
}));

test('full setup flow: state -> claim -> save the Gemini key (write-only) -> profile -> session', () => fresh(async ({ logs }) => {
  const s0 = await call('GET', '/api/elvar/state', { ip: '203.0.113.5' }); assert.equal(s0.body.initialized, false); assert.equal(s0.body.setupCodeRequired, true);
  const code = logs.join('\n').match(/SETUP CODE: ([A-Z0-9-]{9})/)[1];
  const bad = await call('POST', '/api/elvar/setup/claim', { ip: '203.0.113.5', body: { setupCode: 'WRONG-CODE', password: PW } }); assert.equal(bad.status, 403);
  const claim = await call('POST', '/api/elvar/setup/claim', { ip: '203.0.113.5', body: { setupCode: code, password: PW, deviceName: 'Laptop' } });
  assert.equal(claim.status, 200); const token = claim.body.token;

  const c0 = await call('GET', '/api/elvar/config', { token }); assert.equal(c0.status, 200);
  assert.equal(c0.body.mode, 'vault'); assert.equal(c0.body.writable, true); assert.deepEqual(c0.body.missing, ['GEMINI_API_KEY']);
  assert.deepEqual([c0.body.secrets.GEMINI_API_KEY.set, c0.body.secrets.GEMINI_API_KEY.last4], [false, null]);

  const KEY = 'AIzaFAKE-KEY-0123456789abcdWXYZ';
  const p = await call('PATCH', '/api/elvar/config', { token, body: { secrets: { GEMINI_API_KEY: KEY }, settings: { GROQ_MODEL: 'my-model' } } });
  assert.equal(p.status, 200);
  assert.deepEqual(p.body.secrets.GEMINI_API_KEY, { set: true, source: 'app', last4: 'WXYZ', label: 'Gemini API key', group: 'gemini', testable: true });
  assert.equal(p.body.settings.GROQ_MODEL.value, 'my-model'); assert.equal(p.body.settings.GROQ_MODEL.source, 'app'); assert.deepEqual(p.body.missing, []);
  // write-only: the value is in no response, no log line, and not in the store in the clear
  const everything = JSON.stringify([p.body, (await call('GET', '/api/elvar/config', { token })).body, (await call('GET', '/api/elvar/session', { token })).body, (await call('GET', '/api/elvar/profile', { token })).body, (await call('GET', '/api/elvar/devices', { token })).body]) + logs.join('\n') + JSON.stringify(await getStore().get('elvar:v1:doc'));
  assert.ok(!everything.includes(KEY) && !everything.includes('0123456789abcd'), 'the key is never echoed, logged or stored in the clear');
  assert.ok(logs.join('\n').includes('config-updated') && logs.join('\n').includes('GEMINI_API_KEY'), 'the audit log names the key, not the value');

  const prof = { owner: { name: 'テスト太郎', address: 'テスト様', avoidAddresses: ['テストさん'] }, locale: { timeZone: 'America/New_York' }, home: { city: 'Boston', labelEn: 'BOSTON' }, features: { shift: true } };
  const put = await call('PUT', '/api/elvar/profile', { token, body: { profile: prof } }); assert.equal(put.status, 200);
  assert.equal(put.body.profile.owner.address, 'テスト様'); assert.equal(put.body.profile.assistant.displayName, 'E.L.V.A.R.'); assert.equal(put.body.profile.features.shift, true); assert.equal(put.body.profile.features.finance, true);
  const sess = await call('GET', '/api/elvar/session', { token });
  assert.equal(sess.body.profile.locale.timeZone, 'America/New_York'); assert.deepEqual(sess.body.brand, { name: 'E.L.V.A.R.', spokenName: 'エルヴァー', ownerAddress: 'テスト様' });
  assert.ok(sess.body.notifSecret.length >= 40); assert.deepEqual(sess.body.missing, []); assert.equal(sess.body.mode, 'vault');
  assert.equal((await call('POST', '/api/elvar/setup/claim', { ip: '203.0.113.5', body: { setupCode: code, password: PW } })).status, 409, 'setup runs once');
}, { ELVAR_SETUP_CODE: undefined }));

test('config PATCH validation: unknown / refresh-token / profile-backed keys, whitespace in keys, null deletes, settings revert to default', () => fresh(async () => {
  const token = await owner(); const patch = (body) => call('PATCH', '/api/elvar/config', { token, body });
  for (const body of [{ secrets: { NOPE_KEY: 'x' } }, { secrets: { GOOGLE_REFRESH_TOKEN: 'x' } }, { settings: { GEMINI_API_KEY: 'x' } }, { settings: { GEMINI_LIVE_VOICE: 'Puck' } }, { settings: { UPSTASH_REDIS_REST_TOKEN: 'x' } }, { secrets: { GROQ_MODEL: 'x' } }]) {
    const r = await patch(body); assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.body.error, 'unknown_key');
  }
  for (const v of ['', '   ', 'has space', 'new\nline', 'x'.repeat(513), 42, {}]) assert.equal((await patch({ secrets: { GROQ_API_KEY: v } })).status, 400, JSON.stringify(v));
  assert.equal((await patch({ secrets: { GROQ_API_KEY: '"gsk_quoted-key-1234"' } })).body.secrets.GROQ_API_KEY.last4, '1234', 'surrounding quotes are stripped');
  assert.equal((await patch({ secrets: { GROQ_API_KEY: null } })).body.secrets.GROQ_API_KEY.set, false);
  await patch({ settings: { GROQ_MODEL: 'custom' } });
  const back = await patch({ settings: { GROQ_MODEL: '' } }); assert.equal(back.body.settings.GROQ_MODEL.value, 'openai/gpt-oss-120b'); assert.equal(back.body.settings.GROQ_MODEL.source, 'default');
  assert.equal((await patch({ settings: { GROQ_MODEL: 'a\u0000b' } })).status, 400);
}));

test('Google client id / secret / products are editable in the app (secret write-only, strict shapes); the refresh token is not', () => fresh(async ({ logs }) => {
  const token = await owner(); const patch = (body) => call('PATCH', '/api/elvar/config', { token, body });
  const SEC = 'FAKE-SECRET-fake-secret-ABCDEFGH1234';
  const ok = await patch({ secrets: { GOOGLE_CLIENT_SECRET: SEC }, settings: { GOOGLE_CLIENT_ID: '123456-abc.apps.googleusercontent.com', GOOGLE_SERVICES: 'calendar,tasks', GOOGLE_READONLY: '1' } });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.secrets.GOOGLE_CLIENT_SECRET.set, ok.body.secrets.GOOGLE_CLIENT_SECRET.last4], [true, '1234']);
  assert.equal(ok.body.settings.GOOGLE_CLIENT_ID.value, '123456-abc.apps.googleusercontent.com'); assert.equal(ok.body.settings.GOOGLE_SERVICES.value, 'calendar,tasks');
  assert.ok(!ok.body.secrets.GOOGLE_REFRESH_TOKEN, 'the refresh token is not part of the editable keys');
  const all = JSON.stringify([ok.body, (await call('GET', '/api/elvar/config', { token })).body, (await call('GET', '/api/elvar/session', { token })).body]) + logs.join('\n');
  assert.ok(!all.includes('fake-secret-ABCDEFGH'), 'the client secret is never echoed or logged');
  for (const bad of [{ GOOGLE_CLIENT_ID: 'not-a-client-id' }, { GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com' }, { GOOGLE_SERVICES: 'calendar,evil' }, { GOOGLE_READONLY: 'yes' }]) {
    const r = await patch({ settings: bad }); assert.equal(r.status, 400, JSON.stringify(bad)); assert.equal(r.body.error, 'bad_value');
  }
}));

test('profile PUT validates (422 with per-field errors) and keeps the old profile on error', () => fresh(async () => {
  const token = await owner();
  const r = await call('PUT', '/api/elvar/profile', { token, body: { profile: { owner: { address: '' }, locale: { timeZone: 'Mars/Base', currency: 'yen' }, home: { lat: 999 } } } });
  assert.equal(r.status, 422); assert.equal(r.body.error, 'invalid_profile');
  assert.deepEqual(r.body.errors.map((e) => e.path).sort(), ['home.lat', 'locale.currency', 'locale.timeZone', 'owner.address']);
  assert.deepEqual((await call('GET', '/api/elvar/profile', { token })).body.profile, DEFAULT_PROFILE);
}));

test('env mode and local mode are read-only for config and profile', () => fresh(async () => {
  const r = await call('PATCH', '/api/elvar/config', { token: 'env-tok', body: { secrets: { GROQ_API_KEY: 'gsk_x1234567' } }, ip: '203.0.113.5' });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'read_only');
  assert.equal((await call('PUT', '/api/elvar/profile', { token: 'env-tok', body: { profile: {} }, ip: '203.0.113.5' })).status, 409);
  const c = await call('GET', '/api/elvar/config', { token: 'env-tok', ip: '203.0.113.5' }); assert.equal(c.body.mode, 'env'); assert.equal(c.body.writable, false);
  const s = await call('GET', '/api/elvar/session', { token: 'env-tok', ip: '203.0.113.5' }); assert.equal(s.body.notifSecret, null);
}, { ELVAR_ACCESS_TOKEN: 'env-tok' }));

test('env values are shown with source "env" (and last4) but can be overridden in the app', () => fresh(async () => {
  const token = await owner(); process.env.GROQ_API_KEY = 'gsk_env-secret-ENV1';
  const c = await call('GET', '/api/elvar/config', { token });
  assert.deepEqual([c.body.secrets.GROQ_API_KEY.set, c.body.secrets.GROQ_API_KEY.source, c.body.secrets.GROQ_API_KEY.last4], [true, 'env', 'ENV1']);
  assert.ok(!JSON.stringify(c.body).includes('gsk_env-secret'));
  const p = await call('PATCH', '/api/elvar/config', { token, body: { secrets: { GROQ_API_KEY: 'gsk_app-secret-APP2' } } });
  assert.deepEqual([p.body.secrets.GROQ_API_KEY.source, p.body.secrets.GROQ_API_KEY.last4], ['app', 'APP2']);
}));

test('config/test checks one key on the server and never returns it', () => fresh(async () => {
  const token = await owner(); const real = globalThis.fetch, seen = [];
  globalThis.fetch = async (u, o) => { seen.push({ u: String(u), h: o?.headers }); return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    assert.equal((await call('POST', '/api/elvar/config/test', { token, body: { name: 'GEMINI_API_KEY' } })).body.status, 'fail', 'no key saved yet');
    await call('PATCH', '/api/elvar/config', { token, body: { secrets: { GEMINI_API_KEY: 'AIzaFAKEKEY-test9999' } } });
    const t = await call('POST', '/api/elvar/config/test', { token, body: { name: 'GEMINI_API_KEY' } });
    assert.equal(t.status, 200); assert.equal(t.body.status, 'ok'); assert.ok(!JSON.stringify(t.body).includes('AIzaFAKEKEY'));
    assert.match(seen.at(-1).u, /generativelanguage\.googleapis\.com/); assert.equal(seen.at(-1).h['x-goog-api-key'], 'AIzaFAKEKEY-test9999');
    globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
    assert.match((await call('POST', '/api/elvar/config/test', { token, body: { name: 'GEMINI_API_KEY' } })).body.detail, /拒否/);
    globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); };
    const off = (await call('POST', '/api/elvar/config/test', { token, body: { name: 'GEMINI_API_KEY' } })).body; assert.equal(off.status, 'fail'); assert.match(off.detail, /ENOTFOUND/);
    assert.equal((await call('POST', '/api/elvar/config/test', { token, body: { name: 'NEWSDATA_API_KEY' } })).status, 400);
  } finally { globalThis.fetch = real; }
}));

test('devices over the API: list, revoke another, revoke self flagged', () => fresh(async () => {
  const token = await owner();
  const l2 = await call('POST', '/api/elvar/auth/login', { body: { password: PW, deviceName: 'Phone' }, ip: '198.51.100.2' }); assert.equal(l2.status, 200);
  const list = (await call('GET', '/api/elvar/devices', { token })).body.devices; assert.equal(list.length, 2);
  const phone = list.find((d) => d.name === 'Phone');
  assert.deepEqual((await call('DELETE', `/api/elvar/devices/${phone.id}`, { token })).body, { ok: true, self: false });
  assert.equal((await call('GET', '/api/elvar/session', { token: l2.body.token })).status, 401);
  const me = list.find((d) => d.current); assert.equal((await call('DELETE', `/api/elvar/devices/${me.id}`, { token })).body.self, true);
  assert.equal((await call('GET', '/api/elvar/session', { token })).status, 401);
}));

test('a store outage is reported as 503 without leaking details', () => fresh(async () => {
  const token = await owner(); const store = getStore(); const real = store.get.bind(store);
  store.get = async () => { throw Object.assign(new Error('Redisに接続できません: ENOTFOUND secret-host'), { status: 502 }); };
  try {
    const r = await call('GET', '/api/elvar/session', { token }); assert.equal(r.status, 503); assert.ok(!JSON.stringify(r.body).includes('secret-host'));
    const s = await call('GET', '/api/elvar/state'); assert.equal(s.status, 200); assert.equal(s.body.storageError, true);
  } finally { store.get = real; }
}));

test('api/elvar.js: the Vercel entry maps ?p=<path> (from the rewrite) to the router and writes JSON', () => fresh(async () => {
  const run = async (url, over = {}) => { const out = {}; await handler({ method: 'GET', url, headers: {}, socket: { remoteAddress: '127.0.0.1' }, ...over }, { setHeader() {}, end(b) { out.body = JSON.parse(b); }, get statusCode() { return out.status; }, set statusCode(v) { out.status = v; } }); return out; };
  const st = await run('/api/elvar?p=state'); assert.equal(st.status, 200); assert.equal(st.body.initialized, false);
  const nf = await run('/api/elvar?p=nothing/here'); assert.equal(nf.status, 404);
  const cl = await run('/api/elvar?p=setup/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { setupCode: CODE, password: PW } }); assert.equal(cl.status, 200); assert.ok(cl.body.token);
  const dev = await run(`/api/elvar?p=devices`, { headers: { 'x-elvar-token': cl.body.token } }); assert.equal(dev.status, 200); assert.equal(dev.body.devices.length, 1);
  const q = await run('/api/elvar?p=devices&x=1', { headers: {} }); assert.equal(q.status, 401);
}));

test('writes must be JSON (415 otherwise); a malformed %-escape is a 400, not a crash', () => fresh(async () => {
  const r = await call('POST', '/api/elvar/setup/claim', { body: { setupCode: CODE, password: PW }, headers: { 'content-type': 'text/plain' } });
  assert.equal(r.status, 415);
  assert.equal((await call('PATCH', '/api/elvar/config', { headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await call('DELETE', '/api/elvar/devices/%E0%A4%A')).status, 400);
  const out = {}; await handler({ method: 'GET', url: '/api/elvar?p=devices/%E0%A4%A', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, { setHeader() {}, end(b) { out.body = JSON.parse(b); }, get statusCode() { return out.status; }, set statusCode(v) { out.status = v; } });
  assert.ok(out.status === 400 || out.status === 405, 'answered');
}));

test('SARASHINA_BASE_URL and other endpoint settings cannot be set from the app (a typed URL could send the key elsewhere); repos / model names are format-checked', () => fresh(async () => {
  const token = await owner(); const patch = (settings) => call('PATCH', '/api/elvar/config', { token, body: { settings } });
  assert.equal((await patch({ SARASHINA_BASE_URL: 'https://evil.example/v1' })).body.error, 'unknown_key');
  assert.ok(!('SARASHINA_BASE_URL' in (await call('GET', '/api/elvar/config', { token })).body.settings));
  for (const [k, v] of [['BRAIN_REPO', '../../evil'], ['BRAIN_REPO', 'a/b/c'], ['BUILD_REPO', 'x y/z'], ['GROQ_MODEL', '../../v1/x'], ['GEMINI_LIVE_MODEL', 'm?key=1'], ['SARASHINA_MODEL', 'a#b']]) {
    assert.equal((await patch({ [k]: v })).status, 400, `${k}=${v}`);
  }
  assert.equal((await patch({ BRAIN_REPO: 'owner-1/notes.repo', GROQ_MODEL: 'openai/gpt-oss-120b' })).status, 200);
}));

test('Vercel: /api/google/callback is rewritten into the single router function and answers an HTML page with its own strict CSP (no token needed)', () => fresh(async () => {
  const rewrites = JSON.parse((await import('node:fs')).readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')).rewrites;
  assert.ok(rewrites.some((r) => r.source === '/api/google/callback' && r.destination === '/api/elvar?p=connect/google/callback'));
  assert.ok(rewrites.some((r) => r.source === '/api/google/status' && r.destination === '/api/elvar?p=connect/google/status'));
  const store = getStore();
  const flow = () => startFlow({ store, provider: 'google', authUrl: 'https://a.example/auth', tokenUrl: 'http://127.0.0.1:1/oauth', clientId: 'c', clientSecret: 's', redirectUri: 'https://x.example/api/google/callback', scopes: ['a'] });
  const mockRes = () => { const r = { headers: {}, statusCode: 0, body: '', setHeader(k, v) { r.headers[k.toLowerCase()] = v; }, end(b) { r.body = String(b ?? ''); } }; return r; };
  const f = await flow(), res = mockRes();
  await handler({ method: 'GET', url: `/api/elvar?p=connect/google/callback&error=access_denied&state=${f.state}`, headers: { host: 'x.example' }, socket: { remoteAddress: '203.0.113.9' } }, res);
  assert.equal(res.statusCode, 400); assert.match(res.headers['content-type'], /text\/html/); assert.match(res.body, /許可されませんでした/);
  assert.match(res.headers['content-security-policy'], /default-src 'none'/); assert.equal(res.headers['cache-control'], 'no-store'); assert.equal(res.headers['referrer-policy'], 'no-referrer');
  // the local server reaches the same handler through the alias; an unknown state is refused with a page, never a redirect
  const r2 = await routeElvar(mk('GET', undefined, '203.0.113.9'), { pathname: '/api/google/callback', query: { code: 'c', state: f.state } });
  assert.equal(r2.status, 403); assert.ok(r2.html.includes('<html') && !('location' in (r2.headers || {})));
  const r3 = await routeElvar(mk('GET', undefined, '203.0.113.9'), { pathname: '/api/google/callback/', query: { state: 'x' } }); assert.equal(r3.status, 403);
  // 30 callbacks per 10 minutes per address
  let last; for (let i = 0; i < 32; i++) last = await routeElvar(mk('GET', undefined, '198.51.100.7'), { pathname: '/api/google/callback', query: { state: 'x' } });
  assert.equal(last.status, 429);
  // the function budget: the three Google endpoints no longer have a function of their own
  const api = (await import('node:fs')).readdirSync(new URL('../api/', import.meta.url)).filter((x) => x.endsWith('.js'));
  assert.ok(api.length <= 12 && !api.some((x) => /^google-(connect|status|callback)/.test(x)), api.join(','));
}));
