// Shift planning for the owner's part-time jobs / internships, in the second brain (private repo):
//   シフト/職場.md   jobs and hourly wages        シフト/目標.md   income goals and limits
//   シフト/YYYY-MM.md  the shifts of a month
// Pay and suggestions are computed by plain code (no model arithmetic). Suggestions avoid the owner's Google Calendar events and the shifts already
// recorded; they are proposals — nothing is registered until the owner agrees. Pay is an estimate: 深夜割増 (22:00–5:00, +25 %) is added, 休憩 is unpaid.
import crypto from 'node:crypto';
import { brainReadRaw, brainWrite, brainRepoIsPrivate, brainConfigured } from './brain.js';
import { U, TZ } from './profile/index.js';
import { localDate, startOfLocalDay, tzLabel } from '../shared/tz.js';

const DAY = 864e5;
export const NIGHT_RATE = 0.25;
const tzDate = (ms) => localDate(ms, TZ());
const cell = (s) => String(s ?? '').replace(/\|/g, '／').replace(/\s+/g, ' ').trim();
const norm = (s) => cell(s).toLowerCase().replace(/[\s　・\-_（）()]/g, '');
export const monthOf = (d) => String(d).slice(0, 7);
const dayMs = (date) => startOfLocalDay(date, TZ());
const daysIn = (month) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const monthPath = (m) => `シフト/${m}.md`;
const num = (v) => { const n = Number(String(v ?? '').replace(/[,，円¥￥\s]/g, '')); return Number.isFinite(n) ? n : NaN; };

// ---------------------------------------------------------------- time helpers (pure)
/** "9時" "9:30" "９時半" "17:00" "午後5時" "25:00" → minutes from midnight, or null */
export function parseTime(w) {
  let t = String(w ?? '').trim().replace(/[０-９：]/g, (c) => (c === '：' ? ':' : String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
  if (!t) return null;
  const pm = /(午後|PM|pm)/.test(t), am = /(午前|AM|am)/.test(t); t = t.replace(/(午後|午前|PM|pm|AM|am)/g, '').trim();
  let m = t.match(/^(\d{1,2})\s*[:時]\s*(\d{1,2})?\s*分?$/) || t.match(/^(\d{1,2})\s*時\s*(半)$/) || t.match(/^(\d{1,2})$/);
  if (!m) return null;
  let h = Number(m[1]), mi = m[2] === '半' ? 30 : Number(m[2] || 0);
  if (pm && h < 12) h += 12; if (am && h === 12) h = 0;
  if (h > 30 || mi > 59) return null;
  return h * 60 + mi;
}
export const hhmm = (min) => { const m = ((min % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
/** "今日" "明日" "あさって" "3日後" "11月3日" "11/3" "来週の月曜" is NOT handled (the model resolves weekdays to dates) */
export function parseDateWord(w, nowMs = Date.now()) {
  const t = String(w ?? '').trim(); if (!t) return null; const today = tzDate(nowMs);
  const rel = { 今日: 0, きょう: 0, 明日: 1, あした: 1, あす: 1, 明後日: 2, あさって: 2, 昨日: -1, きのう: -1, 一昨日: -2, おととい: -2 };
  if (t in rel) return tzDate(nowMs + rel[t] * DAY);
  let m = t.match(/^(\d+)\s*日(後|前)$/); if (m) return tzDate(nowMs + (m[2] === '後' ? 1 : -1) * Number(m[1]) * DAY);
  m = t.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/); if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[/月](\d{1,2})日?$/); if (m) { const y = Number(today.slice(0, 4)); return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`; }
  m = t.match(/^(\d{1,2})日$/); if (m) return `${today.slice(0, 7)}-${String(m[1]).padStart(2, '0')}`;
  return null;
}
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

// ---------------------------------------------------------------- pay (pure)
/** Legal minimum unpaid break: over 8 h → 60 min, over 6 h → 45 min. */
export const defaultBreak = (workedMin) => (workedMin > 480 ? 60 : workedMin > 360 ? 45 : 0);
/** @returns {{grossMin:number, workMin:number, nightMin:number, hours:number, pay:number, transport:number}} (pay = wage part only; end <= start means it ends the next day) */
export function shiftPay({ start, end, breakMin }, { hourly = 0, transport = 0 } = {}) {
  const s = start, e = end <= start ? end + 1440 : end, gross = e - s;
  const br = breakMin == null || breakMin === '' ? defaultBreak(gross) : Math.max(0, Math.min(gross, Number(breakMin) || 0));
  const work = Math.max(0, gross - br);
  let night = 0; for (const [a, b] of [[-120, 300], [1320, 1740], [2760, 3180]]) night += Math.max(0, Math.min(e, b) - Math.max(s, a));
  night = Math.min(night, work);
  const pay = Math.round((work / 60) * hourly + (night / 60) * hourly * NIGHT_RATE);
  return { grossMin: gross, breakMin: br, workMin: work, nightMin: night, hours: Math.round((work / 60) * 100) / 100, pay, transport: Math.round(transport) };
}

// ---------------------------------------------------------------- file formats
const JOB_HEAD = '| 職場 | 時給 | 交通費 | 状態 |\n|---|---|---|---|';
export function parseJobs(text) {
  const rows = []; for (const m of String(text || '').matchAll(/^\|\s*([^|\n]+?)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(有効|削除)\s*\|/gm)) if (m[1] !== '職場') rows.push({ name: m[1], hourly: Number(m[2]), transport: Number(m[3]), active: m[4] === '有効' });
  const last = new Map(); for (const r of rows) last.set(norm(r.name), r); return [...last.values()].filter((r) => r.active).map(({ active, ...r }) => r);
}
const SHIFT_HEAD = '| id | 日付 | 開始 | 終了 | 休憩 | 職場 | 予定ID | 備考 |\n|---|---|---|---|---|---|---|---|';
export function parseShifts(text) {
  const out = []; for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\|\s*([0-9a-f]{6})\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(\d{2}:\d{2})\s*\|\s*(\d{2}:\d{2})\s*\|\s*(\d*)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|?\s*$/);
    if (m) out.push({ id: m[1], date: m[2], start: m[3], end: m[4], breakMin: m[5] === '' ? null : Number(m[5]), job: m[6].trim(), eventId: m[7].trim(), note: m[8].trim() });
  }
  return out;
}
const rowOf = (s) => `| ${s.id} | ${s.date} | ${s.start} | ${s.end} | ${s.breakMin ?? ''} | ${cell(s.job)} | ${cell(s.eventId)} | ${cell(s.note)} |`;
const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const GOAL_KEYS = ['月収目標', '年収上限', '週の上限時間', '月の目標時間'];
export function parseGoals(text) {
  const g = { monthly: {}, defaults: {} };
  for (const m of String(text || '').matchAll(/^\s*[-*]\s*(月収目標|年収上限|週の上限時間|月の目標時間)(?:\s+(\d{4}-\d{2}))?\s*[：:]\s*(\d+(?:\.\d+)?)/gm)) {
    if (m[2]) (g.monthly[m[2]] ||= {})[m[1]] = Number(m[3]); else g.defaults[m[1]] = Number(m[3]);
  }
  return g;
}
/** The goal values that apply to a month (a month-specific line beats the standing one). */
export const goalFor = (g, month) => ({ income: g.monthly[month]?.月収目標 ?? g.defaults.月収目標 ?? null, hours: g.monthly[month]?.月の目標時間 ?? g.defaults.月の目標時間 ?? null, weeklyCap: g.defaults.週の上限時間 ?? null, yearCap: g.defaults.年収上限 ?? null });

// ---------------------------------------------------------------- IO
async function guardPrivate() { if (!(await brainRepoIsPrivate())) throw new Error('第二の脳のリポジトリが公開になっているため、シフトのデータは保存しません（プライベートにしてください）'); }
export async function readJobs() { return parseJobs(await brainReadRaw('シフト/職場.md').catch(() => null)); }
export async function readGoals() { return parseGoals(await brainReadRaw('シフト/目標.md').catch(() => null)); }
export async function readShifts(month) { return parseShifts(await brainReadRaw(monthPath(month)).catch(() => null)); }

/** Registers / changes (action 'add') or removes ('remove') a job. */
export async function setJob({ name, hourly, transport, action = 'add' }) {
  await guardPrivate();
  const nm = cell(name).slice(0, 40); if (!nm) throw new Error('職場の名前が分かりません');
  const cur = await readJobs(), old = cur.find((j) => norm(j.name) === norm(nm));
  let h = num(hourly), t = num(transport);
  if (action === 'remove') { if (!old) throw new Error(`「${nm}」は登録されていません`); h = old.hourly; t = old.transport; }
  else { if (!Number.isFinite(h) || h <= 0) { if (old && hourly == null) h = old.hourly; else throw new Error('時給が分かりません'); } if (!Number.isFinite(t) || t < 0) t = old?.transport ?? 0; }
  const exists = await brainReadRaw('シフト/職場.md').catch(() => null);
  await brainWrite({ path: 'シフト/職場.md', content: (exists ? '' : `# 職場と時給\n\n${U()}が登録した、バイト・インターンの職場です（時給・交通費は円、交通費は1出勤あたり）。同じ名前の最後の行が有効で、「削除」にすると一覧から消えます。\n\n${JOB_HEAD}\n`) + `| ${nm} | ${Math.round(h)} | ${Math.round(t)} | ${action === 'remove' ? '削除' : '有効'} |`, mode: 'append' });
  return { name: nm, hourly: Math.round(h), transport: Math.round(t), removed: action === 'remove', changed: !!old };
}

/** Sets a goal / limit. key: 月収目標 | 年収上限 | 週の上限時間 | 月の目標時間. month (YYYY-MM) makes it apply to that month only (月収目標・月の目標時間 only). */
export async function setGoal({ key = '月収目標', value, month }) {
  await guardPrivate();
  if (!GOAL_KEYS.includes(key)) throw new Error(`目標の種類は ${GOAL_KEYS.join(' / ')} のどれかです`);
  const v = num(value); if (!Number.isFinite(v) || v < 0) throw new Error('目標の数字が分かりません');
  if (month && !/^\d{4}-\d{2}$/.test(month)) throw new Error('month は YYYY-MM で指定してください');
  if (month && !['月収目標', '月の目標時間'].includes(key)) throw new Error(`${key}は月ごとには決められません（毎月の共通です）`);
  const g = parseGoals(await brainReadRaw('シフト/目標.md').catch(() => null));
  if (month) (g.monthly[month] ||= {})[key] = v; else g.defaults[key] = v;
  const lines = [...Object.entries(g.defaults).map(([k, x]) => `- ${k}：${x}`), ...Object.entries(g.monthly).sort().flatMap(([mo, o]) => Object.entries(o).map(([k, x]) => `- ${k} ${mo}：${x}`))];
  await brainWrite({ path: 'シフト/目標.md', content: `# シフトの目標と上限\n\n月収目標は円、年収上限は円、週の上限時間・月の目標時間は時間です。「月収目標 2026-12：90000」のように月を付けると、その月だけの目標になります。\n\n${lines.join('\n')}\n`, mode: 'replace' });
  return { key, value: v, month: month || null, goals: goalFor(g, month || tzDate(Date.now()).slice(0, 7)) };
}

/** Normalizes one shift from loose voice-model input. Throws a plain Japanese message when something is missing. */
export function normalizeShift(raw, { jobs = [], nowMs = Date.now() } = {}) {
  const date = parseDateWord(raw?.date ?? raw?.day ?? raw?.日付, nowMs) || (validDate(String(raw?.date ?? '').trim()) ? String(raw.date).trim() : null);
  if (!date || !validDate(date)) throw new Error('日付が分かりません（例：11月20日、明日）');
  const s = parseTime(raw?.start ?? raw?.from ?? raw?.開始), e = parseTime(raw?.end ?? raw?.to ?? raw?.終了);
  if (s == null) throw new Error('開始の時刻が分かりません（例：17時、9:30）');
  if (e == null) throw new Error('終了の時刻が分かりません（例：22時、18:00）');
  if (s === e) throw new Error('開始と終了が同じ時刻です');
  const want = cell(raw?.job ?? raw?.workplace ?? raw?.職場);
  let job = jobs.find((j) => want && (norm(j.name) === norm(want) || norm(j.name).includes(norm(want)) || norm(want).includes(norm(j.name))));
  if (!job && !want && jobs.length === 1) job = jobs[0];
  if (!job) throw new Error(jobs.length ? `どの職場か分かりません（登録済み：${jobs.map((j) => j.name).join('・')}）` : '職場がまだ登録されていません（職場の名前と時給を教えてください）');
  const bm = raw?.breakMin ?? raw?.break ?? raw?.休憩;
  return { date, start: hhmm(s), end: hhmm(e), breakMin: bm == null || bm === '' || !Number.isFinite(num(bm)) ? null : Math.max(0, Math.round(num(bm))), job: job.name, eventId: cell(raw?.eventId || ''), note: cell(raw?.note ?? raw?.備考 ?? '').slice(0, 80) };
}

const idFor = (s, n) => crypto.createHash('sha1').update(`${s.date}|${s.start}|${s.end}|${s.job}|${n}`).digest('hex').slice(0, 6);
/** Adds shifts (a shift that exactly repeats an existing one is skipped). @returns {{added:object[], skipped:number}} */
export async function addShifts(list, { nowMs = Date.now() } = {}) {
  await guardPrivate();
  const jobs = await readJobs(), byMonth = new Map(), added = []; let skipped = 0;
  for (const raw of (Array.isArray(list) ? list : []).slice(0, 40)) {
    const s = normalizeShift(raw, { jobs, nowMs }), month = monthOf(s.date);
    if (!byMonth.has(month)) byMonth.set(month, await readShifts(month));
    const cur = byMonth.get(month);
    if (cur.some((x) => x.date === s.date && x.start === s.start && x.end === s.end && norm(x.job) === norm(s.job))) { skipped++; continue; }
    s.id = idFor(s, cur.length); cur.push(s); added.push(s);
  }
  for (const [month] of byMonth) {
    const fresh = added.filter((s) => monthOf(s.date) === month); if (!fresh.length) continue;
    const exists = await brainReadRaw(monthPath(month)).catch(() => null);
    await brainWrite({ path: monthPath(month), content: (exists ? '' : `# シフト ${month}\n\n日付・時刻は${tzLabel(TZ())}です。休憩が空なら、法定の最低（6時間超で45分、8時間超で60分）として計算します。\n\n${SHIFT_HEAD}\n`) + fresh.map(rowOf).join('\n'), mode: 'append' });
  }
  return { added, skipped };
}

async function findShift(id, month, nowMs) {
  const months = month ? [month] : [tzDate(nowMs).slice(0, 7), tzDate(nowMs + 31 * DAY).slice(0, 7), tzDate(nowMs - 31 * DAY).slice(0, 7)];
  for (const m of months) { const text = await brainReadRaw(monthPath(m)).catch(() => null); if (!text) continue; const lines = text.split('\n'); const i = lines.findIndex((l) => new RegExp(`^\\|\\s*${id}\\s*\\|`).test(l)); if (i >= 0) return { m, lines, i, shift: parseShifts(lines[i])[0] }; }
  throw new Error(`id ${id} のシフトが見つかりません`);
}
export async function cancelShift(id, month, { nowMs = Date.now() } = {}) {
  await guardPrivate(); const f = await findShift(id, month, nowMs);
  f.lines.splice(f.i, 1); await brainWrite({ path: monthPath(f.m), content: f.lines.join('\n'), mode: 'replace' });
  return { removed: f.shift };
}
/** Changes one shift (date / start / end / break / job / note / eventId). The month file is rewritten (git history keeps the old one); changing the date may move it to another month file. */
export async function updateShift({ id, patch = {}, month, nowMs = Date.now() }) {
  await guardPrivate(); const jobs = await readJobs(), f = await findShift(id, month, nowMs), old = f.shift;
  const merged = normalizeShift({ date: patch.date ?? old.date, start: patch.start ?? old.start, end: patch.end ?? old.end, breakMin: patch.breakMin !== undefined ? patch.breakMin : old.breakMin, job: patch.job ?? old.job, note: patch.note ?? old.note, eventId: patch.eventId ?? old.eventId }, { jobs: jobs.length ? jobs : [{ name: old.job }], nowMs });
  const next = { ...merged, id: old.id };
  if (monthOf(next.date) === f.m) { f.lines[f.i] = rowOf(next); await brainWrite({ path: monthPath(f.m), content: f.lines.join('\n'), mode: 'replace' }); }
  else { f.lines.splice(f.i, 1); await brainWrite({ path: monthPath(f.m), content: f.lines.join('\n'), mode: 'replace' }); await addShiftRaw(next); }
  return { before: old, after: next };
}
async function addShiftRaw(s) {
  const month = monthOf(s.date), exists = await brainReadRaw(monthPath(month)).catch(() => null);
  await brainWrite({ path: monthPath(month), content: (exists ? '' : `# シフト ${month}\n\n${SHIFT_HEAD}\n`) + rowOf(s), mode: 'append' });
}

// ---------------------------------------------------------------- analysis (pure)
const weekKey = (date) => { const d = new Date(`${date}T00:00:00Z`), wd = (d.getUTCDay() + 6) % 7; return new Date(d.getTime() - wd * DAY).toISOString().slice(0, 10); };
const WD = ['日', '月', '火', '水', '木', '金', '土'];
export const weekdayOf = (date) => WD[new Date(`${date}T00:00:00Z`).getUTCDay()];
const withPay = (s, jobs) => { const j = jobs.find((x) => norm(x.name) === norm(s.job)) || { hourly: 0, transport: 0 }; return { ...s, ...shiftPay({ start: toMin(s.start), end: toMin(s.end), breakMin: s.breakMin }, j), weekday: weekdayOf(s.date) }; };

/** One month: shifts with pay, per-job totals, earned so far / still to come, goal progress and the hours still needed. Pure (tested). */
export function summarize({ month, shifts = [], jobs = [], goals = { monthly: {}, defaults: {} }, ytd = null, nowMs = Date.now() }) {
  const today = tzDate(nowMs), g = goalFor(goals, month);
  const list = shifts.filter((s) => monthOf(s.date) === month).map((s) => withPay(s, jobs)).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const sum = (arr, k) => arr.reduce((a, s) => a + s[k], 0);
  const done = list.filter((s) => s.date <= today), ahead = list.filter((s) => s.date > today);
  const earned = sum(done, 'pay') + sum(done, 'transport'), planned = sum(ahead, 'pay') + sum(ahead, 'transport'), projected = earned + planned;
  const byJob = jobs.map((j) => { const a = list.filter((s) => norm(s.job) === norm(j.name)); return { job: j.name, hourly: j.hourly, transport: j.transport, shifts: a.length, hours: Math.round(sum(a, 'hours') * 100) / 100, pay: sum(a, 'pay') + sum(a, 'transport') }; });
  const weeks = new Map(); for (const s of list) weeks.set(weekKey(s.date), (weeks.get(weekKey(s.date)) || 0) + s.hours);
  const weekly = [...weeks].map(([start, hours]) => ({ weekStart: start, hours: Math.round(hours * 100) / 100, over: g.weeklyCap != null && hours > g.weeklyCap }));
  const hoursTotal = Math.round(sum(list, 'hours') * 100) / 100;
  const best = jobs.length ? jobs.reduce((a, j) => (j.hourly > a.hourly ? j : a), jobs[0]) : null;
  const perHour = (() => { const h = sum(list, 'hours'); return h > 0 ? (sum(list, 'pay') + sum(list, 'transport')) / h : best ? best.hourly : 0; })();
  const remainingIncome = g.income != null ? Math.max(0, g.income - projected) : null;
  const hoursNeeded = remainingIncome != null && perHour > 0 ? Math.round((remainingIncome / perHour) * 10) / 10 : null;
  const warnings = [];
  for (const w of weekly) if (w.over) warnings.push(`${w.weekStart}の週は${w.hours}時間で、上限（週${g.weeklyCap}時間）を超えています`);
  if (g.hours != null && hoursTotal > g.hours) warnings.push(`月の目標時間（${g.hours}時間）を超えています`);
  let year = null;
  if (ytd != null) { year = { earned: ytd, cap: g.yearCap, remaining: g.yearCap != null ? Math.max(0, g.yearCap - ytd) : null, pct: g.yearCap ? Math.round((ytd / g.yearCap) * 100) : null }; if (year.pct != null && year.pct >= 90) warnings.push(`今年の収入が年収上限の${year.pct}%（¥${ytd.toLocaleString('ja-JP')}）に達しています`); }
  return { month, today, jobs, shifts: list, count: list.length, hours: hoursTotal, earned, planned, projected, byJob, weekly, goal: g, goalPct: g.income ? Math.round((projected / g.income) * 100) : null, remainingIncome, hoursNeeded, perHour: Math.round(perHour), warnings, year, empty: !list.length, note: '金額は、時給×働いた時間（休憩は無給）＋深夜割増（22〜5時は25%増）＋交通費で計算した概算です。実際の給与明細と違うことがあります。' };
}

/** Proposes shifts that reach the remaining goal, avoiding calendar events (busy: [{start,end} ISO or ms]) and recorded shifts, spread evenly over the weeks. Pure (tested).
 *  c: { dayStart=9, dayEnd=22 (hours), minBlock=3, maxBlock=6 (hours), weeklyCap, maxDaysPerWeek, avoidWeekdays:[], onlyWeekdays:[], hoursNeeded (override), from (date) } */
export function suggestShifts({ month, job, shifts = [], busy = [], hoursNeeded, c = {}, nowMs = Date.now() }) {
  const today = tzDate(nowMs), dayStart = (c.dayStart ?? 9) * 60, dayEnd = (c.dayEnd ?? 22) * 60, minB = Math.max(1, c.minBlock ?? 3) * 60, maxB = Math.max(minB / 60, c.maxBlock ?? 6) * 60;
  const wantMin = Math.max(0, Math.round((hoursNeeded ?? 0) * 60));
  const avoid = new Set((c.avoidWeekdays || []).map(String)), only = c.onlyWeekdays?.length ? new Set(c.onlyWeekdays.map(String)) : null;
  const busyMs = busy.map((b) => [typeof b.start === 'number' ? b.start : Date.parse(b.start), typeof b.end === 'number' ? b.end : Date.parse(b.end)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const first = c.from && validDate(c.from) ? c.from : today > `${month}-01` ? tzDate(nowMs + DAY) : `${month}-01`;
  const hasShift = new Set(shifts.map((s) => s.date)), weekHours = new Map(), weekDays = new Map();
  for (const s of shifts) { const k = weekKey(s.date), p = shiftPay({ start: toMin(s.start), end: toMin(s.end), breakMin: s.breakMin }, {}); weekHours.set(k, (weekHours.get(k) || 0) + p.workMin / 60); weekDays.set(k, (weekDays.get(k) || 0) + 1); }
  const cands = [];
  for (let d = 1; d <= daysIn(month); d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`; if (date < first || hasShift.has(date)) continue;
    const wd = weekdayOf(date); if (avoid.has(wd) || (only && !only.has(wd))) continue;
    const base = dayMs(date), blocks = busyMs.map(([a, b]) => [Math.round((a - base) / 60000) - 30, Math.round((b - base) / 60000) + 30]).filter(([a, b]) => b > dayStart && a < dayEnd).sort((x, y) => x[0] - y[0]);
    let cur = dayStart, best = null; const free = [];
    for (const [a, b] of blocks) { if (a > cur) free.push([cur, a]); cur = Math.max(cur, b); } if (cur < dayEnd) free.push([cur, dayEnd]);
    for (const w of free) if (w[1] - w[0] >= minB && (!best || w[1] - w[0] > best[1] - best[0])) best = w;
    if (best) cands.push({ date, wd, win: best, week: weekKey(date) });
  }
  const out = []; let left = wantMin; const used = new Set();
  while (left > 0) {
    const pool = cands.filter((x) => !used.has(x.date) && (c.weeklyCap == null || (weekHours.get(x.week) || 0) + minB / 60 <= c.weeklyCap) && (c.maxDaysPerWeek == null || (weekDays.get(x.week) || 0) < c.maxDaysPerWeek));
    if (!pool.length) break;
    pool.sort((a, b) => (weekHours.get(a.week) || 0) - (weekHours.get(b.week) || 0) || (b.win[1] - b.win[0]) - (a.win[1] - a.win[0]) || a.date.localeCompare(b.date));
    const x = pool[0]; used.add(x.date);
    let len = Math.min(maxB, x.win[1] - x.win[0], Math.max(120, Math.ceil(left / 30) * 30));
    if (c.weeklyCap != null) len = Math.min(len, Math.floor((c.weeklyCap - (weekHours.get(x.week) || 0)) * 2) * 30);
    if (len < 120) continue;
    const brk = defaultBreak(len), work = len - brk;
    const startMin = x.win[0], p = shiftPay({ start: startMin, end: startMin + len, breakMin: brk }, job || {});
    out.push({ date: x.date, weekday: x.wd, start: hhmm(startMin), end: hhmm(startMin + len), breakMin: brk, hours: p.hours, pay: p.pay + p.transport, reason: `その日は${hhmm(x.win[0])}〜${hhmm(x.win[1])}が予定なし（前後30分の余裕を確保）` });
    weekHours.set(x.week, (weekHours.get(x.week) || 0) + work / 60); weekDays.set(x.week, (weekDays.get(x.week) || 0) + 1); left -= work;
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  const hours = Math.round(out.reduce((a, s) => a + s.hours, 0) * 100) / 100, pay = out.reduce((a, s) => a + s.pay, 0);
  return { month, job: job?.name || null, proposals: out, hours, pay, shortfallHours: Math.round(Math.max(0, left) / 6) / 10, candidateDays: cands.length };
}

// ---------------------------------------------------------------- composition
export async function shiftSummary({ month, nowMs = Date.now() } = {}) {
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : tzDate(nowMs).slice(0, 7);
  if (!brainConfigured()) return { ...summarize({ month: m, nowMs }), unconfigured: true };
  const [jobs, goals, shifts] = await Promise.all([readJobs(), readGoals(), readShifts(m)]);
  const year = m.slice(0, 4); let ytd = 0;
  const g = goalFor(goals, m);
  if (g.yearCap != null) { const ms = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`); const all = await Promise.all(ms.map((x) => (x === m ? shifts : readShifts(x)))); for (const s of all.flat()) { const j = jobs.find((q) => norm(q.name) === norm(s.job)); if (j) { const p = shiftPay({ start: toMin(s.start), end: toMin(s.end), breakMin: s.breakMin }, j); ytd += p.pay + p.transport; } } }
  return summarize({ month: m, shifts, jobs, goals, ytd: g.yearCap != null ? ytd : null, nowMs });
}

// ---------------------------------------------------------------- calendar colouring (入れられない日 / 要確認の日)
/** Words that mean "the whole day is taken" when they are in the title of an all-day event. */
export const BLOCKING_WORDS = /旅行|旅|帰省|出張|合宿|試験|テスト|定期|模試|面接|説明会|研修|大会|ライブ|結婚式|式典|葬|休み|休暇|入院|通院|引っ越|引越|フェス|遠征/;
/**
 * Pure (tested). Classifies each day of the month from the Google Calendar events:
 *  busy  (入れられない日): all-day event with a blocking word, or timed events leaving no free block of `minBlock` hours between dayStart and dayEnd (±30 min margin as in suggestions)
 *  check (要確認の日): there is some event, but a free block remains, or it is an all-day event without a blocking word (a birthday, a reminder …)
 *  free: nothing. Events that are the recorded shifts themselves (same day, same start/end) are ignored.
 *  events: [{ summary, start, end }] (start/end: ISO with time, or YYYY-MM-DD for all-day; all-day end is exclusive)
 * → { 'YYYY-MM-DD': { status, items: [{ title, time }], reason } } for days that have something (free days are left out).
 */
export function classifyDays({ month, events = [], shifts = [], c = {} }) {
  const dayStart = (c.dayStart ?? 9) * 60, dayEnd = (c.dayEnd ?? 22) * 60, minB = Math.max(1, c.minBlock ?? 3) * 60;
  const mine = new Set(shifts.map((s) => `${s.date}|${s.start}|${s.end}`));
  const days = {}; const n = daysIn(month);
  const get = (date) => (days[date] ||= { items: [], timed: [], allDayBlock: false, allDay: false });
  for (const e of events) {
    const title = String(e.summary || '(無題)'), s = String(e.start || ''), en = String(e.end || '');
    if (!s) continue;
    if (!s.includes('T')) {   // all-day (possibly several days; the end date is exclusive)
      const last = en && !en.includes('T') ? new Date(Date.parse(`${en}T00:00:00Z`) - DAY).toISOString().slice(0, 10) : s;
      for (let t = Date.parse(`${s}T00:00:00Z`); t <= Date.parse(`${last}T00:00:00Z`); t += DAY) {
        const date = new Date(t).toISOString().slice(0, 10); if (!date.startsWith(month)) continue;
        const d = get(date); d.allDay = true; if (BLOCKING_WORDS.test(title)) d.allDayBlock = true; d.items.push({ title, time: '終日' });
      }
      continue;
    }
    const a = Date.parse(s), b = Date.parse(en || s); if (!Number.isFinite(a)) continue;
    const date = tzDate(a); if (!date.startsWith(month)) continue;
    const st = hhmm(Math.round((a - dayMs(date)) / 60000)), ed = hhmm(Math.round(((Number.isFinite(b) ? b : a) - dayMs(date)) / 60000));
    if (mine.has(`${date}|${st}|${ed}`)) continue;
    const d = get(date); d.timed.push([Math.round((a - dayMs(date)) / 60000), Math.round(((Number.isFinite(b) ? b : a) - dayMs(date)) / 60000)]); d.items.push({ title, time: `${st}-${ed}` });
  }
  const out = {};
  for (let i = 1; i <= n; i++) {
    const date = `${month}-${String(i).padStart(2, '0')}`, d = days[date]; if (!d || !d.items.length) continue;
    const blocks = d.timed.map(([a, b]) => [a - 30, b + 30]).filter(([a, b]) => b > dayStart && a < dayEnd).sort((x, y) => x[0] - y[0]);
    let cur = dayStart, best = 0; for (const [a, b] of blocks) { if (a > cur) best = Math.max(best, a - cur); cur = Math.max(cur, b); } if (cur < dayEnd) best = Math.max(best, dayEnd - cur);
    let status, reason;
    if (d.allDayBlock) { status = 'busy'; reason = '終日の予定'; }
    else if (d.timed.length && best < minB) { status = 'busy'; reason = `予定で埋まっている（空きは最大${Math.floor(best / 60)}時間${best % 60 ? best % 60 + '分' : ''}）`; }
    else { status = 'check'; reason = d.timed.length ? `予定あり。空きは最大${Math.floor(best / 60)}時間${best % 60 ? best % 60 + '分' : ''}` : '終日の予定（入れてよいか確認）'; }
    out[date] = { status, items: d.items.slice(0, 6), reason };
  }
  return out;
}
