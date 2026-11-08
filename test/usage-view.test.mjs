import test from 'node:test';
import assert from 'node:assert/strict';
import { dayRows, toolBreakdown, barsSvg, toolLabel } from '../web/src/usage-view.js';

const NOW = Date.parse('2026-05-20T03:00:00Z');   // 2026-05-20 12:00 JST
test('dayRows: n days oldest first, missing days are zeros, JST days', () => {
  const raw = { days: { '2026-05-20': { liveSeconds: 600, liveSessions: 2, tools: { news: 3, weather: 1 } }, '2026-05-18': { liveSeconds: 90, liveSessions: 1, tools: { deep_think: 2 } } } };
  const r = dayRows(raw, 4, NOW);
  assert.deepEqual(r.map((x) => x.day), ['2026-05-17', '2026-05-18', '2026-05-19', '2026-05-20']);
  assert.equal(r[3].liveMinutes, 10); assert.equal(r[3].calls, 4); assert.equal(r[2].calls, 0); assert.equal(r[1].liveMinutes, 1.5);
  assert.equal(dayRows({}, 3, NOW).length, 3);
});
test('toolBreakdown: sums over days, most used first, top N', () => {
  const t = toolBreakdown([{ tools: { a: 2, b: 5 } }, { tools: { a: 4, c: 1 } }], 2);
  assert.deepEqual(t, [{ name: 'a', count: 6 }, { name: 'b', count: 5 }]);
  assert.equal(toolLabel('deep_think'), '難しい推論'); assert.equal(toolLabel('zzz'), 'zzz');
});
test('barsSvg: one bar per value, budget line, over-budget bar is red, escapes labels', () => {
  const s = barsSvg([0, 30, 70], ['5/18', '5/19', '<x>'], { line: 60, unit: '分' });
  assert.equal((s.match(/<rect /g) || []).length, 2);   // zero value draws no bar
  assert.ok(s.includes('目安 60分')); assert.ok(s.includes('#ff6b6b')); assert.ok(!s.includes('<x>'));
  assert.ok(barsSvg([], []).startsWith('<svg'));
});
