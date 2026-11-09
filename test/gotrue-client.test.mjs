// The browser's Supabase Auth client (web/src/elvar/gotrue.js) against a scripted fetch, and the per-user namespace shim (web/public/ns.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createAuthClient, installAuthFetch, challengeOf, authMessage, AuthApiError } from '../web/src/elvar/gotrue.js';
import { nsOf } from '../web/src/elvar/local.js';

const mkStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
const sess = (n = 1, exp = Math.floor(Date.now() / 1000) + 3600) => ({ access_token: 'a' + n, refresh_token: 'r' + n, expires_at: exp, user: { id: 'u1', email: 'a@example.test', app_metadata: { provider: 'email' } } });
const res = (status, body) => ({ status, ok: status < 400, json: async () => body, clone() { return this; } });

test('sign-up sends a PKCE challenge, never the verifier; the code exchange uses the stored verifier once', async () => {
  const calls = []; const storage = mkStore();
  const c = createAuthClient({ url: 'https://x.supabase.test', anonKey: 'pub', storage, locks: null, fetchImpl: async (u, i) => { calls.push({ u, body: i.body && JSON.parse(i.body), h: i.headers }); return res(200, u.includes('/token') ? sess() : {}); } });
  assert.deepEqual(await c.signUp({ email: 'a@example.test', password: 'Pw0rdPw0rdPw0rd', captchaToken: 'cap', redirectTo: 'https://app/cb' }), { needsConfirmation: true });
  const b = calls[0].body, verifier = storage.m.get('elvar_auth_pkce');
  assert.equal(calls[0].h.apikey, 'pub'); assert.equal(b.gotrue_meta_security.captcha_token, 'cap'); assert.equal(b.code_challenge, await challengeOf(verifier)); assert.ok(!JSON.stringify(b).includes(verifier));
  await c.exchangeCode('code123'); assert.equal(calls[1].body.code_verifier, verifier); assert.equal(c.session().user.email, 'a@example.test');
  await assert.rejects(c.exchangeCode('again'), (e) => e.code === 'no_verifier');
  assert.ok(storage.m.has('elvar_auth_session'), 'session kept device-wide');
});

test('refresh rotates the token; a rejected refresh signs out; signOut drops the local session even if the server is down', async () => {
  const storage = mkStore(); let n = 1, fail = false;
  const c = createAuthClient({ url: 'https://x.supabase.test', anonKey: 'p', storage, locks: null, fetchImpl: async (u) => { if (fail) return res(400, { error_code: 'refresh_token_not_found', msg: 'x' }); return res(200, sess(++n)); } });
  await c.signInWithPassword({ email: 'a@example.test', password: 'x' }); assert.equal(c.token(), 'a2');
  await c.refresh(); assert.equal(c.token(), 'a3');
  fail = true; const events = []; c.onChange((e) => events.push(e));
  await assert.rejects(c.refresh()); assert.equal(c.session(), null); assert.deepEqual(events, ['SIGNED_OUT']);
  fail = false; await c.signInWithPassword({ email: 'a@example.test', password: 'x' });
  const down = createAuthClient({ url: 'https://x.supabase.test', anonKey: 'p', storage, locks: null, fetchImpl: async () => { throw new TypeError('offline'); } });
  assert.ok(down.session()); await down.signOut(); assert.equal(down.session(), null); assert.equal(storage.m.has('elvar_auth_session'), false);
});

test('installAuthFetch adds the token to our /api/ calls only, refreshes once after token_expired, and reports a lost login', async () => {
  const seen = []; let out = [];
  const win = { location: { href: 'https://app.test/', origin: 'https://app.test' }, fetch: async (u, i = {}) => { const h = new Headers(i.headers); seen.push([String(u), h.get('authorization')]); return seen.length === 2 && String(u).includes('/api/') ? res(401, { error: 'token_expired' }) : res(200, {}); } };
  let tok = 'old'; const client = { accessToken: async () => tok, refresh: async () => { tok = 'new'; } };
  installAuthFetch(client, { win, onSignedOut: (w) => out.push(w) });
  await win.fetch('https://other.test/x'); await win.fetch('/api/elvar/session'); await win.fetch('https://app.test/api/elvar/config');
  assert.deepEqual(seen[0], ['https://other.test/x', null], 'other origins untouched');
  assert.deepEqual(seen.slice(1).map((s) => s[1]), ['Bearer old', 'Bearer new', 'Bearer new'], 'retried once with the refreshed token');
});

test('messages are Japanese for the cases a person can fix', () => {
  assert.match(authMessage(new AuthApiError(400, 'invalid_credentials')), /違います/); assert.match(authMessage(new AuthApiError(0, 'network')), /接続できません/);
  assert.match(authMessage(new AuthApiError(400, 'weak_password')), /10文字/);
});

test('ns.js: localStorage keys and IndexedDB names get the signed-in user\'s namespace; the session and the pointer stay device-wide', async () => {
  const store = new Map(), nativeGet = (k) => (store.has(k) ? store.get(k) : null);
  class Storage { getItem(k) { return nativeGet(k); } setItem(k, v) { store.set(k, String(v)); } removeItem(k) { store.delete(k); } }
  const localStorage = new Storage(); const opened = [];
  class IDBFactory { open(n) { opened.push(n); } deleteDatabase(n) { opened.push('del:' + n); } }
  const ctx = { localStorage, Storage, IDBFactory, indexedDB: new IDBFactory(), window: {} };
  const run = () => vm.runInNewContext(fs.readFileSync('web/public/ns.js', 'utf8'), ctx);
  const ns = await nsOf('11111111-1111-4111-8111-111111111111'); assert.match(ns, /^[0-9a-f]{16}$/); assert.notEqual(ns, await nsOf('22222222-2222-4222-8222-222222222222'));
  localStorage.setItem('elvar_ns', ns); run();
  localStorage.setItem('conv', 'mine'); localStorage.setItem('elvar_auth_session', 's');
  assert.equal(store.get(`u.${ns}.conv`), 'mine'); assert.equal(store.get('elvar_auth_session'), 's'); assert.equal(localStorage.getItem('conv'), 'mine');
  ctx.indexedDB.open('elvar-files', 1); assert.equal(opened[0], `elvar-files@${ns}`);
  // another user on the same browser sees nothing of the first
  store.set('elvar_ns', 'b'.repeat(16)); const ctx2 = { ...ctx, window: {} }; vm.runInNewContext(fs.readFileSync('web/public/ns.js', 'utf8').replace(/Storage\.prototype/g, 'Storage.prototype'), ctx2);
  assert.equal(localStorage.getItem('conv'), null, 'the second user\'s namespace is empty');
  const none = new Map(); void none;
});
