// Time-zone helpers shared by the server and the web app (plain ES module, no dependencies).
// Everything is computed with Intl, so daylight-saving zones work. Replaces the old fixed "+09:00" / "9 * 3600e3".
const dtf = new Map();
function fmt(tz) {
  let f = dtf.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    dtf.set(tz, f);
  }
  return f;
}
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const p2 = (n) => String(n).padStart(2, '0');
export const DAY_MS = 864e5;
export const isValidTimeZone = (tz) => { try { fmt(String(tz)); return typeof tz === 'string' && tz.length > 0; } catch { return false; } };

/** Wall-clock fields of an instant in `tz`. */
export function localParts(ms, tz) {
  const o = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) o[x.type] = x.value;
  return { year: +o.year, month: +o.month, day: +o.day, hour: +o.hour % 24, minute: +o.minute, second: +o.second, weekday: WD[o.weekday] };
}
/** tz offset from UTC in ms at the instant `atMs` (positive east of UTC). */
export function offsetMs(tz, atMs = Date.now()) {
  const p = localParts(atMs, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(atMs / 1000) * 1000;
}
/** 'YYYY-MM-DD' of the instant in `tz`. */
export function localDate(ms, tz) { const p = localParts(ms, tz); return `${p.year}-${p2(p.month)}-${p2(p.day)}`; }
/** 'HH:MM' of the instant in `tz`. */
export function localHM(ms, tz) { const p = localParts(ms, tz); return `${p2(p.hour)}:${p2(p.minute)}`; }
/** Minutes since local midnight. */
export function localMinutes(ms, tz) { const p = localParts(ms, tz); return p.hour * 60 + p.minute; }
/** 0 (Sunday) .. 6 (Saturday) in `tz`. */
export function localWeekday(ms, tz) { return localParts(ms, tz).weekday; }
/** Epoch ms of the local wall time `dateStr` + 'HH:MM[:SS]' in `tz` (DST aware). */
export function zonedTimeToMs(dateStr, hm, tz) {
  const [y, mo, d] = String(dateStr).split('-').map(Number), [h = 0, mi = 0, s = 0] = String(hm || '00:00').split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = wall - offsetMs(tz, wall);
  t = wall - offsetMs(tz, t);
  return t;
}
/** Epoch ms of 00:00 local on `dateStr` ('YYYY-MM-DD'). */
export const startOfLocalDay = (dateStr, tz) => zonedTimeToMs(dateStr, '00:00', tz);
/** ISO 8601 with the zone's offset at that moment: isoAt('2026-11-02', '14:00', 'Asia/Tokyo') -> '2026-11-02T14:00:00+09:00'. */
export function isoAt(dateStr, hm, tz) {
  const t = zonedTimeToMs(dateStr, hm, tz), off = Math.round(offsetMs(tz, t) / 60000), a = Math.abs(off);
  const [h = '00', m = '00', s = '00'] = String(hm || '00:00').split(':');
  return `${dateStr}T${p2(+h)}:${p2(+m)}:${p2(+s)}${off < 0 ? '-' : '+'}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
}
/** Calendar arithmetic on 'YYYY-MM-DD' (no zone involved). */
export function addDays(dateStr, n) { return new Date(Date.parse(dateStr + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10); }
/** Offset label like '+09:00' at `atMs`. */
export function offsetLabel(tz, atMs = Date.now()) { const off = Math.round(offsetMs(tz, atMs) / 60000), a = Math.abs(off); return `${off < 0 ? '-' : '+'}${p2(Math.floor(a / 60))}:${p2(a % 60)}`; }
/** Name used in spoken text: '日本時間' for Tokyo, otherwise the zone id. */
export const tzLabel = (tz) => (tz === 'Asia/Tokyo' ? '日本時間' : String(tz || ''));
