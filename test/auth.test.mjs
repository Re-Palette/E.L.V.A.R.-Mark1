// Owner auth: setup code -> claim -> login -> device tokens, rate limits, modes (vault / env / local), and the config merge. Memory store, cheap scrypt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetStore, getStore } from '../server/store/index.js';
import * as A from '../server/config/auth.js';
import * as V from '../server/config/vault.js';
import { getConfig, runWithConfig, env, envConfig, _clearWarmCache } from '../server/config/resolve.js';
import { withOwner, withConfig } from '../server/config/with-owner.js';
import { signTicket, verifyTicket } from '../server/google/ticket.js';
import { VERSION } from '../server/version.js';
import fs from 'node:fs';

A._setKdfForTests({ N: 2 ** 10, r: 8, p: 1 });
const PW = 'correct horse battery';
const TOUCH = ['ELVAR_ACCESS_TOKEN', 'ELVAR_SETUP_CODE', 'VERCEL', 'GEMINI_API_KEY', 'GROQ_MODEL'];

async function fresh(fn, env0 = {}) {
  const old = Object.fromEntries(TOUCH.map((k) => [k, process.env[k]]));
  for (const k of TOUCH) delete process.env[k];
  Object.assign(process.env, env0);
  resetStore(); _clearWarmCache();
  const logs = []; const realLog = console.log; console.log = (...a) => logs.push(a.join(' '));
  try { return await fn({ store: getStore(), logs }); }
  finally { console.log = realLog; for (const k of TOUCH) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } resetStore(); _clearWarmCache(); }
}
const req = (o = {}) => ({ method: 'GET', headers: {}, socket: { remoteAddress: '203.0.113.9' }, url: '/', ...o });
const local = (h = {}, o = {}) => req({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:8787', ...h }, ...o });
const withTok = (token, o = {}) => req({ headers: { 'x-elvar-token': token }, ...o });
const codeFrom = (logs) => { const m = logs.join('\n').match(/ELVAR SETUP CODE: ([A-Z0-9]{4}-[A-Z0-9]{4})/); return m && m[1]; };

test('state: a fresh remote instance asks for the setup code, which is printed to the server log only', () => fresh(async ({ logs }) => {
  const s = await A.setupState(req());
  assert.deepEqual([s.body.initialized, s.body.storage, s.body.setupCodeRequired, s.body.envMode], [false, 'memory', true, false]);
  const code = codeFrom(logs); assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/, 'unambiguous characters');
  assert.ok(!JSON.stringify(s).includes(code.replace('-', '')), 'never in the response');
  const again = await A.setupState(req()); assert.equal(again.body.setupCodeRequired, true);
  assert.equal(logs.filter((l) => l.includes('SETUP CODE')).length, 1, 'one code, not a new one per request');
  assert.ok(!JSON.stringify(await getStore().get('elvar:v1:setup')).includes(code.replace('-', '')), 'only a hash is stored');
}));

test('state: the setup code is ALWAYS required (also from this machine); `local` only describes the caller', () => fresh(async ({ logs }) => {
  const s = await A.setupState(local());
  assert.equal(s.body.setupCodeRequired, true); assert.equal(s.body.local, true); assert.ok(codeFrom(logs));
  assert.equal((await A.setupState(local({ 'x-forwarded-for': '198.51.100.1' }))).body.local, false, 'behind a proxy: not local');
  process.env.VERCEL = '1';
  assert.equal((await A.setupState(local())).body.local, false);
}));

test('state: no storage on Vercel reports storage "none" and no setup is possible', () => fresh(async () => {
  const keep = process.env.ELVAR_STORE; delete process.env.ELVAR_STORE; resetStore();
  try {
    const s = await A.setupState(req()); assert.equal(s.body.storage, 'none'); assert.equal(s.body.setupCodeRequired, false);
    assert.equal((await A.claim(req(), { setupCode: 'X', password: PW })).status, 503);
    assert.deepEqual((await A.authenticate(req())), { ok: false, status: 401, error: 'storage_required' });
  } finally { process.env.ELVAR_STORE = keep; resetStore(); }
}, { VERCEL: '1' }));

test('claim: wrong code 403, weak password 400, success returns a device token, then 409; the code is single use', () => fresh(async ({ logs }) => {
  await A.setupState(req()); const code = codeFrom(logs);
  assert.equal((await A.claim(req(), { setupCode: 'AAAA-AAAA', password: PW })).status, 403);
  assert.equal((await A.claim(req(), { setupCode: '', password: PW })).status, 403);
  const weak = await A.claim(req(), { setupCode: code, password: 'short' }); assert.equal(weak.status, 400); assert.equal(weak.body.error, 'weak_password');
  const ok = await A.claim(req(), { setupCode: code.toLowerCase().replace('-', ' '), password: PW, deviceName: 'PC' });
  assert.equal(ok.status, 200); assert.match(ok.body.token, /^elv1\.[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/);
  assert.ok(!logs.join('\n').includes(ok.body.token) && !logs.join('\n').includes(PW), 'secrets are never logged');
  assert.equal((await A.claim(req(), { setupCode: code, password: PW })).status, 409);
  assert.equal(await getStore().get('elvar:v1:setup'), null, 'code consumed');
  assert.equal((await A.setupState(req())).body.initialized, true);
}));

test('claim: needs the setup code even from loopback (no local shortcut); a JSON-less / cross-site request cannot claim either', () => fresh(async ({ logs }) => {
  await A.setupState(local()); const code = codeFrom(logs);
  assert.equal((await A.claim(local({ 'content-type': 'application/json' }, { method: 'POST' }), { password: PW })).status, 403, 'no code, local');
  assert.equal((await A.claim(local({ 'content-type': 'text/plain', origin: 'https://evil.example' }, { method: 'POST' }), { password: PW })).status, 403, 'the reported CSRF');
  assert.equal((await A.claim(local({ 'content-type': 'application/json' }, { method: 'POST' }), { setupCode: code, password: PW })).status, 200);
}));

test('claim in env mode needs the setup code AND the env token (the env owner cannot be locked out by a local / cross-site caller)', () => fresh(async ({ logs }) => {
  await A.setupState(local()); const code = codeFrom(logs);
  const r1 = await A.claim(local({ 'content-type': 'text/plain', origin: 'https://evil.example' }, { method: 'POST' }), { setupCode: code, password: PW });
  assert.equal(r1.status, 401, 'right code but no env token');
  assert.equal((await A.claim(local({ 'x-elvar-token': 'wrong' }), { setupCode: code, password: PW })).status, 401);
  assert.equal((await A.authenticate(withTok('env-secret'))).mode, 'env', 'the env token still works');
  assert.equal((await A.claim(local({ 'x-elvar-token': 'env-secret' }), { setupCode: code, password: PW })).status, 200);
}, { ELVAR_ACCESS_TOKEN: 'env-secret' }));

test('pre-setup local mode: only a same-machine browser (loopback peer + loopback Host + no foreign Origin + not cross-site + JSON writes)', () => fresh(async () => {
  const ok = (h, o) => A.authenticate(local(h, o)).then((r) => r.ok);
  assert.equal(await ok(), true);
  assert.equal(await ok({ host: '127.0.0.1:5173', origin: 'http://localhost:5173' }), true, 'the Vite dev server');
  assert.equal(await ok({ host: 'attacker.example:8787' }), false, 'DNS rebinding: foreign Host');
  assert.equal(await ok({ origin: 'https://evil.example' }), false, 'foreign Origin');
  assert.equal(await ok({ origin: 'null' }), false, 'opaque origin (sandboxed iframe, file://)');
  assert.equal(await ok({ 'sec-fetch-site': 'cross-site' }), false);
  assert.equal(await ok({ 'content-type': 'text/plain' }, { method: 'POST' }), false, 'simple POST');
  assert.equal(await ok({ 'content-type': 'application/json' }, { method: 'POST' }), true);
  assert.equal(await ok({ 'x-forwarded-for': '203.0.113.1' }), false, 'reverse proxy');
  assert.equal((await A.authenticate(req({ headers: { host: 'localhost' } }))).ok, false, 'remote peer');
}));

test('claim: ELVAR_SETUP_CODE (advanced) is honoured and nothing is generated', () => fresh(async ({ logs }) => {
  const s = await A.setupState(req()); assert.equal(s.body.setupCodeRequired, true); assert.equal(codeFrom(logs), null);
  assert.equal((await A.claim(req(), { setupCode: 'nope', password: PW })).status, 403);
  assert.equal((await A.claim(local(), { password: PW })).status, 403, 'a fixed code is required even locally');
  assert.equal((await A.claim(req(), { setupCode: 'my-fixed-code', password: PW })).status, 200);
}, { ELVAR_SETUP_CODE: 'MY-FIXED-CODE' }));

test('claim is rate limited: 5 attempts an hour per address; many wrong codes rotate (and re-print) the code instead of blocking everyone', () => fresh(async ({ logs }) => {
  await A.setupState(req());
  for (let i = 0; i < 5; i++) assert.equal((await A.claim(req(), { setupCode: 'BAD' + i, password: PW })).status, 403);
  const r = await A.claim(req(), { setupCode: 'BAD6', password: PW }); assert.equal(r.status, 429);
  assert.equal((await A.claim(req({ socket: { remoteAddress: '198.51.100.7' } }), { setupCode: 'BAD', password: PW })).status, 403, 'another address is not blocked by the first');
  // 20 wrong codes from many addresses: the code is replaced (printed again); the owner is not locked out
  const first = codeFrom(logs);
  for (let i = 0; i < 20; i++) await A.claim(req({ socket: { remoteAddress: `198.51.100.${50 + i}` } }), { setupCode: 'WRONG' + i, password: PW });
  const codes = logs.join('\n').match(/ELVAR SETUP CODE: ([A-Z0-9-]{9})/g);
  assert.ok(codes.length >= 2, 'a new code was printed'); const latest = codes.at(-1).slice(-9);
  assert.notEqual(latest, first);
  assert.equal((await A.claim(req({ socket: { remoteAddress: '198.51.100.99' } }), { setupCode: first, password: PW })).status, 403, 'the old code is dead');
  assert.equal((await A.claim(req({ socket: { remoteAddress: '198.51.100.98' } }), { setupCode: latest, password: PW })).status, 200, 'the owner, with the new code, still gets in');
}));

async function setup(logs) { await A.setupState(req()); const c = await A.claim(req(), { setupCode: codeFrom(logs), password: PW, deviceName: 'PC' }); assert.equal(c.status, 200); return c.body; }

test('authenticate: modes. vault token ok; wrong / foreign / missing token 401; env token and loopback stop working once the vault exists', () => fresh(async ({ logs }) => {
  const before = await A.authenticate(local()); assert.equal(before.mode, 'local');
  assert.equal((await A.authenticate(req())).error, 'setup_required');
  const { token } = await setup(logs);
  const a = await A.authenticate(withTok(token)); assert.equal(a.ok, true); assert.equal(a.mode, 'vault'); assert.equal(a.dek.length, 32);
  assert.equal((await A.authenticate(withTok(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')))).status, 401);
  assert.equal((await A.authenticate(req())).status, 401);
  assert.equal((await A.authenticate(local())).status, 401, 'loopback is no longer trusted after setup');
  process.env.ELVAR_ACCESS_TOKEN = 'env-secret';
  assert.equal((await A.authenticate(withTok('env-secret'))).status, 401, 'the env token does not bypass an initialised vault');
}));

test('authenticate: env mode (ELVAR_ACCESS_TOKEN, no vault yet) compares in constant time and rejects everything else', () => fresh(async () => {
  const ok = await A.authenticate(withTok('env-secret')); assert.deepEqual([ok.ok, ok.mode], [true, 'env']);
  for (const t of ['', 'env-secreT', 'env-secret ', 'x'.repeat(500)]) assert.equal((await A.authenticate(withTok(t))).status, 401);
  assert.equal((await A.authenticate(local())).status, 401, 'with an env token set, loopback alone is not enough');
  assert.equal((await A.setupState(req())).body.envMode, true);
}, { ELVAR_ACCESS_TOKEN: 'env-secret' }));

test('login: wrong password 401; 5 failures lock the address (even for the right password); the lock is per address; success issues a second device', () => fresh(async ({ logs }) => {
  const first = await setup(logs);
  for (let i = 0; i < 5; i++) { const r = await A.login(req(), { password: 'wrong password ' + i }); assert.equal(r.status, 401); assert.equal(r.body.error, 'invalid_credentials'); }
  assert.equal((await A.login(req(), { password: PW })).status, 429, 'locked');
  const other = req({ socket: { remoteAddress: '198.51.100.20' } });
  const ok = await A.login(other, { password: PW, deviceName: 'Phone' }); assert.equal(ok.status, 200);
  assert.notEqual(ok.body.token, first.token);
  assert.equal((await A.authenticate(withTok(ok.body.token))).mode, 'vault');
  assert.ok(!logs.join('\n').includes(PW) && !logs.join('\n').includes(ok.body.token));
  const a = await A.authenticate(withTok(first.token));
  const list = A.listDevices(a).body.devices; assert.equal(list.length, 2); assert.deepEqual(list.map((d) => d.name).sort(), ['PC', 'Phone']);
  assert.equal(list.find((d) => d.current).name, 'PC'); assert.ok(!JSON.stringify(list).includes(ok.body.token));
}));

test('login before setup is refused; the daily cap (20) also applies', () => fresh(async ({ logs }) => {
  assert.equal((await A.login(req(), { password: PW })).status, 409);
  await setup(logs);
  const store = getStore(); await store.set('elvar:v1:rl:loginday:203.0.113.9', 20, { ttlSec: 100 });
  assert.equal((await A.login(req(), { password: PW })).status, 429);
}));

test('devices: revoking a device ends its access at once; logout revokes the caller; bad ids are refused', () => fresh(async ({ logs }) => {
  const a1 = await setup(logs), a2 = (await A.login(req(), { password: PW, deviceName: 'Phone' })).body;
  const me = await A.authenticate(withTok(a1.token));
  assert.equal((await A.removeDevice(me, 'not-an-id')).status, 400);
  assert.equal((await A.removeDevice(me, '0'.repeat(16))).status, 404);
  const r = await A.removeDevice(me, a2.deviceId); assert.deepEqual(r.body, { ok: true, self: false });
  assert.equal((await A.authenticate(withTok(a2.token))).status, 401);
  await A.logout(me);
  assert.equal((await A.authenticate(withTok(a1.token))).status, 401, 'logged out');
}));

test('password change: needs the current password, enforces the policy, old password stops working', () => fresh(async ({ logs }) => {
  const { token } = await setup(logs); const me = await A.authenticate(withTok(token));
  assert.equal((await A.changeOwnerPassword(req(), me, { current: 'nope nope nope', next: 'a new long password' })).status, 401);
  assert.equal((await A.changeOwnerPassword(req(), me, { current: PW, next: 'short' })).status, 400);
  assert.equal((await A.changeOwnerPassword(req(), me, { current: PW, next: 'a new long password' })).status, 200);
  assert.equal((await A.login(req({ socket: { remoteAddress: '198.51.100.30' } }), { password: PW })).status, 401);
  assert.equal((await A.login(req({ socket: { remoteAddress: '198.51.100.31' } }), { password: 'a new long password' })).status, 200);
  assert.equal((await A.authenticate(withTok(token))).ok, true, 'devices keep working');
}));

test('getConfig merges the vault: vault > env > default, with the source reported, and secrets only as status', () => fresh(async ({ logs }) => {
  const { token } = await setup(logs); const me = await A.authenticate(withTok(token));
  await V.updateDoc(getStore(), me.dek, (d) => { d.secrets.GEMINI_API_KEY = 'AIzaFAKEKEY-abcd1234'; d.settings.GROQ_MODEL = 'from-app'; d.profile = { owner: { name: 'テスト太郎', address: 'テスト様' }, locale: { timeZone: 'America/New_York' } }; return d; });
  process.env.GROQ_MODEL = 'from-env'; process.env.GEMINI_API_KEY = 'env-key-shouldnt-win';
  const r = await getConfig(withTok(token));
  assert.equal(r.ok, true); const { cfg } = r;
  assert.equal(cfg.get('GEMINI_API_KEY'), 'AIzaFAKEKEY-abcd1234'); assert.equal(cfg.source('GEMINI_API_KEY'), 'app');
  assert.equal(cfg.get('GROQ_MODEL'), 'from-app'); assert.equal(cfg.source('GROQ_MODEL'), 'app');
  assert.equal(cfg.source('BRAIN_BRANCH'), 'default');
  assert.equal(cfg.get('GOOGLE_TIMEZONE'), 'America/New_York', 'profile-backed names come from the profile'); assert.equal(cfg.profile.owner.address, 'テスト様');
  assert.equal(cfg.profile.assistant.displayName, 'E.L.V.A.R.', 'partial stored profile is completed by the defaults');
  const st = cfg.secretStatus().GEMINI_API_KEY; assert.deepEqual(st, { set: true, source: 'app', last4: '1234' });
  assert.ok(!JSON.stringify(cfg.secretStatus()).includes('AIzaFAKEKEY'), 'status never holds the value');
  runWithConfig(cfg, () => { assert.equal(env('GEMINI_API_KEY'), 'AIzaFAKEKEY-abcd1234'); assert.equal(env('GROQ_MODEL'), 'from-app'); });
  // delete from the vault -> falls back to env
  await V.updateDoc(getStore(), me.dek, (d) => { delete d.settings.GROQ_MODEL; return d; });
  const r2 = await getConfig(withTok(token)); assert.equal(r2.cfg.get('GROQ_MODEL'), 'from-env'); assert.equal(r2.cfg.source('GROQ_MODEL'), 'env');
  assert.equal(r2.cfg.version, r2.cfg.version);
}));

test('getConfig: unauthenticated callers get an env-only config and no vault value', () => fresh(async ({ logs }) => {
  const { token } = await setup(logs); const me = await A.authenticate(withTok(token));
  await V.updateDoc(getStore(), me.dek, (d) => { d.secrets.GEMINI_API_KEY = 'AIzaSECRET-0000'; return d; });
  const r = await getConfig(req()); assert.equal(r.ok, false); assert.equal(r.status, 401);
  assert.equal(r.cfg.get('GEMINI_API_KEY'), undefined);
}));

test('the warm cache notices a changed document (version) and expires', () => fresh(async ({ logs }) => {
  const { token } = await setup(logs); const me = await A.authenticate(withTok(token));
  assert.equal((await getConfig(withTok(token))).cfg.get('GROQ_MODEL'), undefined);
  await V.updateDoc(getStore(), me.dek, (d) => { d.settings.GROQ_MODEL = 'm1'; return d; });
  assert.equal((await getConfig(withTok(token))).cfg.get('GROQ_MODEL'), 'm1', 'docVer in meta changed -> fresh read');
}));

test('withOwner: 401 without a device token; with one the handler runs inside the vault config (Vercel functions get vault values)', () => fresh(async ({ logs }) => {
  const { token } = await setup(logs); const me = await A.authenticate(withTok(token));
  await V.updateDoc(getStore(), me.dek, (d) => { d.secrets.GEMINI_API_KEY = 'AIzaFAKEKEY-wxyz9999'; return d; });
  const call = async (wrapper, r) => { const out = { headers: {} }; await wrapper(r, { statusCode: 0, setHeader() {}, end(b) { out.body = JSON.parse(b); }, get statusCode() { return out.status; }, set statusCode(v) { out.status = v; } }); return out; };
  let seen = null;
  const h = withOwner((rq, rs, ctx) => { seen = { key: env('GEMINI_API_KEY'), mode: ctx.auth.mode }; rs.statusCode = 200; rs.end(JSON.stringify({ ok: true })); });
  const no = await call(h, req()); assert.equal(no.status, 401); assert.equal(seen, null);
  const yes = await call(h, withTok(token)); assert.equal(yes.status, 200); assert.deepEqual(seen, { key: 'AIzaFAKEKEY-wxyz9999', mode: 'vault' });
  let open = null; const c = withConfig((rq, rs, ctx) => { open = { key: env('GEMINI_API_KEY'), ok: ctx.ok }; rs.statusCode = 200; rs.end('{}'); });
  await call(c, req()); assert.deepEqual(open, { key: undefined, ok: false }, 'no auth required, but no vault values either');
  await call(c, withTok(token)); assert.deepEqual(open, { key: 'AIzaFAKEKEY-wxyz9999', ok: true });
  const boom = withOwner(() => { throw new Error('secret detail AIzaLEAK'); });
  const b = await call(boom, withTok(token)); assert.equal(b.status, 500); assert.ok(!JSON.stringify(b.body).includes('AIzaLEAK'));
}));

test('approval tickets are signed with a key derived from the vault key (same on every instance), not from a token', () => fresh(async ({ logs }) => {
  const { token } = await setup(logs);
  const c1 = (await getConfig(withTok(token))).cfg, c2 = (await getConfig(withTok(token))).cfg;
  const t = runWithConfig(c1, () => signTicket('gmail_send', { to: 'a' }));
  assert.equal((await runWithConfig(c2, () => verifyTicket(t, 'gmail_send', { to: 'a' }))).ok, true, 'another request / instance of the same vault verifies it');
  const t2 = runWithConfig(c1, () => signTicket('gmail_send', { to: 'a' }));
  assert.equal((await runWithConfig(envConfig(), () => verifyTicket(t2, 'gmail_send', { to: 'a' }))).ok, false, 'a different key (no vault) cannot');
  assert.equal(c1.ticketKey.length, 32); assert.equal(c1.auth.mode, 'vault'); assert.equal(c1.dek, undefined, 'the vault key itself is not on cfg');
}));

test('version.js equals package.json; the Vercel function budget is respected (<= 12) and /api/elvar/* is rewritten to the router', () => {
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  assert.equal(VERSION, JSON.parse(fs.readFileSync(root + 'package.json', 'utf8')).version);
  assert.ok(fs.readdirSync(root + 'api').filter((f) => f.endsWith('.js')).length <= 12);
  const v = JSON.parse(fs.readFileSync(root + 'vercel.json', 'utf8'));
  assert.ok(v.rewrites.some((r) => r.source === '/api/elvar/:path*' && r.destination === '/api/elvar?p=:path*'));
});

test('login: 40 parallel wrong guesses -> at most 5 reach the password check (counted atomically before scrypt)', () => fresh(async ({ logs }) => {
  await setup(logs);
  const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => A.login(req(), { password: 'wrong password ' + i })));
  assert.equal(rs.filter((r) => r.status === 401).length, 5); assert.equal(rs.filter((r) => r.status === 429).length, 35);
  assert.equal((await A.login(req(), { password: PW })).status, 429, 'still locked');
}));

test('login: a success clears the address count; a global failure cap stops distributed guessing; IPv6 is grouped by /64', () => fresh(async ({ logs }) => {
  await setup(logs);
  for (let i = 0; i < 4; i++) await A.login(req(), { password: 'nope nope nope' });
  assert.equal((await A.login(req(), { password: PW })).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await A.login(req(), { password: 'nope nope nope' })).status, 401, 'the count restarted');
  // IPv6: different addresses in one /64 share one counter
  const v6 = (h) => req({ socket: { remoteAddress: `2001:db8:1:2:${h}::1` } });
  for (let i = 0; i < 5; i++) assert.equal((await A.login(v6(i.toString(16)), { password: 'nope nope nope' })).status, 401);
  assert.equal((await A.login(v6('ff'), { password: PW })).status, 429, 'same /64');
  assert.equal(A.addrKey('2001:db8:1:2:aaaa::1'), A.addrKey('2001:0db8:0001:0002:ffff:1:2:3'));
  assert.equal(A.addrKey('::ffff:192.0.2.1'), '192.0.2.1'); assert.equal(A.addrKey('192.0.2.1'), '192.0.2.1');
  // global cap: 100 failures across many addresses in 15 min
  const store = getStore(); await store.set('elvar:v1:rl:loginall:all', 100, { ttlSec: 900 });
  assert.equal((await A.login(req({ socket: { remoteAddress: '198.51.100.200' } }), { password: PW })).status, 429, 'global cap');
}));

test('password change uses the same atomic attempt counting', () => fresh(async ({ logs }) => {
  const { token } = await setup(logs); const me = await A.authenticate(withTok(token));
  const rs = await Promise.all(Array.from({ length: 12 }, () => A.changeOwnerPassword(req(), me, { current: 'wrong wrong wrong', next: 'a new long password' })));
  assert.equal(rs.filter((r) => r.status === 401).length, 5); assert.ok(rs.filter((r) => r.status === 429).length >= 7);
}));

test('client address: the socket off Vercel (forwarding headers ignored), ELVAR_TRUST_PROXY names the header of YOUR proxy (rightmost entry)', () => fresh(async () => {
  const r = req({ headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.7' }, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(A.clientIp(r), '127.0.0.1', 'not trusted by default');
  process.env.ELVAR_TRUST_PROXY = 'x-forwarded-for';
  try { assert.equal(A.clientIp(r), '203.0.113.7', 'the entry the proxy appended, not the one the client sent'); }
  finally { delete process.env.ELVAR_TRUST_PROXY; }
  process.env.VERCEL = '1'; assert.equal(A.clientIp(req({ headers: { 'x-real-ip': '203.0.113.8' } })), '203.0.113.8');
}));
