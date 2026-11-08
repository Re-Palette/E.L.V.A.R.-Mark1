// Decides when to start the briefing-prep agent in the background (so the spoken briefing is instant): once per day and kind, when the
// page is opened in the morning (05:00-12:00) or evening (17:30-24:00, the owner's time zone), the agent exists (Google + notes configured) and none ran yet.
import { timeZone } from './brand.js';
import { localMinutes, localDate, localWeekday } from '../../shared/tz.js';
export function briefingPrepDue({ nowMs = Date.now(), done = '', available = false, locked = false }) {
  if (!available || locked) return null;
  const tz = timeZone(), min = localMinutes(nowMs, tz), date = localDate(nowMs, tz);
  const kind = min >= 300 && min < 720 ? 'morning' : min >= 1050 ? 'evening' : null;
  if (!kind) return null;
  const mark = `${date}-${kind}`;
  return mark === done ? null : { kind, mark, task: kind === 'morning' ? '朝のブリーフィングの準備をしてください。' : '夜の振り返り（イブニングリキャップ）の準備をしてください。' };
}

/** Weekly silent run of the learning agent (refreshes the owner's profile). `last` = ms of the previous run. */
export function learningDue({ nowMs = Date.now(), last = 0, available = false, locked = false }) {
  if (!available || locked) return false;
  return nowMs - Number(last || 0) > 7 * 864e5;
}

/** Weekly silent security scan (same rule as the learning run). */
export const securityDue = learningDue;

// ---------------------------------------------------------------- weekly review (Sunday evening, or Monday morning if missed)
const pad = (n) => String(n).padStart(2, '0');
/** ISO week (Mon-Sun) of a date. `d` = a Date whose UTC fields are already shifted to the owner's time zone. */
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())), dayNum = (t.getUTCDay() + 6) % 7;      // Mon=0
  const monday = new Date(t.getTime() - dayNum * 864e5), thursday = new Date(monday.getTime() + 3 * 864e5);
  const y = thursday.getUTCFullYear(), wk = Math.floor((thursday - Date.UTC(y, 0, 1)) / 864e5 / 7) + 1;
  return { id: `${y}-W${pad(wk)}`, monday, sunday: new Date(monday.getTime() + 6 * 864e5) };
}
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
/** @returns {{mark:string, week:string, from:string, to:string, task:string}|null} */
export function reviewDue({ nowMs = Date.now(), done = '', available = false, locked = false }) {
  if (!available || locked) return null;
  const tz = timeZone(), dow = localWeekday(nowMs, tz), min = localMinutes(nowMs, tz), d = new Date(Date.parse(localDate(nowMs, tz) + 'T00:00:00Z'));
  let target = null;
  if (dow === 0 && min >= 1050) target = d;                                              // Sunday from 17:30: review this week
  else if (dow === 1 && min < 720) target = new Date(d.getTime() - 2 * 864e5);           // Monday morning: the week that just ended (if Sunday was missed)
  if (!target) return null;
  const w = isoWeek(target);
  if (w.id === done) return null;
  return { mark: w.id, week: w.id, from: ymd(w.monday), to: ymd(w.sunday), task: `${w.id}（${ymd(w.monday)}〜${ymd(w.sunday)}）の週次の振り返りを作ってください。` };
}
