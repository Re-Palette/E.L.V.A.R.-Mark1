import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_MAP, declarations } from '../server/google/tools.js';

test('briefing_data: gathers everything in parallel (one call, not six in a row), keeps going when one source fails', async () => {
  const orig = {};
  const stub = (name, fn) => { orig[name] = TOOL_MAP[name].run; TOOL_MAP[name].run = fn; };
  const calls = [];
  const slow = (name, val) => async (a) => { calls.push(name); await new Promise((r) => setTimeout(r, 200)); return val; };
  try {
    stub('calendar_list_events', slow('cal', { events: [] })); stub('weather', slow('weather', { temp: 20 })); stub('news', async () => { throw new Error('news down'); });
    stub('gmail_search', slow('mail', { messages: [] })); stub('tasks_list', slow('tasks', { tasks: [] }));
    const t0 = Date.now(); const out = await TOOL_MAP.briefing_data.run({ kind: 'evening' }); const ms = Date.now() - t0;
    assert.ok(ms < 700, `parallel: took ${ms} ms (6+ sequential calls would be >1200)`);
    assert.ok(out.today && out.tomorrow && out.waiting && out.weather && out.tasks && out.doneToday && out.drafts, Object.keys(out).join());
    assert.match(out.errors.news, /news down/); assert.equal(out.kind, 'evening'); assert.match(out.now, /^\d{4}-\d\d-\d\d /);
    const m = await TOOL_MAP.briefing_data.run({ kind: 'morning' }); assert.ok(m.unread && m.tasks && !m.tomorrow);
  } finally { for (const [k, f] of Object.entries(orig)) TOOL_MAP[k].run = f; }
  assert.ok(declarations().some((d) => d.name === 'briefing_data'));
});
