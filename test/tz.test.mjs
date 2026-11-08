import test from 'node:test';
import assert from 'node:assert/strict';
import { offsetMs, localDate, localHM, localMinutes, localWeekday, startOfLocalDay, zonedTimeToMs, isoAt, addDays, offsetLabel, tzLabel, isValidTimeZone, localParts } from '../shared/tz.js';

const TOKYO = 'Asia/Tokyo', NY = 'America/New_York';

test('Asia/Tokyo behaves like the old fixed +9h', () => {
  const t = Date.parse('2026-11-02T20:30:00Z');   // 05:30 on 11-03 in Tokyo
  assert.equal(offsetMs(TOKYO, t), 9 * 3600e3);
  assert.equal(localDate(t, TOKYO), '2026-11-03'); assert.equal(localHM(t, TOKYO), '05:30'); assert.equal(localMinutes(t, TOKYO), 330);
  assert.equal(startOfLocalDay('2026-11-03', TOKYO), Date.parse('2026-11-03T00:00:00+09:00'));
  assert.equal(isoAt('2026-11-02', '14:00', TOKYO), '2026-11-02T14:00:00+09:00');
  assert.equal(localWeekday(Date.parse('2026-11-08T00:00:00+09:00'), TOKYO), 0, '2026-11-08 is a Sunday');
  assert.equal(offsetLabel(TOKYO), '+09:00'); assert.equal(tzLabel(TOKYO), '日本時間'); assert.equal(tzLabel(NY), NY);
});

test('midnight rolls over at local midnight, not UTC midnight', () => {
  assert.equal(localDate(Date.parse('2026-11-02T14:59:59Z'), TOKYO), '2026-11-02');
  assert.equal(localDate(Date.parse('2026-11-02T15:00:00Z'), TOKYO), '2026-11-03');
  assert.equal(localHM(Date.parse('2026-11-02T15:00:00Z'), TOKYO), '00:00');
});

test('DST: America/New_York offset changes on the switch days (-4h in summer, -5h in winter)', () => {
  assert.equal(offsetMs(NY, Date.parse('2026-07-01T12:00:00Z')), -4 * 3600e3);
  assert.equal(offsetMs(NY, Date.parse('2026-12-01T12:00:00Z')), -5 * 3600e3);
  // spring forward 2026-03-08 02:00 -> 03:00: that local day has 23 hours
  const d0 = startOfLocalDay('2026-03-08', NY), d1 = startOfLocalDay('2026-03-09', NY);
  assert.equal((d1 - d0) / 3600e3, 23); assert.equal(d0, Date.parse('2026-03-08T00:00:00-05:00')); assert.equal(d1, Date.parse('2026-03-09T00:00:00-04:00'));
  // fall back 2026-11-01 02:00 -> 01:00: 25 hours
  assert.equal((startOfLocalDay('2026-11-02', NY) - startOfLocalDay('2026-11-01', NY)) / 3600e3, 25);
  assert.equal(isoAt('2026-03-07', '12:00', NY), '2026-03-07T12:00:00-05:00'); assert.equal(isoAt('2026-03-09', '12:00', NY), '2026-03-09T12:00:00-04:00');
  assert.equal(localDate(Date.parse('2026-11-01T05:30:00Z'), NY), '2026-11-01', '01:30 EDT, before the switch');
  assert.equal(localHM(Date.parse('2026-11-01T06:30:00Z'), NY), '01:30', '01:30 EST, after the switch');
  assert.equal(zonedTimeToMs('2026-07-04', '09:00', NY), Date.parse('2026-07-04T09:00:00-04:00'));
});

test('half-hour zones and negative offsets format correctly', () => {
  assert.equal(isoAt('2026-11-02', '09:00', 'Asia/Kolkata'), '2026-11-02T09:00:00+05:30');
  assert.equal(offsetLabel('America/St_Johns', Date.parse('2026-12-01T00:00:00Z')), '-03:30');
});

test('addDays is calendar arithmetic; localParts has a 0-23 hour', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01'); assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(localParts(Date.parse('2026-11-02T15:00:00Z'), TOKYO).hour, 0);
});

test('isValidTimeZone', () => {
  assert.ok(isValidTimeZone('Asia/Tokyo')); assert.ok(isValidTimeZone('UTC')); assert.ok(!isValidTimeZone('Mars/Base')); assert.ok(!isValidTimeZone('')); assert.ok(!isValidTimeZone(null));
});

test('server modules follow the profile time zone (schedule analysis across a DST switch; weather/hud use the profile)', async () => {
  const { analyzeSchedule } = await import('../server/google/schedule-analysis.js');
  const { runWithConfig, envConfig } = await import('../server/config/resolve.js');
  const { mergeProfile } = await import('../server/profile/defaults.js');
  const ev = (s, e) => ({ summary: 'mtg', start: { dateTime: s }, end: { dateTime: e } });
  const r = analyzeSchedule([ev('2026-03-09T09:00:00-04:00', '2026-03-09T10:00:00-04:00')], { nowMs: Date.parse('2026-03-07T12:00:00-05:00'), days: 3, timeZone: NY });
  assert.deepEqual(r.perDay.map((d) => d.date), ['2026-03-07', '2026-03-08', '2026-03-09']);
  assert.deepEqual(r.perDay.map((d) => d.weekday), ['土', '日', '月']);
  assert.equal(r.perDay[2].events[0].time, '09:00-10:00');
  // the default comes from the request's profile
  const cfg = { ...envConfig(), profile: mergeProfile({ locale: { timeZone: NY } }) };
  const r2 = runWithConfig(cfg, () => analyzeSchedule([], { nowMs: Date.parse('2026-03-08T03:00:00Z'), days: 1 }));
  assert.equal(r2.today, '2026-03-07', '03:00Z is still the 7th in New York');
  const r3 = analyzeSchedule([], { nowMs: Date.parse('2026-03-08T03:00:00Z'), days: 1 });
  assert.equal(r3.today, '2026-03-08', 'and already the 8th in Tokyo');
});
