// Real data for the HUD cards: weather, today's schedule, tasks, next event. Each part is optional and independent: when a service is not
// connected or fails, that card says so honestly ("未連携" / "取得できませんでした") instead of showing invented content.
import { TOOL_MAP } from './google/tools.js';
import { googleConfigured, googleReauthRequired } from './google/config.js';
import { AGENTS } from './agents/registry.js';
import { pickProvider } from './agents/provider.js';
import { env } from './config/resolve.js';
import { localDate, localHM, localWeekday, startOfLocalDay } from '../shared/tz.js';
import { TZ, currentProfile } from './profile/index.js';

const DAY = 864e5, WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const jdate = (ms) => localDate(ms, TZ());
const jhm = (iso) => localHM(Date.parse(iso), TZ());
// The weather card's city: the profile's English label for the home city, otherwise the place the weather tool resolved, upper-cased.
const cityLabel = (city) => { const h = currentProfile().home || {}; return h.labelEn && (!city || city === h.city) ? h.labelEn : String(city || h.labelEn || '').toUpperCase(); };
const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const msg = (e) => cut(String(e?.message || e).replace(/^.*?：/, ''), 40);

export async function buildHudData({ now = Date.now() } = {}) {
  const out = { at: new Date(now).toISOString(), google: googleConfigured(), googleReauth: googleReauthRequired(), agentsAvailable: Object.fromEntries(Object.entries(AGENTS).map(([id, a]) => [id, !!pickProvider() && (!a.available || !!a.available())])), budgets: { geminiLiveMinutesPerDay: Number(env('GEMINI_LIVE_DAILY_MINUTES')) > 0 ? Number(env('GEMINI_LIVE_DAILY_MINUTES')) : 60 } };
  const today = jdate(now), t0 = startOfLocalDay(today, TZ());
  const jobs = [];

  jobs.push((async () => {
    try {
      const w = await TOOL_MAP.weather.run({ days: 1 });
      const city = String(w.place || '').split(' / ')[0];
      out.weather = { city: cityLabel(city), temp: Number.isFinite(w.now?.tempC) ? `${Math.round(w.now.tempC)}°` : '--°', condition: w.now?.condition || '' };
      if (w.note) out.weather.note = w.note;
    } catch (e) { out.weatherError = msg(e); }
  })());

  if (out.google) {
    jobs.push((async () => {
      try {
        const r = await TOOL_MAP.calendar_list_events.run({ timeMin: new Date(t0).toISOString(), timeMax: new Date(now + 7 * DAY).toISOString(), maxResults: 50 });
        const ev = (r.events || []).filter((e) => e.myResponse !== 'declined' && e.start).sort((a, b) => String(a.start).localeCompare(String(b.start)));
        const isAll = (e) => !String(e.start).includes('T');
        const todays = ev.filter((e) => (isAll(e) ? e.start === today : jdate(Date.parse(e.start)) === today));
        const rows = todays.slice(0, 5).map((e) => ({ time: isAll(e) ? '終日' : jhm(e.start), title: cut(e.summary, 22), sub: cut(e.location || '', 24), accent: !isAll(e) && Number(jhm(e.start).slice(0, 2)) >= 18 ? 'blue' : 'cyan' }));
        out.schedule = rows.length ? rows : [{ time: '--:--', title: '今日の予定はありません', sub: '', accent: 'cyan' }];
        const up = ev.find((e) => !isAll(e) && Date.parse(e.start) > now);
        if (up) { const d = jdate(Date.parse(up.start)); out.nextEvent = { title: cut(up.summary, 20), sub: cut(up.location || '', 22), time: jhm(up.start), when: d === today ? 'Today' : d === jdate(now + DAY) ? 'Tomorrow' : WD[localWeekday(Date.parse(up.start), TZ())] }; }
        else out.nextEvent = { title: '直近の予定なし', sub: '今後7日間', time: '--:--', when: '' };
      } catch (e) {
        out.schedule = [{ time: '--:--', title: '取得できませんでした', sub: msg(e), accent: 'cyan' }];
        out.nextEvent = { title: '取得できませんでした', sub: msg(e), time: '--:--', when: '' };
      }
    })());
    jobs.push((async () => {
      try {
        const r = await TOOL_MAP.tasks_list.run({ showCompleted: true, maxResults: 50 });
        const all = r.tasks || [], open = all.filter((t) => t.status !== 'completed'), doneToday = all.filter((t) => t.status === 'completed' && t.completed && jdate(Date.parse(t.completed)) === today).length;
        open.sort((a, b) => (a.due ? Date.parse(a.due) : 9e15) - (b.due ? Date.parse(b.due) : 9e15));
        out.tasks = open.length ? open.slice(0, 3).map((t) => ({ title: cut(t.title, 24), done: 0, total: 1, checked: false })) : [{ title: '未完了のタスクはありません', done: 1, total: 1, checked: true }];
        out.counts = { tasksDone: doneToday, tasksTotal: doneToday + open.length };
      } catch (e) { out.tasks = [{ title: '取得できませんでした', done: 0, total: 1, checked: false }]; out.tasksError = msg(e); }
    })());
  } else {
    out.schedule = [{ time: '--:--', title: 'Google未連携', sub: '設定すると予定が出ます', accent: 'cyan' }];
    out.nextEvent = { title: 'Google未連携', sub: '設定すると表示されます', time: '--:--', when: '' };
    out.tasks = [{ title: 'Google未連携', done: 0, total: 1, checked: false }];
    out.counts = { tasksDone: 0, tasksTotal: 0 };
  }
  await Promise.all(jobs);
  return out;
}
