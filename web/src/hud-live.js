// Connects the HUD cards to the finished systems: weather, Google calendar/tasks (via /api/hud/data), the sub-agents' real state, a real
// activity log of what E.L.V.A.R. did, and real device/usage gauges. Nothing here is invented: when a source is missing the card says so.
import { timeZone } from './brand.js';
import { localParts, localDate } from '../../shared/tz.js';
const ACT_KEY = 'elvar_activity';
const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NAMES = { memory: '記憶担当', mail: 'メール担当', schedule: '予定・タスク担当', document: '資料作成担当', research: '調査担当', project: 'プロジェクト担当', briefing: 'ブリーフィング準備', learning: '学習担当', security: 'セキュリティ担当', review: '振り返り担当' };
const ROW_ICON = { memory: 'nodes', mail: 'mailFilled', schedule: 'calendar', document: 'clipboard', research: 'sparkle', project: 'folder', briefing: 'sun', learning: 'user', security: 'shield', review: 'checkCircle' };
const PHONE_ORDER = ['research', 'document', 'mail', 'schedule', 'memory'];    // the phone's five round icons (design: search, code, mail, home, shield)
const WHAT = { memory: 'ノートの整理', mail: 'メールの仕分け', schedule: '予定の点検', document: '資料づくり', research: '調べもの', project: 'プロジェクトの点検', briefing: 'ブリーフィングの準備', learning: '好みの学習', security: '秘密の点検', review: '週次の振り返り' };
/** The panel has five rows: show the busy ones first, then the recently finished, then the rest in the usual order. */
export function pickRows(ids, state, now = Date.now()) { const rank = (id) => (state[id]?.busy ? 0 : state[id]?.doneAt && now - state[id].doneAt < 15 * 60e3 ? 1 : 2); return ids.map((id, i) => ({ id, i })).sort((a, b) => rank(a.id) - rank(b.id) || a.i - b.i).slice(0, 5).map((x) => x.id); }

/** The task ring: bright arc = share of today's tasks done. */
export const ringArcs = (done, total) => [[0, Math.min(358, Math.max(2, total > 0 ? (done / total) * 360 : 0))]];
export function todayParts(nowMs = Date.now()) { const d = localParts(nowMs, timeZone()); return { day: String(d.day).padStart(2, '0'), weekday: WD_EN[d.weekday], month: MON_EN[d.month - 1] }; }
export function agoText(ms, now = Date.now()) { const m = Math.max(0, Math.round((now - ms) / 60000)); return m < 1 ? '今' : m < 60 ? `${m}分前` : m < 1440 ? `${Math.floor(m / 60)}時間前` : `${Math.floor(m / 1440)}日前`; }

/** What the cards show before the first real data arrives: honest "loading", not sample content. */
export function neutralData() {
  return {
    today: { ...todayParts(), tasksDone: 0, tasksTotal: 0, arcs: ringArcs(0, 0) },
    schedule: [{ time: '--:--', title: '読み込み中…', sub: '', accent: 'cyan' }],
    tasks: [{ title: '読み込み中…', done: 0, total: 1, checked: false }],
    nextEvent: { title: '読み込み中…', sub: '', time: '--:--', when: '' },
    weather: { city: '--', temp: '--°', condition: '' },
    agents: pickRows(Object.keys(NAMES), {}).map((id) => ({ icon: ROW_ICON[id], name: NAMES[id], status: '待機中' })),
    activity: [{ icon: 'gear', title: '起動しました', sub: 'E.L.V.A.R.', ago: '今' }],
    system: [{ label: 'LIVE', value: '0', unit: '%', pct: 0 }, { label: 'API', value: '0', unit: 'calls', pct: 0 }, { label: 'STORAGE', value: '--', unit: '%', pct: 0 }, { label: 'NETWORK', value: '--', unit: 'ms', pct: 0 }],
    agentName: 'ELVAR',
    phoneAgents: PHONE_ORDER.map((id) => ({ icon: { research: 'mSearch', document: 'mCode', mail: 'mMail', schedule: 'mHome', memory: 'mShield' }[id], label: NAMES[id] })),
  };
}

export function initHudLive({ hud, live, authHeaders, usage }) {
  const readAct = () => { try { const j = JSON.parse(localStorage.getItem(ACT_KEY) || '[]'); return Array.isArray(j) ? j : []; } catch { return []; } };
  const writeAct = (a) => { try { localStorage.setItem(ACT_KEY, JSON.stringify(a.slice(0, 30))); } catch {} };
  const agentState = {};            // id -> { busy, doneAt, ok }
  let server = null, rtt = null;

  const renderActivity = () => {
    const rows = readAct().slice(0, 4).map((a) => ({ icon: a.icon || 'gear', title: a.title, sub: a.sub || '', ago: agoText(a.at) }));
    hud.setData({ activity: rows.length ? rows : [{ icon: 'gear', title: 'まだ活動はありません', sub: '', ago: '' }] });
  };
  const renderAgents = () => {
    const avail = server?.agentsAvailable || {}, now = Date.now();
    const status = (id) => agentState[id]?.busy ? '作業中…' : avail[id] === false ? '未設定' : agentState[id]?.doneAt && now - agentState[id].doneAt < 15 * 60e3 ? (agentState[id].ok ? '完了' : '失敗') : '待機中';
    hud.setData({
      agents: pickRows(Object.keys(NAMES), agentState, now).map((id) => ({ icon: ROW_ICON[id], name: NAMES[id], status: status(id), busy: !!agentState[id]?.busy })),
      phoneAgents: PHONE_ORDER.map((id) => ({ icon: { research: 'mSearch', document: 'mCode', mail: 'mMail', schedule: 'mHome', memory: 'mShield' }[id], label: `${NAMES[id]}（${status(id)}）`, busy: !!agentState[id]?.busy })),
    });
  };
  const renderSystem = async () => {
    const day = localDate(Date.now(), timeZone()), u = usage.raw().days?.[day] || { liveSeconds: 0, tools: {} };
    const budget = server?.budgets?.geminiLiveMinutesPerDay || 60, livePct = Math.min(100, Math.round(u.liveSeconds / 60 / budget * 100));
    const calls = Object.values(u.tools || {}).reduce((a, c) => a + c, 0);
    let st = null; try { const e = await navigator.storage?.estimate?.(); if (e?.quota) st = Math.min(100, Math.round(e.usage / e.quota * 100)); } catch {}
    hud.setData({ system: [
      { label: 'LIVE', value: String(livePct), unit: '%', pct: livePct / 100 },
      { label: 'API', value: String(calls), unit: 'calls', pct: Math.min(1, calls / 100) },
      { label: 'STORAGE', value: st == null ? '--' : String(st), unit: '%', pct: (st || 0) / 100 },
      { label: 'NETWORK', value: rtt == null ? '--' : String(rtt), unit: 'ms', pct: rtt == null ? 0 : Math.max(0.03, 1 - Math.min(rtt, 1000) / 1000) },
    ] });
  };
  async function refresh() {
    try {
      const t = performance.now();
      const r = await fetch('/api/hud/data', { headers: authHeaders(), cache: 'no-store' });
      rtt = Math.round(performance.now() - t);
      if (!r.ok) throw new Error(String(r.status));
      server = await r.json();
      const counts = server.counts || { tasksDone: 0, tasksTotal: 0 };
      const patch = { today: { ...todayParts(), ...counts, arcs: ringArcs(counts.tasksDone, counts.tasksTotal) } };
      for (const k of ['weather', 'schedule', 'tasks', 'nextEvent']) if (server[k]) patch[k] = server[k];
      hud.setData(patch); renderAgents();
    } catch (e) { console.warn('[hud-live] refresh failed', e?.message ?? e); }
    renderSystem();
  }

  /** Public: record something E.L.V.A.R. really did (shown in RECENT ACTIVITY). */
  const logActivity = ({ icon = 'gear', title, sub = '' } = {}) => { if (!title) return; writeAct([{ icon, title, sub, at: Date.now() }, ...readAct()]); renderActivity(); };
  const agentStart = (id) => { agentState[id] = { busy: true }; renderAgents(); logActivity({ icon: 'nodes', title: `${NAMES[id] || id}に依頼`, sub: WHAT[id] || '' }); };
  const agentEnd = (id, ok, detail = '') => { agentState[id] = { busy: false, doneAt: Date.now(), ok }; renderAgents(); logActivity({ icon: ok ? 'checkCircle' : 'gear', title: `${NAMES[id] || id}が${ok ? '完了' : '失敗'}`, sub: String(detail).slice(0, 40) }); };

  renderActivity(); renderAgents(); renderSystem();
  refresh();
  setInterval(refresh, 10 * 60e3);                                   // weather / calendar / tasks
  setInterval(() => { renderActivity(); renderAgents(); }, 60e3);   // "N分前" and the 15-minute "完了" fade
  setInterval(renderSystem, 20e3);
  setInterval(() => { const c = server?.counts || { tasksDone: 0, tasksTotal: 0 }; hud.setData({ today: { ...todayParts(), ...c, arcs: ringArcs(c.tasksDone, c.tasksTotal) } }); }, 5 * 60e3);   // the date rolls over at midnight
  live.onSessionOpen = () => logActivity({ icon: 'mic', title: '会話を開始', sub: '' });
  return { refresh, logActivity, agentStart, agentEnd, renderAgents, getServer: () => server };
}
