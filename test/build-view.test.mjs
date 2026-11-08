import test from 'node:test';
import assert from 'node:assert/strict';
import { stageSegments, stageColor, stepperHtml, percentBar, fmtElapsed, fmtAgo, checksText, kpiOf, hourlySvg, dailySvg, STAGE_ORDER } from '../web/src/build-view.js';
import { buildOutput } from '../web/src/google-tools.js';
import { guideHtml } from '../web/src/project-view.js';
import { progressOf, aggregateUsage } from '../server/build.js';

test('build view: stage segments (7, one current, done filled), colours by state, empty = ghost meter', () => {
  const p = progressOf({ issue: { state: 'open' }, botCommented: true });
  const seg = stageSegments(p);
  assert.equal(seg.length, 7); assert.deepEqual(seg.map((s) => s.state), ['done', 'done', 'current', 'todo', 'todo', 'todo', 'todo']);
  assert.deepEqual(seg.map((s) => s.id), STAGE_ORDER);
  assert.equal(stageColor(p), '#19d3ff');
  const bad = progressOf({ issue: { state: 'open' }, pr: { draft: false }, checks: { state: 'failure' } });
  assert.equal(stageColor(bad), '#ff6b6b'); assert.equal(stageSegments(bad).find((s) => s.state === 'current').problem, true);
  assert.equal(stageColor(progressOf({ issue: { state: 'open' }, pr: { draft: false }, checks: { state: 'success' } })), '#ffb347');
  const done = stageSegments(progressOf({ issue: { state: 'closed' } })); assert.ok(done.every((s) => s.state === 'done')); assert.equal(stageColor(progressOf({ issue: { state: 'closed' } })), '#5ee08a');
  const ghost = stageSegments(null); assert.equal(ghost.length, 7); assert.ok(ghost.every((s) => s.state === 'todo'));
  assert.equal((stepperHtml(p).match(/<i /g) || []).length, 7); assert.equal((stepperHtml(null).match(/<i /g) || []).length, 7);
});

test('build view: percent bar clamps, elapsed and "ago" text, checks phrase', () => {
  assert.match(percentBar(40), /width:40%/); assert.match(percentBar(250), /width:100%/); assert.match(percentBar(undefined), /width:0%/);
  assert.equal(fmtElapsed(0), '0分'); assert.equal(fmtElapsed(45), '45分'); assert.equal(fmtElapsed(90), '1時間30分'); assert.equal(fmtElapsed(120), '2時間'); assert.equal(fmtElapsed(1500), '1日1時間'); assert.equal(fmtElapsed(null), '—');
  assert.equal(fmtAgo(new Date(Date.now() - 5 * 60000).toISOString()), '5分前'); assert.equal(fmtAgo('x'), '');
  assert.equal(checksText(null), null);
  assert.match(checksText({ state: 'success', passed: 3, total: 3 }).text, /✔/); assert.equal(checksText({ state: 'failure', passed: 1, failed: 1, total: 2 }).cls, 'bad'); assert.match(checksText({ state: 'pending', passed: 1, total: 2 }).text, /実行中/);
  assert.match(checksText({ state: 'unknown', error: '取得できませんでした（権限不足）' }).text, /権限不足/); assert.equal(checksText({ state: 'none' }).text, 'チェックなし');
});

test('build view: KPI tiles - counts, 5 h runs with the optional self-set meter, limit state wording is hedged', () => {
  const b = (state) => ({ state });
  const base = { builds: [b('queued'), b('working'), b('review'), b('done'), b('done')] };
  const u = aggregateUsage([], Date.now(), null);
  const k = kpiOf({ ...base, usage: u, limit: { hit: false } });
  assert.equal(k.length, 5); assert.deepEqual(k.slice(0, 3).map((x) => x.value), [2, 1, 2]);
  assert.equal(k[3].value, '0回'); assert.equal(k[3].meter, null); assert.match(k[3].sub, /合計 0分/);
  assert.match(k[4].value, /表示なし/); assert.match(k[4].sub, /見えません/);
  const run = (agoMin) => ({ name: 'Claude Code', status: 'completed', run_started_at: new Date(Date.now() - agoMin * 60000).toISOString(), created_at: new Date(Date.now() - agoMin * 60000).toISOString(), updated_at: new Date(Date.now() - agoMin * 60000 + 600000).toISOString() });
  const k2 = kpiOf({ builds: [], usage: aggregateUsage([run(5), run(20), run(40)], Date.now(), 4), limit: { hit: true, resetHint: 'resets at 3pm' } });
  assert.equal(k2[3].value, '3回'); assert.equal(k2[3].meter, 75); assert.match(k2[3].sub, /ご自分の目安/); assert.equal(k2[3].cls, '');
  assert.equal(k2[4].cls, 'bad'); assert.match(k2[4].value, /可能性/); assert.match(k2[4].sub, /resets at 3pm/);
  assert.equal(kpiOf({ builds: [], usage: { available: false, error: '取得できませんでした（権限不足）' }, limit: { suspect: true } })[3].value, '—');
  assert.equal(kpiOf({ builds: [] }).length, 5, 'works with nothing at all');
});

test('build view: SVG builders - 24 hourly bars with the 5 h window, 7 daily bars, valid empty charts', () => {
  const now = Date.parse('2026-11-05T12:00:00Z'), r = (agoH) => ({ name: 'Claude Code', status: 'completed', run_started_at: new Date(now - agoH * 3600e3).toISOString(), created_at: new Date(now - agoH * 3600e3).toISOString(), updated_at: new Date(now - agoH * 3600e3 + 300000).toISOString() });
  const u = aggregateUsage([r(0.2), r(0.4), r(2), r(10), r(50)], now);
  const h = hourlySvg(u), d = dailySvg(u);
  assert.match(h, /^<svg /); assert.match(h, /直近5時間/); assert.equal((h.match(/<rect x=/g) || []).length, 1 + 3, 'window band + 3 bars (the hour buckets with runs)');
  assert.equal((h.match(/fill="#19d3ff"/g) || []).length >= 2, true); assert.match(h, /24時間前/);
  assert.match(d, /^<svg /); assert.equal((d.match(/<rect /g) || []).length, 2, 'two days have runs'); assert.match(d, /11\/5/);
  for (const s of [hourlySvg(null), dailySvg(null), hourlySvg({ hourly: [] }), dailySvg(aggregateUsage([], now))]) { assert.match(s, /<svg /); assert.ok(!/NaN|undefined/.test(s)); }
});

test('build output for the voice model: compact, honest about what is unknown; the project guide states the real scoring', () => {
  const d = { count: 1, builds: [{ number: 3, title: 'x', self: false, stateLabel: '作業中', progress: progressOf({ issue: { state: 'open' }, botCommented: true }), elapsedMin: 12, summary: 's' }], usage: aggregateUsage([], Date.now(), null), limit: { hit: false }, warning: 'w' };
  const o = buildOutput(d);
  assert.equal(o.builds[0].stage, '実装中'); assert.equal(o.builds[0].percent, 40); assert.match(o.percentNote, /予測ではありません/); assert.match(o.usage.note, /\/usage/); assert.match(o.limit.note, /正確な残りは読めません/); assert.match(o.shown, /自動で表示/);
  assert.equal(buildOutput({ builds: [], count: 0, usage: { available: false, caveat: 'c' } }).usage.unavailable, true);
  const g = guideHtml('n');
  for (const w of ['健康度', '進み', '最優先', '−25点', '−15点', '−20点', '−30点', '75点以上', '完了 ÷（完了＋未完了）']) assert.ok(g.includes(w), w);
});
