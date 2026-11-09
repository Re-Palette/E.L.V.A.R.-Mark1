// Which text-LLM APIs are currently unusable (rejected key, limit hit, outage). Every caller that has an alternative checks this, so one API
// failing does not make each later request waste a call on it, and the others quietly cover for it. Per server process (best effort on serverless).
import { userState } from './auth/user-state.js';
// Per USER (one user's rejected key or limit must not switch an API off for everybody else on a warm instance).
const D = () => userState('llm-down', () => new Map());   // name -> { until, status }
export const cooldownFor = (status) => (status === 429 ? 60_000 : status === 401 || status === 403 ? 30 * 60_000 : status >= 500 || status === 502 ? 30_000 : 0);
/** Seconds from a Retry-After style header ("12", "1m30s"/"6m0s" as Groq sends); null if absent. */
export function retryAfterSec(headers) {
  const v = headers?.get?.('retry-after') ?? headers?.get?.('x-ratelimit-reset-tokens') ?? headers?.get?.('x-ratelimit-reset-requests');
  if (v == null || v === '') return null;
  if (/^\d+(\.\d+)?$/.test(String(v))) return Number(v);
  let t = 0, any = false; for (const m of String(v).matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) { any = true; t += Number(m[1]) * ({ ms: 0.001, s: 1, m: 60, h: 3600 }[m[2]]); }
  return any ? t : null;
}
/** `retryAfter` (seconds, from the API itself) beats the default cool-down: a per-minute limit is skipped for seconds, a daily one for up to 30 minutes at a time. */
export function noteFailure(name, status, retryAfter = null) {
  let ms = cooldownFor(Number(status) || 0);
  if (Number(status) === 429 && retryAfter != null && Number.isFinite(retryAfter)) ms = Math.min(30 * 60_000, Math.max(5_000, Math.ceil(retryAfter * 1000) + 1000));
  if (ms) D().set(name, { until: Date.now() + ms, status: Number(status) });
}
export const noteSuccess = (name) => { D().delete(name); };
export function isUp(name) { const d = D().get(name); if (!d) return true; if (Date.now() > d.until) { D().delete(name); return true; } return false; }
export const downInfo = () => Object.fromEntries([...D()].filter(([, d]) => Date.now() <= d.until).map(([k, d]) => [k, d.status]));
export const _reset = () => D().clear();
