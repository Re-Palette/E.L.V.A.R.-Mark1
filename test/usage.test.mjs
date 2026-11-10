// Usage metering and limits (docs/ELVAR_MULTIUSER.md 6; principle 6): every provider call is counted in the CALLER's own usage (their own day), the user's soft limits warn or
// stop (and only for them), an administrator's hard limits stop an account (and only that account), the refusals are clear Japanese, and the numbers the page reports are
// checked against the clock. Real route table + MemoryDb + two signed-in users; the providers are a stub fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/api-harness.mjs';
import { authenticate } from '../server/auth/with-user.js';
import { runWithConfig } from '../server/config/resolve.js';
import { meteredFetch, gate, UsageLimitError, _clearUsageCache, userDay, assertRoomForNote } from '../server/usage.js';
import { completeText } from '../server/llm.js';
import { executeTool } from '../server/tools/execute.js';
import { LIVE_METRICS, HARD_LIMITS, effectiveHardLimits, envDefaultLimits, shown, stored, limitMessage } from '../server/usage-limits.js';
import { _clearRequestWindows } from '../server/auth/with-user.js';
import { mintVerifiedUid } from '../server/db/verified-uid.js';
import { startMcp } from './helpers/mock-mcp.mjs';

process.env.ELVAR_UNSAFE_TEST_NETWORK = 'loopback'; delete process.env.VERCEL; delete process.env.NODE_ENV;
let h, a, b, A, B;
test.before(async () => {
  h = await startHarness(); _clearUsageCache(); _clearRequestWindows();
  a = h.mkUser('a@example.test'); b = h.mkUser('b@example.test'); A = await h.bearer(a); B = await h.bearer(b);
  for (const who of [A, B]) { await h.call('GET', '/api/elvar/session', who); await h.call('PATCH', '/api/elvar/config', who, { secrets: { GEMINI_API_KEY: 'AIza-test-key-1234567890', GROQ_API_KEY: 'gsk-test-key-1234567890' } }); }
});
test.after(() => h.stop());

/** Run fn the way a request runs: inside the user's own request configuration. */
async function as(who, fn) { const r = await authenticate('user', { headers: who, socket: { remoteAddress: '203.0.113.7' } }); assert.ok(r.ok, JSON.stringify(r)); await r.ctx.loadConfig({ fresh: true }); return runWithConfig(r.ctx.cfg, fn); }
const uidOf = (u) => mintVerifiedUid(u, 'test');
const numbers = async (u) => { const day = userDay(); return Object.fromEntries((await h.db.asUser(uidOf(u), (r) => r.usage.daily({ from: day, to: day }))).map((x) => [`${x.provider}|${x.metric}`, x.amount])); };
const stubFetch = (handler) => { const real = globalThis.fetch, calls = []; globalThis.fetch = async (url, init = {}) => { calls.push(String(url)); return handler(String(url), init); }; return { calls, restore: () => { globalThis.fetch = real; } }; };
const okJson = (j) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => j, clone() { return this; } });
const setLimit = (who, l) => h.call('PUT', '/api/elvar/usage/limits', who, l);
const delLimit = (who, p, m, per) => h.call('DELETE', `/api/elvar/usage/limits/${p}/${m}/${per}`, who);

test('every provider call is counted for the caller only: calls always, tokens when the answer has them (Gemini usageMetadata, OpenAI-style usage), on the user\'s own day', async () => {
  const f = stubFetch((u) => okJson(u.includes('generativelanguage') ? { usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 } } : u.includes('groq') ? { usage: { prompt_tokens: 50, completion_tokens: 7 } } : { results: [] }));
  try {
    await as(A, async () => {
      await meteredFetch('gemini', 'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent', { method: 'POST' });
      await meteredFetch('groq', 'https://api.groq.com/openai/v1/chat/completions', { method: 'POST' });
      await meteredFetch('exa', 'https://api.exa.ai/search', { method: 'POST' }); await meteredFetch('newsdata', 'https://newsdata.io/api/1/latest');
      await meteredFetch('google', 'https://www.googleapis.com/calendar/v3/x'); await meteredFetch('sarashina', 'https://api.sarashina.ai/v1/chat/completions', {}, { tokens: false });
    });
  } finally { f.restore(); }
  assert.deepEqual(await numbers(a), { 'gemini|calls': 1, 'gemini|input_tokens': 120, 'gemini|output_tokens': 30, 'groq|calls': 1, 'groq|input_tokens': 50, 'groq|output_tokens': 7, 'exa|calls': 1, 'newsdata|calls': 1, 'google|calls': 1, 'sarashina|calls': 1 });
  assert.deepEqual(await numbers(b), {}, 'B\'s numbers did not move');
  // a call that never reached the provider (network error) is not counted; outside a request nothing is counted and fetch is just fetch
  const f2 = stubFetch(() => { throw new Error('ECONNRESET'); });
  try { await as(B, async () => { await assert.rejects(meteredFetch('exa', 'https://api.exa.ai/search', {}), /ECONNRESET/); }); } finally { f2.restore(); }
  assert.deepEqual(await numbers(b), {});
  const f3 = stubFetch(() => okJson({})); try { assert.equal((await meteredFetch('exa', 'https://x.test', {})).ok, true); } finally { f3.restore(); }
});

test('soft limits are the user\'s own: warn never stops anything; stop refuses further calls of that provider with a Japanese sentence; the other user and other providers are not affected; removing it lifts it at once', async () => {
  const f = stubFetch(() => okJson({}));
  try {
    const n0 = (await numbers(a))['exa|calls'] || 0;
    assert.equal((await setLimit(A, { provider: 'exa', metric: 'calls', period: 'day', soft: n0 + 2, softAction: 'warn' })).status, 200);
    await as(A, async () => { for (let i = 0; i < 4; i++) await meteredFetch('exa', 'https://api.exa.ai/search', {}); });   // over the warning limit: still goes through
    assert.equal(f.calls.length, 4);
    assert.equal((await setLimit(A, { provider: 'exa', metric: 'calls', period: 'day', soft: n0 + 5, softAction: 'block' })).status, 200);
    await as(A, async () => { await meteredFetch('exa', 'https://api.exa.ai/search', {}); });   // the 5th: allowed (used n0+4 < n0+5), now at the limit
    const before = f.calls.length;
    await as(A, async () => { await assert.rejects(meteredFetch('exa', 'https://api.exa.ai/search', {}), (e) => { const c = [e instanceof UsageLimitError, e.status === 429, e.code === 'soft_limit', /Exa/.test(e.message), new RegExp(`1日の上限（${n0 + 5}回）`).test(e.message), /あなたが設定した上限/.test(e.message), /利用状況/.test(e.message)]; return c.every(Boolean); }); });
    assert.equal(f.calls.length, before, 'refused BEFORE the call: nothing reached the provider and nothing was counted');
    assert.equal((await numbers(a))['exa|calls'], n0 + 5);
    await as(A, async () => { await meteredFetch('groq', 'https://api.groq.com/x', {}); });   // another provider of A is fine
    await as(B, async () => { await meteredFetch('exa', 'https://api.exa.ai/search', {}); });   // B has no limit
    assert.equal((await delLimit(A, 'exa', 'calls', 'day')).status, 200);
    await as(A, async () => { await meteredFetch('exa', 'https://api.exa.ai/search', {}); });   // lifted at once
  } finally { f.restore(); }
});

test('soft limits by month and by token count; a Live-time limit stops a Live start but not ordinary Gemini calls (and the reverse)', async () => {
  const f = stubFetch((u) => okJson({ usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 0 } }));
  try {
    await setLimit(B, { provider: 'gemini', metric: 'input_tokens', period: 'month', soft: 1000, softAction: 'block' });
    await as(B, async () => { await meteredFetch('gemini', 'https://generativelanguage.googleapis.com/x', {}); await meteredFetch('gemini', 'https://generativelanguage.googleapis.com/x', {}); });   // 600 + 600 > 1000
    await as(B, async () => { await assert.rejects(meteredFetch('gemini', 'https://generativelanguage.googleapis.com/x', {}), (e) => e.code === 'soft_limit' && /1か月の上限/.test(e.message) && /入力トークン/.test(e.message)); });
    await delLimit(B, 'gemini', 'input_tokens', 'month');
    // Live time
    await setLimit(B, { provider: 'gemini', metric: 'live_seconds', period: 'day', soft: 60, softAction: 'block' });
    await h.db.asUser(uidOf(b), (r) => r.usage.record({ provider: 'gemini', metric: 'live_seconds', amount: 90, source: 'client', day: userDay() }));
    _clearUsageCache();
    await as(B, async () => { await gate('gemini'); await assert.rejects(gate('gemini', { metrics: LIVE_METRICS }), (e) => e.code === 'soft_limit' && /Live 会話の時間/.test(e.message) && /1日の上限（1分）/.test(e.message)); });   // ordinary calls pass, a Live start does not
    await delLimit(B, 'gemini', 'live_seconds', 'day');
    await setLimit(B, { provider: 'gemini', metric: 'calls', period: 'day', soft: 1, softAction: 'block' });
    await as(B, async () => { await assert.rejects(gate('gemini'), /Gemini/); await gate('gemini', { metrics: LIVE_METRICS }); });   // a calls limit does not stop a Live start
    await delLimit(B, 'gemini', 'calls', 'day');
  } finally { f.restore(); }
});

test('hard limits are the administrator\'s: a daily call limit per provider stops that account only, in Japanese that says it is the administrator\'s; null lifts it', async () => {
  const f = stubFetch(() => okJson({})); const boss = await h.adminBearer(h.mkUser('boss@example.test'));
  try {
    const set = (l) => h.call('POST', `/api/elvar/admin/users/${a}/limits`, boss, { limits: l });
    const n0 = (await numbers(a))['newsdata|calls'] || 0;
    assert.equal((await set({ newsdataCallsPerDay: n0 + 2 })).status, 200);
    await as(A, async () => { for (let i = 0; i < 2; i++) await meteredFetch('newsdata', 'https://newsdata.io/x', {}); await assert.rejects(meteredFetch('newsdata', 'https://newsdata.io/x', {}), (e) => e.code === 'hard_limit' && /管理者が設定した上限/.test(e.message) && /明日/.test(e.message) && /NewsData/.test(e.message)); });
    await as(B, async () => { for (let i = 0; i < 3; i++) await meteredFetch('newsdata', 'https://newsdata.io/x', {}); });   // B is not limited
    assert.equal((await h.call('GET', '/api/elvar/usage', A)).body.hardMeters.find((m) => m.key === 'newsdataCallsPerDay').level, 'over');
    assert.equal((await set({ newsdataCallsPerDay: null })).status, 200); _clearUsageCache();
    await as(A, async () => { await meteredFetch('newsdata', 'https://newsdata.io/x', {}); });
  } finally { f.restore(); }
});

test('the text router moves on when one provider is stopped by a limit (not an outage), and says so when every provider is stopped', async () => {
  const f = stubFetch((u) => okJson(u.includes('groq') ? { choices: [{ message: { content: 'groq-answer' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } } : { choices: [{ message: { content: 'gemini-answer' } }] }));
  const mk = (e) => as(A, () => completeText({ messages: [{ role: 'user', content: 'x' }], prefer: ['gemini', 'groq'] }));
  try {
    await setLimit(A, { provider: 'gemini', metric: 'calls', period: 'day', soft: 0, softAction: 'block' });
    const r = await mk(); assert.equal(r.via, 'groq'); assert.equal(r.text, 'groq-answer');
    await setLimit(A, { provider: 'groq', metric: 'calls', period: 'day', soft: 0, softAction: 'block' });
    await assert.rejects(mk(), (e) => e instanceof UsageLimitError && /止めています/.test(e.message), 'every provider stopped by a limit: the limit sentence, not "all failed"');
    assert.equal(f.calls.filter((u) => u.includes('generativelanguage')).length, 0, 'a stopped provider is never called');
  } finally { f.restore(); await delLimit(A, 'gemini', 'calls', 'day'); await delLimit(A, 'groq', 'calls', 'day'); }
});

test('the administrator\'s limit on requests per minute (default 120) answers 429 with a Japanese message, per user', async () => {
  const boss = await h.adminBearer(h.mkUser('boss2@example.test')), c = h.mkUser('c@example.test'), C = await h.bearer(c);
  _clearRequestWindows();
  assert.equal((await h.call('POST', `/api/elvar/admin/users/${c}/limits`, boss, { limits: { requestsPerMinute: 4 } })).status, 200);
  const codes = []; for (let i = 0; i < 6; i++) codes.push((await h.call('GET', '/api/elvar/session', C)).status);
  assert.deepEqual(codes.slice(0, 3).every((x) => x === 200) && codes.slice(-2), [429, 429]); const r = await h.call('GET', '/api/elvar/session', C); assert.equal(r.body.error, 'rate_limited'); assert.match(r.body.message, /リクエスト.*1分あたり/);
  assert.equal((await h.call('GET', '/api/elvar/session', A)).status, 200, 'another user is not affected');
  await h.call('POST', `/api/elvar/admin/users/${c}/limits`, boss, { limits: { requestsPerMinute: null } }); _clearRequestWindows();
  assert.equal((await h.call('GET', '/api/elvar/session', C)).status, 200, 'null: the platform default (120) applies again');
});

test('connector calls are counted, and the administrator\'s daily limit on them stops the account; the number of notes and connectors can be capped too', async () => {
  const boss = await h.adminBearer(h.mkUser('boss3@example.test')), d = h.mkUser('d@example.test'), D = await h.bearer(d); await h.call('GET', '/api/elvar/session', D);
  const mcp = await startMcp();
  try {
    const cx = await h.call('POST', '/api/elvar/connectors', { ...D, host: 'localhost:8787' }, { type: 'mcp', name: 'Notes', mcp: { url: mcp.url }, auth: { type: 'none' } }); assert.equal(cx.status, 200, JSON.stringify(cx.body));
    const id = cx.body.connector.id; await h.call('POST', `/api/elvar/connectors/${id}/sync`, D, {});
    await h.call('PATCH', `/api/elvar/connectors/${id}`, D, { toolPrefs: { search: { approval: 'auto' } }, enabled: true });
    const run = () => as(D, () => executeTool({ tool: 'cx_notes_search', args: { query: 'x' } }));
    assert.equal((await run()).status, 200); assert.equal((await numbers(d))['connector|calls'], 1);
    assert.equal((await h.call('POST', `/api/elvar/admin/users/${d}/limits`, boss, { limits: { connectorCallsPerDay: 1 } })).status, 200);
    const refused = await run(); assert.equal(refused.status, 429); assert.match(refused.body.error, /連携アプリ.*管理者が設定した上限/); assert.equal(refused.body.code, 'hard_limit');
    assert.equal((await numbers(d))['connector|calls'], 1, 'a refused call is not counted');
    // the number of connectors
    assert.equal((await h.call('POST', `/api/elvar/admin/users/${d}/limits`, boss, { limits: { connectorCallsPerDay: null, maxConnectors: 1 } })).status, 200);
    const second = await h.call('POST', '/api/elvar/connectors', { ...D, host: 'localhost:8787' }, { type: 'mcp', name: 'Second', mcp: { url: mcp.url }, auth: { type: 'none' } }); assert.equal(second.status, 422); assert.match(JSON.stringify(second.body), /1個まで/);
    // the number of notes
    assert.equal((await h.call('POST', `/api/elvar/admin/users/${d}/limits`, boss, { limits: { maxNotes: 1 } })).status, 200);
    assert.equal((await h.call('POST', '/api/elvar/notes', D, { path: 'one.md', content: 'first' })).status, 200);
    const two = await h.call('POST', '/api/elvar/notes', D, { path: 'two.md', content: 'second' }); assert.equal(two.status, 429); assert.equal(two.body.error, 'hard_limit'); assert.match(two.body.message, /ノートの数.*上限（1件）/);
    assert.equal((await h.call('PUT', `/api/elvar/notes/${(await h.call('GET', '/api/elvar/notes', D)).body.notes[0].id}`, D, { content: 'first, edited' })).status, 200, 'editing an existing note is not creating one');
    await as(D, async () => { await h.db.asUser(uidOf(d), async (r) => assert.rejects(assertRoomForNote(r), /ノートの数/)); });
    await assert.rejects(as(D, () => import('../server/brain.js').then((m) => m.brainWrite({ path: 'three.md', content: 'x', mode: 'create' }))), /ノートの数/, 'the AI\'s tool obeys the same cap');
  } finally { await mcp.close(); }
});

test('the page\'s report: Live seconds are clamped to the time that really passed, tools are counted by name, shape and rate are checked; labelled as client-reported', async () => {
  const e = h.mkUser('e@example.test'), E = await h.bearer(e); await h.call('GET', '/api/elvar/session', E);
  const first = await h.call('POST', '/api/elvar/usage/report', E, { liveSeconds: 30, tools: { weather: 2, news: 1 } }); assert.equal(first.status, 200); assert.equal(first.body.credited, 30, 'the first report: what it says, up to 30 s');
  const second = await h.call('POST', '/api/elvar/usage/report', E, { liveSeconds: 60 }); assert.ok(second.body.credited <= 6, `a second report right after the first cannot claim a minute (got ${second.body.credited})`);
  const u = (await h.call('GET', '/api/elvar/usage', E)).body;
  assert.ok(u.today.gemini.live_seconds > 30 && u.today.gemini.live_seconds <= 36); assert.deepEqual(u.tools.map((t) => [t.name, t.count]), [['news', 1], ['weather', 2]].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])));
  assert.equal(u.sources.live_seconds, 'client'); assert.equal(u.sources.tools, 'client'); assert.equal(u.sources.calls, 'server'); assert.equal(u.scope, 'すべての端末の合計');
  for (const bad of [{ liveSeconds: -1 }, { liveSeconds: 601 }, { liveSeconds: 'x' }, { tools: [] }, { tools: { 'a b': 1 } }, { tools: { ok: 0 } }, { tools: { ok: 1.5 } }, { tools: Object.fromEntries(Array.from({ length: 41 }, (_, i) => ['t' + i, 1])) }]) assert.equal((await h.call('POST', '/api/elvar/usage/report', E, bad)).status, 422, JSON.stringify(bad).slice(0, 60));
  for (let i = 0; i < 12; i++) await h.call('POST', '/api/elvar/usage/report', E, { tools: { x: 1 } });
  assert.equal((await h.call('POST', '/api/elvar/usage/report', E, { tools: { x: 1 } })).status, 429, 'rate limited');
});

test('GET /api/elvar/usage: today, this month, 30 days, meters with 80 % / 100 % levels, the hard limits of the account, the storage meter, the catalog and where each number comes from', async () => {
  const g = h.mkUser('g@example.test'), G = await h.bearer(g); await h.call('GET', '/api/elvar/session', G);
  await h.db.asUser(uidOf(g), async (r) => { await r.usage.record({ provider: 'groq', metric: 'calls', amount: 8, day: userDay() }); await r.usage.record({ provider: 'exa', metric: 'calls', amount: 3, day: userDay() }); });
  await setLimit(G, { provider: 'groq', metric: 'calls', period: 'day', soft: 10, softAction: 'warn' }); await setLimit(G, { provider: 'exa', metric: 'calls', period: 'month', soft: 3, softAction: 'block' });
  const u = (await h.call('GET', '/api/elvar/usage', G)).body;
  assert.deepEqual(u.meters.map((m) => [m.provider, m.pct, m.level]).sort(), [['exa', 100, 'over'], ['groq', 80, 'warn']]); assert.match(u.meters.find((m) => m.provider === 'groq').text, /Groq.*呼び出し回数.*1日.*8回 \/ 10回/);
  assert.equal(u.today.groq.calls, 8); assert.equal(u.month.groq.calls, 8); assert.equal(u.hard.requestsPerMinute, 120); assert.equal(u.hard.maxFileBytes, 62914560); assert.equal(u.storage.quotaBytes, 524288000); assert.ok(u.catalog.gemini.metrics.live_seconds && u.catalog.connector);
  const rep = (await as(G, () => executeTool({ tool: 'usage_report', args: {} }))).body.result;
  assert.equal(rep.report.scope, 'すべての端末の合計'); assert.ok(rep.report.warnings.some((w) => /Exa.*上限に達しています/.test(w)) && rep.report.warnings.some((w) => /Groq.*近づいています/.test(w)));
  assert.equal(rep.report.items.find((i) => /Groq/.test(i.name)).today, '8回'); assert.match(rep.report.note, /端末からの報告/);
});

test('the catalog helpers: minutes <-> seconds, the defaults (ELVAR_DEFAULT_LIMITS under the account\'s own values, bad entries ignored), messages', () => {
  assert.equal(shown('gemini', 'live_seconds', 3600), 60); assert.equal(stored('gemini', 'live_seconds', 60), 3600); assert.equal(shown('groq', 'calls', 7.4), 7);
  assert.equal(effectiveHardLimits({}).requestsPerMinute, 120); assert.equal(effectiveHardLimits({}).geminiCallsPerDay, null); assert.equal(effectiveHardLimits({}).liveTokensPerHour, 30); assert.equal(effectiveHardLimits({}).maxConnectors, 10);
  const env = { ELVAR_DEFAULT_LIMITS: JSON.stringify({ geminiCallsPerDay: 500, requestsPerMinute: 60, nope: 1, maxNotes: -5, exaCallsPerDay: '3' }) };
  assert.deepEqual(envDefaultLimits(env), { geminiCallsPerDay: 500, requestsPerMinute: 60 }); assert.deepEqual(envDefaultLimits({ ELVAR_DEFAULT_LIMITS: 'not json' }), {}); assert.deepEqual(envDefaultLimits({ ELVAR_DEFAULT_LIMITS: '[1]' }), {});
  assert.equal(effectiveHardLimits({ hardLimits: { requestsPerMinute: 10 } }, env).requestsPerMinute, 10, 'the account\'s own value wins'); assert.equal(effectiveHardLimits({}, env).geminiCallsPerDay, 500);
  assert.equal(effectiveHardLimits({ hardLimits: { maxFileBytes: 0 } }).maxFileBytes, 0); assert.equal(Object.keys(HARD_LIMITS).includes('maxFileBytes'), true);
  assert.match(limitMessage({ kind: 'soft', provider: 'groq', metric: 'calls', period: 'day', limit: 5 }), /^Groqが、1日の上限（5回）に達したため、止めています。/);
  assert.match(limitMessage({ kind: 'hard', provider: 'gemini', metric: 'live_seconds', period: 'month', limit: 3600 }), /GeminiのLive 会話の時間が、1か月の上限（60分。管理者が設定した上限です）に達しました。来月/);
});
