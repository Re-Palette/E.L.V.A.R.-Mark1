// One place to ask "any available text model" for a plain answer: Gemini, Groq and Sarashina behind the same call, tried in order, skipping the ones that are
// missing or currently down (rejected / limited), moving on automatically when one fails. Used wherever a text answer is needed and any of them will do.
import { withGeminiModel } from './gemini-models.js';
import { sarashinaChat, sarashinaConfigured } from './sarashina.js';
import { isUp, noteFailure, noteSuccess, retryAfterSec } from './llm-health.js';
import { env } from './config/resolve.js';

const trunc = (s, n) => String(s ?? '').slice(0, n);
async function openaiCompat(url, key, body, timeoutMs, label) {
  let r;
  try { r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (e) { throw Object.assign(new Error(`${label}に接続できません: ${e?.cause?.code || e?.message || e}`), { status: 502 }); }
  const j = await r.json().catch(() => ({}));
  const text = j?.choices?.[0]?.message?.content;
  if (!r.ok || !text) { const apiMsg = (Array.isArray(j) ? j[0] : j)?.error?.message || ''; throw Object.assign(new Error(`${label}のエラー (${r.status}, モデル ${body.model}): ${trunc(apiMsg, 140)}`), { status: r.status || 502, apiMessage: apiMsg, retryAfter: retryAfterSec(r.headers) }); }
  return String(text).trim();
}

export const PROVIDERS = {
  gemini: {
    label: 'Gemini', key: () => env('GEMINI_API_KEY'),
    call: ({ messages, temperature, timeoutMs }) => withGeminiModel(env('DEEP_THINK_FALLBACK_MODEL'), (model) => openaiCompat('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', env('GEMINI_API_KEY'), { model, messages, temperature }, timeoutMs, 'Gemini')),
  },
  groq: {
    label: 'Groq', key: () => env('GROQ_API_KEY'),
    call: ({ messages, temperature, timeoutMs }) => { const model = env('GROQ_MODEL') || 'openai/gpt-oss-120b'; return openaiCompat('https://api.groq.com/openai/v1/chat/completions', env('GROQ_API_KEY'), { model, messages, temperature, ...(/gpt-oss/i.test(model) ? { reasoning_effort: 'low' } : {}) }, timeoutMs, 'Groq'); },
  },
  sarashina: {
    label: 'Sarashina', key: () => (sarashinaConfigured() ? 'set' : ''),
    call: ({ messages, temperature, timeoutMs }) => sarashinaChat({ messages, temperature, timeoutMs }),
  },
};

/** Providers that can be tried now, in the preferred order (keys present, not marked down); if all are marked down, the ones with keys anyway. */
export function usable(prefer = ['gemini', 'groq', 'sarashina']) {
  const withKey = prefer.filter((n) => PROVIDERS[n]?.key());
  const up = withKey.filter((n) => isUp(n));
  return up.length ? up : withKey;
}

/** @returns {Promise<{text:string, via:string, note?:string}>} */
export async function completeText({ messages, prefer, temperature = 0.3, timeoutMs = 25000 }) {
  const order = usable(prefer), first = (prefer || ['gemini', 'groq', 'sarashina']).find((n) => PROVIDERS[n]?.key()), errs = [];
  if (!order.length) throw new Error('使える文章生成のAPIがありません（GEMINI_API_KEY / GROQ_API_KEY / SARASHINA_API_KEY のどれかを設定してください）');
  for (const n of order) {
    try { const text = await PROVIDERS[n].call({ messages, temperature, timeoutMs }); noteSuccess(n); return { text, via: n, ...(n !== first ? { note: `${PROVIDERS[first]?.label || first}が使えなかったため、${PROVIDERS[n].label}で処理しました（${errs.map((x) => x.slice(0, 70)).join(' / ')}）` } : {}) }; }
    catch (e) { noteFailure(n, e?.status, e?.retryAfter ?? null); errs.push(`${PROVIDERS[n].label}: ${String(e?.message || e)}`); }
  }
  throw new Error(`すべての文章生成APIで失敗しました。${errs.join(' ／ ')}`);
}
