// Predictive Intelligence: looks ahead from the owner's calendar, tasks, projects and builds and returns concrete signals (deadline at risk, a day that is
// too full, a double booking, what tomorrow needs, a project that is going cold). All arithmetic is plain code on real data (no model guessing); the
// predict sub-agent / the voice model only turn the signals into advice. Dependencies are injected, so this file imports nothing from the tools.
import { localDate, localHM, localWeekday, startOfLocalDay } from '../shared/tz.js';
import { TZ } from './profile/index.js';
const DAY = 864e5;
const tzDate = (ms) => localDate(ms, TZ());
const dayStartMs = (d) => startOfLocalDay(d, TZ());
const daysBetween = (a, b) => Math.round((dayStartMs(b) - dayStartMs(a)) / DAY);
const hhmm = (ms) => localHM(ms, TZ());
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const wd = (d) => WD[localWeekday(dayStartMs(d), TZ())];
const rel = (n) => (n < 0 ? `${-n}日前` : n === 0 ? '今日' : n === 1 ? '明日' : n === 2 ? '明後日' : `${n}日後`);
export const SEV = { high: 0, med: 1, low: 2 };
const KEY_EVENT = /(面接|面談|プレゼン|発表|登壇|商談|契約|試験|テスト|手術|通院|診察|フライト|飛行機|新幹線|出張|締切|〆切|提出|納期|審査|撮影|本番|ライブ|イベント)/;
const DEADLINE_EVENT = /(締切|〆切|締め切り|期限|提出|納期)/;

/** Hours of work a task needs: "(2時間)" / "30分" / "1.5h" in its title or notes; otherwise a plain 1 hour. */
export function effortHours(t) {
  const s = `${t?.title || ''} ${t?.notes || ''}`;
  let m = s.match(/(\d+(?:\.\d+)?)\s*(?:時間|h\b|hr)/i); if (m) return Math.min(40, Number(m[1]));
  m = s.match(/(\d+)\s*分/); if (m) return Math.max(0.25, Number(m[1]) / 60);
  return 1;
}
const idOf = (kind, date, title) => `${kind}:${date || ''}:${String(title).replace(/\s+/g, '').slice(0, 24)}`;

/**
 * @param {{events:object[], analysis:object|null, tasks:object[], projects:object[], builds:object[], nowMs:number}} d
 * @returns {{id:string, kind:string, severity:'high'|'med'|'low', title:string, detail:string, date?:string, suggestion:string}[]}
 */
export function computeSignals({ events = [], analysis = null, tasks = [], projects = [], builds = [], nowMs = Date.now() } = {}) {
  const today = tzDate(nowMs), out = [];
  const add = (kind, severity, title, detail, suggestion, date) => out.push({ id: idOf(kind, date, title), kind, severity, title, detail, suggestion, ...(date ? { date } : {}) });
  const free = analysis?.freeSlots || [];
  const freeHoursUntil = (date) => Math.round(free.filter((s) => s.date <= date).reduce((a, s) => a + s.minutes, 0) / 6) / 10;

  // ---- deadlines at risk (tasks): needed time vs. the real free time left before the due date
  for (const t of tasks) {
    if (t.status === 'completed' || !t.due) continue;
    const due = String(t.due).slice(0, 10), left = daysBetween(today, due), need = effortHours(t);
    if (left < 0) { add('deadline', 'high', `「${t.title}」が期限切れです`, `期限は ${due}（${rel(left)}）でした。まだ完了していません`, '今日、最初に片づけるか、期限の延長を連絡するか、判断が必要です', due); continue; }
    if (left > 7) continue;
    const fh = freeHoursUntil(due);
    if (analysis && fh < need) add('deadline', 'high', `「${t.title}」の期限に間に合わない可能性があります`, `期限は${rel(left)}（${due}）。必要な時間は約${need}時間（見積り）ですが、期限までの空き時間は約${fh}時間です`, '他の予定を動かして時間を確保するか、期限の相談を早めに', due);
    else if (left <= 1) add('deadline', 'med', `「${t.title}」の期限が${rel(left)}です`, `空き時間は約${fh}時間、必要な時間は約${need}時間（見積り）`, left === 0 ? '今日のうちに着手するのがおすすめです' : '今日中に着手しておくと安心です', due);
    else if (analysis && left <= 3 && fh < need * 2) add('deadline', 'med', `「${t.title}」は余裕が少なめです`, `期限は${rel(left)}。空き時間は約${fh}時間、必要な時間は約${need}時間（見積り）`, '空いているうちに、先に進めておきましょう', due);
  }
  // ---- deadlines written into calendar events (提出・締切 …) in the next 3 days
  for (const e of events) {
    if (!DEADLINE_EVENT.test(e.summary || '')) continue;
    const d = String(e.start || '').slice(0, 10); if (!d) continue; const left = daysBetween(today, d);
    if (left >= 0 && left <= 3) add('deadline', left <= 1 ? 'med' : 'low', `予定「${e.summary}」が${rel(left)}です`, `${d}（${wd(d)}）`, '準備が済んでいるか、確認してください', d);
  }
  // ---- too full days / double bookings / back-to-back
  for (const c of analysis?.conflicts || []) { const left = daysBetween(today, c.date); if (left >= 0 && left <= 5) add('conflict', left <= 2 ? 'high' : 'med', `${rel(left)}（${wd(c.date)}）に予定が重なっています`, `${c.a} と ${c.b}（${c.overlapMinutes}分重複）`, 'どちらかを動かすか、欠席の連絡を', c.date); }
  for (const day of analysis?.perDay || []) {
    const left = daysBetween(today, day.date); if (left < 0 || left > 5) continue;
    if (day.busyMinutes >= 480) add('overload', left <= 1 ? 'high' : 'med', `${rel(left)}（${wd(day.date)}）は予定が詰まりすぎです`, `予定が合計 約${Math.round(day.busyMinutes / 6) / 10}時間。休憩や移動の余裕がほとんどありません`, '動かせる予定がないか、休憩の時間を先に確保しておきましょう', day.date);
    else if (day.busyMinutes >= 360) add('overload', 'low', `${rel(left)}（${wd(day.date)}）は予定が多めです`, `予定が合計 約${Math.round(day.busyMinutes / 6) / 10}時間`, '食事と休憩の時間を確保してください', day.date);
  }
  // ---- tomorrow's preparation (also today's later events)
  const tomorrow = tzDate(nowMs + DAY);
  for (const e of events) {
    if (!e.start || String(e.start).length <= 10) continue;   // all-day items are not prepared for here
    const s = Date.parse(e.start); if (!Number.isFinite(s)) continue; const d = tzDate(s);
    if (d !== tomorrow && !(d === today && s > nowMs)) continue;
    const why = [], tips = []; const title = e.summary || '(無題)';
    const hour = Number(hhmm(s).slice(0, 2));
    if (hour < 8) { why.push(`開始が${hhmm(s)}と早い`); tips.push('今夜は早めに休み、朝の支度の時間を逆算しておく'); }
    if (e.location) { why.push(`場所：${String(e.location).slice(0, 40)}`); tips.push('移動時間・経路・天気・持ち物を確認する'); }
    if ((e.attendees || []).length >= 2 || /(会議|打ち合わせ|打合せ|MTG|ミーティング|面談|商談)/i.test(title)) { why.push('人と会う予定'); tips.push('議題・前回の話・確認したいことを整理する（打ち合わせ準備担当に頼めます）'); }
    const key = KEY_EVENT.test(title);
    if (key) { why.push('重要そうな予定'); tips.push('資料・持ち物・服装・時間の余裕を確認する'); }
    if (!why.length) continue;
    add('prep', key || hour < 8 ? 'med' : 'low', `${rel(daysBetween(today, d))} ${hhmm(s)}「${title}」の準備`, why.join('／'), [...new Set(tips)].join('。'), d);
  }
  // ---- projects going cold
  for (const p of projects || []) {
    if (p.daysSinceUpdate != null && p.daysSinceUpdate > 14 && p.openTasks > 0) add('stale', p.daysSinceUpdate > 30 ? 'med' : 'low', `プロジェクト「${p.name}」が${p.daysSinceUpdate}日動いていません`, `未完了 ${p.openTasks} 件。次の一手：${(p.nextActions || [])[0] || '未定'}`, '次の一手を1つだけ決めて、着手するか、保留にするか判断を', undefined);
  }
  // ---- builds waiting for the owner
  for (const b of builds || []) { if (b.state === 'review') add('build', 'low', `製作「${b.title}」のPRが確認待ちです`, b.pr ? `Pull Request #${b.pr.number}` : '', 'PRを確認して、動かして試してください', undefined); }

  out.sort((a, b) => SEV[a.severity] - SEV[b.severity] || String(a.date || '9').localeCompare(String(b.date || '9')));
  return out.slice(0, 14);
}

const withTimeout = (p, ms = 9000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('時間切れ')), ms))]);

/** Collects the data (in parallel; a missing source only drops its own signals) and computes the signals. */
export async function predictScan(deps, { nowMs = Date.now() } = {}) {
  const today = tzDate(nowMs), t0 = dayStartMs(today), errors = {};
  const get = async (key, fn) => { if (!fn) return null; try { return await withTimeout(fn()); } catch (e) { errors[key] = String(e?.message || e).slice(0, 100); return null; } };
  const [ev, an, tk, pj, bd] = await Promise.all([
    get('events', deps.events && (() => deps.events({ timeMin: new Date(t0).toISOString(), timeMax: new Date(t0 + 8 * DAY).toISOString(), maxResults: 50 }))),
    get('analysis', deps.analysis && (() => deps.analysis({ days: 7 }))),
    get('tasks', deps.tasks && (() => deps.tasks({ maxResults: 50 }))),
    get('projects', deps.projects), get('builds', deps.builds),
  ]);
  const signals = computeSignals({ events: ev?.events || [], analysis: an, tasks: tk?.tasks || [], projects: pj?.projects || [], builds: bd?.builds || [], nowMs });
  const counts = { high: 0, med: 0, low: 0 }; for (const s of signals) counts[s.severity]++;
  return { generatedAt: new Date(nowMs).toISOString(), today, counts, signals, errors, note: '日時・件数・空き時間は、実際の予定とタスクから計算した値です。「必要な時間」は、タスクの題名やメモにある見積り（なければ1時間）で、目安です' };
}
