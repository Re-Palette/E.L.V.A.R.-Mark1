// "Which APIs are connected?": one row per external service with a plain state. Cheap, free probes only (model lists, a tiny forecast, a token refresh);
// services that have no free ping are reported as "key set, not verified" unless `deep` (which spends a few requests).
import { readConfig } from './live-token-core.js';
import { googleStatus } from './google/index.js';
import { brainStatus, brainConfigured } from './brain.js';
import { syncStatus } from './notif-sync.js';
import { buildConfigured } from './build.js';
import { sarashinaConfigured, sarashinaEnabled, sarashinaChat, sarashinaKeyInfo, sarashinaBaseUrl } from './sarashina.js';
import { env } from './config/resolve.js';

const withTimeout = (p, ms = 6000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('時間切れ')), ms))]);
const why = (e) => String(e?.cause?.code || e?.message || e).slice(0, 120);
const ms = async (fn) => { const t = Date.now(); const r = await fn(); return [r, Date.now() - t]; };

/** @returns {Promise<{id:string,group:'api',label:string,status:'ok'|'warn'|'fail'|'off',detail:string,verified:boolean,fix?:string}[]>} */
export async function apiConnections({ deep = false } = {}) {
  const cfg = readConfig(), items = [];
  const add = (id, label, status, detail, { verified = status === 'ok', fix } = {}) => items.push({ id: 'api-' + id, group: 'api', label, status, detail, verified, ...(fix ? { fix } : {}) });
  const keyOnly = (id, label, envNames, what) => (envNames.some((k) => env(k)) ? add(id, label, 'ok', `キーは設定済み（${what}。通信の確認はしていません）`, { verified: false }) : add(id, label, 'off', '未設定です', { fix: envNames[0] + ' を設定' }));
  const probeHttp = async (id, label, url, headers, okText) => {
    try {
      const [r, t] = await ms(() => withTimeout(fetch(url, { headers })));
      if (r.ok) return add(id, label, 'ok', `接続できています（${t}ms）${okText || ''}`);
      if (r.status === 401 || r.status === 403) return add(id, label, 'fail', `キーが拒否されました (${r.status})`, { fix: 'キーを確認して作り直す' });
      if (r.status === 429) return add(id, label, 'warn', '利用上限に達しています (429)', { verified: true });
      add(id, label, 'warn', `応答はありましたが想定外です (${r.status})。キーは設定済み`, { verified: false });
    } catch (e) { add(id, label, 'fail', `接続できません: ${why(e)}`); }
  };

  const jobs = [];
  jobs.push(cfg.apiKey ? probeHttp('gemini', 'Gemini（音声会話・文章・検索）', 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { 'x-goog-api-key': cfg.apiKey }) : Promise.resolve(add('gemini', 'Gemini（音声会話・文章・検索）', 'fail', 'キーがありません', { fix: 'GEMINI_API_KEY を設定' })));
  jobs.push(env('GROQ_API_KEY') ? probeHttp('groq', 'Groq（難しい推論・サブエージェント）', 'https://api.groq.com/openai/v1/models', { authorization: `Bearer ${env('GROQ_API_KEY')}` }) : Promise.resolve(add('groq', 'Groq（難しい推論・サブエージェント）', 'off', '未設定です', { fix: 'GROQ_API_KEY を設定' })));
  jobs.push((async () => {   // no documented /models route: send one tiny chat to the light model (60 requests/min)
    const label = 'Sarashina（日本語処理・控え）';
    if (env('SARASHINA_API_KEY') && !sarashinaEnabled()) return add('sarashina', label, 'off', 'いったん使わない設定です（キーは保存済み。Gemini・Groqが代わりに処理しています）', { fix: '使うときは、環境変数 SARASHINA_ENABLED=1 を追加して再デプロイ' });
    if (!sarashinaConfigured()) return add('sarashina', label, 'off', '未設定です', { fix: 'SARASHINA_API_KEY を設定' });
    try { const [, t] = await ms(() => withTimeout(sarashinaChat({ fast: true, model: env('SARASHINA_FAST_MODEL') || 'sarashina3-nano', messages: [{ role: 'user', content: '「はい」とだけ答えてください。' }], timeoutMs: 8000 }), 9000)); add('sarashina', label, 'ok', `接続できています（${t}ms、軽量モデルで1回だけ試しました）`); }
    catch (e) {
      const st = e?.status;
      const ki = sarashinaKeyInfo(), hint = `［サーバーが受け取ったキー: ${ki.length}文字${ki.hadSpaceOrQuote ? '・前後の空白/引用符を除去' : ''}${ki.hasInnerSpace ? '・途中に空白あり！' : ''}${ki.nonAscii ? '・全角など英数字以外が混入！' : ''}／接続先: ${sarashinaBaseUrl()}］`;
      if (st === 401 || st === 403) add('sarashina', label, 'fail', `キーが拒否されました (${st}): ${String(e.message).replace(/^[^:]*:\s*/, '').slice(0, 200)} ${hint}`, { fix: 'キーを chat.sarashina.ai のAPIキー画面で確認し、SARASHINA_API_KEY を入れ直す（前後の空白や引用符に注意）。接続先を変えている場合は SARASHINA_BASE_URL も確認' });
      else if (st === 429) add('sarashina', label, 'warn', '利用上限に達しています (429)。モデルごとに毎分の上限が小さいため、少し待てば使えます', { verified: true });
      else add('sarashina', label, 'fail', `${String(e?.message || e).slice(0, 160)} ${hint}`, { fix: 'SARASHINA_BASE_URL（既定 https://api.sarashina.ai/v1）とモデル名を確認' });
    }
  })());
  jobs.push(probeHttp('weather', 'Open-Meteo（天気）', 'https://api.open-meteo.com/v1/forecast?latitude=35.68&longitude=139.76&current=temperature_2m', {}));
  if (deep && env('EXA_API_KEY')) jobs.push((async () => {
    try { const [r, t] = await ms(() => withTimeout(fetch('https://api.exa.ai/search', { method: 'POST', headers: { 'x-api-key': env('EXA_API_KEY'), 'content-type': 'application/json' }, body: JSON.stringify({ query: 'test', numResults: 1 }) }), 9000));
      add('exa', 'Exa（検索）', r.ok ? 'ok' : r.status === 401 || r.status === 403 ? 'fail' : 'warn', r.ok ? `接続できています（${t}ms）` : `応答 ${r.status}`); } catch (e) { add('exa', 'Exa（検索）', 'fail', `接続できません: ${why(e)}`); }
  })()); else jobs.push(Promise.resolve(keyOnly('exa', 'Exa（検索）', ['EXA_API_KEY'], '本格的な調査用')));
  if (deep && env('NEWSDATA_API_KEY')) jobs.push((async () => {
    try { const [r, t] = await ms(() => withTimeout(fetch(`https://newsdata.io/api/1/latest?apikey=${encodeURIComponent(env('NEWSDATA_API_KEY'))}&q=a&size=1`), 9000));
      add('newsdata', 'NewsData（ニュース）', r.ok ? 'ok' : r.status === 401 || r.status === 403 ? 'fail' : 'warn', r.ok ? `接続できています（${t}ms）` : `応答 ${r.status}`); } catch (e) { add('newsdata', 'NewsData（ニュース）', 'fail', `接続できません: ${why(e)}`); }
  })()); else jobs.push(Promise.resolve(keyOnly('newsdata', 'NewsData（ニュース）', ['NEWSDATA_API_KEY'], 'ニュース用')));
  jobs.push((async () => {
    try {
      const g = await withTimeout(googleStatus({ probe: true }), 9000);
      if (!g.configured) return add('google', 'Google（Gmail・カレンダー・Drive・タスク）', 'off', '未設定です', { fix: 'docs/GOOGLE_INTEGRATION.md の手順で連携' });
      add('google', 'Google（Gmail・カレンダー・Drive・タスク）', g.authenticated ? 'ok' : 'fail', g.authenticated ? '接続できています（認証OK）' : `認証できません: ${g.error || '不明'}`, g.authenticated ? {} : { fix: 'Googleの連携をやり直す' });
    } catch (e) { add('google', 'Google（Gmail・カレンダー・Drive・タスク）', 'warn', `確認できませんでした: ${why(e)}`, { verified: false }); }
  })());
  jobs.push((async () => {
    if (!brainConfigured()) return add('github', 'GitHub（第二の脳）', 'off', '未設定です', { fix: 'BRAIN_GITHUB_TOKEN と BRAIN_REPO を設定' });
    try {
      const b = await withTimeout(brainStatus(), 9000);
      if (b.branchMissing) return add('github', 'GitHub（第二の脳）', 'fail', `ブランチ ${b.branch} がありません`);
      add('github', 'GitHub（第二の脳）', b.canPush === false ? 'warn' : 'ok', b.canPush === false ? '読めますが、書き込み権限がありません（記録できません）' : `接続できています（ノート ${b.notes} 件）`, { fix: b.canPush === false ? 'トークンの Contents を Read and write に' : undefined });
    } catch (e) { add('github', 'GitHub（第二の脳）', 'fail', `接続できません: ${why(e)}`, { fix: 'トークンとリポジトリ名を確認' }); }
  })());
  jobs.push((async () => {
    try {
      const s = await withTimeout(syncStatus(), 7000);
      if (!s.configured) return add('upstash', 'Upstash Redis（通知の同期）', 'off', '未設定です（任意）');
      add('upstash', 'Upstash Redis（通知の同期）', s.reachable ? 'ok' : 'fail', s.reachable ? `接続できています（保存中 ${s.stored} 件）` : `接続できません: ${s.error || ''}`);
    } catch (e) { add('upstash', 'Upstash Redis（通知の同期）', 'warn', `確認できませんでした: ${why(e)}`, { verified: false }); }
  })());
  jobs.push((async () => {   // build requests: repo reachable + a Claude Code workflow present?
    const label = 'GitHub（Claude Codeへの製作依頼）';
    if (!buildConfigured()) return add('build', label, 'off', '未設定です（任意）', { fix: 'BUILD_REPO と BUILD_GITHUB_TOKEN を設定（docs/BUILD_REQUESTS.md）' });
    const tok = env('BUILD_GITHUB_TOKEN') || env('BRAIN_GITHUB_TOKEN'), repo = env('BUILD_REPO'), h = { authorization: `Bearer ${tok}`, accept: 'application/vnd.github+json', 'user-agent': 'elvar-status' };
    try {
      const r = await withTimeout(fetch(`https://api.github.com/repos/${repo}`, { headers: h }), 8000);
      if (r.status === 401 || r.status === 403) return add('build', label, 'fail', `トークンが拒否されました (${r.status})`, { fix: 'BUILD_GITHUB_TOKEN の権限（Issues の Read and write）を確認' });
      if (r.status === 404) return add('build', label, 'fail', `リポジトリ ${repo} が見つかりません（またはトークンの対象外）`, { fix: 'BUILD_REPO の綴りと、トークンの対象リポジトリを確認' });
      if (!r.ok) return add('build', label, 'warn', `応答 ${r.status}`, { verified: false });
      let wf = null; try { const w = await withTimeout(fetch(`https://api.github.com/repos/${repo}/contents/.github/workflows`, { headers: h }), 8000); if (w.ok) wf = (await w.json()).map((f) => f.name); } catch { /* unknown */ }
      if (wf && !wf.some((n) => /claude/i.test(n))) return add('build', label, 'warn', `${repo} に接続できていますが、Claude Codeのワークフロー（.github/workflows/claude*.yml）が見つかりません。依頼してもIssueが作られるだけで、誰も実装しません`, { fix: 'docs/BUILD_REQUESTS.md の手順でClaude Code Actionを入れる' });
      add('build', label, 'ok', `接続できています（${repo}${wf ? '、Claude Codeのワークフローあり' : ''}）`);
    } catch (e) { add('build', label, 'fail', `接続できません: ${why(e)}`); }
  })());
  await Promise.all(jobs);
  // The text AIs cover for each other: say who takes over when one is rejected / limited.
  const AI = { 'api-gemini': 'Gemini', 'api-groq': 'Groq', 'api-sarashina': 'Sarashina' };
  const working = items.filter((i) => AI[i.id] && i.status === 'ok').map((i) => AI[i.id]);
  for (const i of items) if (AI[i.id] && (i.status === 'fail' || i.status === 'warn')) i.detail += working.length ? `。→ 文章の処理は、${working.join('・')}が代わりに行います（自動）` : '。→ 代わりに使えるAPIがありません';
  const order = ['gemini', 'groq', 'sarashina', 'exa', 'newsdata', 'weather', 'google', 'github', 'build', 'upstash'];
  return items.sort((a, b) => order.indexOf(a.id.slice(4)) - order.indexOf(b.id.slice(4)));
}
