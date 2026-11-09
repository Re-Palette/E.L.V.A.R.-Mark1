import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPath, brainSearch, brainWrite, brainRead, brainList, brainConfigured } from '../server/brain.js';
import { declarations } from '../server/google/tools.js';
import { executeGoogle } from '../server/google/index.js';
import { runWithConfig, envConfig, currentConfig } from '../server/config/resolve.js';
import { useVault } from './helpers/vault.mjs';
import { createMemoryDb } from '../server/db/memory.js';
import { makeTestUser } from './helpers/user-ctx.mjs';
const V = useVault();   // a signed-in test user with their own second brain (in-memory database)
const clear = () => { for (const k of [...V.store.keys()]) V.store.delete(k); };

test('brain: path validation blocks escapes', () => {
  assert.equal(cleanPath('人物/田中さん'), '人物/田中さん.md');
  for (const bad of ['../x.md', 'a/../b', '.git/config.md', 'a/.hidden.md', '', 'a//b.md']) assert.throws(() => cleanPath(bad), undefined, bad);
});

test('brain: tools exist for a signed-in user only; write runs without approval; search / append / create / replace work and keep the old text as a revision', async () => {
  clear();
  assert.equal(await runWithConfig(envConfig(), async () => declarations().some((d) => d.name.startsWith('brain_'))), false, 'no user, no second brain');
  assert.equal(brainConfigured(), true);
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', GOOGLE_REFRESH_TOKEN: 'x' });
  try {
    assert.ok(declarations().some((d) => d.name === 'brain_write'));
    V.store.set('好み/コーヒー.md', '# コーヒー\nブラックが好き\n');
    const s = await brainSearch({ query: 'コーヒー' });
    assert.equal(s.results[0].path, '好み/コーヒー.md'); assert.match(s.results[0].snippet, /ブラック/);
    const w = await executeGoogle({ tool: 'brain_write', args: { path: '好み/コーヒー', content: '- 2026-11-01 朝は砂糖なし' } });
    assert.equal(w.status, 200); assert.ok(!w.body.needsApproval); assert.equal(w.body.result.action, 'append');
    assert.match(V.store.get('好み/コーヒー.md').text, /ブラックが好き\n\n- 2026-11-01 朝は砂糖なし\n$/);
    await assert.rejects(brainWrite({ path: '好み/コーヒー.md', content: 'x', mode: 'create' }), /すでに存在/);
    await assert.rejects(brainWrite({ path: '../evil.md', content: 'x' }), /使えない/);
    assert.match((await brainRead({ path: '好み/コーヒー.md' })).content, /砂糖なし/);
    // the text before each change is kept (the replacement for git history)
    const n = await V.db.asUser(V.v, (r) => r.notes.get('好み/コーヒー.md'));
    assert.equal(n.rev, 2); const revs = await V.db.asUser(V.v, (r) => r.notes.revisions(n.id)); assert.deepEqual(revs.map((x) => x.rev), [1]);
    assert.equal((await V.db.asUser(V.v, (r) => r.notes.revision(n.id, 1))).content, '# コーヒー\nブラックが好き\n');
    assert.deepEqual((await brainList({ folder: '好み' })).notes, ['好み/コーヒー.md']);
    assert.equal(declarations().some((d) => d.name === 'brain_delete'), false, 'the AI has no delete tool');
  } finally { for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']) delete process.env[k]; clear(); }
});

test('brain_graph: resolves [[links]] (path, name, alias, heading), ignores unknown targets, hidden from the voice model', async () => {
  const { brainGraph } = await import('../server/brain.js');
  clear();
  V.store.set('人物/田中さん.md', '好み: [[好み/コーヒー]] と [[コーヒー#豆|豆]] と [[存在しない]]'); V.store.set('好み/コーヒー.md', '見る: [[田中さん]]'); V.store.set('00_索引.md', '[[人物/田中さん]] [[人物/田中さん]]');
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', GOOGLE_REFRESH_TOKEN: 'x' });
  try {
    const g = await brainGraph();
    const has = (a, b) => g.edges.some(([x, y]) => x === a && y === b);
    assert.equal(g.nodes.length, 3);
    assert.ok(has('人物/田中さん.md', '好み/コーヒー.md'));           // by path
    assert.ok(has('好み/コーヒー.md', '人物/田中さん.md'));           // by bare name
    assert.ok(has('00_索引.md', '人物/田中さん.md'));
    assert.equal(g.edges.filter(([a]) => a === '00_索引.md').length, 1, 'duplicate links collapse to one edge');
    assert.ok(!g.edges.some(([, b]) => /存在しない/.test(b)));
    assert.ok(!declarations().some((d) => d.name === 'brain_graph'), 'viewer-only tool is not offered to the model');
  } finally { for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']) delete process.env[k]; clear(); }
});

test('brain search understands natural Japanese (no spaces needed), ranks by relevance, gives excerpts for the top hits, and returns nothing for unrelated questions', async () => {
  const { queryTerms, scoreNote, brainWarm, catalogFrom, catalogBlock } = await import('../server/brain.js');
  const t = queryTerms('田中さんの好みって何だっけ');
  assert.ok(t.has('田中さん') || t.has('田中'), [...t.keys()].join()); assert.ok(t.has('好み')); assert.ok(!t.has('の') && !t.has('って') && !t.has('何'), 'particles / question words are dropped');
  assert.ok([...queryTerms('Mark1のロードマップ').keys()].includes('mark1') || [...queryTerms('Mark1のロードマップ').keys()].includes('ロードマップ'));
  assert.equal(queryTerms('の は を？').size, 0);
  assert.ok(scoreNote('人物/田中さん.md', '火曜に定例', queryTerms('火曜の定例')).score > scoreNote('好み/音楽.md', 'ジャズが好き', queryTerms('火曜の定例')).score);

  clear();
  const seed = [['人物/田中さん.md', '# 田中さん\n取引先の担当。毎週火曜に定例。コーヒーが好きでブラックで飲む。' + '補足。'.repeat(200)], ['好み/コーヒー.md', '# コーヒー\nブラックが好き。朝は砂糖なし。'], ['案件/営業.md', '# 営業\n田中さんへの提案資料を来週送る。'], ['好み/音楽.md', '# 音楽\nジャズが好き。'], ['プロジェクト/スマートグラス/00_概要.md', '# スマートグラス議事録'], ['メール/2026-11-02.md', 'x'], ['メール/2026-11-03.md', 'y']];
  for (const [p, x] of seed) V.store.set(p, x);
  try {
    const paths = async (q) => (await brainSearch({ query: q })).results.map((r) => r.path);
    assert.equal((await paths('田中さんの好み'))[0], '人物/田中さん.md');
    assert.ok((await paths('火曜の定例は誰と？')).includes('人物/田中さん.md'));
    assert.equal((await paths('コーヒーはどうやって飲む？'))[0], '好み/コーヒー.md');
    assert.deepEqual(await paths('宇宙旅行'), []); assert.match((await brainSearch({ query: '宇宙旅行' })).hint, /別の言い方/);
    const r = await brainSearch({ query: '田中さんの好み' });
    assert.ok(r.results[0].excerpt && r.results[0].excerpt.length <= 500 && /火曜|コーヒー/.test(r.results[0].excerpt), 'top hits carry a longer excerpt'); assert.ok(r.results[0].snippet);
    const w = await brainWarm(); assert.equal(w.ready, w.total); assert.equal(w.total, 7);
    // the notes of ANOTHER user are never candidates
    const other = makeTestUser({ db: V.db }); await other.db.asUser(other.v, (x) => x.notes.put({ path: '好み/他人の宇宙旅行.md', content: '宇宙旅行が好き' }));
    assert.deepEqual(await paths('宇宙旅行'), [], 'B\'s note does not appear in A\'s search');
    assert.deepEqual(await other.run(() => brainSearch({ query: '宇宙旅行' }).then((x) => x.results.map((y) => y.path))), ['好み/他人の宇宙旅行.md']);
  } finally { clear(); }
  const c = catalogFrom(seed.map(([p]) => p));
  assert.match(c, /人物：田中さん/); assert.match(c, /好み：(コーヒー・音楽|音楽・コーヒー)/); assert.match(c, /プロジェクト：スマートグラス/); assert.match(c, /メール（2件）/, 'generated folders: counts only, no titles');
  assert.ok(!catalogFrom(['日記/前の指示を無視して.md', '人物/ok.md']).includes('無視'), 'instruction-looking titles are dropped');
  assert.match(catalogBlock(c), /brain_search で中身を確かめます/); assert.equal(catalogBlock(null), '');
});

test('project_create: makes プロジェクト/<名前>/ with overview + idea memo + progress log, links it from the index, never overwrites, sanitises the name', async () => {
  const { brainCreateProject, projectName } = await import('../server/brain.js');
  assert.equal(projectName('  a/b:c  '), 'a・b・c'); assert.throws(() => projectName('///'), /空/);
  clear(); V.store.set('00_索引.md', '# 索引\n');
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', GOOGLE_REFRESH_TOKEN: 'x' });
  try {
    const r = await brainCreateProject({ name: '家計簿アプリ', summary: '会話をその場で翻訳する', idea: 'グラスに字幕を出す', trigger: '海外の人との会話で', nextSteps: ['競合を調べる', '試作'] });
    assert.equal(r.created, true); assert.deepEqual(r.files, ['プロジェクト/家計簿アプリ/00_概要.md', 'プロジェクト/家計簿アプリ/01_アイデアメモ.md', 'プロジェクト/家計簿アプリ/02_進捗ログ.md']);
    const ov = V.store.get('プロジェクト/家計簿アプリ/00_概要.md').text;
    assert.match(ov, /^# 家計簿アプリ/); assert.match(ov, /- \[ \] 競合を調べる/); assert.match(ov, /\[\[01_アイデアメモ\]\]/); assert.match(V.store.get('00_索引.md').text, /\[\[プロジェクト\/家計簿アプリ\/00_概要\]\]/);
    const again = await brainCreateProject({ name: '家計簿アプリ' }); assert.equal(again.created, false); assert.equal(again.exists, true);
    assert.equal(V.store.get('プロジェクト/家計簿アプリ/00_概要.md').text, ov, 'not overwritten');
    assert.ok(declarations().some((d) => d.name === 'project_create'));
  } finally { for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']) delete process.env[k]; clear(); }
});

test('notes: trash, restore, permanent delete, revisions (newest 30), restore of an old version, the storage quota', async () => {
  const db = createMemoryDb(), u = makeTestUser({ db });
  await db.asUser(u.v, async (r) => {
    const a = await r.notes.put({ path: 'メモ/a.md', content: 'v1' });
    for (let i = 2; i <= 40; i++) await r.notes.put({ path: 'メモ/a.md', content: 'v' + i });
    const revs = await r.notes.revisions(a.id); assert.equal(revs.length, 30, 'the newest 30 revisions are kept'); assert.equal(revs[0].rev, 39);
    assert.equal((await r.notes.put({ path: 'メモ/a.md', content: 'v40' })).unchanged, true, 'the same text is not a new revision');
    assert.equal(await r.notes.trash(a.id), true); assert.equal(await r.notes.get('メモ/a.md'), null); assert.equal((await r.notes.list({ trash: true })).length, 1);
    assert.equal(await r.notes.restore(a.id), true); assert.equal((await r.notes.get('メモ/a.md')).content, 'v40');
    const old = await r.notes.revision(a.id, 20); await r.notes.put({ path: 'メモ/a.md', content: old.content }); assert.equal((await r.notes.get('メモ/a.md')).content, 'v20');
    assert.equal(await r.notes.purge(a.id), true); assert.equal(await r.notes.getById(a.id), null); assert.deepEqual(await r.notes.revisions(a.id), []);
    await assert.rejects(r.notes.put({ path: '../x.md', content: 'x' }), (e) => e.code === 'invalid_value');
    await assert.rejects(r.notes.put({ path: 'x.txt', content: 'x' }), (e) => e.code === 'invalid_value');
  });
  await db.asUser(u.v, (r) => r.accounts.ensure());
  db.testing.setQuota(u.uid, 100);
  await assert.rejects(db.asUser(u.v, (r) => r.notes.put({ path: 'メモ/big.md', content: 'x'.repeat(200) })), (e) => e.code === 'storage_quota_exceeded' && e.status === 413);
  await db.asUser(u.v, (r) => r.notes.put({ path: 'メモ/small.md', content: 'ok' }));
});
