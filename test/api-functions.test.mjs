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

test('/api/notif: a user or a device token with the right scope; the relay itself is "coming soon" for everybody', async () => {
  const h = await startHarness();
  try {
    const a = h.mkUser(), hd = await h.bearer(a), av = mintVerifiedUid(a, 'test');
    const mk = async (scopes) => { const t = newDeviceToken(); await h.db.asUser(av, (r) => r.devices.create({ id: t.deviceId, name: 'p', tokenHash: t.hash, scopes })); return { 'x-elvar-token': t.token }; };
    const push = await mk(['notif:push']), pull = await mk(['notif:pull']);
    for (const [hdrs, method, want] of [[hd, 'GET', 503], [hd, 'POST', 503], [push, 'POST', 503], [pull, 'GET', 503], [push, 'GET', 401], [pull, 'POST', 401], [{ 'x-elvar-token': 'elv2.0000000000000000.' + 'a'.repeat(43) }, 'GET', 401]]) {
      const r = await run('notif', method, hdrs); assert.equal(r.status, want, `${method} ${JSON.stringify(Object.keys(hdrs))}`);
      if (want === 503) { assert.equal(r.body.error, 'coming_soon'); assert.match(r.body.message, /準備中/); }
    }
    assert.equal((await run('google-execute', 'POST', push, { tool: 'current_datetime' })).status, 401, 'a device token opens nothing but /api/notif');
  } finally { await h.stop(); }
});
