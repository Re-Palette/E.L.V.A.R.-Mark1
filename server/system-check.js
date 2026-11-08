// Server-side half of the E.L.V.A.R. system check. Verifies configuration and reachability of every service (read-only probes that cost
// nothing; `deep` adds probes that use a little quota). It reports facts it measured; it never says "works" for something it did not test.
import { readConfig, mintLiveToken } from './live-token-core.js';
import { googleStatus } from './google/index.js';
import { brainConfigured, brainStatus, brainProfileSummary } from './brain.js';
import { pickProvider, routeFor } from './agents/provider.js';
import { AGENTS } from './agents/registry.js';
import { syncStatus } from './notif-sync.js';
import { CAPABILITIES, routeOrder } from './routing.js';
import { chat as stdChat, tts as stdTts } from './chat-api.js';
import { sarashinaConfigured, sarashinaChat } from './sarashina.js';
import { apiConnections } from './api-status.js';
import { env, currentConfig } from './config/resolve.js';
import { keyInfo } from './config/keys.js';

const withTimeout = (p, ms = 7000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('時間切れ')), ms))]);
const why = (e) => String(e?.cause?.code || e?.message || e).slice(0, 140);

export async function runServerChecks({ deep = false } = {}) {
  const cfg = readConfig(), items = [], t0 = Date.now();
  const add = (id, label, status, detail, fix) => items.push({ id, group: 'server', label, status, detail, ...(fix ? { fix } : {}) });

  const cc = currentConfig(), mode = cc.auth?.mode === 'vault' ? 'vault' : cfg.accessToken ? 'env' : 'local';
  add('access', 'オーナー認証', mode === 'vault' ? 'ok' : mode === 'env' ? 'ok' : 'warn',
    mode === 'vault' ? 'オーナーのパスワードと端末トークンで保護されています' : mode === 'env' ? '環境変数のアクセストークンで保護されています（設定はアプリから変更できません）' : 'まだセットアップされていません。この端末からだけ使える状態です',
    mode === 'vault' || mode === 'env' ? undefined : 'アプリを開いてセットアップを完了する');
  // Where each configured value comes from (app = saved in the app, env = environment variable), and what is still missing.
  { const st = cc.secretStatus(), set = Object.entries(st).filter(([, v]) => v.set);
    const label = (n) => (keyInfo(n)?.label || n);
    const missing = ['GEMINI_API_KEY'].filter((n) => !st[n]?.set);
    add('config', '設定の出どころ', missing.length ? 'fail' : 'ok',
      (set.length ? set.map(([n, v]) => `${label(n)}: ${v.source === 'app' ? 'アプリ' : '環境変数'}${v.last4 ? `（末尾 ${v.last4}）` : ''}`).join('、') : 'キーはまだありません') + (missing.length ? `。未設定の必須項目: ${missing.map(label).join('、')}` : ''),
      missing.length ? '設定画面の「APIキー」で入力' : undefined); }
  add('runtime', '動作環境', 'ok', cfg.onVercel ? 'Vercel' : 'ローカルのサーバー');

  const jobs = [];
  // Gemini (voice): key valid?  deep: really mint a session token (counts toward the hourly cap)
  jobs.push((async () => {
    if (!cfg.apiKey) return add('gemini', 'Gemini（音声会話）', 'fail', 'APIキーがありません', 'Vercelの環境変数 GEMINI_API_KEY を設定');
    try {
      const r = await withTimeout(fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': cfg.apiKey } }));
      if (r.status === 400 || r.status === 401 || r.status === 403) return add('gemini', 'Gemini（音声会話）', 'fail', `キーが拒否されました (${r.status})`, 'GEMINI_API_KEY を作り直して設定');
      if (r.status === 429) return add('gemini', 'Gemini（音声会話）', 'warn', '利用上限に達しています (429)', '時間をおくか、使用量を控える');
      if (!r.ok) return add('gemini', 'Gemini（音声会話）', 'warn', `応答が異常です (${r.status})`);
      let detail = `キーは有効、モデル設定: ${cfg.model}`;
      if (deep) { try { await withTimeout(mintLiveToken(cfg), 10000); detail += '、会話用トークンの発行にも成功'; } catch (e) { return add('gemini', 'Gemini（音声会話）', 'fail', `キーは有効ですが、会話用トークンを発行できません: ${why(e)}`, 'GEMINI_LIVE_MODEL の名前と、キーの権限を確認'); } }
      add('gemini', 'Gemini（音声会話）', 'ok', detail);
    } catch (e) { add('gemini', 'Gemini（音声会話）', 'warn', `確認できませんでした: ${why(e)}`); }
  })());
  // Google
  jobs.push((async () => {
    try {
      const g = await withTimeout(googleStatus({ probe: true }), 12000);
      if (!g.configured) return add('google', 'Google連携', 'off', '未設定です（予定・メール・Driveなどは使えません）', '設定の「Google」で連携する');
      if (g.authenticated === false) return add('google', 'Google連携', 'fail', g.error || 'ログインが無効です', '設定の「Google」で、もう一度「Googleと連携」を押す');
      add('google', 'Google連携', 'ok', `認証OK（道具 ${g.tools} 個、うち書き込み ${g.write}）`);
    } catch (e) { add('google', 'Google連携', 'warn', `確認できませんでした: ${why(e)}`); }
  })());
  // Weather (no key)
  jobs.push((async () => {
    try {
      const r = await withTimeout(fetch('https://api.open-meteo.com/v1/forecast?latitude=35.69&longitude=139.69&current=temperature_2m'), 6000);
      add('weather', '天気（Open-Meteo）', r.ok ? 'ok' : 'warn', r.ok ? '接続OK' : `応答が異常です (${r.status})`);
    } catch (e) { add('weather', '天気（Open-Meteo）', 'warn', `接続できません: ${why(e)}`); }
  })());
  // News
  jobs.push((async () => {
    const key = env('NEWSDATA_API_KEY');
    if (!key) return add('news', 'ニュース（NewsData）', 'off', 'キー未設定です', '使うなら NEWSDATA_API_KEY を設定');
    if (!deep) return add('news', 'ニュース（NewsData）', 'ok', 'キーは設定済み（通信は確認していません。詳細チェックで確認できます）');
    try {
      const r = await withTimeout(fetch('https://newsdata.io/api/1/latest?language=ja&country=jp&size=1', { headers: { 'X-ACCESS-KEY': key } }), 8000);
      add('news', 'ニュース（NewsData）', r.ok ? 'ok' : r.status === 429 ? 'warn' : 'fail', r.ok ? '接続OK（1クレジット使用）' : `エラー (${r.status})`, r.ok ? '' : 'キーまたは1日の上限を確認');
    } catch (e) { add('news', 'ニュース（NewsData）', 'warn', `接続できません: ${why(e)}`); }
  })());
  // Web search (Exa preferred, Gemini grounding as the fallback)
  jobs.push((async () => {
    const exa = env('EXA_API_KEY'), gem = cfg.apiKey;
    if (!exa && !gem) return add('websearch', 'ウェブ検索', 'off', '検索用のキーがありません', '使うなら EXA_API_KEY（推奨）か GEMINI_API_KEY を設定');
    if (!exa) return add('websearch', 'ウェブ検索', 'ok', 'Geminiの検索を使います（Exaのキーを設定すると、検索結果そのものを使えて、調査担当の質が上がります）');
    if (!deep) return add('websearch', 'ウェブ検索', 'ok', `Exaのキーは設定済み${gem ? '（Exaが使えないときはGeminiで代行）' : ''}（通信は確認していません。詳細チェックで確認できます）`);
    try {
      const r = await withTimeout(fetch('https://api.exa.ai/search', { method: 'POST', headers: { 'x-api-key': exa, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'test', numResults: 1 }) }), 10000);
      add('websearch', 'ウェブ検索', r.ok ? 'ok' : r.status === 401 || r.status === 403 ? 'fail' : 'warn', r.ok ? 'Exaに接続できました（検索1回分を使用）' : `Exaのエラー (${r.status})`, r.status === 401 || r.status === 403 ? 'EXA_API_KEY を確認して設定し直す' : r.status === 402 || r.status === 429 ? 'Exaの利用枠（クレジット）を確認' : '');
    } catch (e) { add('websearch', 'ウェブ検索', 'warn', `Exaに接続できません: ${why(e)}`); }
  })());
  // Groq
  jobs.push((async () => {
    const key = env('GROQ_API_KEY');
    if (!key) return add('groq', '難しい推論（Groq）', 'off', 'キー未設定です', '使うなら GROQ_API_KEY を設定');
    try {
      const r = await withTimeout(fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${key}` } }), 6000);
      add('groq', '難しい推論（Groq）', r.ok ? 'ok' : r.status === 401 ? 'fail' : 'warn', r.ok ? `キー有効、モデル設定: ${env('GROQ_MODEL') || 'openai/gpt-oss-120b'}` : `エラー (${r.status})`, r.status === 401 ? 'GROQ_API_KEY を作り直して設定' : '');
    } catch (e) { add('groq', '難しい推論（Groq）', 'warn', `接続できません: ${why(e)}`); }
  })());
  // Second brain
  jobs.push((async () => {
    if (!brainConfigured()) return add('brain', '第二の脳（GitHub）', 'off', '未設定です', 'BRAIN_GITHUB_TOKEN と BRAIN_REPO を設定');
    try {
      const b = await withTimeout(brainStatus(), 9000);
      if (b.branchMissing) return add('brain', '第二の脳（GitHub）', 'fail', `リポジトリ ${b.repo} にブランチ ${b.branch} がありません`, 'READMEを付けてリポジトリを作り直すか、BRAIN_BRANCH を確認');
      add('brain', '第二の脳（GitHub）', b.canPush === false ? 'warn' : 'ok', `${b.repo}（${b.private ? 'プライベート' : '公開！'}）ノート ${b.notes} 件` + (b.canPush === false ? '。書き込み権限がありません' : ''), b.private ? (b.canPush === false ? 'トークンの Contents を Read and write に' : '') : 'リポジトリをプライベートに変更');
      if (!b.private) items[items.length - 1].status = 'warn';
      try { const prof = await withTimeout(brainProfileSummary({ force: true }), 4000); add('profile', '学習したプロフィール', prof ? 'ok' : 'off', prof ? `会話の前提として渡されています（${prof.split('\n').length}行）` : 'まだありません（「私のことを学習して」で作れます。週に1回は自動でも更新）'); } catch { add('profile', '学習したプロフィール', 'off', '確認できませんでした'); }
    } catch (e) { add('brain', '第二の脳（GitHub）', e.status === 401 || e.status === 403 || e.status === 404 ? 'fail' : 'warn', `${e.message || why(e)}`, e.status === 404 ? 'BRAIN_REPO の綴りと、トークンの対象リポジトリを確認' : e.status === 401 ? 'BRAIN_GITHUB_TOKEN を作り直して設定' : ''); }
  })());
  // Sub-agents
  jobs.push((async () => {   // relay for phone notifications -> PC
    if (!cfg.accessToken) return add('notifsync', '通知の同期（スマホ→PC）', 'off', 'アクセストークンが未設定のため使えません（暗号化の鍵に使います）', 'ELVAR_ACCESS_TOKEN を設定');
    try {
      const st = await withTimeout(syncStatus(), 8000);
      if (!st.configured) return add('notifsync', '通知の同期（スマホ→PC）', 'off', 'Redis（Upstash）が未設定です。スマホの通知をPCで聞きたい場合に必要です', 'UPSTASH_REDIS_REST_URL と UPSTASH_REDIS_REST_TOKEN を設定');
      add('notifsync', '通知の同期（スマホ→PC）', st.reachable ? 'ok' : 'warn', st.reachable ? `Redisに接続できました（暗号文を ${st.stored} 件保管中・3日で自動削除）` : `Redisに接続できません: ${st.error || ''}`);
    } catch (e) { add('notifsync', '通知の同期（スマホ→PC）', 'warn', `確認できませんでした: ${why(e)}`); }
  })());
  { const prov = pickProvider(), ready = Object.values(AGENTS).filter((a) => !a.available || a.available()).map((a) => a.label), notReady = Object.values(AGENTS).filter((a) => a.available && !a.available()).map((a) => a.label);
    const routes = Object.entries(AGENTS).filter(([, a]) => !a.available || a.available()).map(([id, a]) => `${a.label}=${routeFor(id).join('→')}`).join('、');
    add('agents', 'サブエージェント', prov && ready.length ? 'ok' : 'off', prov ? `担当ごとのAI（失敗時は右へ切り替え）: ${routes || 'なし'}。使える担当: ${ready.join('、') || 'なし'}${notReady.length ? `（連携が未設定で使えない担当: ${notReady.join('、')}）` : ''}` : 'AIのキーがありません（GROQ_API_KEY か GEMINI_API_KEY）', prov ? '' : 'どちらかのキーを設定'); }

  { // the routing table: who handles what, and who backs it up (only services that are configured)
    const has = { sarashina: sarashinaConfigured(), gemini: !!cfg.apiKey, exa: !!env('EXA_API_KEY'), groq: !!env('GROQ_API_KEY'), newsdata: !!env('NEWSDATA_API_KEY'), 'open-meteo': true, 'met-no': true, search: !!(env('EXA_API_KEY') || cfg.apiKey) };
    const line = (cap) => `${CAPABILITIES[cap].label}：${routeOrder(cap, (n) => has[n]).map((n) => CAPABILITIES[cap].names[n]).join(' → ') || '使えるサービスなし'}`;
    const lines = Object.keys(CAPABILITIES).map(line); const dead = Object.keys(CAPABILITIES).filter((c) => !routeOrder(c, (n) => has[n]).length);
    const single = Object.keys(CAPABILITIES).filter((c) => routeOrder(c, (n) => has[n]).length === 1);
    add('routing', 'サービスの使い分けと控え', dead.length ? 'warn' : 'ok', lines.join('　／　') + (single.length ? `　※控えが無い: ${single.map((c) => CAPABILITIES[c].label).join('、')}` : ''), dead.length ? `${dead.map((c) => CAPABILITIES[c].label).join('、')} に使えるサービスがありません。キーを設定してください` : (single.length ? '控えがあると、片方が止まっても動き続けます（例: EXA_API_KEY と GEMINI_API_KEY の両方を設定）' : ''));
  }
  await Promise.all(jobs);
  // Standard voice mode (used when Live is over its limit): needs the Gemini key; deep = really try one chat turn and one spoken sentence
  { const key = !!env('GEMINI_API_KEY');
    if (!key) add('stdvoice', '通常の音声モード', 'fail', 'GEMINI_API_KEY が無いため使えません', 'GEMINI_API_KEY を設定');
    else if (!deep) add('stdvoice', '通常の音声モード', 'ok', 'キーは設定済み（通信は確認していません。詳細チェックで、返答と読み上げを実際に試せます）');
    else {
      const out = [];
      try { await withTimeout(stdChat({ contents: [{ role: 'user', parts: [{ text: 'テストです。「はい」とだけ答えてください。' }] }] }), 20000); out.push('返答 OK'); } catch (e) { out.push(`返答 NG（${why(e)}）`); }
      try { await withTimeout(stdTts({ text: 'はい。' }), 20000); out.push('読み上げ OK'); } catch (e) { out.push(`読み上げ NG（${why(e)}）`); }
      add('stdvoice', '通常の音声モード', out.some((x) => x.includes('NG')) ? 'warn' : 'ok', out.join('、'), out.some((x) => x.includes('NG')) ? 'モデル名は STD_CHAT_MODEL / STD_TTS_MODEL で変えられます（AI Studioで使える名前）' : '');
    } }
  if (sarashinaConfigured()) {   // Sarashina: key set; deep = one tiny real request
    if (!deep) add('sarashina', 'Sarashina（日本語処理）', 'ok', 'キーは設定済み（通信は確認していません。詳細チェックで確認できます）');
    else { try { await withTimeout(sarashinaChat({ fast: true, messages: [{ role: 'user', content: '「はい」とだけ答えてください。' }] }), 15000); add('sarashina', 'Sarashina（日本語処理）', 'ok', '応答できました'); } catch (e) { add('sarashina', 'Sarashina（日本語処理）', 'warn', `応答できません: ${why(e)}`, 'SARASHINA_BASE_URL / SARASHINA_MODEL / キーを確認'); } }
  } else add('sarashina', 'Sarashina（日本語処理）', 'off', '未設定です（任意）', 'SARASHINA_API_KEY を設定すると、日本語の要約・分類・翻訳と、Geminiが使えないときの会話の控えに使います');
  const order = ['access', 'runtime', 'gemini', 'google', 'weather', 'news', 'websearch', 'groq', 'stdvoice', 'sarashina', 'brain', 'profile', 'notifsync', 'agents', 'routing'];
  items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  try { items.push(...await apiConnections({ deep })); } catch (e) { items.push({ id: 'api-all', group: 'api', label: 'API接続状況', status: 'warn', detail: `確認できませんでした: ${why(e)}`, verified: false }); }
  return { items, deep, tookMs: Date.now() - t0, at: new Date().toISOString() };
}
