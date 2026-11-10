// Usage metering and the limits that are checked BEFORE a call (docs/ELVAR_MULTIUSER.md 6.1, 6.3; principle 6). Everything is per user: the numbers live in the user's
// own app.usage_daily (the day is the user's own day, in their time zone), the soft limits in their own app.usage_limits, the hard limits (set by an administrator)
// in their account row. Always awaited by the caller (the request's identity is not available after the response), a failure to record never breaks the call.
//
//   meteredFetch(provider, url, init)   the one way server code reaches Gemini / Groq / Exa / NewsData / Sarashina / Google: the limits are checked first (a refusal is
//                                       a UsageLimitError with a Japanese message and status 429), then the call is made and counted (calls + tokens when the answer has them)
//   gate(provider, { metrics })         the check alone (for calls that are not a plain fetch, e.g. minting a Live token)
//   recordUsage(provider, metric, n)    a count by hand
//   summary(...)                        what the usage screen and the HUD meters read
// Outside a signed-in request (scripts, cron) there is nobody to count for: everything here is then a no-op and fetch is just fetch.
import { currentConfig } from './config/resolve.js';
import { localDate } from '../shared/tz.js';
import { TZ } from './profile/index.js';
import { LIVE_METRICS, UsageLimitError, effectiveHardLimits, hardLimitFor } from './usage-limits.js';

export { UsageLimitError };
const TOKEN_PROVIDERS = new Set(['gemini', 'groq', 'sarashina']);
const TTL_MS = 5000, MAX_USERS = 500;

/** The day a count belongs to: the user's own day (their profile's time zone; Asia/Tokyo by default). */
export const userDay = (ms = Date.now()) => { try { return localDate(ms, TZ()); } catch { return new Date(ms).toISOString().slice(0, 10); } };

// ---- the user's numbers (limits + today + this month), cached for a few seconds per user on this instance and bumped by every count
const cache = new Map();   // uid -> { at, day, limits, hard, today:Map, month:Map }
export const _clearUsageCache = () => cache.clear();
const key = (p, m) => `${p}|${m}`;

async function load(c) {
  const day = userDay(), hit = cache.get(c.uid);
  if (hit && hit.day === day && Date.now() - hit.at < TTL_MS) return hit;
  const monthStart = `${day.slice(0, 8)}01`;
  const d = await c.db(async (r) => ({ limits: await r.usageLimits.list(), daily: await r.usage.daily({ from: monthStart, to: day }), acct: await r.accounts.get() }));
  const today = new Map(), month = new Map();
  for (const x of d.daily) { const k = key(x.provider, x.metric); month.set(k, (month.get(k) || 0) + x.amount); if (x.day === day) today.set(k, (today.get(k) || 0) + x.amount); }
  const s = { at: Date.now(), day, limits: d.limits, hard: effectiveHardLimits(d.acct), today, month };
  cache.delete(c.uid); cache.set(c.uid, s);
  while (cache.size > MAX_USERS) cache.delete(cache.keys().next().value);
  return s;
}
function bump(uid, provider, metric, amount) {
  const s = cache.get(uid); if (!s) return;
  const k = key(provider, metric); s.today.set(k, (s.today.get(k) || 0) + amount); s.month.set(k, (s.month.get(k) || 0) + amount);
}
export const invalidateUsage = (uid) => { cache.delete(String(uid?.uid ?? uid)); };

/** Count something for the signed-in user. Never throws. */
export async function recordUsage(provider, metric, amount = 1, source = 'server') {
  const c = currentConfig();
  if (typeof c.record !== 'function' || !(amount >= 0)) return;
  try { await c.record(provider, metric, amount, source, userDay()); bump(c.uid, provider, metric, amount); }
  catch (e) { console.error('[elvar] usage not recorded:', e?.code || e?.message); }
}

/** Gemini's usageMetadata or an OpenAI-style `usage` -> input / output tokens. */
export async function recordTokens(provider, json) {
  const g = json?.usageMetadata, o = json?.usage;
  const input = Number(g?.promptTokenCount ?? o?.prompt_tokens) || 0, output = Number(g?.candidatesTokenCount ?? o?.completion_tokens) || 0;
  if (input > 0) await recordUsage(provider, 'input_tokens', input);
  if (output > 0) await recordUsage(provider, 'output_tokens', output);
}

/**
 * Check the limits for `provider` before a call. Throws UsageLimitError (429):
 *   hard   an administrator's daily call limit for this provider on this account
 *   soft   a limit the user set themselves with the action "stop" (block), on any metric of this provider (Live time / starts only for a Live token: `metrics`)
 * A "warn" limit never stops anything (the screens show it).
 * @param {{metrics?: string[]}} [o] the metrics that count for this call; default: every metric except the Live ones
 */
export async function gate(provider, { metrics = null } = {}) {
  const c = currentConfig();
  if (typeof c.db !== 'function' || !c.uid) return;
  let s; try { s = await load(c); } catch (e) { console.error('[elvar] usage limits could not be read (the call goes on):', e?.code || e?.message); return; }   // the limits are a brake, not a lock: a database hiccup must not stop the assistant
  const hk = hardLimitFor(provider), hl = hk ? s.hard[hk] : null;
  if (hl !== null && hl !== undefined && (s.today.get(key(provider, 'calls')) || 0) >= hl && !(metrics && metrics.every((m) => LIVE_METRICS.includes(m)))) throw new UsageLimitError({ kind: 'hard', provider, metric: 'calls', period: 'day', limit: hl });
  for (const l of s.limits) {
    if (l.provider !== provider || l.softAction !== 'block') continue;
    if (metrics ? !metrics.includes(l.metric) : LIVE_METRICS.includes(l.metric)) continue;
    const used = (l.period === 'day' ? s.today : s.month).get(key(provider, l.metric)) || 0;
    if (used >= l.soft) throw new UsageLimitError({ kind: 'soft', provider, metric: l.metric, period: l.period, limit: l.soft, used });
  }
}

/** The hard limit `name` of the signed-in account (null = unlimited), or undefined outside a user request. */
export async function hardLimit(name) {
  const c = currentConfig(); if (typeof c.db !== 'function' || !c.uid) return undefined;
  try { return (await load(c)).hard[name]; } catch { return undefined; }
}
/** Creating one more note: the administrator's cap on the number of notes (docs 6.3). Call inside the user's transaction with its repos. */
export async function assertRoomForNote(r) {
  const lim = await hardLimit('maxNotes'); if (lim === undefined || lim === null) return;
  const n = await r.notes.count();
  if (n >= lim) throw new UsageLimitError({ kind: 'hard', provider: 'notes', metric: 'count', limit: lim, used: n, message: `ノートの数が、管理者が設定した上限（${lim.toLocaleString('ja-JP')}件）に達しました。使わないノートを削除してから、もう一度お試しください` });
}
/** What was used today for a metric (the hard limit on connector calls and the like). */
export async function usedToday(provider, metric = 'calls') {
  const c = currentConfig(); if (typeof c.db !== 'function' || !c.uid) return 0;
  try { return (await load(c)).today.get(key(provider, metric)) || 0; } catch { return 0; }
}

/** fetch() for a provider call: limits first, then the call, then the count. A network error is not counted (nothing reached the provider). */
export async function meteredFetch(provider, url, init, { tokens = TOKEN_PROVIDERS.has(provider) } = {}) {
  await gate(provider);
  const r = await globalThis.fetch(url, init);
  await recordUsage(provider, 'calls', 1);
  if (tokens && r?.ok) {
    try { await recordTokens(provider, await (typeof r.clone === 'function' ? r.clone() : r).json()); } catch { /* an answer without usage numbers */ }
  }
  return r;
}
