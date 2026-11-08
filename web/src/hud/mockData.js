/**
 * PLACEHOLDER — not real data.
 *
 * Every value in this file is static mock content copied from the reference
 * design image so the HUD can be laid out and reviewed. None of it comes from
 * a calendar, task manager, agent runtime, OS sensor or weather service.
 * Replace these objects with real data sources in a later phase; the HUD
 * renders whatever shape is exported here (see renderPanels in template.js).
 */

// PLACEHOLDER — not real data. "TODAY" header block.
// arcs: bright tick(s) on the gold task ring ([startDeg, endDeg], clockwise from 12 o'clock).
export const today = {
  day: '06',
  weekday: 'Fri',
  month: 'Nov',
  tasksDone: 0,
  tasksTotal: 2,
  arcs: [[356, 4]],
};

// PLACEHOLDER — not real data. Schedule rows in the TODAY panel.
// accent: 'cyan' | 'blue' (colour of the second dot; both are amber in the ELVAR theme, 'blue' is the paler one)
export const schedule = [
  { time: '--:--', title: '今日の予定はありません', sub: '', accent: 'cyan' },
];

// PLACEHOLDER — not real data. TODAY'S TASKS rows.
export const tasks = [
  { title: '企画書の最終確認', done: 0, total: 1, checked: false },
  { title: '資料の下調べ', done: 0, total: 1, checked: false },
];

// PLACEHOLDER — not real data. NEXT EVENT card.
export const nextEvent = { title: '週次ミーティング', sub: '', time: '20:00', when: 'Wed' };

// PLACEHOLDER — not real data. Weather widget (bottom-left).
export const weather = { city: 'TOKYO', temp: '16°C', condition: '晴れ' };

// PLACEHOLDER — not real data. ACTIVE AGENTS rows.
// icon: key in icons.js
export const agents = [
  { icon: 'nodes', name: '記憶担当', status: '待機中' },
  { icon: 'mailFilled', name: 'メール担当', status: '待機中' },
  { icon: 'calendar', name: '予定・タスク担当', status: '待機中' },
  { icon: 'calendar', name: '資料作成担当', status: '待機中' },
  { icon: 'sparkle', name: '調査担当', status: '待機中' },
];

// PLACEHOLDER — not real data. RECENT ACTIVITY rows.
export const activity = [
  { icon: 'mic', title: '会話を開始', sub: '', ago: '3分前' },
  { icon: 'mic', title: '会話を開始', sub: '', ago: '7分前' },
  { icon: 'mic', title: '会話を開始', sub: '', ago: '8分前' },
  { icon: 'mic', title: '会話を開始', sub: '', ago: '9分前' },
];

// PLACEHOLDER — not real data. SYSTEM STATUS gauges.
// `arcs` are the decorative bright ring segments copied from the reference
// image ([startDeg, endDeg], clockwise from 12 o'clock). If omitted, a single
// arc of length pct*360 is drawn instead.
export const system = [
  { label: 'CPU', value: '12', unit: '%', pct: 0.12, arcs: [[318, 40]] },
  { label: 'AI', value: '4', unit: 'calls', pct: 0.04, arcs: [[340, 18]] },
  { label: 'STORAGE', value: '0', unit: '%', pct: 0 },
  { label: 'NETWORK', value: '553', unit: 'ms', pct: 0.4, arcs: [[24, 168]] },
];

// ---------------------------------------------------------------- phone layout
// PLACEHOLDER — not real data. Name shown on the phone's assistant card (bottom-right, over the status).
export const agentName = 'ELVAR';

// PLACEHOLDER — not real data. Round icon buttons in the phone's ACTIVE AGENTS card.
// icon: key in icons.js. The phone weather card reuses `weather` above.
export const phoneAgents = [
  { icon: 'mSearch', label: 'Research' },
  { icon: 'mCode', label: 'Code' },
  { icon: 'mMail', label: 'Email' },
  { icon: 'mHome', label: 'Smart Home' },
  { icon: 'mShield', label: 'Security' },
];
