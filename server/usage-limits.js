// The catalog of what is metered and what can be limited (docs/ELVAR_MULTIUSER.md 6.1, 6.3). Pure data and helpers; no I/O.
//   PROVIDERS     what a user can set a SOFT limit on (warn or stop), with the unit and the Japanese words the screens and the refusals use
//   HARD_LIMITS   what an ADMIN can set per user (abuse and infrastructure protection; the AI cost is the user's own key) and the platform defaults
//   messages      the Japanese refusals: a soft limit is the user's own and can be changed any time; a hard limit is the administrator's
// The list of hard-limit keys is the same as in supabase/migrations/20261110000018_usage_limits_admin.sql (test/usage-limits.test.mjs compares).
import { HARD_LIMIT_KEYS } from './db/validate.js';

/** metric -> { label, unit, scale }: `scale` converts the stored number to the number shown (live_seconds is stored in seconds and shown in minutes). */
const CALLS = { calls: { label: '呼び出し回数', unit: '回', scale: 1 } };
const TOKENS = { input_tokens: { label: '入力トークン', unit: 'トークン', scale: 1 }, output_tokens: { label: '出力トークン', unit: 'トークン', scale: 1 } };
export const PROVIDERS = Object.freeze({
  gemini: { label: 'Gemini', metrics: { ...CALLS, ...TOKENS, live_sessions: { label: 'Live 会話の開始', unit: '回', scale: 1 }, live_seconds: { label: 'Live 会話の時間', unit: '分', scale: 1 / 60 } } },
  groq: { label: 'Groq', metrics: { ...CALLS, ...TOKENS } },
  exa: { label: 'Exa（Web検索）', metrics: { ...CALLS } },
  newsdata: { label: 'NewsData（ニュース）', metrics: { ...CALLS } },
  sarashina: { label: 'Sarashina', metrics: { ...CALLS, ...TOKENS } },
  google: { label: 'Google（カレンダー・メール・Drive など）', metrics: { ...CALLS } },
  connector: { label: '連携アプリ（コネクタ）', metrics: { ...CALLS } },
});
/** Not a provider: how many times each tool was used (reported by the page), for the "よく使う道具" chart. Cannot be limited. */
export const TOOL_PROVIDER = 'tool';
export const LIVE_METRICS = Object.freeze(['live_sessions', 'live_seconds']);
export const PERIODS = Object.freeze(['day', 'month']);
export const SOFT_ACTIONS = Object.freeze(['warn', 'block']);
export const PERIOD_JA = { day: '1日', month: '1か月' };

export const isLimitable = (provider, metric) => Object.hasOwn(PROVIDERS, provider) && Object.hasOwn(PROVIDERS[provider].metrics, metric);
/** The stored number as the screen shows it (minutes for Live time). */
export const shown = (provider, metric, n) => { const m = PROVIDERS[provider]?.metrics?.[metric]; const v = (Number(n) || 0) * (m?.scale ?? 1); return m?.unit === '分' ? Math.round(v * 10) / 10 : Math.round(v); };
/** The number as the user typed it (minutes) back to the stored unit (seconds). */
export const stored = (provider, metric, n) => Math.round((Number(n) || 0) / (PROVIDERS[provider]?.metrics?.[metric]?.scale ?? 1));
export const fmtAmount = (provider, metric, n) => { const m = PROVIDERS[provider]?.metrics?.[metric]; return `${shown(provider, metric, n).toLocaleString('ja-JP')}${m?.unit || ''}`; };

/**
 * What an administrator can limit per user. `default` is the platform's value when the account has none (and ELVAR_DEFAULT_LIMITS does not say otherwise);
 * null = unlimited. `provider` ties a daily call limit to a provider (checked before every call to it).
 */
export const HARD_LIMITS = Object.freeze({
  requestsPerMinute: { label: '1分あたりのリクエスト数', unit: '回', default: 120 },
  liveTokensPerHour: { label: '1時間あたりの Live 会話の開始数', unit: '回', default: 30 },
  connectorCallsPerDay: { label: '連携アプリの呼び出し（1日）', unit: '回', default: 2000, provider: 'connector' },
  exportsPerDay: { label: 'データの書き出し（1日）', unit: '回', default: 1 },
  maxConnectors: { label: '連携アプリの数', unit: '個', default: 10 },
  maxNotes: { label: 'ノートの数', unit: '件', default: 20000 },
  maxFileBytes: { label: '1ファイルの最大サイズ', unit: 'バイト', default: 62914560 },
  geminiCallsPerDay: { label: 'Gemini の呼び出し（1日）', unit: '回', default: null, provider: 'gemini' },
  groqCallsPerDay: { label: 'Groq の呼び出し（1日）', unit: '回', default: null, provider: 'groq' },
  exaCallsPerDay: { label: 'Exa の呼び出し（1日）', unit: '回', default: null, provider: 'exa' },
  newsdataCallsPerDay: { label: 'NewsData の呼び出し（1日）', unit: '回', default: null, provider: 'newsdata' },
  sarashinaCallsPerDay: { label: 'Sarashina の呼び出し（1日）', unit: '回', default: null, provider: 'sarashina' },
  googleCallsPerDay: { label: 'Google API の呼び出し（1日）', unit: '回', default: null, provider: 'google' },
});
export const hardLimitFor = (provider) => Object.entries(HARD_LIMITS).find(([, v]) => v.provider === provider)?.[0] || null;
export const isHardLimitKey = (k) => Object.hasOwn(HARD_LIMITS, k);
export const HARD_LIMIT_KEYS_JS = Object.freeze(Object.keys(HARD_LIMITS));
if (HARD_LIMIT_KEYS_JS.length !== HARD_LIMIT_KEYS.length || HARD_LIMIT_KEYS_JS.some((k) => !HARD_LIMIT_KEYS.includes(k))) throw new Error('server/usage-limits.js and server/db/validate.js disagree on the hard-limit keys');

const wholeNumber = (v) => Number.isInteger(v) && v >= 0 && v <= 2_000_000_000;
/** ELVAR_DEFAULT_LIMITS (a JSON object of the same keys): the operator's defaults for accounts that have no value of their own. Bad entries are ignored. */
export function envDefaultLimits(env = process.env) {
  let o; try { o = JSON.parse(String(env.ELVAR_DEFAULT_LIMITS || '{}')); } catch { return {}; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => isHardLimitKey(k) && wholeNumber(v)));
}
/** The limits that apply to an account: the platform defaults, then ELVAR_DEFAULT_LIMITS, then the administrator's value for this user. null = unlimited. */
export function effectiveHardLimits(account, env = process.env) {
  const out = Object.fromEntries(Object.entries(HARD_LIMITS).map(([k, v]) => [k, v.default])), mine = account?.hardLimits && typeof account.hardLimits === 'object' ? account.hardLimits : {};
  Object.assign(out, envDefaultLimits(env));
  for (const [k, v] of Object.entries(mine)) if (isHardLimitKey(k) && wholeNumber(v)) out[k] = v;
  out.maxFileBytes = Math.min(62914560, out.maxFileBytes ?? 62914560);
  return out;
}

/** The error a gate throws. status 429; `code` tells which kind (the page shows `message`, which is already Japanese). */
export class UsageLimitError extends Error {
  constructor({ kind, provider, metric, period, limit, used, message }) {
    super(message || limitMessage({ kind, provider, metric, period, limit, used }));
    this.name = 'UsageLimitError'; this.status = 429; this.failover = true;   // another provider may answer instead
    this.code = kind === 'soft' ? 'soft_limit' : 'hard_limit';
    this.limit = { kind, provider, metric, period, limit, used };
  }
}
export function limitMessage({ kind, provider, metric, period, limit }) {
  const what = PROVIDERS[provider]?.label || provider, metricWord = metric === 'calls' ? '' : `の${PROVIDERS[provider]?.metrics?.[metric]?.label || metric}`;
  const amount = metric ? fmtAmount(provider, metric, limit) : String(limit), per = PERIOD_JA[period] || '1日';
  if (kind === 'soft') return `${what}${metricWord}が、${per}の上限（${amount}）に達したため、止めています。これはあなたが設定した上限です。設定の「利用状況」で、いつでも変更・解除できます`;
  return `${what}${metricWord}が、${per}の上限（${amount}。管理者が設定した上限です）に達しました。${period === 'month' ? '来月' : '明日'}になるとまた使えます。必要な場合は、管理者に相談してください`;
}
export const rateMessage = (what, perWhat) => `${what}の回数が多すぎます（${perWhat}の上限）。少し待ってから、もう一度お試しください`;
