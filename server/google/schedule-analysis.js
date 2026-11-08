// Deterministic schedule analysis (in the owner's time zone): overlaps, back-to-back meetings, heavy days, early/late events and free slots.
// The schedule sub-agent calls this instead of doing time arithmetic itself (language models are unreliable at it).
import { localDate, localMinutes, localWeekday, startOfLocalDay, addDays } from '../../shared/tz.js';
import { TZ } from '../profile/index.js';
const MIN = 60e3;
const WD = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * @param {Array<{id?:string, summary?:string, start?:{dateTime?:string,date?:string}, end?:{dateTime?:string,date?:string}, transparency?:string, status?:string, attendees?:Array<{self?:boolean,responseStatus?:string}>}>} events  raw Google events
 * @param {{nowMs?:number, days?:number, dayStart?:number, dayEnd?:number, minSlot?:number}} o
 */
export function analyzeSchedule(events, { nowMs = Date.now(), days = 7, dayStart = 9, dayEnd = 19, minSlot = 60, timeZone } = {}) {
  days = Math.max(1, Math.min(14, Math.round(days)));
  const tz = timeZone || TZ();
  const tzDate = (ms) => localDate(ms, tz), tzMinutes = (ms) => localMinutes(ms, tz);
  const hhmm = (ms) => { const m = tzMinutes(ms); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  const today = tzDate(nowMs);
  const timed = [], allDay = {};
  for (const e of events || []) {
    if (e.status === 'cancelled') continue;
    if ((e.attendees || []).find((a) => a.self)?.responseStatus === 'declined') continue;
    const title = e.summary || '(無題)';
    if (e.start?.date && !e.start?.dateTime) { const d = e.start.date; (allDay[d] ||= []).push(title); continue; }
    const s = Date.parse(e.start?.dateTime), en = Date.parse(e.end?.dateTime);
    if (!Number.isFinite(s) || !Number.isFinite(en) || en <= s) continue;
    timed.push({ id: e.id, title, s, e: en, free: e.transparency === 'transparent' });
  }
  timed.sort((a, b) => a.s - b.s || a.e - b.e);
  const busy = timed.filter((x) => !x.free);

  // overlaps (pairs) and back-to-back (gap < 10 min)
  const conflicts = [], backToBack = [];
  for (let i = 0; i < busy.length; i++) for (let j = i + 1; j < busy.length && busy[j].s < busy[i].e; j++) {
    const ov = Math.round((Math.min(busy[i].e, busy[j].e) - busy[j].s) / MIN);
    if (ov > 0) conflicts.push({ date: tzDate(busy[j].s), a: `${hhmm(busy[i].s)}-${hhmm(busy[i].e)} ${busy[i].title}`, b: `${hhmm(busy[j].s)}-${hhmm(busy[j].e)} ${busy[j].title}`, overlapMinutes: ov });
  }
  for (let i = 0; i + 1 < busy.length; i++) {
    const gap = Math.round((busy[i + 1].s - busy[i].e) / MIN);
    if (gap >= 0 && gap < 10 && tzDate(busy[i].e) === tzDate(busy[i + 1].s)) backToBack.push({ date: tzDate(busy[i + 1].s), first: `${busy[i].title}（〜${hhmm(busy[i].e)}）`, next: `${busy[i + 1].title}（${hhmm(busy[i + 1].s)}〜）`, gapMinutes: gap });
  }

  const perDay = [], freeSlots = [], notes = [];
  for (let k = 0; k < days; k++) {
    const date = addDays(today, k), ds = startOfLocalDay(date, tz), de = startOfLocalDay(addDays(date, 1), tz), wd = WD[localWeekday(ds, tz)];
    const dayEv = timed.filter((x) => x.s >= ds && x.s < de);
    // union of busy intervals inside the day
    const iv = busy.filter((x) => x.e > ds && x.s < de).map((x) => [Math.max(x.s, ds), Math.min(x.e, de)]).sort((a, b) => a[0] - b[0]);
    const merged = []; for (const [s, e] of iv) { const l = merged[merged.length - 1]; if (l && s <= l[1]) l[1] = Math.max(l[1], e); else merged.push([s, e]); }
    const busyMinutes = Math.round(merged.reduce((a, [s, e]) => a + (e - s), 0) / MIN);
    perDay.push({ date, weekday: wd, events: dayEv.map((x) => ({ time: `${hhmm(x.s)}-${hhmm(x.e)}`, title: x.title, ...(x.free ? { showsAsFree: true } : {}) })), allDay: allDay[date] || [], busyMinutes });
    if (busyMinutes >= 360) notes.push({ date, kind: 'heavyDay', detail: `${wd}曜は予定が合計 ${Math.round(busyMinutes / 6) / 10} 時間で詰まっています` });
    for (const x of dayEv) { if (tzMinutes(x.s) < 8 * 60) notes.push({ date, kind: 'early', detail: `${hhmm(x.s)} 開始：${x.title}` }); if (tzMinutes(x.e) > 20 * 60 && tzDate(x.e) === date) notes.push({ date, kind: 'late', detail: `${hhmm(x.e)} 終了：${x.title}` }); }
    // free slots inside the working window (today: from "now", rounded up to 15 min)
    let ws = ds + dayStart * 60 * MIN; const we = ds + dayEnd * 60 * MIN;
    if (date === today) ws = Math.max(ws, Math.ceil(nowMs / (15 * MIN)) * 15 * MIN);
    let cur = ws;
    for (const [s, e] of merged) { if (e <= cur) continue; if (s > cur) { const end = Math.min(s, we); if (end - cur >= minSlot * MIN) freeSlots.push({ date, weekday: wd, start: hhmm(cur), end: hhmm(end), minutes: Math.round((end - cur) / MIN) }); } cur = Math.max(cur, e); if (cur >= we) break; }
    if (cur < we && we - cur >= minSlot * MIN) freeSlots.push({ date, weekday: wd, start: hhmm(cur), end: hhmm(we), minutes: Math.round((we - cur) / MIN) });
  }
  return { today, days, workWindow: `${String(dayStart).padStart(2, '0')}:00-${String(dayEnd).padStart(2, '0')}:00`, perDay, conflicts, backToBack, notes, freeSlots, longestFreeSlots: [...freeSlots].sort((a, b) => b.minutes - a.minutes).slice(0, 5) };
}
