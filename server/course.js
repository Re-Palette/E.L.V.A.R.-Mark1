// 履修登録サポート (university course-registration support) in the second brain (private repo):
//   履修/設定.md        period times (1限 9:00–10:30 …) and the teaching period of each term (used by the シフト link)
//   履修/卒業要件.md    credits needed to graduate, per category, per-term cap (CAP), the 必修科目 list
//   履修/YYYY-前期|後期.md   the courses of a term (YYYY = 年度)
// All arithmetic (credits, conflicts, checks, suggestions) is plain code. The app cannot see the university's registration site, the syllabus or the
// course catalogue: the data is only what the owner tells / types in, and nothing is registered anywhere by this module.
import crypto from 'node:crypto';
import { brainReadRaw, brainWrite, brainRepoIsPrivate, brainConfigured, brainList } from './brain.js';
import { U, TZ } from './profile/index.js';
import { localDate, isoAt, tzLabel } from '../shared/tz.js';

const DAY = 864e5;
const tzDate = (ms) => localDate(ms, TZ());
const cell = (s) => String(s ?? '').replace(/\|/g, '／').replace(/\s+/g, ' ').trim();
const norm = (s) => cell(s).toLowerCase().replace(/[\s　・\-_（）()「」『』]/g, '');
const num = (v) => { if (v == null || String(v).trim() === '') return NaN; const n = Number(String(v ?? '').replace(/[,，単位\s]/g, '')); return Number.isFinite(n) ? n : NaN; };
const daysIn = (month) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const WD = ['日', '月', '火', '水', '木', '金', '土'];
export const DAYS = ['月', '火', '水', '木', '金', '土'];
export const STATUSES = ['候補', '履修', '抽選待ち', '取消', '修得済み'];
export const KINDS = ['集中', 'オンデマンド'];
const MAXP = 9;
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };

export const DEFAULT_PERIODS = { 1: ['09:00', '10:30'], 2: ['10:40', '12:10'], 3: ['13:00', '14:30'], 4: ['14:40', '16:10'], 5: ['16:20', '17:50'], 6: ['18:00', '19:30'], 7: ['19:40', '21:10'] };
export const DEFAULT_RANGES = { 前期: { from: '04-01', to: '07-31' }, 後期: { from: '10-01', to: '01-31' } };

// ---------------------------------------------------------------- terms (pure)
export const fiscalYear = (nowMs = Date.now()) => { const d = tzDate(nowMs), y = Number(d.slice(0, 4)); return Number(d.slice(5, 7)) >= 4 ? y : y - 1; };
/** The term that is "now" (4–9月 = 前期, 10月〜翌3月 = 後期; YYYY is the 年度). */
export const currentTerm = (nowMs = Date.now()) => { const m = Number(tzDate(nowMs).slice(5, 7)); return `${fiscalYear(nowMs)}-${m >= 4 && m <= 9 ? '前期' : '後期'}`; };
export const termLabel = (t) => `${t.slice(0, 4)}年度 ${t.slice(5)}`;
export const validTerm = (t) => /^\d{4}-(前期|後期)$/.test(String(t || ''));
export const shiftTerm = (t, d) => { let y = Number(t.slice(0, 4)), h = t.slice(5) === '前期' ? 0 : 1, i = y * 2 + h + d; return `${Math.floor(i / 2)}-${i % 2 ? '後期' : '前期'}`; };
/** "2026前期" "2026-後期" "後期" "秋学期" "今学期" "来学期" → 'YYYY-前期|後期' or null */
export function parseTerm(w, nowMs = Date.now()) {
  const t = String(w ?? '').trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)); if (!t) return null;
  const cur = currentTerm(nowMs);
  if (/^(今学期|今期|今)$/.test(t)) return cur; if (/^(来学期|来期|次の学期|次学期)$/.test(t)) return shiftTerm(cur, 1); if (/^(前学期|先学期|前の学期)$/.test(t)) return shiftTerm(cur, -1);
  const h = /(前期|春学期|春)/.test(t) ? '前期' : /(後期|秋学期|秋)/.test(t) ? '後期' : null; if (!h) return null;
  const y = t.match(/(\d{4})/)?.[1]; return `${y || fiscalYear(nowMs)}-${h}`;
}
/** Which term a date falls into, from the teaching periods in 設定 (null in vacations). */
export function termForDate(date, ranges = DEFAULT_RANGES) {
  const y = Number(date.slice(0, 4)), md = date.slice(5);
  for (const h of ['前期', '後期']) {
    const { from, to } = ranges[h] || DEFAULT_RANGES[h];
    if (from <= to) { if (md >= from && md <= to) return `${y}-${h}`; }
    else { if (md >= from) return `${y}-${h}`; if (md <= to) return `${y - 1}-${h}`; }
  }
  return null;
}

// ---------------------------------------------------------------- slot words (pure)
const half = (s) => String(s ?? '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[－―—–−]/g, '-').replace(/[〜～]/g, '~');
const SLOT_RE = /([月火水木金土])\s*(?:曜日|曜)?\s*(?:の)?\s*(午前|午後|\d+\s*(?:限|時限)?(?:\s*(?:[-~ー・,、]|と|から)\s*\d+\s*(?:限|時限)?)*)?/g;
const WINDOWS = { 午前: [1, 2], 午後: [3, 4, 5] };
/**
 * "月曜3限" "火2・3" "木3-4" "水曜の午後" "月3/木3" "集中" "オンデマンド" → { slots: [{day, periods:[..], window?}], kind: ''|'集中'|'オンデマンド' }
 * A day without a period gives periods: [] (a "day only" word); 午前/午後 give the periods of that half of the day plus window (a time window, not a class slot).
 */
export function parseSlots(word) {
  const t = half(word), slots = []; let kind = '';
  if (/集中/.test(t)) kind = '集中'; else if (/オンデマンド|オンライン|ネット授業|動画/.test(t)) kind = 'オンデマンド';
  for (const m of t.matchAll(SLOT_RE)) {
    const day = m[1], g = m[2];
    if (!g) { slots.push({ day, periods: [] }); continue; }
    if (WINDOWS[g]) { slots.push({ day, periods: [...WINDOWS[g]], window: g }); continue; }
    const set = new Set(); let last = null, range = false;
    for (const tok of g.match(/\d+|[-~ー]|から/g) || []) {
      if (/\d/.test(tok)) { const n = Number(tok); if (range && last != null) { for (let k = Math.min(last, n); k <= Math.max(last, n); k++) set.add(k); } else set.add(n); last = n; range = false; }
      else range = true;
    }
    slots.push({ day, periods: [...set].sort((a, b) => a - b) });
  }
  return { slots, kind };
}
/** The first concrete slot of a phrase ({day, periods}) or null. */
export const parseSlot = (word) => parseSlots(word).slots.find((s) => s.periods.length) || null;
const periodsText = (ps) => { const a = [...ps].sort((x, y) => x - y); if (a.length < 2) return a.join(''); const run = a.every((v, i) => i === 0 || v === a[i - 1] + 1); return run ? `${a[0]}-${a[a.length - 1]}` : a.join('・'); };
export const slotsText = (slots, kind = '') => (slots?.length ? slots.map((s) => `${s.day}${periodsText(s.periods)}`).join('/') : kind || '');
const timeLabel = (slots, periods) => slots.map((s) => { const a = periods[s.periods[0]], b = periods[s.periods[s.periods.length - 1]]; return `${s.day}${periodsText(s.periods)}${a && b ? ` ${a[0]}–${b[1]}` : ''}`; }).join('、');

// ---------------------------------------------------------------- file formats
const COURSE_HEAD = '| id | 科目 | 時間割 | 単位 | 区分 | 状態 | 必修 | 教員 | 教室 | 成績 | 備考 |\n|---|---|---|---|---|---|---|---|---|---|---|';
export function parseCourses(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const c = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => x.trim());
    if (!/^[0-9a-f]{6}$/.test(c[0]) || c.length < 6) continue;
    const { slots, kind } = parseSlots(c[2]);
    out.push({ id: c[0], name: c[1], slots: slots.filter((s) => s.periods.length), kind, credits: Number(c[3]) || 0, category: c[4] || '', status: STATUSES.includes(c[5]) ? c[5] : '候補', required: /^(○|◯|はい|true|必修)$/.test(c[6] || ''), instructor: c[7] || '', room: c[8] || '', grade: c[9] || '', memo: c[10] || '' });
  }
  return out;
}
const rowOf = (c) => `| ${c.id} | ${cell(c.name)} | ${slotsText(c.slots, c.kind)} | ${c.credits} | ${cell(c.category)} | ${c.status} | ${c.required ? '○' : ''} | ${cell(c.instructor)} | ${cell(c.room)} | ${cell(c.grade)} | ${cell(c.memo)} |`;
const termFileHead = (term) => `# 履修 ${termLabel(term)}\n\n${U()}が教えた（入力した）科目の記録です。大学の履修登録システムとは連動していません。時間割は「月3」（月曜3限）、「火2-3」（火曜2〜3限）、「月3/木3」（週2回）、「集中」「オンデマンド」の形です。状態は 候補・履修・抽選待ち・取消・修得済み。\n\n${COURSE_HEAD}\n`;
const termPath = (t) => `履修/${t}.md`;

export function parseSettings(text) {
  const periods = {}, ranges = {};
  for (const m of String(text || '').matchAll(/^\s*[-*]\s*(\d)限\s*[：:]\s*(\d{1,2}:\d{2})\s*[-~〜ー－–]\s*(\d{1,2}:\d{2})/gm)) periods[Number(m[1])] = [hhmm(toMin(m[2])), hhmm(toMin(m[3]))];
  for (const m of String(text || '').matchAll(/^\s*[-*]\s*(前期|後期)の授業期間\s*[：:]\s*(\d{1,2})[-/](\d{1,2})\s*[-~〜ー－–]\s*(\d{1,2})[-/](\d{1,2})/gm)) { const p = (a, b) => `${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`; ranges[m[1]] = { from: p(m[2], m[3]), to: p(m[4], m[5]) }; }
  return { periods: { ...DEFAULT_PERIODS, ...periods }, ranges: { ...DEFAULT_RANGES, ...ranges }, custom: { periods: Object.keys(periods).length > 0, ranges: Object.keys(ranges).length > 0 } };
}
const serializeSettings = (s) => `# 履修の設定\n\n大学ごとの時限の時刻（${tzLabel(TZ())}）と、学期の授業期間です。変更したいときは、話しかけるか、画面から直せます。授業期間は、シフトの提案で「授業の時間」を避けるときに使います（長期休暇や休講は見ていません）。\n\n${Object.entries(s.periods).sort(([a], [b]) => a - b).map(([n, [a, b]]) => `- ${n}限：${a}-${b}`).join('\n')}\n${['前期', '後期'].map((h) => `- ${h}の授業期間：${s.ranges[h].from}〜${s.ranges[h].to}`).join('\n')}\n`;

export function parseRequirements(text) {
  const r = { total: null, cap: null, capByTerm: {}, categories: {}, required: [] }, t = String(text || '');
  let m = t.match(/^\s*[-*]\s*卒業単位\s*[：:]\s*(\d+(?:\.\d+)?)/m); if (m) r.total = Number(m[1]);
  m = t.match(/^\s*[-*]\s*学期の履修上限\s*[：:]\s*(\d+(?:\.\d+)?)/m); if (m) r.cap = Number(m[1]);
  for (const x of t.matchAll(/^\s*[-*]\s*学期の履修上限\s+(\d{4}-(?:前期|後期))\s*[：:]\s*(\d+(?:\.\d+)?)/gm)) r.capByTerm[x[1]] = Number(x[2]);
  for (const x of t.matchAll(/^\s*[-*]\s*区分\s+(\S+?)\s*[：:]\s*(\d+(?:\.\d+)?)/gm)) r.categories[x[1]] = Number(x[2]);
  m = t.match(/^\s*[-*]\s*必修科目\s*[：:]\s*(.+)$/m); if (m) r.required = m[1].split(/[、,，\/／]/).map((x) => x.trim()).filter(Boolean);
  return r;
}
const serializeRequirements = (r) => `# 卒業要件と履修の上限\n\n${U()}が教えた（入力した）数字です。大学の学則とは照合していません。単位は数字、必修科目は「、」区切りです。\n\n${[r.total != null ? `- 卒業単位：${r.total}` : '', r.cap != null ? `- 学期の履修上限：${r.cap}` : '', ...Object.entries(r.capByTerm).sort().map(([t, v]) => `- 学期の履修上限 ${t}：${v}`), ...Object.entries(r.categories).map(([k, v]) => `- 区分 ${k}：${v}`), r.required.length ? `- 必修科目：${r.required.join('、')}` : ''].filter(Boolean).join('\n')}\n`;
export const capFor = (r, term) => r.capByTerm?.[term] ?? r.cap ?? null;

// ---------------------------------------------------------------- normalizing (pure)
export function normalizeStatus(w) {
  const t = cell(w); if (!t) return null; if (STATUSES.includes(t)) return t;
  if (/修得|取得済|合格|単位を?取った|終わった/.test(t)) return '修得済み'; if (/抽選/.test(t)) return '抽選待ち';
  if (/取消|取り消|キャンセル|やめ|辞退|落と/.test(t)) return '取消'; if (/履修|登録|取る|取ります|受ける/.test(t)) return '履修'; if (/候補|検討|気になる|迷/.test(t)) return '候補';
  return null;
}
/** Maps a spoken category ("教養科目") onto a known requirement category (exact, else the longest known name it contains: 選択必修科目 → 選択必修). */
export function matchCategory(w, known = []) {
  const c = cell(w); if (!c) return ''; const k = known.find((x) => norm(x) === norm(c)); if (k) return k;
  const inc = known.filter((x) => norm(c).includes(norm(x))).sort((a, b) => b.length - a.length); return inc[0] || c;
}
const asBool = (v) => v === true || /^(true|○|◯|はい|必修|yes|1)$/i.test(String(v ?? '').trim());
/** One course from loose voice-model input. Throws a plain Japanese message when something is missing (nothing is guessed). */
export function normalizeCourse(raw, { categories = [] } = {}) {
  const name = cell(raw?.name ?? raw?.科目 ?? raw?.title).slice(0, 60); if (!name) throw new Error('科目の名前が分かりません');
  let word = raw?.slot ?? raw?.slots ?? raw?.時間割 ?? raw?.time ?? '';
  if (Array.isArray(word)) word = word.map((s) => (typeof s === 'string' ? s : `${s.day ?? ''}${Array.isArray(s.periods) ? periodsText(s.periods) : (s.period ?? '')}`)).join('/');
  if (!cell(word)) { const d = cell(raw?.day ?? raw?.曜日), p = raw?.periods ?? raw?.period ?? raw?.時限 ?? ''; word = KINDS.includes(d) ? d : `${d}${Array.isArray(p) ? periodsText(p.map(Number)) : p}`; }
  if (raw?.kind && KINDS.includes(raw.kind) && !cell(word)) word = raw.kind;
  const { slots: all, kind } = parseSlots(word);
  if (all.some((s) => s.window)) throw new Error('「午前・午後」では何限か分かりません（何限かを教えてください。例：水曜3限）');
  if (all.some((s) => !s.periods.length)) throw new Error('曜日は分かりましたが、何限か分かりません（例：月曜3限）');
  const slots = all.filter((s) => s.periods.length);
  for (const s of slots) { if (!DAYS.includes(s.day)) throw new Error('曜日は 月〜土 で教えてください'); if (s.periods.some((p) => p < 1 || p > MAXP)) throw new Error(`時限は 1〜${MAXP} で教えてください`); }
  if (!slots.length && !kind) throw new Error('曜日と時限が分かりません（例：月曜3限。集中講義・オンデマンドならそう教えてください）');
  const cr = num(raw?.credits ?? raw?.credit ?? raw?.単位); if (!Number.isFinite(cr) || cr < 0 || cr > 20) throw new Error('単位数が分かりません（例：2単位）');
  const category = matchCategory(raw?.category ?? raw?.区分 ?? '', categories).slice(0, 20);
  const stRaw = raw?.status ?? raw?.状態, status = stRaw == null || stRaw === '' ? '候補' : normalizeStatus(stRaw);
  if (!status) throw new Error(`状態は ${STATUSES.join('・')} のどれかです`);
  const required = raw?.required != null && raw.required !== '' ? asBool(raw.required) : category === '必修';
  return { name, slots, kind: slots.length ? '' : kind, credits: cr, category, status, required, instructor: cell(raw?.instructor ?? raw?.教員).slice(0, 30), room: cell(raw?.room ?? raw?.教室).slice(0, 20), grade: cell(raw?.grade ?? raw?.成績).slice(0, 8), memo: cell(raw?.memo ?? raw?.note ?? raw?.備考).slice(0, 80) };
}
const courseToRaw = (c) => ({ name: c.name, slot: slotsText(c.slots, c.kind), credits: c.credits, category: c.category, status: c.status, required: c.required, instructor: c.instructor, room: c.room, grade: c.grade, memo: c.memo });

// ---------------------------------------------------------------- analysis (pure)
const ACTIVE = ['履修', '候補', '抽選待ち'];
const sharedPeriods = (a, b) => { const out = []; for (const x of a.slots) for (const y of b.slots) if (x.day === y.day) { const p = x.periods.filter((n) => y.periods.includes(n)); if (p.length) out.push({ day: x.day, periods: p }); } return out; };
/** Overlaps in the same term. level: registered (履修 × 履修: cannot be), candidate (履修 × 候補・抽選待ち), alternative (候補・抽選待ち同士: choose one). */
export function findConflicts(courses) {
  const act = courses.filter((c) => ACTIVE.includes(c.status) && c.slots?.length), out = [];
  for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
    const a = act[i], b = act[j], sh = sharedPeriods(a, b); if (!sh.length) continue;
    const level = a.status === '履修' && b.status === '履修' ? 'registered' : a.status === '履修' || b.status === '履修' ? 'candidate' : 'alternative';
    out.push({ a: a.id, b: b.id, aName: a.name, bName: b.name, aStatus: a.status, bStatus: b.status, day: sh[0].day, periods: sh[0].periods, level, text: `${sh[0].day}曜${periodsText(sh[0].periods)}限が重なる：${a.name}（${a.status}）と ${b.name}（${b.status}）` });
  }
  return out;
}
const sum = (arr, f) => arr.reduce((x, c) => x + f(c), 0);
const r1 = (n) => Math.round(n * 10) / 10;
/** Credit totals of one term and (all terms) against the graduation requirements. */
export function creditTotals({ term, byTerm = {}, req }) {
  const mine = byTerm[term] || [], by = (st, list = mine) => sum(list.filter((c) => c.status === st), (c) => c.credits);
  const cap = capFor(req, term), registered = by('履修'), lottery = by('抽選待ち'), candidate = by('候補');
  const all = Object.values(byTerm).flat(), earned = by('修得済み', all), regAll = by('履修', all);
  const names = Object.keys(req.categories), seen = [...new Set(all.filter((c) => c.status === '履修' || c.status === '修得済み').map((c) => c.category).filter(Boolean))].filter((c) => !names.includes(c));
  const cats = [...names, ...seen].map((name) => {
    const required = req.categories[name] ?? null, list = all.filter((c) => c.category === name), e = by('修得済み', list), g = by('履修', list), thisTerm = by('履修', mine.filter((c) => c.category === name));
    return { name, required, earned: r1(e), registered: r1(g), thisTerm: r1(thisTerm), remaining: required == null ? null : r1(Math.max(0, required - e - g)), short: required != null && e + g < required };
  });
  const uncat = by('履修', mine.filter((c) => !c.category));
  return { term, cap, registered: r1(registered), lottery: r1(lottery), candidate: r1(candidate), over: cap != null && registered > cap, capLeft: cap != null ? r1(cap - registered) : null, uncategorizedThisTerm: r1(uncat),
    total: { required: req.total, earned: r1(earned), registered: r1(regAll), remaining: req.total != null ? r1(Math.max(0, req.total - earned - regAll)) : null }, categories: cats };
}

const dayLoad = (courses) => { const m = {}; for (const c of courses.filter((x) => x.status === '履修')) for (const s of c.slots) { const set = (m[s.day] ||= new Set()); for (const p of s.periods) set.add(p); } return m; };
const runs = (ps) => { const a = [...ps].sort((x, y) => x - y), out = []; let cur = []; for (const p of a) { if (cur.length && p === cur[cur.length - 1] + 1) cur.push(p); else { if (cur.length) out.push(cur); cur = [p]; } } if (cur.length) out.push(cur); return out; };

/** Observations about a term: conflicts, CAP, missing required courses, categories still short, overloaded days, 1限, free days, gaps. Plain code. */
export function checkTerm({ term, byTerm = {}, req }) {
  const courses = byTerm[term] || [], all = Object.values(byTerm).flat(), out = [], push = (level, code, text) => out.push({ level, code, text });
  const conflicts = findConflicts(courses);
  for (const c of conflicts) push(c.level === 'registered' ? 'bad' : c.level === 'candidate' ? 'warn' : 'info', 'conflict-' + c.level, c.level === 'alternative' ? `${c.text}（どちらか一方）` : c.text);
  const tot = creditTotals({ term, byTerm, req });
  if (tot.cap != null) {
    if (tot.over) push('bad', 'cap', `履修が上限（${tot.cap}単位）を ${r1(tot.registered - tot.cap)}単位 超えています（${tot.registered}単位）`);
    else if (tot.registered + tot.lottery > tot.cap) push('warn', 'cap-lottery', `抽選待ちが全部当たると上限（${tot.cap}単位）を ${r1(tot.registered + tot.lottery - tot.cap)}単位 超えます`);
    else if (tot.capLeft === 0) push('info', 'cap-full', `履修が上限（${tot.cap}単位）ちょうどです`);
  } else if (tot.registered > 0) push('info', 'cap-unset', '学期の履修上限（CAP）が未設定です。分かれば教えてください');
  const reqNames = new Map(); for (const n of req.required) reqNames.set(norm(n), n); for (const c of courses) if (c.required) reqNames.set(norm(c.name), c.name);
  for (const [k, n] of reqNames) {
    const hit = all.filter((c) => norm(c.name) === k), best = ['修得済み', '履修'].find((s) => hit.some((c) => c.status === s));
    if (best) continue;
    const st = ['抽選待ち', '候補', '取消'].find((s) => hit.some((c) => c.status === s));
    push('warn', 'required', `必修科目「${n}」は${st ? (st === '取消' ? '取消になっています' : `まだ${st}です`) : '記録にありません（まだ入力されていません）'}`);
  }
  const short = tot.categories.filter((c) => c.short);
  if (short.length) push('info', 'category-short', `単位が足りない区分：${short.map((c) => `${c.name} あと${c.remaining}`).join('、')}`);
  if (tot.total.remaining != null && tot.total.remaining > 0) push('info', 'total-remaining', `卒業まで あと ${tot.total.remaining}単位（修得済み${tot.total.earned}＋履修${tot.total.registered}／${tot.total.required}）`);
  const load = dayLoad(courses);
  for (const d of DAYS) { const ps = load[d]; if (!ps) continue; const longest = Math.max(...runs(ps).map((r) => r.length)); if (ps.size >= 5) push('warn', 'heavy-day', `${d}曜は${ps.size}コマあります`); else if (longest >= 4) push('warn', 'heavy-run', `${d}曜は${longest}コマ連続です`); }
  const used = DAYS.filter((d) => load[d]), free = DAYS.filter((d) => !load[d] && d !== '土');
  if (used.length) {
    const first = used.filter((d) => load[d].has(1)), noFirst = used.filter((d) => !load[d].has(1));
    if (first.length) push('info', 'first-period', `1限がある日：${first.join('・')}`); if (noFirst.length && first.length) push('info', 'no-first', `1限がない日：${noFirst.join('・')}`);
    if (free.length) push('info', 'free-days', `授業がない日：${free.join('・')}`);
    const gaps = used.flatMap((d) => { const a = [...load[d]].sort((x, y) => x - y), g = []; for (let i = 1; i < a.length; i++) for (let p = a[i - 1] + 1; p < a[i]; p++) g.push(p); return g.length ? [`${d}${g.join('・')}限`] : []; });
    if (gaps.length) push('info', 'gaps', `空きコマ：${gaps.join('、')}`);
  }
  const lot = courses.filter((c) => c.status === '抽選待ち'); if (lot.length) push('info', 'lottery', `抽選待ち ${lot.length}科目（${lot.slice(0, 3).map((c) => c.name).join('、')}${lot.length > 3 ? ' ほか' : ''}）。結果が出たら状態を直してください`);
  if (!courses.length) push('info', 'empty', 'この学期の科目はまだありません');
  const order = { bad: 0, warn: 1, info: 2 }; return out.map((x, i) => [x, i]).sort((a, b) => order[a[0].level] - order[b[0].level] || a[1] - b[1]).map((x) => x[0]);
}

/** The weekly grid: { days, periods:[{n,start,end}], cells: { '月3': [{id,name,status,category,conflict,first}] } } (conflict: registered|candidate|alternative|null). */
export function buildGrid(courses, settings = parseSettings('')) {
  const conf = findConflicts(courses), flag = new Map(); const rank = { registered: 3, candidate: 2, alternative: 1 };
  for (const c of conf) for (const id of [c.a, c.b]) if ((rank[c.level] || 0) > (rank[flag.get(id)] || 0)) flag.set(id, c.level);
  const used = courses.filter((c) => c.status !== '取消').flatMap((c) => c.slots.flatMap((s) => s.periods)), maxP = Math.max(Math.max(...Object.keys(settings.periods).map(Number)), ...used, 5);
  const periods = Array.from({ length: maxP }, (_, i) => ({ n: i + 1, start: settings.periods[i + 1]?.[0] || '', end: settings.periods[i + 1]?.[1] || '' }));
  const cells = {};
  for (const c of courses.filter((x) => x.status !== '取消')) for (const s of c.slots) for (const p of s.periods) (cells[`${s.day}${p}`] ||= []).push({ id: c.id, name: c.name, status: c.status, category: c.category, credits: c.credits, required: c.required, conflict: flag.get(c.id) || null, first: p === s.periods[0] });
  return { days: DAYS, periods, cells, offGrid: courses.filter((c) => !c.slots.length && c.status !== '取消').map((c) => ({ id: c.id, name: c.name, status: c.status, kind: c.kind, category: c.category })) };
}

/** One term for the screen / the model: courses with times, grid, credits, checks. Pure (tested). */
export function summarizeTerm({ term, byTerm = {}, req = parseRequirements(''), settings = parseSettings('') }) {
  const courses = (byTerm[term] || []).map((c) => ({ ...c, term, slotsText: slotsText(c.slots, c.kind), time: timeLabel(c.slots, settings.periods) })), sortKey = (c) => (c.slots[0] ? DAYS.indexOf(c.slots[0].day) * 10 + c.slots[0].periods[0] : 99);
  courses.sort((a, b) => sortKey(a) - sortKey(b) || a.name.localeCompare(b.name));
  const conflicts = findConflicts(courses), credits = creditTotals({ term, byTerm: { ...byTerm, [term]: byTerm[term] || [] }, req });
  return { term, label: termLabel(term), count: courses.length, empty: !courses.length, courses, grid: buildGrid(courses, settings), conflicts, credits, checks: checkTerm({ term, byTerm, req }), requirements: { total: req.total, cap: credits.cap, categories: req.categories, required: req.required }, periods: settings.periods,
    note: '大学の履修登録システム・シラバス・開講科目の一覧は、このアプリからは見えません。ここにあるのは、' + U() + 'が教えた（入力した）内容だけです。単位や上限の判定も、入力された数字をもとにした目安です。' };
}

/** Proposes which 候補 to take: required first, then the categories that are still short, without time conflicts or going over the CAP, preferring days already on campus. Pure (tested).
 *  prefs: { avoid1限, freeDays:[曜日], maxPerDay } — preferences never override a required course (it is proposed with a note). */
export function suggestCourses({ term, byTerm = {}, req = parseRequirements(''), prefs = {} }) {
  const mine = byTerm[term] || [], tot = creditTotals({ term, byTerm, req }), cap = tot.cap;
  const registered = mine.filter((c) => c.status === '履修'), pool = mine.filter((c) => c.status === '候補' && c.slots.length), offGrid = mine.filter((c) => c.status === '候補' && !c.slots.length);
  const reqNames = new Set(req.required.map(norm)), isReq = (c) => c.required || reqNames.has(norm(c.name));
  const free = new Set((prefs.freeDays || []).map(String)), maxPerDay = prefs.maxPerDay > 0 ? Number(prefs.maxPerDay) : null;
  const remaining = Object.fromEntries(tot.categories.filter((c) => c.required != null).map((c) => [c.name, c.remaining]));
  const chosen = [], notes = [], why = new Map(); let credits = tot.registered;
  const load = () => dayLoad([...registered, ...chosen].map((c) => ({ ...c, status: '履修' })));
  const days = () => new Set(Object.keys(load()));
  const feasible = (c) => {
    const clash = [...registered, ...chosen].find((x) => sharedPeriods(c, x).length); if (clash) return `${clash.name}と時間が重なる`;
    if (cap != null && credits + c.credits > cap) return `上限（${cap}単位）を超える`;
    const ld = load(); if (maxPerDay) for (const s of c.slots) if ((ld[s.day]?.size || 0) + s.periods.length > maxPerDay) return `${s.day}曜が1日${maxPerDay}コマを超える`;
    return null;
  };
  const wishNote = (c) => { const n = []; if (prefs.avoid1限 && c.slots.some((s) => s.periods.includes(1))) n.push('1限（避けたい希望より必修を優先）'); const fd = c.slots.filter((s) => free.has(s.day)).map((s) => s.day); if (fd.length) n.push(`${fd[0]}曜（空けたい希望より必修を優先）`); return n; };
  const wishBlock = (c) => { if (prefs.avoid1限 && c.slots.some((s) => s.periods.includes(1))) return '1限を避ける希望'; const fd = c.slots.find((s) => free.has(s.day)); return fd ? `${fd.day}曜を空ける希望` : null; };
  const needed = (c) => isReq(c) || (c.category && remaining[c.category] > 0);
  for (;;) {
    const d0 = days(), opts = pool.filter((c) => !chosen.includes(c) && needed(c) && !feasible(c) && (isReq(c) || !wishBlock(c)));
    if (!opts.length) break;
    const key = (c) => [isReq(c) ? 0 : 1, c.slots.filter((s) => !d0.has(s.day)).length, -(remaining[c.category] || 0), c.slots.reduce((a, s) => a + s.periods.length, 0), -c.credits, c.name, c.id];
    opts.sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; });
    const c = opts[0], w = []; if (isReq(c)) w.push('必修科目'); else w.push(`${c.category}があと${r1(remaining[c.category])}単位足りない`);
    const newDays = c.slots.filter((s) => !d0.has(s.day)).map((s) => s.day); w.push(newDays.length ? `${[...new Set(newDays)].join('・')}曜が新しく通う日になる` : `すでに通う曜日（${c.slots.map((s) => s.day).join('・')}）に入る`);
    const wn = isReq(c) ? wishNote(c) : []; if (wn.length) w.push(`注意：${wn.join('、')}`);
    chosen.push(c); credits += c.credits; why.set(c, w.join('。')); if (c.category in remaining) remaining[c.category] = Math.max(0, remaining[c.category] - c.credits);
  }
  const final = [...registered, ...chosen], skipped = [...pool, ...offGrid].filter((c) => !chosen.includes(c)).map((c) => {
    if (!c.slots.length) return { id: c.id, name: c.name, reason: `${c.kind || '時間割外'}のため、時間の重なりは見ていません。必要なら手で追加してください` };
    const clash = final.find((x) => sharedPeriods(c, x).length), f = feasible(c), w = !isReq(c) ? wishBlock(c) : null;
    return { id: c.id, name: c.name, reason: clash ? `${clash.name}と時間が重なる` : f || (needed(c) ? w || '提案の条件に合わない' : c.category ? `${c.category}の単位は足りている` : '要件に関係する区分ではない') };
  });
  const short = Object.entries(remaining).filter(([, v]) => v > 0).map(([k, v]) => ({ category: k, remaining: r1(v) }));
  const missing = req.required.filter((n) => !final.some((c) => norm(c.name) === norm(n)) && !Object.values(byTerm).flat().some((c) => norm(c.name) === norm(n) && ['修得済み', '履修'].includes(c.status)));
  if (missing.length) notes.push(`必修科目「${missing.join('」「')}」は、候補に入っていないため提案できません（科目と時間を教えてください）`);
  if (short.length) notes.push(`候補だけでは、${short.map((s) => `${s.category} あと${s.remaining}単位`).join('、')}が足りません。候補を追加で教えてください（開講科目はこのアプリからは見えません）`);
  if (!pool.length && !offGrid.length) notes.push('この学期に「候補」の科目がありません。候補を教えてください');
  if (!Object.keys(req.categories).length && !req.required.length) notes.push('卒業要件が未設定のため、必修だけを提案しました（区分ごとの単位を教えると、足りない区分も見ます）');
  const added = chosen.map((c) => ({ id: c.id, name: c.name, slotsText: slotsText(c.slots, c.kind), credits: c.credits, category: c.category, required: isReq(c), reason: why.get(c) }));
  return { term, label: termLabel(term), proposals: added, skipped, addedCredits: r1(sum(chosen, (c) => c.credits)), registeredAfter: r1(credits), cap, capLeftAfter: cap != null ? r1(cap - credits) : null, daysAfter: DAYS.filter((d) => days().has(d)), stillShort: short, covered: !short.length && !missing.length, notes, prefs: { avoid1限: !!prefs.avoid1限, freeDays: [...free], maxPerDay } };
}

// ---------------------------------------------------------------- shift link (pure)
/** Class occurrences of the month as busy events for the シフト module: each 履修 course of the term in force on that date, one block per run of consecutive periods. Vacations / 休講 are unknown. */
export function classOccurrences({ month, byTerm = {}, settings = parseSettings('') }) {
  const out = [];
  for (let d = 1; d <= daysIn(month); d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`, term = termForDate(date, settings.ranges), list = term ? (byTerm[term] || []).filter((c) => c.status === '履修') : []; if (!list.length) continue;
    const wd = WD[new Date(`${date}T00:00:00Z`).getUTCDay()];
    for (const c of list) for (const s of c.slots) if (s.day === wd) for (const run of runs(s.periods)) {
      const a = settings.periods[run[0]], b = settings.periods[run[run.length - 1]]; if (!a || !b) continue;
      out.push({ summary: `授業：${c.name}`, start: isoAt(date, a[0], TZ()), end: isoAt(date, b[1], TZ()), course: c.id });
    }
  }
  return out;
}

// ---------------------------------------------------------------- IO
async function guardPrivate() { if (!(await brainRepoIsPrivate())) throw new Error('第二の脳のリポジトリが公開になっているため、履修のデータは保存しません（プライベートにしてください）'); }
export async function readSettings() { return parseSettings(await brainReadRaw('履修/設定.md').catch(() => null)); }
export async function readRequirements() { return parseRequirements(await brainReadRaw('履修/卒業要件.md').catch(() => null)); }
export async function readTerm(term) { return parseCourses(await brainReadRaw(termPath(term)).catch(() => null)); }
/** Every term file of the vault (+ the extra terms asked for) → { 'YYYY-後期': [courses] } */
export async function readAllTerms(extra = []) {
  let names = []; try { names = (await brainList({ folder: '履修' })).notes.map((p) => p.match(/^履修\/(\d{4}-(?:前期|後期))\.md$/)?.[1]).filter(Boolean); } catch { /* listing is optional */ }
  const terms = [...new Set([...names, ...extra.filter(validTerm)])], byTerm = {};
  await Promise.all(terms.map(async (t) => { byTerm[t] = await readTerm(t); })); return byTerm;
}
const idFor = (term, c, n) => crypto.createHash('sha1').update(`${term}|${c.name}|${slotsText(c.slots, c.kind)}|${n}`).digest('hex').slice(0, 6);
const resolveTerm = (w, nowMs) => (w ? (validTerm(w) ? w : parseTerm(w, nowMs)) : currentTerm(nowMs));

/** Adds courses (an identical name + time in the same term that is not 取消 is skipped). @returns {{added, skipped, term}} */
export async function addCourses(list, { term, nowMs = Date.now() } = {}) {
  await guardPrivate(); const req = await readRequirements(), cats = Object.keys(req.categories), byTerm = new Map(), added = []; let skipped = 0;
  for (const raw of (Array.isArray(list) ? list : []).slice(0, 40)) {
    const c = normalizeCourse(raw, { categories: cats }), t = resolveTerm(raw?.term || term, nowMs); if (!t) throw new Error('学期が分かりません（例：2026年度の後期）');
    if (!byTerm.has(t)) byTerm.set(t, await readTerm(t)); const cur = byTerm.get(t);
    if (cur.some((x) => norm(x.name) === norm(c.name) && slotsText(x.slots, x.kind) === slotsText(c.slots, c.kind) && x.status !== '取消')) { skipped++; continue; }
    let n = cur.length; do { c.id = idFor(t, c, n++); } while (cur.some((x) => x.id === c.id)); c.term = t; cur.push(c); added.push(c);
  }
  for (const [t] of byTerm) { const fresh = added.filter((c) => c.term === t); if (!fresh.length) continue; const exists = await brainReadRaw(termPath(t)).catch(() => null); await brainWrite({ path: termPath(t), content: (exists ? '' : termFileHead(t)) + fresh.map(rowOf).join('\n'), mode: 'append' }); }
  return { added, skipped, term: added[0]?.term || resolveTerm(term, nowMs) };
}
async function findCourse(id, term, nowMs) {
  const terms = term ? [resolveTerm(term, nowMs)] : Object.keys(await readAllTerms([currentTerm(nowMs)]));
  for (const t of terms) { const text = await brainReadRaw(termPath(t)).catch(() => null); if (!text) continue; const lines = text.split('\n'), i = lines.findIndex((l) => new RegExp(`^\\|\\s*${id}\\s*\\|`).test(l)); if (i >= 0) return { t, lines, i, course: parseCourses(lines[i])[0] }; }
  throw new Error(`id ${id} の科目が見つかりません`);
}
export async function cancelCourse(id, term, { nowMs = Date.now() } = {}) {
  await guardPrivate(); const f = await findCourse(id, term, nowMs); f.lines.splice(f.i, 1);
  await brainWrite({ path: termPath(f.t), content: f.lines.join('\n'), mode: 'replace' }); return { removed: { ...f.course, term: f.t }, term: f.t };
}
/** Changes courses (one `id` or several `ids`; the same patch for each). The term file is rewritten (git history keeps the old one). */
export async function updateCourses({ id, ids, patch = {}, term, nowMs = Date.now() }) {
  await guardPrivate(); const req = await readRequirements(), cats = Object.keys(req.categories), list = [...new Set([...(Array.isArray(ids) ? ids : []), ...(id ? [id] : [])])].slice(0, 40);
  if (!list.length) throw new Error('どの科目か分かりません（id が必要です）'); const done = [];
  for (const one of list) {
    const f = await findCourse(one, term, nowMs), old = f.course, p = {}; for (const [k, v] of Object.entries(patch)) if (v !== undefined) p[k] = v;
    const raw = { ...courseToRaw(old), ...p }; if ((p.day != null || p.period != null || p.periods != null) && p.slot == null) { delete raw.slot; raw.day = p.day ?? old.slots[0]?.day ?? ''; raw.period = p.period ?? p.periods ?? old.slots[0]?.periods ?? ''; }
    const next = { ...normalizeCourse(raw, { categories: cats }), id: old.id, term: f.t }; f.lines[f.i] = rowOf(next);
    await brainWrite({ path: termPath(f.t), content: f.lines.join('\n'), mode: 'replace' }); done.push({ before: { ...old, term: f.t }, after: next });
  }
  return { updated: done, before: done[0].before, after: done[0].after, term: done[0].after.term };
}

/** Sets graduation requirements / CAP / required courses / period times / teaching periods. clear: 卒業単位 | 上限 | 区分:名前 | 必修科目 | 時限 | 授業期間 */
export async function setRequirements(a = {}) {
  await guardPrivate(); const req = await readRequirements(), set = await readSettings(), changed = []; let reqDirty = false, setDirty = false;
  const clear = cell(a.clear);
  if (clear) {
    reqDirty = true;
    if (/^卒業単位/.test(clear)) { req.total = null; } else if (/^(上限|CAP|cap)/.test(clear)) { req.cap = null; req.capByTerm = {}; } else if (/^区分[:：]/.test(clear)) { const k = Object.keys(req.categories).find((x) => norm(x) === norm(clear.replace(/^区分[:：]/, ''))); if (!k) throw new Error('その区分は登録されていません'); delete req.categories[k]; } else if (/^必修/.test(clear)) req.required = []; else if (/^時限|^授業期間/.test(clear)) { reqDirty = false; setDirty = true; if (/^時限/.test(clear)) set.periods = { ...DEFAULT_PERIODS }; else set.ranges = { ...DEFAULT_RANGES }; } else throw new Error('clear は 卒業単位・上限・区分:名前・必修科目・時限・授業期間 のどれかです');
    changed.push(/^時限|^授業期間/.test(clear) ? `${clear}を初期値に戻しました` : `${clear}を消しました`);
  }
  if (a.totalCredits != null && a.totalCredits !== '') { const v = num(a.totalCredits); if (!Number.isFinite(v) || v <= 0) throw new Error('卒業単位の数字が分かりません'); req.total = v; reqDirty = true; changed.push(`卒業単位 ${v}`); }
  if (a.cap != null && a.cap !== '') { const v = num(a.cap); if (!Number.isFinite(v) || v <= 0) throw new Error('履修上限の数字が分かりません'); const t = a.capTerm ? resolveTerm(a.capTerm, Date.now()) : null; if (a.capTerm && !t) throw new Error('上限を決める学期が分かりません'); if (t) req.capByTerm[t] = v; else req.cap = v; reqDirty = true; changed.push(`${t ? termLabel(t) + 'の' : '毎学期の'}履修上限 ${v}`); }
  if (a.category && a.credits != null && a.credits !== '') { const v = num(a.credits), k = cell(a.category).slice(0, 20); if (!Number.isFinite(v) || v < 0) throw new Error('区分の単位数が分かりません'); const old = Object.keys(req.categories).find((x) => norm(x) === norm(k)); req.categories[old || k] = v; reqDirty = true; changed.push(`区分 ${old || k} ${v}単位`); }
  if (Array.isArray(a.requiredCourses)) { req.required = a.requiredCourses.map((x) => cell(x).slice(0, 40)).filter(Boolean).slice(0, 60); reqDirty = true; changed.push(`必修科目 ${req.required.length}件`); }
  if (a.addRequired) { const n = cell(a.addRequired).slice(0, 40); if (!req.required.some((x) => norm(x) === norm(n))) req.required.push(n); reqDirty = true; changed.push(`必修科目に ${n} を追加`); }
  if (a.removeRequired) { req.required = req.required.filter((x) => norm(x) !== norm(a.removeRequired)); reqDirty = true; changed.push(`必修科目から ${cell(a.removeRequired)} を外しました`); }
  if (a.period != null && a.period !== '') {
    const n = Number(a.period), s = parseHm(a.start), e = parseHm(a.end); if (!Number.isInteger(n) || n < 1 || n > MAXP) throw new Error(`時限は 1〜${MAXP} です`); if (s == null || e == null || e <= s) throw new Error('開始と終了の時刻が分かりません（例：9:00 と 10:30）');
    set.periods[n] = [hhmm(s), hhmm(e)]; setDirty = true; changed.push(`${n}限 ${hhmm(s)}-${hhmm(e)}`);
  }
  if (a.termPeriod) { const h = /前/.test(a.termPeriod) ? '前期' : /後/.test(a.termPeriod) ? '後期' : null, f = String(a.from || '').match(/^(\d{1,2})[-/](\d{1,2})$/), t = String(a.to || '').match(/^(\d{1,2})[-/](\d{1,2})$/); if (!h || !f || !t) throw new Error('授業期間は 学期（前期/後期）と、開始・終了を MM-DD で教えてください'); const p = (m) => `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; set.ranges[h] = { from: p(f), to: p(t) }; setDirty = true; changed.push(`${h}の授業期間 ${p(f)}〜${p(t)}`); }
  if (!changed.length) throw new Error('変更する内容が分かりません（卒業単位・履修上限・区分ごとの単位・必修科目・時限の時刻のどれかを教えてください）');
  if (reqDirty) await brainWrite({ path: '履修/卒業要件.md', content: serializeRequirements(req), mode: 'replace' });
  if (setDirty) await brainWrite({ path: '履修/設定.md', content: serializeSettings(set), mode: 'replace' });
  return { changed, requirements: req, periods: set.periods, ranges: set.ranges };
}
const parseHm = (w) => { const m = String(w ?? '').trim().replace(/[０-９：]/g, (c) => (c === '：' ? ':' : String.fromCharCode(c.charCodeAt(0) - 0xfee0))).match(/^(\d{1,2})(?::|時)(\d{1,2})?/); return m ? Number(m[1]) * 60 + Number(m[2] || 0) : null; };

// ---------------------------------------------------------------- composition
export async function courseSummary({ term, nowMs = Date.now() } = {}) {
  const t = resolveTerm(term, nowMs) || currentTerm(nowMs);
  if (!brainConfigured()) return { ...summarizeTerm({ term: t }), unconfigured: true };
  const [byTerm, req, settings] = await Promise.all([readAllTerms([t]), readRequirements(), readSettings()]);
  return { ...summarizeTerm({ term: t, byTerm, req, settings }), hasRequirements: req.total != null || Object.keys(req.categories).length > 0 || req.required.length > 0 || req.cap != null };
}
export async function courseSuggest({ term, prefs = {}, nowMs = Date.now() } = {}) {
  const t = resolveTerm(term, nowMs) || currentTerm(nowMs); const [byTerm, req] = await Promise.all([readAllTerms([t]), readRequirements()]);
  return suggestCourses({ term: t, byTerm, req, prefs });
}
/** The classes (履修) of a month as busy events for the シフト module; [] when there is nothing (optional link; never throws). */
export async function classEvents(month) {
  try {
    if (!brainConfigured()) return [];
    const settings = await readSettings(), terms = new Set(); for (let d = 1; d <= daysIn(month); d++) { const t = termForDate(`${month}-${String(d).padStart(2, '0')}`, settings.ranges); if (t) terms.add(t); }
    if (!terms.size) return []; const byTerm = {}; await Promise.all([...terms].map(async (t) => { byTerm[t] = await readTerm(t); }));
    return classOccurrences({ month, byTerm, settings });
  } catch { return []; }
}
