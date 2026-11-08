import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSlots, parseSlot, slotsText, parseCourses, parseSettings, parseRequirements, normalizeCourse, normalizeStatus, matchCategory, findConflicts, creditTotals, checkTerm, suggestCourses, summarizeTerm, buildGrid, classOccurrences, termForDate, currentTerm, parseTerm, shiftTerm, addCourses, updateCourses, cancelCourse, setRequirements, courseSummary, courseSuggest, classEvents, readAllTerms, readSettings } from '../server/course.js';
import { classifyDays, suggestShifts } from '../server/shift.js';
import { _resetPrivacy } from '../server/brain.js';
import { catColor, shiftTerm as vShiftTerm, timetableHtml, currentTermName } from '../web/src/course-view.js';
import { executeGoogle } from '../server/google/index.js';

const NOW = Date.parse('2026-11-15T12:00:00+09:00');
async function withVault(fn, { isPrivate = true, google = true } = {}) {
  const keep = { ...process.env }, real = globalThis.fetch, store = new Map(); let priv = isPrivate;
  Object.assign(process.env, { BRAIN_GITHUB_TOKEN: 't', BRAIN_REPO: 'me/vault' }); delete process.env.BRAIN_DIR; _resetPrivacy();
  if (google) Object.assign(process.env, { GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', GOOGLE_REFRESH_TOKEN: 'x' });
  globalThis.fetch = async (u, o = {}) => {
    u = String(u);
    if (/\/repos\/me\/vault$/.test(u)) return { ok: true, status: 200, json: async () => ({ full_name: 'me/vault', private: priv, permissions: { push: true } }) };
    if (u.includes('/git/trees/')) return { ok: true, status: 200, json: async () => ({ tree: [...store.keys()].map((path) => ({ path, type: 'blob', size: 50 })) }) };
    const p = decodeURIComponent(u).match(/\/contents\/([^?]+)/)?.[1];
    if (o.method === 'PUT') { store.set(p, { text: Buffer.from(JSON.parse(o.body).content, 'base64').toString('utf8'), sha: 'n' + Math.random() }); return { ok: true, status: 200, json: async () => ({ commit: { sha: 'abc1234' } }) }; }
    const f = store.get(p); return f ? { ok: true, status: 200, json: async () => ({ type: 'file', sha: f.sha, content: Buffer.from(f.text).toString('base64') }) } : { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
  };
  try { return await fn({ store, setPrivate: (v) => { priv = v; _resetPrivacy(); } }); } finally { globalThis.fetch = real; for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); _resetPrivacy(); }
}
const C = (id, name, slot, credits, category, status = '履修', extra = {}) => { const { slots, kind } = parseSlots(slot); return { id, name, slots: slots.filter((s) => s.periods.length), kind, credits, category, status, required: false, instructor: '', room: '', grade: '', memo: '', ...extra }; };
const T = '2026-後期';

test('parseSlots: 月曜3限 / 火2・3 / 木3-4 / 水曜の午後 / 月3/木3 / 3限と4限 / 集中 / オンデマンド / full-width digits', () => {
  assert.deepEqual(parseSlot('月曜3限'), { day: '月', periods: [3] });
  assert.deepEqual(parseSlot('火2・3'), { day: '火', periods: [2, 3] });
  assert.deepEqual(parseSlot('木曜日の3-4限'), { day: '木', periods: [3, 4] });
  assert.deepEqual(parseSlot('金曜の３限と４限'), { day: '金', periods: [3, 4] });
  assert.deepEqual(parseSlot('月1〜3限'), { day: '月', periods: [1, 2, 3] });
  assert.deepEqual(parseSlot('月1・3'), { day: '月', periods: [1, 3] });
  const w = parseSlots('水曜の午後'); assert.equal(w.slots[0].window, '午後'); assert.deepEqual(w.slots[0].periods, [3, 4, 5]);
  assert.deepEqual(parseSlots('月曜の午前').slots[0].periods, [1, 2]);
  const two = parseSlots('月3/木3-4'); assert.deepEqual(two.slots.map((s) => [s.day, s.periods]), [['月', [3]], ['木', [3, 4]]]);
  assert.deepEqual(parseSlots('月曜3限・木曜3限').slots.map((s) => [s.day, s.periods]), [['月', [3]], ['木', [3]]]);
  assert.equal(parseSlots('集中講義').kind, '集中'); assert.equal(parseSlots('オンデマンド').kind, 'オンデマンド'); assert.equal(parseSlots('オンライン授業').kind, 'オンデマンド');
  assert.deepEqual(parseSlots('火曜').slots, [{ day: '火', periods: [] }]); assert.equal(parseSlot('いつか'), null); assert.equal(parseSlot('火曜'), null);
  assert.equal(slotsText(parseSlots('月曜3限・木曜3-4限').slots), '月3/木3-4'); assert.equal(slotsText([], '集中'), '集中'); assert.equal(slotsText(parseSlots('月1・3').slots), '月1・3');
});

test('terms: current term, parseTerm words, shiftTerm, term in force on a date (teaching periods)', () => {
  assert.equal(currentTerm(NOW), '2026-後期'); assert.equal(currentTerm(Date.parse('2027-02-10T12:00:00+09:00')), '2026-後期'); assert.equal(currentTerm(Date.parse('2026-05-10T12:00:00+09:00')), '2026-前期');
  assert.equal(parseTerm('後期', NOW), '2026-後期'); assert.equal(parseTerm('2027前期', NOW), '2027-前期'); assert.equal(parseTerm('秋学期', NOW), '2026-後期'); assert.equal(parseTerm('来学期', NOW), '2027-前期'); assert.equal(parseTerm('今学期', NOW), '2026-後期'); assert.equal(parseTerm('なにか', NOW), null);
  assert.equal(shiftTerm('2026-後期', 1), '2027-前期'); assert.equal(shiftTerm('2026-前期', -1), '2025-後期'); assert.equal(vShiftTerm('2026-後期', 1), '2027-前期'); assert.equal(currentTermName(NOW), '2026-後期');
  const s = parseSettings('');
  assert.equal(termForDate('2026-05-20', s.ranges), '2026-前期'); assert.equal(termForDate('2026-08-20', s.ranges), null); assert.equal(termForDate('2026-11-02', s.ranges), '2026-後期'); assert.equal(termForDate('2027-01-12', s.ranges), '2026-後期'); assert.equal(termForDate('2027-02-12', s.ranges), null);
});

test('file formats: courses round-trip (slots, kind, required, text with |), settings (period times, ranges), requirements', () => {
  const src = [C('abc123', '線形代数', '月3', 2, '必修', '履修', { required: true, instructor: '山田', room: 'A101', memo: 'メモ|あり' }), C('abc124', '体育', '火2-3/金1', 1, '教養', '候補'), C('abc125', '特別講義', '集中', 1, '選択', '抽選待ち'), C('abc126', '統計学', 'オンデマンド', 2, '専門', '修得済み', { grade: 'A' })];
  const text = src.map((c) => `| ${c.id} | ${c.name} | ${slotsText(c.slots, c.kind)} | ${c.credits} | ${c.category} | ${c.status} | ${c.required ? '○' : ''} | ${c.instructor} | ${c.room} | ${c.grade} | ${c.memo.replace('|', '／')} |`).join('\n');
  const back = parseCourses('| id | 科目 |\n|---|---|\n' + text);
  assert.equal(back.length, 4); assert.deepEqual(back[0].slots, [{ day: '月', periods: [3] }]); assert.equal(back[0].required, true); assert.equal(back[0].memo, 'メモ／あり'); assert.deepEqual(back[1].slots.map((s) => s.day + s.periods.join('')), ['火23', '金1']); assert.equal(back[2].kind, '集中'); assert.equal(back[2].status, '抽選待ち'); assert.equal(back[3].grade, 'A'); assert.equal(back[3].kind, 'オンデマンド');
  const st = parseSettings('- 2限：10:40-12:10\n- 3限：13:10〜14:40\n- 後期の授業期間：9/20〜1/20'); assert.deepEqual(st.periods[3], ['13:10', '14:40']); assert.deepEqual(st.periods[1], ['09:00', '10:30']); assert.deepEqual(st.ranges.後期, { from: '09-20', to: '01-20' }); assert.deepEqual(st.ranges.前期, { from: '04-01', to: '07-31' });
  assert.deepEqual(parseSettings('').periods[7], ['19:40', '21:10']);
  const rq = parseRequirements('- 卒業単位：124\n- 学期の履修上限：24\n- 学期の履修上限 2026-後期：20\n- 区分 必修：30\n- 区分 選択必修：12\n- 必修科目：線形代数、微分積分'); assert.deepEqual([rq.total, rq.cap, rq.capByTerm[T], rq.categories.必修, rq.categories.選択必修, rq.required], [124, 24, 20, 30, 12, ['線形代数', '微分積分']]);
});

test('normalizeCourse: loose input, slot words, status words, category mapping, honest errors (nothing is guessed)', () => {
  const k = ['必修', '選択必修', '選択'];
  const c = normalizeCourse({ name: '線形代数', slot: '月曜3限', credits: '2単位', category: '必修科目', status: '履修登録した' }, { categories: k }); assert.deepEqual([c.slots[0].day, c.slots[0].periods, c.credits, c.category, c.status, c.required], ['月', [3], 2, '必修', '履修', true]);
  assert.equal(normalizeCourse({ name: 'a', day: '火曜', period: '2-3', credits: 2 }).slots[0].periods.join(), '2,3'); assert.equal(normalizeCourse({ name: 'a', day: '水', period: 4, credits: 1 }).slots[0].periods[0], 4);
  assert.equal(normalizeCourse({ name: 'a', day: '集中', credits: 1 }).kind, '集中'); assert.equal(normalizeCourse({ name: 'a', slot: 'オンデマンド', credits: 1 }).status, '候補', 'default is 候補, nothing is claimed as registered');
  assert.equal(matchCategory('選択必修科目', k), '選択必修'); assert.equal(matchCategory('選択', k), '選択'); assert.equal(matchCategory('教養', k), '教養');
  assert.throws(() => normalizeCourse({ slot: '月3', credits: 2 }), /科目の名前/); assert.throws(() => normalizeCourse({ name: 'a', credits: 2 }), /曜日と時限/); assert.throws(() => normalizeCourse({ name: 'a', slot: '水曜の午後', credits: 2 }), /何限/); assert.throws(() => normalizeCourse({ name: 'a', slot: '月曜', credits: 2 }), /何限/);
  assert.throws(() => normalizeCourse({ name: 'a', slot: '月3' }), /単位数/); assert.throws(() => normalizeCourse({ name: 'a', slot: '月3', credits: 2, status: 'ふむ' }), /状態は/); assert.throws(() => normalizeCourse({ name: 'a', slot: '月12', credits: 2 }), /時限は/);
  assert.equal(normalizeStatus('抽選に落ちた'), '抽選待ち'); assert.equal(normalizeStatus('キャンセル'), '取消'); assert.equal(normalizeStatus('単位を取った'), '修得済み'); assert.equal(normalizeStatus('検討中'), '候補');
});

test('findConflicts: same day overlapping periods; 履修×履修 / 履修×候補 / 候補×候補 levels; adjacent and other days are fine; 取消・修得済み ignored', () => {
  const cs = [C('a', '線形代数', '月3-4', 2, '必修'), C('b', '英語', '月4', 1, '教養', '候補'), C('c', '物理', '月4', 2, '専門', '履修'), C('d', '化学', '月4/火1', 2, '専門', '抽選待ち'), C('e', '体育', '月5', 1, '教養'), C('f', '歴史', '火4', 2, '教養'), C('g', '古い', '月3', 2, '教養', '取消'), C('h', '済', '月3', 2, '教養', '修得済み')];
  const r = findConflicts(cs), by = (x, y) => r.find((c) => (c.a === x && c.b === y) || (c.a === y && c.b === x));
  assert.equal(by('a', 'c').level, 'registered'); assert.equal(by('a', 'b').level, 'candidate'); assert.equal(by('b', 'd').level, 'alternative'); assert.equal(by('b', 'c').level, 'candidate');
  assert.equal(by('a', 'e'), undefined, '4限と5限は連続しているだけ'); assert.equal(by('a', 'f'), undefined); assert.ok(!r.some((c) => ['g', 'h'].includes(c.a) || ['g', 'h'].includes(c.b)));
  assert.match(by('a', 'c').text, /月曜4限が重なる/);
});

test('creditTotals: per term (履修 / 候補 / 抽選待ち), CAP over / left, per category and graduation total (修得済み from other terms count)', () => {
  const req = parseRequirements('- 卒業単位：20\n- 学期の履修上限：10\n- 区分 必修：6\n- 区分 選択：8');
  const byTerm = { '2026-前期': [C('p1', '前の必修', '月1', 4, '必修', '修得済み'), C('p2', '前の選択', '火1', 2, '選択', '修得済み'), C('p3', '自由科目', '水1', 1, '自由', '修得済み')],
    [T]: [C('a', '線形代数', '月3', 2, '必修'), C('b', '英語', '火3', 2, '選択'), C('c', '統計', '水3', 2, '選択', '履修'), C('d', '哲学', '木3', 2, '教養', '候補'), C('e', '抽選科目', '金3', 2, '選択', '抽選待ち')] };
  const t = creditTotals({ term: T, byTerm, req });
  assert.deepEqual([t.registered, t.candidate, t.lottery, t.cap, t.over, t.capLeft], [6, 2, 2, 10, false, 4]);
  assert.deepEqual([t.total.earned, t.total.registered, t.total.remaining], [7, 6, 7]);
  const hit = (n) => t.categories.find((c) => c.name === n); assert.deepEqual([hit('必修').earned, hit('必修').registered, hit('必修').remaining, hit('必修').short], [4, 2, 0, false]); assert.deepEqual([hit('選択').earned, hit('選択').registered, hit('選択').remaining, hit('選択').short], [2, 4, 2, true]);
  assert.equal(hit('自由').required, null, 'category without a requirement is listed, not judged'); assert.equal(hit('教養'), undefined, '候補 only does not make a row');
  const over = creditTotals({ term: T, byTerm: { [T]: [C('x', 'x', '月1', 12, '選択')] }, req }); assert.equal(over.over, true); assert.equal(over.capLeft, -2);
  assert.equal(creditTotals({ term: T, byTerm, req: parseRequirements('- 学期の履修上限：10\n- 学期の履修上限 2026-後期：4') }).over, true, 'a term-specific cap beats the standing one');
});

test('checkTerm: conflicts, CAP, lottery over CAP, missing required courses, short categories, heavy days, 1限, free days, gaps — in order bad > warn > info', () => {
  const req = parseRequirements('- 卒業単位：30\n- 学期の履修上限：6\n- 区分 必修：6\n- 必修科目：線形代数、微分積分、英語');
  const byTerm = { [T]: [
    C('a', '線形代数', '月1', 2, '必修'), C('b', '物理', '月1', 2, '専門'),                            // registered conflict
    C('c', '微分積分', '火1', 2, '必修', '候補'),                                                           // required, only 候補
    C('d', 'ゼミ', '木1-5', 2, '専門'),                                                                   // 5 periods in a day
    C('e', '体育', '金2', 2, '教養'), C('f', '歴史', '金4', 1, '教養', '抽選待ち') ] };
  const r = checkTerm({ term: T, byTerm, req }), txt = r.map((x) => x.text).join('\n');
  assert.equal(r[0].level, 'bad'); assert.match(r[0].text, /月曜1限が重なる/); assert.ok(r.some((x) => x.code === 'cap' && /上限（6単位）を 2単位 超えて/.test(x.text)));
  assert.match(txt, /必修科目「微分積分」はまだ候補です/); assert.match(txt, /必修科目「英語」は記録にありません/); assert.ok(!/必修科目「線形代数」/.test(txt));
  assert.match(txt, /木曜は5コマ/); assert.match(txt, /単位が足りない区分：必修 あと4/); assert.match(txt, /卒業まで あと 22単位/); assert.match(txt, /1限がある日：月・木/); assert.match(txt, /1限がない日：金/); assert.match(txt, /授業がない日：火・水/); assert.match(txt, /抽選待ち 1科目/);
  const order = { bad: 0, warn: 1, info: 2 }; assert.deepEqual(r.map((x) => order[x.level]), [...r.map((x) => order[x.level])].sort((a, b) => a - b));
  assert.ok(!r.some((x) => x.code === 'heavy-run' && /木/.test(x.text)), '5 classes reported once, not also as a run');
  const lot = checkTerm({ term: T, byTerm: { [T]: [C('a', 'a', '月2', 4, '選択'), C('b', 'b', '月4', 4, '選択', '抽選待ち')] }, req: parseRequirements('- 学期の履修上限：6') }); assert.ok(lot.some((x) => x.code === 'cap-lottery' && x.level === 'warn'));
  const run4 = checkTerm({ term: T, byTerm: { [T]: [C('a', 'a', '水2-5', 4, '選択')] }, req: parseRequirements('') }); assert.ok(run4.some((x) => /水曜は4コマ連続/.test(x.text)));
  const gap = checkTerm({ term: T, byTerm: { [T]: [C('a', 'a', '月1', 1, ''), C('b', 'b', '月4', 1, '')] }, req: parseRequirements('') }); assert.ok(gap.some((x) => /空きコマ：月2・3限/.test(x.text)));
  assert.ok(checkTerm({ term: T, byTerm: {}, req: parseRequirements('') }).some((x) => x.code === 'empty'));
});

test('suggestCourses: required first, covers short categories, no conflicts, within CAP, fewest days, preferences, explained; honest about what is still short', () => {
  const req = parseRequirements('- 卒業単位：40\n- 学期の履修上限：10\n- 区分 必修：4\n- 区分 選択：2\n- 必修科目：線形代数');
  const byTerm = { [T]: [
    C('r1', '解析', '月2', 2, '必修'),                                                    // already registered
    C('k1', '線形代数', '月3', 2, '必修', '候補', { required: true }),                       // required → first, same day as 解析
    C('s1', '政治学', '月4', 2, '選択', '候補'),                                              // same day (Mon), covers 選択
    C('s2', '経済学', '火1', 2, '選択', '候補'),                                              // new day (Tue) – not needed once 政治学 is in
    C('s3', '心理学', '月3', 2, '選択', '候補'),                                              // conflicts with 線形代数
    C('x1', '芸術', '木5', 2, '教養', '候補'),                                                // category without a requirement → not needed
    C('x2', '集中講座', '集中', 1, '選択', '候補') ] };
  const r = suggestCourses({ term: T, byTerm, req });
  assert.deepEqual(r.proposals.map((p) => p.name), ['線形代数', '政治学']); assert.equal(r.proposals[0].required, true); assert.match(r.proposals[0].reason, /必修科目.*すでに通う曜日（月）/);
  assert.equal(r.addedCredits, 4); assert.equal(r.registeredAfter, 6); assert.equal(r.capLeftAfter, 4); assert.deepEqual(r.daysAfter, ['月']); assert.equal(r.covered, true);
  const why = Object.fromEntries(r.skipped.map((s) => [s.name, s.reason])); assert.match(why['心理学'], /線形代数と時間が重なる/); assert.match(why['経済学'], /単位は足りている/); assert.match(why['芸術'], /要件に関係しない|足りている/); assert.match(why['集中講座'], /時間の重なりは見ていません/);
  // determinism
  assert.deepEqual(suggestCourses({ term: T, byTerm, req }), r);
  // CAP: only 1 credit of room → the 2-credit required course cannot be proposed, and that is said
  const tight = suggestCourses({ term: T, byTerm, req: parseRequirements('- 学期の履修上限：3\n- 必修科目：線形代数\n- 区分 選択：4') }); assert.equal(tight.proposals.length, 0); assert.match(tight.skipped.find((s) => s.name === '線形代数').reason, /上限（3単位）を超える/); assert.equal(tight.covered, false);
  // preferences: avoid 1限 / free day (not applied to required courses, which carry a note); maxPerDay
  const pb = { [T]: [C('a', '朝の選択', '月1', 2, '選択', '候補'), C('b', '昼の選択', '火3', 2, '選択', '候補'), C('c', '必修朝', '水1', 2, '必修', '候補', { required: true })] };
  const p1 = suggestCourses({ term: T, byTerm: pb, req: parseRequirements('- 区分 選択：4\n- 区分 必修：2'), prefs: { avoid1限: true } }); assert.deepEqual(p1.proposals.map((p) => p.name).sort(), ['必修朝', '昼の選択']); assert.match(p1.proposals.find((p) => p.name === '必修朝').reason, /1限（避けたい希望より必修を優先）/); assert.match(p1.skipped.find((s) => s.name === '朝の選択').reason, /1限を避ける希望/);
  const p2 = suggestCourses({ term: T, byTerm: pb, req: parseRequirements('- 区分 選択：2'), prefs: { freeDays: ['火'] } }); assert.deepEqual(p2.proposals.map((p) => p.name), ['必修朝', '朝の選択']);
  const pm = suggestCourses({ term: T, byTerm: { [T]: [C('a', 'a', '月1', 2, '選択', '候補'), C('b', 'b', '月2', 2, '選択', '候補'), C('c', 'c', '火1', 2, '選択', '候補')] }, req: parseRequirements('- 区分 選択：6'), prefs: { maxPerDay: 1 } }); assert.equal(pm.proposals.length, 2); assert.deepEqual(pm.daysAfter, ['月', '火']);
  // still short + missing required are reported plainly
  const sh = suggestCourses({ term: T, byTerm: { [T]: [C('a', 'a', '月1', 2, '選択', '候補')] }, req: parseRequirements('- 区分 選択：6\n- 必修科目：微分積分') }); assert.deepEqual(sh.stillShort, [{ category: '選択', remaining: 4 }]); assert.ok(sh.notes.some((n) => /微分積分/.test(n))); assert.ok(sh.notes.some((n) => /開講科目はこのアプリからは見えません/.test(n))); assert.equal(sh.covered, false);
  assert.ok(suggestCourses({ term: T, byTerm: {}, req }).notes.some((n) => /候補」の科目がありません/.test(n)));
  // fewest days: with equal needs, the course on a day already on campus wins over a new day
  const fd = suggestCourses({ term: T, byTerm: { [T]: [C('m', '月の履修', '月1', 2, '専門'), C('a', 'あ', '火1', 2, '選択', '候補'), C('b', 'い', '月2', 2, '選択', '候補')] }, req: parseRequirements('- 区分 選択：2') }); assert.deepEqual(fd.proposals.map((p) => p.name), ['い']);
});

test('summarizeTerm / buildGrid: grid cells per day×period with flags, off-grid courses, period times, conflicts', () => {
  const byTerm = { [T]: [C('a', '線形代数', '月3-4', 2, '必修'), C('b', '物理', '月4', 2, '専門', '候補'), C('c', '集中', '集中', 1, '選択', '履修'), C('d', '消えた', '火1', 1, '選択', '取消')] };
  const s = summarizeTerm({ term: T, byTerm, req: parseRequirements('- 学期の履修上限：24'), settings: parseSettings('') });
  assert.equal(s.label, '2026年度 後期'); assert.equal(s.grid.periods.length, 7); assert.equal(s.grid.periods[2].start, '13:00'); assert.equal(s.grid.cells['月3'].length, 1); assert.equal(s.grid.cells['月4'].length, 2); assert.equal(s.grid.cells['月3'][0].first, true); assert.equal(s.grid.cells['月4'][0].first, false);
  assert.equal(s.grid.cells['月4'].find((x) => x.id === 'a').conflict, 'candidate'); assert.equal(s.grid.cells['火1'], undefined, '取消 is not on the grid'); assert.deepEqual(s.grid.offGrid.map((x) => x.name), ['集中']);
  assert.equal(s.courses[0].time, '月3-4 13:00–16:10'); assert.match(s.note, /見えません/); assert.equal(s.credits.registered, 3);
  const html = timetableHtml(s.grid); assert.ok(html.includes('線形代数') && html.includes('〃') && html.includes('cand') && html.includes('warn')); assert.match(html, /1限 09:00–10:30/);
  assert.notEqual(catColor('必修'), undefined); assert.equal(catColor('必修'), catColor('必修')); assert.equal(catColor(''), '#7fb6d6');
});

test('shift link: class occurrences (consecutive periods → one block, weekly, only inside the teaching period) and optional (no data → nothing)', () => {
  const settings = parseSettings(''), byTerm = { [T]: [C('a', '線形代数', '月3-4', 2, '必修'), C('b', '英語', '月1/木2', 1, '教養'), C('c', '候補', '火1', 1, '選択', '候補'), C('d', '集中', '集中', 1, '選択'), C('e', '夜間', '月5-7', 2, '専門')] };
  const ev = classOccurrences({ month: '2026-11', byTerm, settings });
  const mon = ev.filter((e) => e.start.startsWith('2026-11-02')); assert.deepEqual(mon.map((e) => [e.summary, e.start.slice(11, 16), e.end.slice(11, 16)]), [['授業：線形代数', '13:00', '16:10'], ['授業：英語', '09:00', '10:30'], ['授業：夜間', '16:20', '21:10']]);
  assert.equal(ev.filter((e) => e.summary === '授業：英語').length, 9, 'Mondays (2,9,16,23,30) + Thursdays (5,12,19,26)');
  assert.ok(!ev.some((e) => /候補|集中/.test(e.summary)), '候補 and 集中 are not busy blocks');
  assert.deepEqual(classOccurrences({ month: '2026-08', byTerm, settings }), [], 'no classes in the vacation (outside the teaching period)'); assert.deepEqual(classOccurrences({ month: '2026-11', byTerm: {}, settings }), []);
  assert.ok(classOccurrences({ month: '2027-01', byTerm, settings }).length > 0, '後期 runs into January'); assert.deepEqual(classOccurrences({ month: '2027-02', byTerm, settings }), []);
  // through classifyDays: a Monday with classes in 1限, 3-7限 has no free 3 h block → busy; Thursday with one 2限 class leaves a block → check
  const cd = classifyDays({ month: '2026-11', events: ev.map(({ summary, start, end }) => ({ summary, start, end })) });
  assert.equal(cd['2026-11-02'].status, 'busy'); assert.equal(cd['2026-11-05'].status, 'check'); assert.equal(cd['2026-11-03'], undefined, 'a day without classes is unchanged'); assert.match(cd['2026-11-02'].items[0].title, /授業/);
  // through suggestShifts: classes (+30 min margin) are avoided; Thursday 2限 ends 12:10 → shift starts after 12:40
  const r = suggestShifts({ month: '2026-11', job: { name: 'コンビニ', hourly: 1000, transport: 0 }, busy: ev.map((e) => ({ start: e.start, end: e.end })), hoursNeeded: 200, nowMs: NOW });
  const thu = r.proposals.find((p) => p.date === '2026-11-19'); assert.ok(thu && thu.start >= '12:40', 'after the class and the margin: ' + thu?.start); assert.ok(!r.proposals.some((p) => p.date === '2026-11-16' && p.start < '16:40'), 'Monday afternoon classes end 16:10 → earliest 16:40');
});

test('vault: courses are written to 履修/*.md; summary reads them back; update / batch status / cancel rewrite rows; requirements & period times persist', async () => {
  await withVault(async ({ store }) => {
    await setRequirements({ totalCredits: 124, cap: 24 }); await setRequirements({ category: '必修', credits: 30 }); await setRequirements({ category: '選択必修', credits: 12 }); await setRequirements({ requiredCourses: ['線形代数', '微分積分'] }); await setRequirements({ period: 2, start: '10:50', end: '12:20' });
    assert.ok(store.has('履修/卒業要件.md') && store.has('履修/設定.md')); assert.match(store.get('履修/設定.md').text, /2限：10:50-12:20/); assert.match(store.get('履修/設定.md').text, /1限：09:00-10:30/);
    const r = await addCourses([{ name: '線形代数', slot: '月曜3限', credits: 2, category: '必修科目', status: '履修' }, { name: '線形代数', slot: '月3', credits: 2, status: '履修' }, { name: '政治学', slot: '火2-3', credits: 2, category: '選択必修科目' }, { name: '前期の科目', slot: '水1', credits: 2, term: '2026-前期', status: '修得済み', grade: 'A' }], { nowMs: NOW });
    assert.equal(r.added.length, 3); assert.equal(r.skipped, 1); assert.ok(store.has('履修/2026-後期.md') && store.has('履修/2026-前期.md')); assert.equal(r.added[0].required, true); assert.equal(r.added[1].category, '選択必修'); assert.equal(r.added[1].status, '候補');
    const s = await courseSummary({ term: '2026-後期', nowMs: NOW });
    assert.deepEqual([s.count, s.credits.registered, s.credits.cap, s.credits.total.earned, s.credits.total.registered, s.credits.total.remaining], [2, 2, 24, 2, 2, 120]); assert.equal(s.grid.cells['月3'][0].name, '線形代数'); assert.equal(s.grid.periods[1].start, '10:50'); assert.equal(s.hasRequirements, true);
    assert.ok(s.checks.some((c) => /必修科目「微分積分」は記録にありません/.test(c.text)));
    const sug = await courseSuggest({ term: '2026-後期', nowMs: NOW }); assert.deepEqual(sug.proposals.map((p) => p.name), ['政治学']);
    const ids = r.added.slice(0, 2).map((c) => c.id), up = await updateCourses({ ids: [ids[1]], patch: { status: '履修' }, nowMs: NOW }); assert.equal(up.after.status, '履修'); assert.equal((await courseSummary({ term: '2026-後期' })).credits.registered, 4);
    const up2 = await updateCourses({ id: ids[0], patch: { slot: '木2', credits: 3, grade: 'B' } }); assert.deepEqual([up2.after.slots[0].day, up2.after.credits, up2.after.grade], ['木', 3, 'B']);
    const up3 = await updateCourses({ id: ids[0], patch: { day: '金', period: '1-2' } }); assert.equal(up3.after.slots[0].periods.join(), '1,2');
    await assert.rejects(() => updateCourses({ id: 'zzzzzz', patch: {} }), /見つかりません/); await assert.rejects(() => updateCourses({ id: ids[0], patch: { status: 'ふむ' } }), /状態は/);
    const del = await cancelCourse(ids[1]); assert.equal(del.removed.name, '政治学'); assert.equal((await courseSummary({ term: '2026-後期' })).count, 1); await assert.rejects(() => cancelCourse('zzzzzz'), /見つかりません/);
    const all = await readAllTerms(); assert.deepEqual(Object.keys(all).sort(), ['2026-前期', '2026-後期']);
    await setRequirements({ clear: '必修科目' }); assert.doesNotMatch(store.get('履修/卒業要件.md').text, /- 必修科目/); await assert.rejects(() => setRequirements({}), /変更する内容/); await assert.rejects(() => setRequirements({ period: 2, start: '12:00', end: '10:00' }), /開始と終了/);
    await setRequirements({ termPeriod: '後期', from: '9-20', to: '1-20' }); assert.deepEqual((await readSettings()).ranges.後期, { from: '09-20', to: '01-20' });
  });
});

test('vault: shift link reads the courses of the term in force; no 履修 data → nothing changes', async () => {
  await withVault(async () => {
    assert.deepEqual(await classEvents('2026-11'), []);
    await addCourses([{ name: '線形代数', slot: '月3-4', credits: 2, status: '履修' }, { name: '候補科目', slot: '火1', credits: 2 }], { term: '2026-後期', nowMs: NOW });
    const ev = await classEvents('2026-11'); assert.equal(ev.length, 5); assert.equal(ev[0].summary, '授業：線形代数'); assert.deepEqual(await classEvents('2026-08'), []);
  });
});

test('public repo: course data is refused; unconfigured vault gives an empty summary', async () => {
  await withVault(async () => { await assert.rejects(() => addCourses([{ name: 'a', slot: '月1', credits: 1 }]), /プライベート/); await assert.rejects(() => setRequirements({ totalCredits: 100 }), /プライベート/); }, { isPrivate: false });
  const keep = process.env.BRAIN_GITHUB_TOKEN; delete process.env.BRAIN_GITHUB_TOKEN; try { const s = await courseSummary({ nowMs: NOW }); assert.equal(s.unconfigured, true); assert.equal(s.empty, true); } finally { if (keep) process.env.BRAIN_GITHUB_TOKEN = keep; }
});

test('tools: course_add records by voice (no card), course_update ids, course_cancel needs approval unless confirmed, summary / suggest / requirements work, shift_suggest avoids classes', async () => {
  await withVault(async () => {
    const ex = (tool, args) => executeGoogle({ tool, args });
    assert.equal((await ex('course_requirements', { cap: 24, category: '選択', credits: 4 })).body.ok, true);
    const add = await ex('course_add', { courses: [{ name: '統計学', slot: '月曜3限', credits: 2, category: '選択' }, { name: '経済学', slot: '火2', credits: 2, category: '選択', status: '履修' }] }); assert.equal(add.body.ok, true); assert.equal(add.body.result.added.length, 2);
    const [a, b] = add.body.result.added; assert.equal(a.status, '候補');
    const sg = await ex('course_suggest', {}); assert.equal(sg.body.ok, true); assert.deepEqual(sg.body.result.proposals.map((p) => p.name), ['統計学']);
    const up = await ex('course_update', { ids: [a.id], status: '履修' }); assert.equal(up.body.ok, true); assert.equal(up.body.result.updated.length, 1);
    const sum = await ex('course_summary', {}); assert.equal(sum.body.ok, true); assert.equal(sum.body.result.credits.registered, 4); assert.equal(sum.body.result.term, currentTerm());
    const ask = await ex('course_cancel', { id: b.id }); assert.equal(ask.body.needsApproval, true, 'by voice: an approval card');
    assert.equal((await ex('course_cancel', { id: b.id, confirmed: true })).body.ok, true);
    assert.equal((await ex('course_add', { name: 'x', slot: '月3' })).body.ok, false, 'a missing credit count is explained, not guessed');
    assert.equal((await ex('course_view', {})).body.ok, false, 'course_view runs in the page');
  });
  await withVault(async () => { const r = await executeGoogle({ tool: 'course_summary', args: {} }); assert.equal(r.body.ok, true); assert.equal(r.body.result.empty, true); });
});

test('tools: shift_suggest / shift_summary include the 履修 classes (Google not connected → classes alone still colour the calendar)', async () => {
  await withVault(async () => {
    const ex = (tool, args) => executeGoogle({ tool, args });
    await ex('shift_job', { name: 'コンビニ', hourly: 1000, transport: 0 }); await ex('shift_goal', { key: '月収目標', value: 30000 });
    const month = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
    // the term in force this month (whatever "now" is): add a class on every weekday of the first teaching term found
    const { termForDate } = await import('../server/course.js');
    const days = Array.from({ length: 28 }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`).filter((d) => termForDate(d, parseSettings('').ranges));
    if (!days.length) return;   // a vacation month: nothing to link (covered by the pure tests)
    const term = termForDate(days[0], parseSettings('').ranges);
    for (const d of ['月', '火', '水', '木', '金']) await ex('course_add', { name: `授業${d}`, slot: `${d}1-4`, credits: 2, status: '履修', term });
    const sum = await ex('shift_summary', {}); assert.equal(sum.body.ok, true);
    const busyDays = Object.values(sum.body.result.calendarDays).filter((x) => x.status === 'busy' || x.status === 'check');
    assert.ok(busyDays.length > 0 && busyDays.every((x) => x.items.some((i) => /授業/.test(i.title)))); assert.match(sum.body.result.calendarNote, /履修の授業/);
  });
});
