import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSignals, effortHours, predictScan } from '../server/predict.js';
import { analyzeSchedule } from '../server/google/schedule-analysis.js';
import { pickAlerts, noteForAlerts, predictAgentDue } from '../web/src/predict.js';

// "now" = 2026-11-04 (Wed) 21:00 JST  -> tomorrow = 11-05 (Thu)
const NOW = Date.parse('2026-11-04T21:00:00+09:00');
const ev = (id, summary, s, e, extra = {}) => ({ id, summary, start: `2026-11-${s.d}T${s.t}:00+09:00`, end: `2026-11-${e.d || s.d}T${e.t}:00+09:00`, ...extra });
const gev = (e) => ({ id: e.id, summary: e.summary, start: { dateTime: e.start }, end: { dateTime: e.end } });

test('effortHours reads an estimate from the task text, otherwise 1 hour', () => {
  assert.equal(effortHours({ title: '資料作成（3時間）' }), 3); assert.equal(effortHours({ title: 'x', notes: '90分くらい' }), 1.5); assert.equal(effortHours({ title: '1.5h' }), 1.5); assert.equal(effortHours({ title: 'メール返信' }), 1);
});

test('predictive signals: deadline at risk (needed hours vs real free hours), overdue, conflict, packed day, tomorrow prep, cooling project, build waiting', () => {
  const events = [
    // tomorrow (Thu 11-05): 07:30 interview at a location, overlapping meetings, and a packed afternoon
    ev('a', '就職の面接', { d: '05', t: '07:30' }, { t: '08:30' }, { location: '東京駅前ビル', attendees: ['x@y.z', 'a@b.c'] }),
    ev('b', '定例MTG', { d: '05', t: '10:00' }, { t: '12:00' }), ev('c', '企画レビュー', { d: '05', t: '11:00' }, { t: '12:30' }),
    ev('d', '作業', { d: '05', t: '13:00' }, { t: '19:00' }),
    ev('e', '企画書の提出', { d: '06', t: '09:00' }, { t: '09:30' }),
  ].map((e) => ({ ...e, start: e.start, end: e.end }));
  const analysis = analyzeSchedule(events.map(gev), { nowMs: NOW, days: 7 });
  const tasks = [
    { id: '1', title: '見積書を作る（4時間）', due: '2026-11-05T00:00:00.000Z', status: 'needsAction' },   // tomorrow, needs 4 h, but almost no free time
    { id: '2', title: '請求書を送る', due: '2026-11-02T00:00:00.000Z', status: 'needsAction' },          // overdue
    { id: '3', title: '来週の準備', due: '2026-11-20T00:00:00.000Z', status: 'needsAction' },           // far away: no signal
    { id: '4', title: '済んだもの', due: '2026-11-05T00:00:00.000Z', status: 'completed' },
  ];
  const sig = computeSignals({ events, analysis, tasks, projects: [{ name: '翻訳アプリ', daysSinceUpdate: 33, openTasks: 3, nextActions: ['競合を調べる'] }, { name: '元気な案', daysSinceUpdate: 2, openTasks: 2 }], builds: [{ title: 'Hello', state: 'review', pr: { number: 8 } }, { title: 'x', state: 'working' }], nowMs: NOW });
  const by = (k) => sig.filter((s) => s.kind === k);
  assert.ok(by('deadline').some((s) => s.severity === 'high' && /見積書/.test(s.title) && /間に合わない/.test(s.title)), 'deadline at risk');
  assert.ok(by('deadline').some((s) => s.severity === 'high' && /請求書.*期限切れ/.test(s.title)), 'overdue');
  assert.ok(!sig.some((s) => /来週の準備|済んだもの/.test(s.title)), 'far away / completed: nothing');
  assert.ok(by('deadline').some((s) => /企画書の提出/.test(s.title)), 'a deadline written into an event');
  assert.ok(by('conflict').some((s) => s.severity === 'high' && /定例MTG/.test(s.detail) && /企画レビュー/.test(s.detail)), 'double booking tomorrow');
  assert.ok(by('overload').some((s) => /詰まりすぎ|多め/.test(s.title)), 'packed day');
  const prep = by('prep').find((s) => /就職の面接/.test(s.title)); assert.ok(prep && prep.severity === 'med' && /07:30/.test(prep.title) && /早い/.test(prep.detail) && /東京駅前ビル/.test(prep.detail) && /経路|移動/.test(prep.suggestion), 'tomorrow prep');
  assert.ok(by('stale').some((s) => /翻訳アプリ/.test(s.title)) && !by('stale').some((s) => /元気な案/.test(s.title)), 'cooling project only');
  assert.ok(by('build').some((s) => /Hello/.test(s.title)) && !by('build').some((s) => /x/.test(s.title) && s.kind === 'build' && /「x」/.test(s.title)), 'build waiting for review');
  // ordered by severity, ids stable
  const sev = sig.map((s) => ({ high: 0, med: 1, low: 2 }[s.severity])); assert.deepEqual(sev, [...sev].sort((a, b) => a - b));
  assert.deepEqual(computeSignals({ events, analysis, tasks, nowMs: NOW }).map((s) => s.id).filter((i) => /^deadline/.test(i)), sig.map((s) => s.id).filter((i) => /^deadline/.test(i)));
  assert.deepEqual(computeSignals({ nowMs: NOW }), [], 'nothing known -> no signals');
});

test('predictScan: reads its sources in parallel; a failing source only drops its own signals and is reported in errors', async () => {
  const calls = [];
  const deps = {
    events: async () => { calls.push('events'); return { events: [{ id: 'a', summary: '面接', start: '2026-11-05T07:30:00+09:00', end: '2026-11-05T08:30:00+09:00', location: '東京' }] }; },
    analysis: async () => { calls.push('analysis'); return analyzeSchedule([], { nowMs: NOW, days: 7 }); },
    tasks: async () => { calls.push('tasks'); return { tasks: [{ id: '1', title: '見積書（6時間）', due: '2026-11-05T00:00:00.000Z', status: 'needsAction' }] }; },
    projects: async () => { throw new Error('GitHubに接続できません'); }, builds: null,
  };
  const r = await predictScan(deps, { nowMs: NOW });
  assert.deepEqual(calls.sort(), ['analysis', 'events', 'tasks']); assert.match(r.errors.projects, /GitHub/); assert.ok(r.counts.high + r.counts.med + r.counts.low === r.signals.length);
  assert.ok(r.signals.some((s) => s.kind === 'prep') && r.note);
});

test('predictive alerts on the page: high ones always (once per 6 h), medium prep/deadline only in the evening, max 2, an honest system note; the daily agent run happens once per evening', () => {
  const S = (id, severity, kind = 'deadline') => ({ id, severity, kind, title: id + 'です', detail: '詳細', suggestion: '提案' });
  const sigs = [S('h1', 'high'), S('h2', 'high', 'conflict'), S('h3', 'high'), S('m1', 'med', 'prep'), S('m2', 'med', 'stale'), S('l1', 'low')];
  const morning = Date.parse('2026-11-04T09:00:00+09:00'), evening = Date.parse('2026-11-04T20:00:00+09:00');
  assert.deepEqual(pickAlerts(sigs, {}, morning).map((s) => s.id), ['h1', 'h2'], 'max 2, high only in the morning');
  assert.deepEqual(pickAlerts(sigs, { h1: morning - 3600e3, h2: morning - 7 * 3600e3 }, morning).map((s) => s.id), ['h2', 'h3'], 'announced < 6 h ago: skipped');
  assert.deepEqual(pickAlerts([S('m1', 'med', 'prep'), S('m2', 'med', 'stale')], {}, evening).map((s) => s.id), ['m1'], 'evening: medium prep yes, medium "stale" no');
  assert.deepEqual(pickAlerts([S('m1', 'med', 'prep')], {}, morning), []);
  const n = noteForAlerts(pickAlerts(sigs, {}, morning)); assert.match(n, /^\[システム\]/); assert.match(n, /作らないでください/); assert.match(n, /h1です/);
  assert.equal(predictAgentDue({ nowMs: morning, signals: sigs, available: true }), false, 'not before 18:00');
  assert.equal(predictAgentDue({ nowMs: evening, signals: sigs, available: true }), true);
  assert.equal(predictAgentDue({ nowMs: evening, lastDay: '2026-11-04', signals: sigs, available: true }), false, 'once per day');
  assert.equal(predictAgentDue({ nowMs: evening, signals: [S('l1', 'low', 'stale')], available: true }), false, 'nothing worth preparing');
  assert.equal(predictAgentDue({ nowMs: evening, signals: sigs, available: false }), false);
});

test('predict agent + tool wiring: guard (予測/日付.md only), no write tools besides notes, tool offered with Google, persona knows it', async () => {
  const { AGENTS, AGENT_IDS } = await import('../server/agents/registry.js'); const a = AGENTS.predict;
  assert.ok(AGENT_IDS.includes('predict') && a.tools.includes('predict_scan'));
  assert.equal(a.guard('brain_write', { path: '予測/2026-11-04.md', mode: 'create' }), null); assert.ok(a.guard('brain_write', { path: '会議/x.md' })); assert.ok(a.guard('brain_write', { path: '予測/x.md', mode: 'replace' }));
  assert.ok(!a.tools.some((t) => /gmail_(send|create|trash)|tasks_(create|complete|delete)|calendar_(create|update|delete)/.test(t))); assert.match(a.system(), /【要対応】/); assert.match(a.system(), /計算し直さない/);
  const keep = { ...process.env }; Object.assign(process.env, { GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', GOOGLE_REFRESH_TOKEN: 'x' });
  try { const { declarations } = await import('../server/google/tools.js'); assert.ok(declarations().some((d) => d.name === 'predict_scan')); const { buildInstruction } = await import('../server/persona.js'); assert.match(buildInstruction({ google: true }), /predict_scan/); }
  finally { for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } }
});
