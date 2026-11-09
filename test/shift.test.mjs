import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, hhmm, parseDateWord, shiftPay, defaultBreak, parseJobs, parseShifts, parseGoals, goalFor, normalizeShift, summarize, suggestShifts, setJob, setGoal, addShifts, updateShift, cancelShift, shiftSummary, readShifts } from '../server/shift.js';
import { monthCells, hhmmShort } from '../web/src/shift-view.js';
import { executeGoogle } from '../server/google/index.js';
import { useVault } from './helpers/vault.mjs';
const V = useVault();   // a signed-in test user with their own (empty) second brain in the in-memory database: approval tickets and notes are theirs

const NOW = Date.parse('2026-11-15T12:00:00+09:00');
async function withVault(fn, { google = true } = {}) {
  const keep = { ...process.env };
  if (google) Object.assign(process.env, { GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', GOOGLE_REFRESH_TOKEN: 'x' });
  try { return await V.withVault(fn); } finally { for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); }
}


test('parseTime / hhmm: 17時, 9:30, 午後5時, 9時半, 25:00', () => {
  assert.equal(parseTime('17時'), 1020); assert.equal(parseTime('9:30'), 570); assert.equal(parseTime('午後5時'), 1020); assert.equal(parseTime('９時半'), 570); assert.equal(parseTime('25:00'), 1500); assert.equal(parseTime('abc'), null);
  assert.equal(hhmm(1020), '17:00'); assert.equal(hhmm(1500), '01:00');
});
test('parseDateWord: 明日 / あさって / 11月20日 / 3日後 / ISO', () => {
  assert.equal(parseDateWord('明日', NOW), '2026-11-16'); assert.equal(parseDateWord('あさって', NOW), '2026-11-17'); assert.equal(parseDateWord('11月20日', NOW), '2026-11-20'); assert.equal(parseDateWord('3日後', NOW), '2026-11-18'); assert.equal(parseDateWord('2026-12-01', NOW), '2026-12-01'); assert.equal(parseDateWord('いつか', NOW), null);
});
test('shiftPay: unpaid legal break, night premium 22-5 (+25 %), overnight, transport kept apart', () => {
  assert.equal(defaultBreak(300), 0); assert.equal(defaultBreak(420), 45); assert.equal(defaultBreak(540), 60);
  const a = shiftPay({ start: 17 * 60, end: 22 * 60 }, { hourly: 1200, transport: 400 }); assert.deepEqual([a.hours, a.pay, a.transport, a.nightMin], [5, 6000, 400, 0]);
  const b = shiftPay({ start: 9 * 60, end: 18 * 60 }, { hourly: 1000 }); assert.deepEqual([b.breakMin, b.hours, b.pay], [60, 8, 8000]);
  const c = shiftPay({ start: 20 * 60, end: 2 * 60, breakMin: 0 }, { hourly: 1000 }); assert.equal(c.hours, 6); assert.equal(c.nightMin, 240); assert.equal(c.pay, 6000 + 1000);
});
test('file formats: jobs (last row wins, 削除 hides), shifts, goals (month-specific beats standing)', () => {
  const jobs = parseJobs('| 職場 | 時給 | 交通費 | 状態 |\n|---|---|---|---|\n| コンビニ | 1100 | 300 | 有効 |\n| コンビニ | 1200 | 400 | 有効 |\n| 塾 | 1500 | 0 | 有効 |\n| 塾 | 1500 | 0 | 削除 |');
  assert.deepEqual(jobs, [{ name: 'コンビニ', hourly: 1200, transport: 400 }]);
  const sh = parseShifts('| abc123 | 2026-11-20 | 17:00 | 22:00 |  | コンビニ | ev1 | メモ |'); assert.deepEqual([sh[0].id, sh[0].breakMin, sh[0].eventId, sh[0].job], ['abc123', null, 'ev1', 'コンビニ']);
  const g = parseGoals('- 月収目標：80000\n- 週の上限時間：20\n- 月収目標 2026-12：100000'); assert.equal(goalFor(g, '2026-11').income, 80000); assert.equal(goalFor(g, '2026-12').income, 100000); assert.equal(goalFor(g, '2026-11').weeklyCap, 20);
});
test('normalizeShift: loose voice input; one job can be omitted; unknown job / missing time are explained', () => {
  const jobs = [{ name: 'コンビニ', hourly: 1200, transport: 400 }];
  const s = normalizeShift({ date: '明日', start: '17時', end: '午後10時' }, { jobs, nowMs: NOW }); assert.deepEqual([s.date, s.start, s.end, s.job], ['2026-11-16', '17:00', '22:00', 'コンビニ']);
  assert.throws(() => normalizeShift({ date: '明日', start: '17時', end: '22時', job: '塾' }, { jobs: [...jobs, { name: '書店', hourly: 1, transport: 0 }], nowMs: NOW }), /どの職場/);
  assert.throws(() => normalizeShift({ date: '明日', start: '17時' }, { jobs, nowMs: NOW }), /終了/); assert.throws(() => normalizeShift({ date: '明日', start: '17時', end: '22時' }, { jobs: [], nowMs: NOW }), /登録されていません/);
});
test('summarize: earned vs planned, goal progress, hours still needed, weekly cap and year-cap warnings', () => {
  const jobs = [{ name: 'コンビニ', hourly: 1000, transport: 0 }], shifts = [{ id: 'a', date: '2026-11-10', start: '17:00', end: '22:00', breakMin: null, job: 'コンビニ' }, { id: 'b', date: '2026-11-20', start: '17:00', end: '22:00', breakMin: null, job: 'コンビニ' }];
  const goals = parseGoals('- 月収目標：20000\n- 週の上限時間：4\n- 年収上限：100000');
  const r = summarize({ month: '2026-11', shifts, jobs, goals, ytd: 95000, nowMs: NOW });
  assert.deepEqual([r.earned, r.planned, r.projected, r.hours, r.remainingIncome, r.hoursNeeded, r.goalPct], [5000, 5000, 10000, 10, 10000, 10, 50]);
  assert.ok(r.warnings.some((w) => /上限（週4時間）/.test(w)) && r.warnings.some((w) => /95%/.test(w)));
  assert.equal(summarize({ month: '2026-11', nowMs: NOW }).empty, true);
});
test('suggestShifts: avoids calendar events (+30 min margin) and recorded shifts, honours weekly cap / weekday wishes, spreads over weeks, reports the shortfall', () => {
  const job = { name: 'コンビニ', hourly: 1000, transport: 0 };
  const busy = [{ start: '2026-11-16T09:00:00+09:00', end: '2026-11-16T18:00:00+09:00' }];
  const r = suggestShifts({ month: '2026-11', job, shifts: [{ date: '2026-11-17', start: '17:00', end: '22:00', breakMin: null, job: 'コンビニ' }], busy, hoursNeeded: 12, nowMs: NOW });
  assert.ok(r.proposals.length >= 2); assert.ok(!r.proposals.some((p) => p.date === '2026-11-17'), 'a day that already has a shift is not proposed');
  const mon = r.proposals.find((p) => p.date === '2026-11-16'); if (mon) assert.ok(mon.start >= '18:30', 'starts after the event plus the margin');
  assert.ok(r.hours >= 11 && r.hours <= 14, 'close to the wanted hours: ' + r.hours); assert.ok(r.proposals.every((p) => p.date > '2026-11-15'), 'only future days');
  const capped = suggestShifts({ month: '2026-11', job, shifts: [], hoursNeeded: 40, c: { weeklyCap: 6, onlyWeekdays: ['土', '日'] }, nowMs: NOW });
  assert.ok(capped.proposals.every((p) => ['土', '日'].includes(p.weekday))); assert.ok(capped.shortfallHours > 0, 'cannot reach 40 h under a 6 h weekly cap');
  assert.equal(suggestShifts({ month: '2026-11', job, hoursNeeded: 0, nowMs: NOW }).proposals.length, 0);
});
test('vault: job / goal / shifts are written to シフト/*.md; summary reads them back; update and cancel rewrite one row', async () => {
  await withVault(async ({ store }) => {
    await setJob({ name: 'コンビニ', hourly: '1,200円', transport: 400 }); assert.ok(store.has('シフト/職場.md'));
    await setGoal({ key: '月収目標', value: 80000 }); await setGoal({ key: '週の上限時間', value: 20 });
    const r = await addShifts([{ date: '2026-11-20', start: '17時', end: '22時' }, { date: '2026-11-20', start: '17時', end: '22時' }, { date: '2026-12-01', start: '9時', end: '15時' }], { nowMs: NOW });
    assert.equal(r.added.length, 2); assert.equal(r.skipped, 1); assert.ok(store.has('シフト/2026-11.md') && store.has('シフト/2026-12.md'));
    const sum = await shiftSummary({ month: '2026-11', nowMs: NOW }); assert.deepEqual([sum.count, sum.projected, sum.goal.income, sum.remainingIncome], [1, 6400, 80000, 73600]);
    const id = r.added[0].id; const up = await updateShift({ id, patch: { end: '21時' }, nowMs: NOW }); assert.equal(up.after.end, '21:00'); assert.equal((await readShifts('2026-11'))[0].end, '21:00');
    const moved = await updateShift({ id, patch: { date: '2026-12-05' }, nowMs: NOW }); assert.equal(moved.after.date, '2026-12-05'); assert.equal((await readShifts('2026-11')).length, 0); assert.equal((await readShifts('2026-12')).length, 2);
    await cancelShift(id, '2026-12', { nowMs: NOW }); assert.equal((await readShifts('2026-12')).length, 1);
    await assert.rejects(() => cancelShift('zzzzzz', null, { nowMs: NOW }), /見つかりません/);
  });
});
test('tools: shift_add (calendar:false) records by voice; shift_cancel needs approval unless confirmed (screen button); shift_summary works with nothing set', async () => {
  await withVault(async () => {
    assert.equal((await executeGoogle({ tool: 'shift_job', args: { name: 'コンビニ', hourly: '1200', transport: '400' } })).body.ok, true);
    const add = await executeGoogle({ tool: 'shift_add', args: { date: '2026-11-20', start: '17:00', end: '22:00', calendar: false } }); assert.equal(add.body.ok, true); assert.equal(add.body.result.added.length, 1);
    const id = add.body.result.added[0].id;
    const ask = await executeGoogle({ tool: 'shift_cancel', args: { id } }); assert.equal(ask.body.needsApproval, true, 'by voice: an approval card');
    const done = await executeGoogle({ tool: 'shift_cancel', args: { id, confirmed: true } }); assert.equal(done.body.ok, true);
  });
  await withVault(async () => { const r = await executeGoogle({ tool: 'shift_summary', args: {} }); assert.equal(r.body.ok, true); assert.equal(r.body.result.empty, true); });
});
test('shift view helpers: month grid starts on the right weekday and has full weeks; times read short', () => {
  const c = monthCells('2026-11'); assert.equal(c.length % 7, 0); assert.equal(c.findIndex((x) => x.date === '2026-11-01'), 0, '2026-11-01 is a Sunday'); assert.equal(c.filter((x) => x.date).length, 30);
  assert.equal(hhmmShort('17:00'), '17時'); assert.equal(hhmmShort('09:30'), '9時30');
});

import { classifyDays } from '../server/shift.js';
test('classifyDays: blocked days, days to check, free days (calendar colouring)', () => {
  const ev = [
    { summary: '旅行', start: '2026-05-10', end: '2026-05-12' },                         // all-day, blocking word, 2 days (end exclusive)
    { summary: '誕生日', start: '2026-05-14', end: '2026-05-15' },                       // all-day, no blocking word → check
    { summary: '授業', start: '2026-05-15T09:00:00+09:00', end: '2026-05-15T20:30:00+09:00' },   // fills the day → busy
    { summary: '歯医者', start: '2026-05-16T10:00:00+09:00', end: '2026-05-16T11:00:00+09:00' },   // free block remains → check
    { summary: 'バイト', start: '2026-05-18T10:00:00+09:00', end: '2026-05-18T16:00:00+09:00' },   // the recorded shift itself → ignored
  ];
  const r = classifyDays({ month: '2026-05', events: ev, shifts: [{ date: '2026-05-18', start: '10:00', end: '16:00' }] });
  assert.equal(r['2026-05-10'].status, 'busy'); assert.equal(r['2026-05-11'].status, 'busy'); assert.equal(r['2026-05-12'], undefined);
  assert.equal(r['2026-05-14'].status, 'check'); assert.equal(r['2026-05-15'].status, 'busy');
  assert.equal(r['2026-05-16'].status, 'check'); assert.match(r['2026-05-16'].reason, /空き/);
  assert.equal(r['2026-05-18'], undefined); assert.equal(r['2026-05-20'], undefined);
});
