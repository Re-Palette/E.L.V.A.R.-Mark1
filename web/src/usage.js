// Local API-usage ledger (this device only): Gemini Live time, tool calls per day, and the real quotas some APIs report back (Groq).
// Stored in localStorage, JST days, last 14 days kept. Nothing here is sent anywhere except what the owner asks the assistant to report.
const KEY = 'elvar_usage_v1';
const jstDay = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const jstFracOfDay = (d = new Date()) => { const t = new Date(d.getTime() + 9 * 3600e3); return (t.getUTCHours() * 3600 + t.getUTCMinutes() * 60 + t.getUTCSeconds()) / 86400; };

function load() { try { const j = JSON.parse(localStorage.getItem(KEY) || '{}'); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
function save(j) { try { localStorage.setItem(KEY, JSON.stringify(j)); } catch {} }
function dayRec(j, day = jstDay()) {
  j.days ??= {};
  j.days[day] ??= { liveSeconds: 0, liveSessions: 0, tools: {} };
  const keys = Object.keys(j.days).sort();
  while (keys.length > 14) delete j.days[keys.shift()];
  return j.days[day];
}

export const usage = {
  /** Called every few seconds while a Live session is open. */
  liveTick(seconds, newSession) { const j = load(); const d = dayRec(j); d.liveSeconds += seconds; if (newSession) d.liveSessions++; save(j); },
  tool(name) { const j = load(); const d = dayRec(j); d.tools[name] = (d.tools[name] || 0) + 1; save(j); },
  /** Real limits reported by an API's response headers (Groq). */
  quota(api, q) { const j = load(); j.quotas ??= {}; j.quotas[api] = { ...q, at: new Date().toISOString() }; save(j); },
  raw() { return load(); },
};

const lvl = (pct) => (pct >= 90 ? '危険' : pct >= 70 ? '注意' : '余裕あり');

/** Build the report the assistant reads out. `server` = { budgets, configured } from the usage_report tool. */
export function buildReport(server = {}) {
  const j = load(); const day = jstDay(); const d = dayRec(j, day);
  const frac = Math.max(0.02, jstFracOfDay());
  const b = server.budgets || {};
  const items = [];
  const add = (name, used, limit, unit, note, ifOver) => {
    if (!(limit > 0)) { items.push({ name, used, unit, note: note || '上限は未設定' }); return; }
    const pct = Math.round((used / limit) * 100), projected = Math.round((used / frac / limit) * 100);
    items.push({ name, used, limit, remaining: Math.max(0, limit - used), unit, usedPct: pct, projectedEndOfDayPct: projected, level: lvl(Math.max(pct, Math.min(projected, 100))), note, ifOver });
  };
  add('Geminiライブ会話（音声）', Math.round(d.liveSeconds / 60 * 10) / 10, b.geminiLiveMinutesPerDay, '分', '上限はこのアプリの目安です。実際の上限はGoogle AI Studioで確認してください', 'だらだら話しかけっぱなしにしない、長い雑談は控える、用が済んだらマイクを切る');
  if (server.configured?.news) add('ニュース（NewsData）', d.tools.news || 0, b.newsCreditsPerDay, '回', '1回の取得で1クレジット', 'ブリーフィング以外でニュースを聞く回数を減らす');
  add('天気（Open-Meteo）', d.tools.weather || 0, b.weatherCallsPerDay, '回', '実質ほぼ無制限', '');
  if (server.configured?.web) add('Web検索（Gemini）', d.tools.web_search || 0, b.webSearchPerDay, '回', '上限はGoogleの利用枠によります。実際の残りは Google AI Studio で確認してください', 'ウェブ検索は、本当に最新の情報が要るときだけにする');
  const g = j.quotas?.groq;
  if (server.configured?.groq) {
    if (g?.requestsLimit > 0) {
      const used = g.requestsLimit - g.requestsRemaining;
      items.push({ name: '難しい推論（Groq）', used, limit: g.requestsLimit, remaining: g.requestsRemaining, unit: '回/日', usedPct: Math.round(used / g.requestsLimit * 100), level: lvl(used / g.requestsLimit * 100), note: `Groqが返した実際の数値（${g.at}時点）。トークン残り ${g.tokensRemaining ?? '不明'}/${g.tokensLimit ?? '不明'}（分あたり）`, ifOver: '難しい推論を頼むのを、本当に必要なときだけにする' });
    } else items.push({ name: '難しい推論（Groq）', used: d.tools.deep_think || 0, unit: '回', note: 'まだGroqから上限の数値が返っていません（一度使うと取得できます）', ifOver: '難しい推論を頼むのを、本当に必要なときだけにする' });
  }
  const others = Object.entries(d.tools).filter(([k]) => !['news', 'weather', 'deep_think', 'usage_report', 'current_datetime', 'web_search'].includes(k)).reduce((a, [, v]) => a + v, 0);
  items.push({ name: 'Google連携・メモ（カレンダー、メール、Drive、第二の脳など）', used: others, unit: '回', note: '上限は十分に大きく、通常は気にする必要はありません' });
  const history = Object.entries(j.days || {}).sort().slice(-7).map(([k, v]) => ({ day: k, liveMinutes: Math.round(v.liveSeconds / 60), liveSessions: v.liveSessions, toolCalls: Object.values(v.tools).reduce((a, c) => a + c, 0) }));
  return { today: day, dayElapsedPct: Math.round(frac * 100), items, last7days: history, scope: 'この端末での集計です（PCとスマホは別々に数えます）', todaySessions: d.liveSessions };
}
