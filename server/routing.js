// One place that says WHICH service handles WHAT, in which order, and who backs it up. Every capability has an ordered list: the first
// available service is tried, and if it fails (limit, outage, bad key) the next one answers, with a note saying so.
// Override any order with an env var, e.g. ROUTE_WEATHER=met-no,open-meteo  or  ROUTE_SEARCH_QUICK=exa,gemini
import { cfgEnv } from './config/resolve.js';
export const CAPABILITIES = {
  search_quick: { label: 'ウェブ検索（短い質問）', env: 'ROUTE_SEARCH_QUICK', keys: 'EXA_API_KEY か GEMINI_API_KEY', default: ['gemini', 'exa'], names: { gemini: 'Gemini（Google検索）', exa: 'Exa' } },
  search_deep: { label: 'ウェブ検索（本格的な調査）', env: 'ROUTE_SEARCH_DEEP', keys: 'EXA_API_KEY か GEMINI_API_KEY', default: ['exa', 'gemini'], names: { exa: 'Exa（検索結果そのもの）', gemini: 'Gemini（回答のみ）' } },
  reasoning: { label: '難しい推論', env: 'ROUTE_REASONING', keys: 'GROQ_API_KEY か GEMINI_API_KEY か SARASHINA_API_KEY', default: ['gemini', 'groq', 'sarashina'], names: { groq: 'Groq', gemini: 'Gemini', sarashina: 'Sarashina' } },
  jp_text: { label: '日本語の要約・分類・翻訳', env: 'ROUTE_JP_TEXT', keys: 'SARASHINA_API_KEY か GEMINI_API_KEY か GROQ_API_KEY', default: ['sarashina', 'gemini', 'groq'], names: { sarashina: 'Sarashina', gemini: 'Gemini', groq: 'Groq' } },
  weather: { label: '天気', env: 'ROUTE_WEATHER', default: ['open-meteo', 'met-no', 'search'], names: { 'open-meteo': 'Open-Meteo', 'met-no': 'MET Norway', search: 'ウェブ検索' } },
  news: { label: 'ニュース', env: 'ROUTE_NEWS', keys: 'NEWSDATA_API_KEY（または EXA_API_KEY か GEMINI_API_KEY）', default: ['newsdata', 'exa', 'gemini'], names: { newsdata: 'NewsData', exa: 'Exa（ニュース検索）', gemini: 'Gemini（Google検索）' } },
};

/** Ordered list of the services to try for `cap`. `isAvailable(name)` says whether a service can be used right now (key present, etc.). */
export function routeOrder(cap, isAvailable = () => true, env = cfgEnv) {
  const c = CAPABILITIES[cap]; if (!c) return [];
  const asked = String(env[c.env] || '').split(/[,\s>→]+/).map((x) => x.trim().toLowerCase()).filter((x) => c.default.includes(x));
  const rest = c.default.filter((x) => !asked.includes(x));
  return [...new Set([...asked, ...rest])].filter((n) => isAvailable(n));
}

/** Run `attempts` (name -> async fn) in the route's order; the first success wins. Adds `via` and, if it was not the first choice, `note`. */
export async function runRoute(cap, attempts, isAvailable, env = cfgEnv) {
  const order = routeOrder(cap, (n) => attempts[n] && isAvailable(n), env), c = CAPABILITIES[cap], errs = [];
  if (!order.length) throw new Error(`${c.label}に使えるサービスがありません${c.keys ? `（環境変数 ${c.keys} を設定してください）` : ''}`);
  for (const [i, n] of order.entries()) {
    try {
      const r = await attempts[n]();
      return i === 0 ? { ...r, via: n } : { ...r, via: n, note: `${c.names[order[0]]}が使えなかったため、${c.names[n]}で取得しました（${errs.map((e) => e.slice(0, 90)).join(' / ')}）` };
    } catch (e) {
      if (e?.noFallback) throw e;                       // e.g. "place not found": another service cannot fix that
      errs.push(`${c.names[n]}: ${String(e?.message || e)}`);
    }
  }
  throw new Error(`${c.label}：すべての取得元で失敗しました。${errs.join(' ／ ')}`);
}
