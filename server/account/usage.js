// The signed-in user's own usage over HTTP (docs/ELVAR_MULTIUSER.md 6.1-6.4; principle 6): what was used (today, this month, the last 30 days, per provider and metric),
// the storage meter, the limits the user set themselves (soft: warn or stop) and the limits an administrator set for this account (hard, read only here), and the page's
// heartbeat (Live time and the tools used). Every call runs as the signed-in user (Row Level Security): there is no way to ask for anybody else's numbers.
//
// Where a number comes from (the screens say so):
//   server   calls, tokens, Live sessions started, connector calls, Google calls: counted by this server at the moment of the call
//   client   Live time and the tool counts: reported by the page (the browser talks to Gemini Live directly, so the server cannot see the seconds). The server clamps what
//            it accepts to the time that really passed since the previous report, so a page cannot claim more than the clock allows
import { PROVIDERS, TOOL_PROVIDER, PERIODS, SOFT_ACTIONS, PERIOD_JA, HARD_LIMITS, effectiveHardLimits, isLimitable, fmtAmount } from '../usage-limits.js';
import { userDay, invalidateUsage } from '../usage.js';
import { addDays } from '../../shared/tz.js';

const bad = (status, error, message) => ({ status, body: { error, ...(message ? { message } : {}) } });
const ok = (body = { ok: true }) => ({ status: 200, body });
const DAYS = 30;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,40}$/;

const catalog = () => Object.fromEntries(Object.entries(PROVIDERS).map(([p, v]) => [p, { label: v.label, metrics: v.metrics }]));
const SOURCES = { calls: 'server', input_tokens: 'server', output_tokens: 'server', live_sessions: 'server', live_seconds: 'client', tools: 'client' };

/** 'warn' from 80 %, 'over' from 100 %. */
export const levelOf = (pct) => (pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok');

/** Pure: what the screens read, from the rows the database returned. */
export function buildSummary({ day, daily, limits, storage, account, env = process.env }) {
  const today = {}, month = {}, monthStart = `${day.slice(0, 8)}01`;
  const add = (o, p, m, a) => { const row = (o[p] ??= {}); row[m] = (row[m] || 0) + a; };
  for (const x of daily) {
    if (x.provider === TOOL_PROVIDER) continue;
    if (x.day >= monthStart) add(month, x.provider, x.metric, x.amount);
    if (x.day === day) add(today, x.provider, x.metric, x.amount);
  }
  const hard = effectiveHardLimits(account, env);
  const meters = limits.map((l) => {
    const used = ((l.period === 'day' ? today : month)[l.provider] || {})[l.metric] || 0, pct = l.soft > 0 ? Math.round((used / l.soft) * 100) : (used > 0 ? 100 : 0);
    return { provider: l.provider, metric: l.metric, period: l.period, soft: l.soft, softAction: l.softAction, used, pct, level: levelOf(pct), text: `${PROVIDERS[l.provider]?.label || l.provider}・${PROVIDERS[l.provider]?.metrics?.[l.metric]?.label || l.metric}（${PERIOD_JA[l.period]}）：${fmtAmount(l.provider, l.metric, used)} / ${fmtAmount(l.provider, l.metric, l.soft)}` };
  });
  const hardMeters = Object.entries(HARD_LIMITS).filter(([k, v]) => v.provider && hard[k] != null).map(([k, v]) => {
    const used = (today[v.provider] || {}).calls || 0, pct = hard[k] > 0 ? Math.round((used / hard[k]) * 100) : 100;
    return { key: k, label: v.label, limit: hard[k], used, pct, level: levelOf(pct) };
  });
  const tools = {};
  for (const x of daily) if (x.provider === TOOL_PROVIDER) { const t = (tools[x.metric] ??= { name: x.metric, count: 0, days: {} }); t.count += x.amount; t.days[x.day] = (t.days[x.day] || 0) + x.amount; }
  const used = storage.filesBytes + storage.textBytes + storage.notesBytes + storage.messagesBytes;
  return {
    day, scope: 'すべての端末の合計', catalog: catalog(), sources: SOURCES,
    daily: daily.filter((x) => x.provider !== TOOL_PROVIDER), tools: Object.values(tools).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    today, month, limits, meters, hard, hardMeters,
    storage: { ...storage, usedBytes: used, quotaBytes: account.storageQuotaBytes, breakdown: { files: storage.filesBytes, text: storage.textBytes, notes: storage.notesBytes, messages: storage.messagesBytes } },
  };
}

async function read(user) {
  const day = userDay(), monthStart = `${day.slice(0, 8)}01`, back = addDays(day, -(DAYS - 1)), from = monthStart < back ? monthStart : back;   // the month so far AND the last 30 days
  const data = await user.db(async (r) => ({ daily: await r.usage.daily({ from, to: day }), limits: await r.usageLimits.list(), storage: await r.usage.storage() }));
  return buildSummary({ day, ...data, account: user.account });
}

export async function getUsage({ user }) {
  // the account row is refreshed here (an administrator may have changed the limits a moment ago)
  const account = await user.db((r) => r.accounts.get());
  return ok({ ...(await read({ ...user, db: user.db, account: account || user.account })), from: addDays(userDay(), -(DAYS - 1)), to: userDay(), quotaBytes: (account || user.account).storageQuotaBytes });
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
/** The user's own soft limit: warn (the meters and one spoken line) or block (the calls of that provider are refused until the period ends or the limit is changed / removed). */
export async function putLimit({ user, body }) {
  const provider = String(body?.provider ?? ''), metric = String(body?.metric ?? ''), period = String(body?.period ?? ''), softAction = String(body?.softAction ?? 'warn'), soft = num(body?.soft);
  if (!isLimitable(provider, metric)) return bad(422, 'bad_limit', 'この項目には上限を設定できません');
  if (!PERIODS.includes(period)) return bad(422, 'bad_limit', '期間は「1日」か「1か月」を選んでください');
  if (!SOFT_ACTIONS.includes(softAction)) return bad(422, 'bad_limit', '動作は「知らせる」か「止める」を選んでください');
  if (!(soft >= 0) || soft > 1e9) return bad(422, 'bad_limit', '上限は 0 以上の数で入れてください');
  const count = (await user.db((r) => r.usageLimits.list())).length;
  if (count >= 60 && !(await user.db((r) => r.usageLimits.list())).some((l) => l.provider === provider && l.metric === metric && l.period === period)) return bad(422, 'too_many', '上限の設定が多すぎます');
  await user.db((r) => r.usageLimits.put({ provider, metric, period, soft: Math.round(soft), softAction }));
  invalidateUsage(user.uid);
  return ok({ limits: await user.db((r) => r.usageLimits.list()) });
}

export async function deleteLimit({ user, params }) {
  const { provider, metric, period } = params;
  if (!isLimitable(provider, metric) || !PERIODS.includes(period)) return bad(404, 'not_found');
  const removed = await user.db((r) => r.usageLimits.del({ provider, metric, period }));
  invalidateUsage(user.uid);
  return removed ? ok({ ok: true, limits: await user.db((r) => r.usageLimits.list()) }) : bad(404, 'not_found');
}

/**
 * The page's heartbeat (every 30 seconds while it has something to say): { liveSeconds, liveSessions?, tools: { name: count } }.
 * Live time is what the browser measured; the server credits at most the time that passed since the previous report (+5 s), and at most 60 s per call, so the
 * number can be too low (a missed report) but cannot be inflated. Counted as source 'client'.
 */
export async function postReport({ user, body }) {
  const sec = Math.round(num(body?.liveSeconds ?? 0)), tools = body?.tools ?? {};
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) return bad(422, 'bad_report', '報告の形式が正しくありません');
  if (!(sec >= 0) || sec > 600) return bad(422, 'bad_report', '報告の形式が正しくありません');
  const names = Object.keys(tools);
  if (names.length > 40 || names.some((n) => !TOOL_NAME.test(n) || !Number.isInteger(tools[n]) || tools[n] < 1 || tools[n] > 500)) return bad(422, 'bad_report', '報告の形式が正しくありません');
  if (!(await user.cfg.hit('usage-report', 60, 12))) return bad(429, 'rate_limited', '報告の回数が多すぎます');
  const now = Date.now(), day = userDay(now);
  let credited = 0;
  if (sec > 0) {
    const last = await user.db((r) => r.kv.get('usage:live-last')), gap = typeof last?.at === 'number' ? Math.max(0, Math.min(now - last.at, 120_000)) / 1000 : 30;
    credited = Math.min(sec, Math.floor(gap) + 5, 60);
    await user.db((r) => r.kv.set('usage:live-last', { at: now }, { ttlSec: 600 }));
  }
  await user.db(async (r) => {
    if (credited > 0) await r.usage.record({ provider: 'gemini', metric: 'live_seconds', amount: credited, source: 'client', day });
    for (const n of names) await r.usage.record({ provider: TOOL_PROVIDER, metric: n, amount: tools[n], source: 'client', day });
  });
  invalidateUsage(user.uid);
  return ok({ credited });
}

/** What the voice model is told for the usage_report tool (and the screen's data): short items with the unit, the limit if there is one and where the number comes from. */
export function voiceReport(s) {
  const items = [];
  const add = (provider, metric, label, note) => {
    const t = (s.today[provider] || {})[metric] || 0, m = (s.month[provider] || {})[metric] || 0;
    if (!t && !m && !s.meters.some((x) => x.provider === provider && x.metric === metric)) return;
    const meter = s.meters.find((x) => x.provider === provider && x.metric === metric && x.period === 'day') || s.meters.find((x) => x.provider === provider && x.metric === metric);
    items.push({ name: label, today: fmtAmount(provider, metric, t), thisMonth: fmtAmount(provider, metric, m), ...(meter ? { limit: fmtAmount(provider, metric, meter.soft), limitPeriod: PERIOD_JA[meter.period], limitAction: meter.softAction === 'block' ? '上限で止める' : '上限で知らせる', usedPct: meter.pct, level: meter.level } : { limit: '未設定' }), ...(note ? { note } : {}) });
  };
  add('gemini', 'live_seconds', 'Gemini のライブ会話（音声）', '端末からの報告をサーバーで検算した時間です');
  add('gemini', 'calls', 'Gemini の呼び出し（文章・検索・通常の音声）');
  add('groq', 'calls', 'Groq の呼び出し'); add('exa', 'calls', 'Exa（Web検索）の呼び出し'); add('newsdata', 'calls', 'NewsData（ニュース）の呼び出し'); add('sarashina', 'calls', 'Sarashina の呼び出し');
  add('google', 'calls', 'Google API（カレンダー・メール・Drive など）の呼び出し'); add('connector', 'calls', '連携アプリの呼び出し');
  const warn = s.meters.filter((x) => x.level !== 'ok').map((x) => x.text + (x.level === 'over' ? '（上限に達しています）' : '（上限に近づいています）'));
  return { today: s.day, scope: s.scope, items, ...(warn.length ? { warnings: warn } : {}), storage: { used: `${Math.round(s.storage.usedBytes / 1048576 * 10) / 10} MB`, quota: `${Math.round(s.storage.quotaBytes / 1048576)} MB` },
    topTools: s.tools.slice(0, 5).map((t) => ({ name: t.name, count: t.count })), note: '呼び出しと回数はサーバーで数えた値、ライブ会話の時間と道具の回数は端末からの報告です。上限は「設定 → 利用状況」で変えられます' };
}
export { read as readUsage };
