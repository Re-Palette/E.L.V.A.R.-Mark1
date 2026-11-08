import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProjects, termsOf, deadlinesIn } from '../server/project-intel.js';
import { projectIntelDue } from '../web/src/predict.js';

const NOW = Date.parse('2026-11-04T21:00:00+09:00');
const note = (path, text) => ({ path, text });
const P = (name, texts, lastUpdated) => ({ name, notes: texts.map((t, i) => note(`プロジェクト/${name}/${i}.md`, t)), lastUpdated });

const projects = [
  P('家計簿アプリ', ['# 家計簿アプリ\n## 次にやること\n- [ ] 競合を調べる\n- [ ] 試作を作る\n翻訳 リアルタイム 字幕 スマートグラス マイク 音声認識 を使う。', '音声認識 の精度が課題。字幕 の表示 が未解決。'], '2026-11-03T00:00:00Z'),
  P('ELVAR改善', ['# ELVAR改善\n期限：2026-11-06\n## 次にやること\n- [ ] 拍手の調整\n- [ ] 球の動き\n- [x] 挨拶\nELVAR 音声認識 マイク 字幕 リアルタイム を改善する。'], '2026-10-30T00:00:00Z'),
  P('古い案', ['# 古い案\n## アイデア\n- 何か作る\n- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d\n- [ ] e\n- [ ] f\n- [ ] g\n- [ ] h'], '2026-09-01T00:00:00Z'),
  P('レシピ整理', ['# レシピ整理\n## 次にやること\n- [ ] 写真を集める\n料理 レシピ 食材 献立 栄養 を整理。'], '2026-11-01T00:00:00Z'),
];
const conversations = [{ date: '2026-11-03', text: '### 20:00\n- **ご主人様**：家計簿アプリの字幕の表示について相談したい\n- **エルヴァー**：承知いたしました。\n### 20:10\n- **ご主人様**：今日の天気は？' }];

test('termsOf: distinctive Japanese / katakana / latin terms, stop words removed', () => {
  const t = termsOf('# プロジェクト\n字幕 の 表示。スマートグラス で ELVAR を 字幕 翻訳 する。メモ アイデア');
  assert.ok(t.includes('字幕') && t.includes('スマートグラス') && t.includes('elvar') && t.includes('翻訳')); assert.ok(!t.includes('プロジェクト') && !t.includes('アイデア') && !t.includes('メモ')); assert.equal(t[0], '字幕', 'most frequent first');
});
test('deadlinesIn: "期限：2026-11-06" and "提出は11月10日"; a month/day already past by 60+ days means next year', () => {
  assert.deepEqual(deadlinesIn('期限：2026-11-06', NOW).map((d) => d.date), ['2026-11-06']);
  assert.deepEqual(deadlinesIn('提出は11月10日です', NOW).map((d) => d.date), ['2026-11-10']);
  assert.deepEqual(deadlinesIn('リリース 1月5日', NOW).map((d) => d.date), ['2027-01-05']); assert.deepEqual(deadlinesIn('なにもなし', NOW), []);
});

test('project intelligence: health, risks, next action, mentions, deadlines — from the real text; weakest first', () => {
  const r = analyzeProjects({ projects, conversations, nowMs: NOW });
  const by = Object.fromEntries(r.projects.map((p) => [p.name, p]));
  assert.equal(r.count, 4); assert.equal(r.projects[0].name, '古い案', 'weakest first');
  assert.equal(by['古い案'].health, '注意'); assert.ok(by['古い案'].risks.some((x) => /日間、更新がありません/.test(x.text)) && by['古い案'].risks.some((x) => /手が付いていません/.test(x.text)));
  const bare = analyzeProjects({ projects: [P('空の案', ['# 空の案\n## アイデア\n- 何か'], '2026-08-01T00:00:00Z')], conversations: [], nowMs: NOW }).projects[0];
  assert.equal(bare.health, '注意'); assert.ok(bare.risks.some((x) => /次にやること/.test(x.text)) && /次の一手を1つ決める/.test(bare.nextAction));
  assert.equal(by['家計簿アプリ'].nextAction, '競合を調べる'); assert.ok(by['家計簿アプリ'].mentionsLast14d >= 1 && by['家計簿アプリ'].lastMentionedAt === '2026-11-03'); assert.ok(by['家計簿アプリ'].blockers.some((b) => /未解決/.test(b)));
  assert.equal(by['ELVAR改善'].deadline.inDays, 2); assert.ok(by['ELVAR改善'].risks.some((x) => x.severity === 'med' && /2日後/.test(x.text)));
  assert.equal(by['レシピ整理'].health, '良好'); assert.equal(by['レシピ整理'].mentionsLast14d, 0);
  assert.equal(r.summary.focus.project, 'ELVAR改善', 'closest deadline is the focus'); assert.ok(r.summary.atRisk.some((x) => x.startsWith('古い案')));
  assert.ok(r.summary.idle.includes('古い案'));
});

test('project intelligence: related projects found by shared terms or by naming each other; unrelated ones are not linked', () => {
  const r = analyzeProjects({ projects, conversations: [], nowMs: NOW });
  const rel = r.relations.find((x) => [x.a, x.b].sort().join() === ['ELVAR改善', '家計簿アプリ'].sort().join());
  assert.ok(rel && rel.shared.includes('字幕') && rel.shared.includes('音声認識') && /共通する言葉/.test(rel.reason), JSON.stringify(r.relations));
  assert.ok(!r.relations.some((x) => x.a === 'レシピ整理' || x.b === 'レシピ整理'), 'recipes are unrelated');
  const named = analyzeProjects({ projects: [P('A案', ['# A案\nこれは B案 に使える。']), P('B案', ['# B案\n別の話。'])], conversations: [], nowMs: NOW });
  assert.ok(named.relations[0].explicit && /名前/.test(named.relations[0].reason));
  assert.deepEqual(analyzeProjects({ nowMs: NOW }).projects, []);
});

test('pintel agent: writes only the dashboard (replace ok) and 進捗ログ (append/create); originals are protected; daily run after 20:00 once per date', async () => {
  const { AGENTS, AGENT_IDS } = await import('../server/agents/registry.js'); const a = AGENTS.pintel;
  assert.ok(AGENT_IDS.includes('pintel') && a.tools.includes('project_insights'));
  assert.equal(a.guard('brain_write', { path: 'プロジェクト/00_統合ダッシュボード.md', mode: 'replace' }), null);
  assert.equal(a.guard('brain_write', { path: 'プロジェクト/翻訳/02_進捗ログ.md', mode: 'append' }), null); assert.equal(a.guard('brain_write', { path: 'プロジェクト/翻訳/02_進捗ログ.md', mode: 'create' }), null);
  assert.ok(a.guard('brain_write', { path: 'プロジェクト/翻訳/02_進捗ログ.md', mode: 'replace' })); assert.match(a.guard('brain_write', { path: 'プロジェクト/翻訳/00_概要.md', mode: 'append' }), /元のノートは変更できません/); assert.ok(a.guard('brain_write', { path: '人物/x.md' }));
  assert.ok(!a.tools.some((t) => /gmail|tasks_|calendar_|build_/.test(t))); assert.match(a.system(), /計算し直さない/);
  const d = (h) => Date.parse(`2026-11-04T${h}:00+09:00`);
  assert.equal(projectIntelDue({ nowMs: d('19:00'), available: true }), false); assert.equal(projectIntelDue({ nowMs: d('20:30'), available: true }), true);
  assert.equal(projectIntelDue({ nowMs: d('20:30'), lastDay: '2026-11-04', available: true }), false); assert.equal(projectIntelDue({ nowMs: d('20:30'), available: false }), false);
  const { TOOL_MAP } = await import('../server/google/tools.js'); assert.ok(TOOL_MAP.project_insights && typeof TOOL_MAP.project_insights.run === 'function');
});

test('project screen helpers: relation map draws nodes + edges (dashed when one names the other), an empty map still draws; project_insights works without any project / without the vault', async () => {
  const { relationSvg, progressPct } = await import('../web/src/project-view.js');
  const svg = relationSvg([{ name: 'A案', health: '良好' }, { name: 'B案', health: '危険' }, { name: 'C案', health: '注意' }], [{ a: 'A案', b: 'B案', score: 0.5, explicit: true }, { a: 'B案', b: 'C案', score: 0.3, explicit: false }]);
  assert.equal((svg.match(/<circle/g) || []).length, 3); assert.equal((svg.match(/<line/g) || []).length, 2); assert.equal((svg.match(/stroke-dasharray/g) || []).length, 1); assert.match(svg, /#ff6b6b/);
  assert.match(relationSvg([], []), /プロジェクトがまだありません/); assert.equal(progressPct({ openTasks: 3, doneTasks: 1 }), 25); assert.equal(progressPct({ openTasks: 0, doneTasks: 0 }), 0);
  const keep = { ...process.env }; delete process.env.BRAIN_GITHUB_TOKEN; delete process.env.BRAIN_REPO; Object.assign(process.env, { GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', GOOGLE_REFRESH_TOKEN: 'x' });
  try {
    const { declarations } = await import('../server/google/tools.js'); assert.ok(declarations().some((d) => d.name === 'project_insights'), 'offered without the vault');
    const { executeGoogle } = await import('../server/google/index.js'); const r = await executeGoogle({ tool: 'project_insights', args: {} });
    assert.equal(r.status, 200); assert.equal(r.body.result.count, 0); assert.equal(r.body.result.unconfigured, true); assert.deepEqual(r.body.result.projects, []);
  } finally { for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); }
});
