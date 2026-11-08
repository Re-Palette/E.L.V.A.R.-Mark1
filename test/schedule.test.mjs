import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSchedule } from '../server/google/schedule-analysis.js';

const ev = (summary, s, e, extra = {}) => ({ id: summary, summary, start: { dateTime: `${s}+09:00` }, end: { dateTime: `${e}+09:00` }, ...extra });
const NOW = Date.parse('2026-11-02T08:00:00+09:00');   // Monday 08:00 JST

test('schedule analysis: overlaps, back-to-back, heavy day, early/late, declined/free events, all-day, free slots', () => {
  const r = analyzeSchedule([
    ev('定例', '2026-11-02T10:00:00', '2026-11-02T11:00:00'),
    ev('面談', '2026-11-02T10:30:00', '2026-11-02T11:30:00'),            // overlaps 定例 by 30 min
    ev('レビュー', '2026-11-02T11:35:00', '2026-11-02T12:00:00'),       // 5 min after 面談: back-to-back
    ev('欠席する会議', '2026-11-02T13:00:00', '2026-11-02T14:00:00', { attendees: [{ self: true, responseStatus: 'declined' }] }),
    ev('空き表示のメモ', '2026-11-02T15:00:00', '2026-11-02T16:00:00', { transparency: 'transparent' }),
    ev('朝活', '2026-11-03T07:00:00', '2026-11-03T07:45:00'),
    ev('懇親会', '2026-11-03T19:00:00', '2026-11-03T21:00:00'),
    { id: 'ad', summary: '出張', start: { date: '2026-11-03' }, end: { date: '2026-11-04' } },
    ev('終日会議A', '2026-11-04T09:00:00', '2026-11-04T12:00:00'), ev('終日会議B', '2026-11-04T13:00:00', '2026-11-04T17:30:00'),
  ], { nowMs: NOW, days: 3 });
  assert.equal(r.today, '2026-11-02');
  assert.equal(r.conflicts.length, 1); assert.equal(r.conflicts[0].overlapMinutes, 30);
  assert.ok(r.backToBack.some((b) => b.next.includes('レビュー') && b.gapMinutes === 5));
  assert.ok(!JSON.stringify(r).includes('欠席する会議'), 'declined events are ignored');
  assert.ok(r.perDay[0].events.some((x) => x.title === '空き表示のメモ' && x.showsAsFree));
  assert.deepEqual(r.perDay[1].allDay, ['出張']);
  assert.ok(r.notes.some((n) => n.kind === 'early' && n.date === '2026-11-03') && r.notes.some((n) => n.kind === 'late' && n.date === '2026-11-03'));
  assert.ok(r.notes.some((n) => n.kind === 'heavyDay' && n.date === '2026-11-04'));   // 3h + 4.5h = 7.5h
  // Monday free slots: 09:00-10:00 (60), 12:00-19:00 (420); the free-marked memo does not block 15:00-16:00
  const mon = r.freeSlots.filter((s) => s.date === '2026-11-02');
  assert.deepEqual(mon.map((s) => [s.start, s.end, s.minutes]), [['09:00', '10:00', 60], ['12:00', '19:00', 420]]);
  assert.deepEqual([r.longestFreeSlots[0].date, r.longestFreeSlots[0].minutes], ['2026-11-03', 600]);   // Tuesday has no daytime events
  assert.equal(r.perDay[0].busyMinutes, 115);   // 10:00-11:30 (90) + 11:35-12:00 (25)
});

test('schedule analysis: today starts "now" (15-min rounded); empty calendar gives whole working days', () => {
  const r = analyzeSchedule([], { nowMs: Date.parse('2026-11-02T14:07:00+09:00'), days: 2 });
  assert.deepEqual(r.freeSlots.filter((s) => s.date === '2026-11-02').map((s) => [s.start, s.end]), [['14:15', '19:00']]);
  assert.deepEqual(r.freeSlots.filter((s) => s.date === '2026-11-03').map((s) => [s.start, s.end]), [['09:00', '19:00']]);
  assert.equal(r.conflicts.length, 0);
});
