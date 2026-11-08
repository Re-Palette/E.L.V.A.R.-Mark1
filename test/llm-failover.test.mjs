import test from 'node:test';
import assert from 'node:assert/strict';
import { completeText, usable } from '../server/llm.js';
import { _reset, isUp, downInfo } from '../server/llm-health.js';
import { TOOL_MAP } from '../server/google/tools.js';
import { chat } from '../server/chat-api.js';

const KEYS = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'SARASHINA_API_KEY', 'SARASHINA_ENABLED'];
async function withKeys(set, fn) {
  const keep = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); for (const k of KEYS) delete process.env[k]; Object.assign(process.env, set, set.SARASHINA_API_KEY ? { SARASHINA_ENABLED: '1' } : {}); _reset();
  const real = globalThis.fetch; try { return await fn(); } finally { globalThis.fetch = real; _reset(); for (const k of KEYS) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } }
}
const host = (u) => (String(u).includes('sarashina') ? 'sarashina' : String(u).includes('groq') ? 'groq' : 'gemini');
const ok = (t) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: t } }] }), text: async () => JSON.stringify({ choices: [{ message: { content: t } }] }), headers: { get: () => null } });
const bad = (st, m = 'x') => ({ ok: false, status: st, json: async () => ({ error: { message: m } }), text: async () => JSON.stringify({ error: { message: m } }), headers: { get: () => null } });
const msgs = [{ role: 'user', content: 'こんにちは' }];

test('failover: a rejected Sarashina (403) is covered by Gemini, then skipped on the next request; Groq covers when Gemini is limited too', async () => {
  await withKeys({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', SARASHINA_API_KEY: 's' }, async () => {
    const calls = []; let gemini = 'ok';
    globalThis.fetch = async (u) => { const h = host(u); calls.push(h); if (h === 'sarashina') return bad(403, ''); if (h === 'gemini' && gemini === 'limit') return bad(429, 'quota'); return ok(h + 'の答え'); };
    const r1 = await completeText({ messages: msgs, prefer: ['sarashina', 'gemini', 'groq'] });
    assert.equal(r1.via, 'gemini'); assert.match(r1.note, /Sarashinaが使えなかった/); assert.deepEqual(calls, ['sarashina', 'gemini']);
    assert.equal(isUp('sarashina'), false, 'marked down after the 403'); assert.equal(downInfo().sarashina, 403);
    calls.length = 0; const r2 = await completeText({ messages: msgs, prefer: ['sarashina', 'gemini', 'groq'] });
    assert.deepEqual(calls, ['gemini'], 'no request wasted on the rejected API'); assert.equal(r2.via, 'gemini');
    gemini = 'limit'; calls.length = 0; const r3 = await completeText({ messages: msgs, prefer: ['sarashina', 'gemini', 'groq'] });
    assert.equal(r3.via, 'groq'); assert.deepEqual(calls, ['gemini', 'groq']);
  });
});

test('failover: with only one working API it is used; when everything is marked down they are all tried anyway; nothing configured = clear error', async () => {
  await withKeys({ GEMINI_API_KEY: 'g' }, async () => {
    globalThis.fetch = async (u) => ok('Geminiだけ'); assert.equal((await completeText({ messages: msgs, prefer: ['sarashina', 'gemini', 'groq'] })).via, 'gemini');
  });
  await withKeys({ GEMINI_API_KEY: 'g', SARASHINA_API_KEY: 's' }, async () => {
    let down = true; globalThis.fetch = async (u) => (down ? bad(429) : ok('回復'));
    await assert.rejects(() => completeText({ messages: msgs, prefer: ['sarashina', 'gemini'] }), /すべての文章生成APIで失敗/);
    assert.deepEqual(usable(['sarashina', 'gemini']).sort(), ['gemini', 'sarashina'], 'all down: still tried');
    down = false; assert.equal((await completeText({ messages: msgs, prefer: ['sarashina', 'gemini'] })).text, '回復');
  });
  await withKeys({}, async () => { await assert.rejects(() => completeText({ messages: msgs }), /使える文章生成のAPIがありません/); });
});

test('jp_text works without Sarashina (Gemini), and Groq answers when Gemini is limited and Sarashina is not set', async () => {
  await withKeys({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' }, async () => {
    let gemini = 'ok'; globalThis.fetch = async (u) => (host(u) === 'gemini' && gemini === 'limit' ? bad(429) : ok(host(u) + 'の要約'));
    const r = await TOOL_MAP.jp_text.run({ task: 'summarize', text: 'あ'.repeat(50) }); assert.equal(r.source, 'Gemini');
    gemini = 'limit'; _reset(); const r2 = await TOOL_MAP.jp_text.run({ task: 'summarize', text: 'あ'.repeat(50) }); assert.equal(r2.source, 'Groq'); assert.match(r2.note, /Geminiが使えなかった|使えなかったため/);
  });
});

test('standard voice chat: Gemini limited, Sarashina rejected -> Groq answers in plain text', async () => {
  await withKeys({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', SARASHINA_API_KEY: 's' }, async () => {
    globalThis.fetch = async (u) => { const h = host(u); return h === 'groq' ? ok('Groqが答えます') : h === 'sarashina' ? bad(403, '') : bad(429, 'quota'); };
    const r = await chat({ contents: [{ role: 'user', parts: [{ text: 'こんにちは' }] }] });
    assert.equal(r.via, 'groq'); assert.equal(r.parts[0].text, 'Groqが答えます');
  });
});

test('sub-agents skip an API that was just rejected', async () => {
  const { routeFor } = await import('../server/agents/provider.js'); const { noteFailure } = await import('../server/llm-health.js');
  await withKeys({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', SARASHINA_API_KEY: 's' }, async () => {
    assert.deepEqual(routeFor('minutes'), ['gemini', 'groq', 'sarashina']);
    noteFailure('sarashina', 403); assert.deepEqual(routeFor('minutes'), ['gemini', 'groq']);
    noteFailure('gemini', 429); noteFailure('groq', 429); assert.deepEqual(routeFor('minutes'), ['gemini', 'groq', 'sarashina'], 'all marked down: all are tried anyway');
  });
});

test('Sarashina is OFF by default (key saved but SARASHINA_ENABLED unset): never called, agents (spec / minutes / reply) lead with Gemini, text work goes to Gemini', async () => {
  const { routeFor } = await import('../server/agents/provider.js');
  const keep = { ...process.env }; Object.assign(process.env, { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', SARASHINA_API_KEY: 'sk' }); delete process.env.SARASHINA_ENABLED; _reset();
  const real = globalThis.fetch, hosts = [];
  try {
    for (const a of ['spec', 'minutes', 'reply', 'mail', 'idea']) assert.deepEqual(routeFor(a), ['gemini', 'groq'], a);
    assert.deepEqual(usable(['sarashina', 'gemini', 'groq']), ['gemini', 'groq']);
    globalThis.fetch = async (u) => { hosts.push(host(u)); return ok('Geminiの答え'); };
    const r = await TOOL_MAP.jp_text.run({ task: 'summarize', text: 'あ'.repeat(40) }); assert.equal(r.source, 'Gemini'); assert.ok(!hosts.includes('sarashina'));
    process.env.SARASHINA_ENABLED = '1'; assert.deepEqual(routeFor('spec'), ['gemini', 'groq', 'sarashina']);
  } finally { globalThis.fetch = real; for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); _reset(); }
});

test('rate-limit cool-down follows the API\'s own Retry-After (seconds, or Groq-style "2m30s"), capped at 30 minutes', async () => {
  const { retryAfterSec, noteFailure, isUp, _reset } = await import('../server/llm-health.js');
  const h = (v) => ({ get: (k) => (k === 'retry-after' ? v : null) });
  assert.equal(retryAfterSec(h('12')), 12); assert.equal(retryAfterSec(h('2m30s')), 150); assert.equal(retryAfterSec(h('6.5s')), 6.5); assert.equal(retryAfterSec(h('')), null); assert.equal(retryAfterSec({ get: () => null }), null);
  _reset(); const real = Date.now; let now = real();
  Date.now = () => now;
  try {
    noteFailure('groq', 429, 8); assert.equal(isUp('groq'), false); now += 10_000; assert.equal(isUp('groq'), true, 'a per-minute limit is over after ~8 s');
    noteFailure('groq', 429, 7200); now += 29 * 60_000; assert.equal(isUp('groq'), false); now += 2 * 60_000; assert.equal(isUp('groq'), true, 'a daily limit is retried at most every 30 min');
    noteFailure('groq', 429); now += 30_000; assert.equal(isUp('groq'), false, 'no header: the default 1 min');
  } finally { Date.now = real; _reset(); }
});
