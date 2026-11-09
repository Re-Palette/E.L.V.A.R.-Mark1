// The Vercel functions (api/*.js): every one except /api/health needs a signed-in user; /api/notif also takes a device token with the right scope.
// And the platform stays within Vercel's Hobby limit of 12 functions (docs/ELVAR_MULTIUSER.md M10).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startHarness } from './helpers/api-harness.mjs';
import { newDeviceToken } from '../server/auth/device-token.js';
import { mintVerifiedUid } from '../server/db/verified-uid.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const fakeRes = () => { const r = { headers: {}, statusCode: 0, body: '' }; r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; }; r.end = (b) => { r.body = b; }; return r; };
const run = async (mod, method, headers = {}, body = {}, url = '/x') => { const res = fakeRes(); await (await import(`../api/${mod}.js`)).default({ method, url, headers: { 'content-type': 'application/json', ...headers }, socket: {}, body }, res); return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }; };

test('at most 12 Vercel functions', () => {
  const fns = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js'));
  assert.ok(fns.length <= 12, `${fns.length} functions`); assert.deepEqual(fns.sort(), ['agent-run.js', 'chat.js', 'elvar.js', 'google-execute.js', 'health.js', 'hud-data.js', 'live-token.js', 'notif.js', 'system-check.js']);
});

test('every function but health refuses a request without a login, and a token of a deleted user; with a login they run as that user', async () => {
  const h = await startHarness();
  try {
    const uid = h.mkUser(), hd = await h.bearer(uid), ghost = await h.bearer(crypto.randomUUID());
    for (const [mod, method] of [['chat', 'POST'], ['google-execute', 'POST'], ['agent-run', 'POST'], ['hud-data', 'GET'], ['system-check', 'GET'], ['live-token', 'POST'], ['notif', 'GET'], ['notif', 'POST']]) {
      assert.equal((await run(mod, method)).status, 401, `${mod} ${method} without a token`);
      assert.equal((await run(mod, method, ghost)).status, 401, `${mod} ${method} with a deleted user's token`);
    }
    const t = await run('google-execute', 'POST', hd, { tool: 'current_datetime', args: {} }); assert.equal(t.status, 200); assert.equal(t.body.ok, true);
    assert.equal((await run('google-execute', 'POST', hd, { tool: 'calendar_list_events', args: {} })).status, 503, 'Google is not connected for anybody yet');
    assert.equal((await run('chat', 'POST', hd, { action: 'chat', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })).status, 503, 'no key of the user\'s own -> no answer (and no platform key to use)');
    const sc = await run('system-check', 'GET', hd); assert.equal(sc.status, 200); assert.ok(sc.body.items.some((i) => i.id === 'gemini' && i.status === 'fail'));
  } finally { await h.stop(); }
});

test('/api/notif: the encrypted relay per user - the phone (push token) uploads, the PC (login, or a pull token) downloads; B never reaches A\'s items; a push token cannot read or clear', async () => {
  const h = await startHarness();
  try {
    const a = h.mkUser(), b = h.mkUser(), hA = await h.bearer(a), hB = await h.bearer(b), av = mintVerifiedUid(a, 'test'), bv = mintVerifiedUid(b, 'test');
    const mk = async (v, scopes) => { const t = newDeviceToken(); await h.db.asUser(v, (r) => r.devices.create({ id: t.deviceId, name: 'p', tokenHash: t.hash, scopes })); return { 'x-elvar-token': t.token }; };
    const push = await mk(av, ['notif:push']), pull = await mk(av, ['notif:pull']), pushB = await mk(bv, ['notif:push']);
    const now = Date.now(), it = (id, at, ct) => ({ id, at, iv: 'AAAAAAAAAAAAAAAA', ct });
    const A_CT = 'QUFBQS1SRUxBWS1DSVBIRVJURVhU';
    assert.deepEqual((await run('notif', 'POST', push, { items: [it('n1-aaaa', now - 2000, A_CT), it('n2-aaaa', now - 1000, A_CT), { id: 'bad id', at: now, iv: 'x', ct: 'y' }] })).body, { stored: 2 });
    assert.equal((await run('notif', 'POST', push, { items: [it('n1-aaaa', now - 2000, A_CT)] })).body.stored, 1, 'the same id is stored once (checked below)');
    for (const hdr of [hA, pull]) { const r = await run('notif', 'GET', hdr, {}, '/api/notif?since=0'); assert.equal(r.status, 200); assert.deepEqual(r.body.items.map((x) => x.id), ['n1-aaaa', 'n2-aaaa']); }
    assert.deepEqual((await run('notif', 'GET', hA, {}, '/api/notif?status=1')).body, { configured: true, reachable: true, stored: 2, keepDays: 3 });
    // B: own login, and B's own phone, see and change only B's relay
    assert.deepEqual((await run('notif', 'GET', hB, {}, '/api/notif?since=0')).body.items, [], 'B sees nothing of A\'s');
    assert.equal((await run('notif', 'POST', pushB, { items: [it('n1-aaaa', now, 'QkJCQg-B-RELAY-CIPHERTEXT')] })).body.stored, 1, 'the same id as A\'s is B\'s own item');
    assert.deepEqual((await run('notif', 'GET', hA, {}, '/api/notif?since=0')).body.items.map((x) => x.ct), [A_CT, A_CT], 'A\'s items are unchanged');
    assert.equal((await run('notif', 'POST', hB, { action: 'clear' })).status, 200);
    assert.equal((await run('notif', 'GET', hA, {}, '/api/notif?status=1')).body.stored, 2, 'B clearing the relay did not clear A\'s');
    // scopes: a push token can neither read nor clear; a pull token cannot upload; unknown / forged tokens are refused
    assert.equal((await run('notif', 'GET', push)).status, 401); assert.equal((await run('notif', 'POST', pull, { items: [it('n9-aaaa', now, A_CT)] })).status, 401);
    assert.equal((await run('notif', 'POST', push, { action: 'clear' })).status, 403, 'the phone cannot wipe the relay');
    assert.equal((await run('notif', 'GET', { 'x-elvar-token': 'elv2.0000000000000000.' + 'a'.repeat(43) })).status, 401);
    assert.equal((await run('notif', 'POST', hA, { action: 'clear' })).body.cleared, true); assert.deepEqual((await run('notif', 'GET', hA, {}, '/api/notif?since=0')).body.items, []);
    assert.equal((await run('google-execute', 'POST', push, { tool: 'current_datetime' })).status, 401, 'a device token opens nothing but /api/notif');
  } finally { await h.stop(); }
});
