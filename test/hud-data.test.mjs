import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHudData } from '../server/hud-data.js';
import { agoText, todayParts, neutralData, ringArcs } from '../web/src/hud-live.js';

const KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_API_MOCK_ORIGIN', 'EXA_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'WEATHER_PLACE', 'ELVAR_PROFILE'];
async function withEnv(env, fn) { const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); for (const k of KEYS) delete process.env[k]; Object.assign(process.env, env); const real = globalThis.fetch; try { return await fn(); } finally { globalThis.fetch = real; for (const k of KEYS) old[k] === undefined ? delete process.env[k] : (process.env[k] = old[k]); } }
const NOW = Date.parse('2026-11-02T08:30:00+09:00');   // Monday 08:30 JST

test('hud data: without Google the cards say 未連携 (no invented content); weather still real', async () => {
  await withEnv({}, async () => {
    globalThis.fetch = async (u) => ({ ok: true, status: 200, json: async () => (String(u).includes('open-meteo') ? { current: { temperature_2m: 17.6, weather_code: 0 }, daily: { time: [] } } : {}) });
    const d = await buildHudData({ now: NOW });
    assert.deepEqual([d.weather.city, d.weather.temp, d.weather.condition], ['TOKYO', '18°', '快晴']);
    assert.equal(d.google, false); assert.match(d.schedule[0].title, /Google未連携/); assert.match(d.tasks[0].title, /Google未連携/); assert.match(d.nextEvent.title, /Google未連携/);
    assert.equal(d.agentsAvailable.mail, false);
  });
});

test('hud data: with Google, today rows / next event / tasks come from the calendar and task list (local time zone, declined events skipped)', async () => {
  await withEnv({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', GOOGLE_REFRESH_TOKEN: 'x', WEATHER_PLACE: '大阪', ELVAR_PROFILE: JSON.stringify({ home: { city: '大阪', labelEn: 'OSAKA' } }) }, async () => {
    const ev = (id, summary, s, e, extra = {}) => ({ id, summary, start: { dateTime: s }, end: { dateTime: e }, ...extra });
    globalThis.fetch = async (u) => {
      u = String(u); const j = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b), json: async () => b });
      if (u.includes('oauth2')) return j({ access_token: 'AT', expires_in: 3600 });
      if (u.includes('open-meteo')) return j({ current: { temperature_2m: 9.4, weather_code: 61 }, daily: { time: [] } });
      if (u.includes('/calendars/primary/events')) return j({ items: [
        ev('1', '定例会議', '2026-11-02T10:00:00+09:00', '2026-11-02T11:00:00+09:00', { location: '会議室A' }),
        ev('2', '欠席の会', '2026-11-02T12:00:00+09:00', '2026-11-02T13:00:00+09:00', { attendees: [{ self: true, responseStatus: 'declined' }] }),
        ev('3', '夕食', '2026-11-02T19:00:00+09:00', '2026-11-02T20:00:00+09:00'),
        { id: '4', summary: '出張', start: { date: '2026-11-02' }, end: { date: '2026-11-03' } },
        ev('5', '朝一の打ち合わせ', '2026-11-03T09:00:00+09:00', '2026-11-03T10:00:00+09:00'),
      ] });
      if (u.includes('/lists/')) return j({ items: [
        { id: 't1', title: '見積もりを送る', status: 'needsAction', due: '2026-11-03T00:00:00.000Z' },
        { id: 't2', title: '資料を読む', status: 'needsAction' },
        { id: 't3', title: '済んだ用事', status: 'completed', completed: '2026-11-02T00:10:00.000Z' },
      ] });
      return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' };
    };
    const d = await buildHudData({ now: NOW });
    assert.equal(d.weather.city, 'OSAKA'); assert.equal(d.weather.temp, '9°'); assert.equal(d.weather.condition, '雨');
    assert.deepEqual(d.schedule.map((r) => [r.time, r.title, r.accent]), [['終日', '出張', 'cyan'], ['10:00', '定例会議', 'cyan'], ['19:00', '夕食', 'blue']]);
    assert.ok(d.schedule.some((r) => r.title === '定例会議' && r.sub === '会議室A')); assert.ok(!d.schedule.some((r) => r.title === '欠席の会' || r.title === '朝一の打ち合わせ'));
    assert.equal(d.schedule.find((r) => r.title === '夕食').accent, 'blue');
    assert.deepEqual([d.nextEvent.title, d.nextEvent.time, d.nextEvent.when], ['定例会議', '10:00', 'Today']);
    assert.deepEqual(d.tasks.map((t) => t.title), ['見積もりを送る', '資料を読む'], 'due date first, then undated');
    assert.deepEqual(d.counts, { tasksDone: 1, tasksTotal: 3 });
  });
});

test('hud-live helpers: relative times, JST date parts, honest neutral data', () => {
  const n = Date.parse('2026-11-02T12:00:00Z');
  assert.deepEqual([agoText(n - 20e3, n), agoText(n - 5 * 60e3, n), agoText(n - 3 * 3600e3, n), agoText(n - 2 * 86400e3, n)], ['今', '5分前', '3時間前', '2日前']);
  assert.deepEqual(todayParts(Date.parse('2026-11-01T16:00:00Z')), { day: '02', weekday: 'Mon', month: 'Nov' });   // 01:00 JST on the 2nd
  assert.deepEqual(ringArcs(1, 4), [[0, 90]]); assert.deepEqual(ringArcs(0, 0), [[0, 2]]); assert.deepEqual(ringArcs(5, 5), [[0, 358]]);
  const d = neutralData();
  assert.equal(d.schedule[0].title, '読み込み中…'); assert.equal(d.agents.length, 5); assert.equal(d.phoneAgents.length, 5); assert.ok(!JSON.stringify(d).includes('Team Meeting'));
});

test('hud-live: the five agent rows show busy ones first, then recently finished, then the rest', async () => {
  const { pickRows } = await import('../web/src/hud-live.js');
  const ids = ['memory', 'mail', 'schedule', 'document', 'research', 'project'], now = 1e12;
  assert.deepEqual(pickRows(ids, {}, now), ['memory', 'mail', 'schedule', 'document', 'research']);
  assert.deepEqual(pickRows(ids, { project: { busy: true } }, now), ['project', 'memory', 'mail', 'schedule', 'document']);
  assert.deepEqual(pickRows(ids, { project: { busy: true }, research: { doneAt: now - 60e3, ok: true } }, now).slice(0, 3), ['project', 'research', 'memory']);
  assert.ok(!pickRows(ids, { project: { doneAt: now - 3600e3 } }, now).includes('project'), 'finished long ago: back to the usual order');
});
