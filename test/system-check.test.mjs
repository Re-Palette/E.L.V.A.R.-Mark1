import test from 'node:test';
import assert from 'node:assert/strict';
import { runServerChecks } from '../server/system-check.js';
import { declarations } from '../server/google/tools.js';
import { summarize, reportText } from '../web/src/system-check.js';

const KEYS = ['GEMINI_API_KEY', 'ELVAR_ACCESS_TOKEN', 'GROQ_API_KEY', 'NEWSDATA_API_KEY', 'BRAIN_GITHUB_TOKEN', 'BRAIN_REPO', 'BUILD_REPO', 'BUILD_GITHUB_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_API_MOCK_ORIGIN', 'SUBAGENT_PROVIDER', 'VERCEL'];
async function withEnv(env, fn) {
  const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); for (const k of KEYS) delete process.env[k]; Object.assign(process.env, env);
  const real = globalThis.fetch;
  try { return await fn(); } finally { globalThis.fetch = real; for (const k of KEYS) old[k] === undefined ? delete process.env[k] : (process.env[k] = old[k]); }
}
const by = (r, id) => r.items.find((i) => i.id === id);

test('system check (server): reports what it measured; optional features are "off", not failures; keys problems are "fail"', async () => {
  await withEnv({}, async () => {
    globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); };
    const r = await runServerChecks();
    assert.equal(by(r, 'gemini').status, 'fail'); assert.match(by(r, 'gemini').fix, /GEMINI_API_KEY/);
    assert.equal(by(r, 'google').status, 'off'); assert.equal(by(r, 'news').status, 'off'); assert.equal(by(r, 'groq').status, 'off'); assert.equal(by(r, 'brain').status, 'off');
    assert.equal(by(r, 'access').status, 'warn');
    assert.equal(by(r, 'weather').status, 'warn'); assert.match(by(r, 'weather').detail, /接続できません: ENOTFOUND/);
  });
  await withEnv({ GEMINI_API_KEY: 'k', ELVAR_ACCESS_TOKEN: 't', GROQ_API_KEY: 'g', NEWSDATA_API_KEY: 'n' }, async () => {
    const seen = [];
    globalThis.fetch = async (u, o = {}) => {
      u = String(u); seen.push(u);
      if (u.includes('generativelanguage')) return { ok: false, status: 403, json: async () => ({}) };
      if (u.includes('api.groq.com')) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const r = await runServerChecks();
    assert.equal(by(r, 'gemini').status, 'fail'); assert.match(by(r, 'gemini').detail, /拒否/);
    assert.equal(by(r, 'groq').status, 'ok'); assert.equal(by(r, 'access').status, 'ok');
    assert.equal(by(r, 'news').status, 'ok'); assert.match(by(r, 'news').detail, /通信は確認していません/);
    assert.ok(!seen.some((u) => u.includes('newsdata.io')), 'a normal check spends no news credit');
    const d = await runServerChecks({ deep: true });
    assert.ok(seen.some((u) => u.includes('newsdata.io')), 'deep check probes news'); assert.match(by(d, 'news').detail, /1クレジット/);
  });
});

test('system check: voice tool is offered even without Google; summary and report text', () => {
  const only = declarations({ alwaysOnly: true }).map((d) => d.name);
  assert.deepEqual([...only].sort(), ['api_status', 'file_delete', 'file_import', 'file_list', 'file_read', 'file_search', 'file_show', 'file_tag', 'human_protocol', 'print_file', 'show_choice', 'system_check']);
  assert.ok(declarations().some((d) => d.name === 'system_check'));
  const items = [{ id: 'a', group: 'server', label: 'A', status: 'ok', detail: 'fine' }, { id: 'b', group: 'server', label: 'B', status: 'warn', detail: 'slow', fix: 'x' }, { id: 'c', group: 'device', label: 'C', status: 'fail', detail: 'bad' }, { id: 'd', group: 'device', label: 'D', status: 'off', detail: 'unused' }];
  const s = summarize(items);
  assert.deepEqual(s.counts, { ok: 1, warn: 1, fail: 1, off: 1 }); assert.deepEqual(s.problems.map((p) => p.id), ['c', 'b']); assert.match(s.verdict, /異常が 1 件/);
  assert.equal(summarize([items[0], items[3]]).verdict, '異常はありません');
  assert.match(reportText(items, 'T'), /\[異常\] C — bad/);
});

test('api connections: one row per service; free probes only; key-only services are marked "not verified"; failures and missing keys are explained', async () => {
  const { apiConnections } = await import('../server/api-status.js');
  const { stateWord } = await import('../web/src/system-check.js');
  const keep = { ...process.env }; const urls = [];
  Object.assign(process.env, { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', SARASHINA_API_KEY: 's', SARASHINA_ENABLED: '1', EXA_API_KEY: 'e', NEWSDATA_API_KEY: 'n' });
  for (const k of ['BRAIN_GITHUB_TOKEN', 'BRAIN_REPO', 'BUILD_REPO', 'BUILD_GITHUB_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) delete process.env[k];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { urls.push(String(url)); if (String(url).includes('groq')) return { ok: false, status: 401, json: async () => ({}) }; if (String(url).includes('sarashina')) return { ok: false, status: 429, json: async () => ({}) }; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const rows = await apiConnections({}); const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.deepEqual(rows.map((r) => r.id), ['api-gemini', 'api-groq', 'api-sarashina', 'api-exa', 'api-newsdata', 'api-weather', 'api-google', 'api-github', 'api-build', 'api-upstash']);
    assert.equal(by['api-gemini'].status, 'ok'); assert.equal(by['api-gemini'].verified, true); assert.equal(stateWord(by['api-gemini']), '接続中');
    assert.equal(by['api-groq'].status, 'fail'); assert.match(by['api-groq'].detail, /拒否/);
    assert.equal(by['api-sarashina'].status, 'warn'); assert.match(by['api-sarashina'].detail, /上限/);
    assert.equal(by['api-exa'].status, 'ok'); assert.equal(by['api-exa'].verified, false); assert.equal(stateWord(by['api-exa']), '設定済み（未確認）');
    assert.equal(by['api-github'].status, 'off'); assert.equal(stateWord(by['api-github']), '未設定'); assert.ok(by['api-github'].fix);
    assert.ok(!urls.some((u) => /exa\.ai|newsdata/.test(u)), 'no paid/quota calls without deep');
    urls.length = 0; await apiConnections({ deep: true }); assert.ok(urls.some((u) => /exa\.ai/.test(u)) && urls.some((u) => /newsdata/.test(u)), 'deep checks Exa and NewsData too');
  } finally { globalThis.fetch = real; for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); }
});

test('system check: reports where each key comes from (app / env) and the missing required key', async () => {
  const { runWithConfig, envConfig } = await import('../server/config/resolve.js');
  const st = { GEMINI_API_KEY: { set: false, source: 'default', last4: null }, GROQ_API_KEY: { set: true, source: 'app', last4: 'AB12' }, EXA_API_KEY: { set: true, source: 'env', last4: null } };
  const cfg = { ...envConfig(), auth: { mode: 'vault' }, secretStatus: () => st };
  const realFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const r = await runWithConfig(cfg, () => runServerChecks({}));
    const c = by(r, 'config');
    assert.equal(c.status, 'fail'); assert.match(c.detail, /Groq API key: アプリ（末尾 AB12）/); assert.match(c.detail, /Exa API key: 環境変数/); assert.match(c.detail, /未設定の必須項目: Gemini API key/);
    assert.equal(by(r, 'access').status, 'ok');
  } finally { globalThis.fetch = realFetch; }
});
