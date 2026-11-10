import test from 'node:test';
import assert from 'node:assert/strict';
import { dayRows, toolBreakdown, usageRows, barsSvg, toolLabel } from '../web/src/usage-view.js';

test('dayRows: n days oldest first ending today, missing days are zeros, live seconds -> minutes, tokens summed', () => {
  const daily = [{ day: '2026-05-20', provider: 'gemini', metric: 'live_seconds', amount: 600 }, { day: '2026-05-20', provider: 'gemini', metric: 'calls', amount: 4 }, { day: '2026-05-18', provider: 'gemini', metric: 'live_seconds', amount: 90 }, { day: '2026-05-18', provider: 'groq', metric: 'input_tokens', amount: 50 }, { day: '2026-05-18', provider: 'groq', metric: 'output_tokens', amount: 5 }];
  const r = dayRows(daily, '2026-05-20', 4);
  assert.deepEqual(r.map((x) => x.day), ['2026-05-17', '2026-05-18', '2026-05-19', '2026-05-20']);
  assert.equal(r[3].liveMinutes, 10); assert.equal(r[3].calls, 4); assert.equal(r[2].calls, 0); assert.equal(r[1].liveMinutes, 1.5); assert.equal(r[1].tokens, 55); assert.equal(dayRows([], '2026-05-20', 3).length, 3);
});
test('toolBreakdown: most used first, ties by name, top N; usageRows lists only providers with a number or a limit, in catalog order, with the source of each number', () => {
  assert.deepEqual(toolBreakdown([{ name: 'a', count: 6 }, { name: 'c', count: 1 }, { name: 'b', count: 6 }], 2), [{ name: 'a', count: 6 }, { name: 'b', count: 6 }]);
  assert.equal(toolLabel('deep_think'), '難しい推論'); assert.equal(toolLabel('zzz'), 'zzz');
  const s = { catalog: { gemini: { label: 'Gemini', metrics: { calls: { label: '呼び出し', unit: '回', scale: 1 }, live_seconds: { label: 'Live', unit: '分', scale: 1 / 60 } } }, groq: { label: 'Groq', metrics: { calls: { label: '呼び出し', unit: '回', scale: 1 } } } },
    today: { gemini: { calls: 3 } }, month: { gemini: { calls: 9 } }, meters: [{ provider: 'groq', metric: 'calls', period: 'day' }], sources: { calls: 'server', live_seconds: 'client' } };
  assert.deepEqual(usageRows(s).map((r) => [r.provider, r.metric, r.source]), [['gemini', 'calls', 'server'], ['groq', 'calls', 'server']]);
});
test('barsSvg: one bar per value, budget line, over-budget bar is red, escapes labels', () => {
  const s = barsSvg([0, 30, 70], ['5/18', '5/19', '<x>'], { line: 60, unit: '分' });
  assert.equal((s.match(/<rect /g) || []).length, 2);   // zero value draws no bar
  assert.ok(s.includes('目安 60分')); assert.ok(s.includes('#ff6b6b')); assert.ok(!s.includes('<x>'));
  assert.ok(barsSvg([], []).startsWith('<svg'));
});
