import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, buildStatus, issueBody, REQUEST_HEAD, buildConfigured } from '../server/build.js';
import { diffBuilds, noteForBuild } from '../web/src/builds.js';
import { declarations, TOOL_MAP } from '../server/google/tools.js';
import { executeGoogle } from '../server/google/index.js';

const BRIEF = '# 翻訳アプリ 企画書\n## 目的\n海外の人との会話をその場で翻訳する。'.padEnd(200, '。');
const withEnv = async (fn) => { const keep = { ...process.env }; Object.assign(process.env, { BUILD_REPO: 'me/build', BUILD_GITHUB_TOKEN: 'ghp_b', BRAIN_GITHUB_TOKEN: 'ghp_x', BRAIN_REPO: 'me/vault' }); delete process.env.BRAIN_DIR; delete process.env.SARASHINA_API_KEY; delete process.env.GEMINI_API_KEY; const real = globalThis.fetch; try { return await fn(); } finally { globalThis.fetch = real; for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); } };

test('build_request: the owner\'s own request goes straight to Claude Code after ONE confirmation (no 企画書); approval lines are an array; nothing is sent before approval; refuses a too-short request', async () => {
  await withEnv(async () => {
    assert.ok(buildConfigured());
    const calls = [];
    globalThis.fetch = async (u, o = {}) => {
      u = String(u); calls.push(`${o.method || 'GET'} ${u.replace('https://api.github.com', '')}`);
      if (u.endsWith('/labels')) return { ok: false, status: 422, json: async () => ({ message: 'already_exists' }) };
      if (u.endsWith('/issues')) { const b = JSON.parse(o.body); assert.match(b.title, /^\[製作\] ボタンHello$/); assert.ok(b.body.startsWith('## 依頼（E.L.V.A.R.より）\n@claude')); assert.ok(b.body.includes('ボタンを押すとHelloと出る')); assert.ok(!b.body.includes('企画書に従って')); assert.deepEqual(b.labels, ['elvar-build']); return { ok: true, status: 201, json: async () => ({ number: 7, html_url: 'https://github.com/me/build/issues/7', title: b.title }) }; }
      return { ok: false, status: 404, json: async () => ({ message: 'nf' }) };
    };
    const args = { title: 'ボタンHello', request: 'ボタンを押すとHelloと出る、1枚のWebページを作ってほしい。スマホでも見やすく。' };
    const first = await executeGoogle({ tool: 'build_request', args });
    assert.equal(first.body.needsApproval, true); assert.ok(Array.isArray(first.body.summary), 'the approval card maps over lines');
    assert.ok(first.body.summary.some((l) => /ボタンを押すとHelloと出る/.test(l)) && first.body.summary.some((l) => /me\/build/.test(l)));
    assert.ok(!calls.some((c) => c.startsWith('POST')), 'nothing sent before approval');
    const done = await executeGoogle({ tool: 'build_request', args, ticket: first.body.ticket });
    assert.equal(done.body.ok, true); assert.equal(done.body.result.number, 7);
    await assert.rejects(() => buildRequest({ title: 'x', request: '短い' }), /短すぎ/);
  });
});

test('confirmation card: a plain spoken 「はい」 approves, 「やめて」 rejects, 「直して」 asks for edits; long or unrelated speech never counts', async () => {
  const { classifyReply } = await import('../web/src/approval.js');
  for (const t of ['はい', 'はい。', 'はい、お願いします', 'お願いします', '依頼して', '依頼してください', '送って', 'OK', 'オーケー', 'いいよ', 'それでお願い', '大丈夫です', 'はいお願い']) assert.equal(classifyReply(t), 'yes', t);
  for (const t of ['いいえ', 'やめて', 'やめる', 'キャンセル', 'だめ', '依頼しない']) assert.equal(classifyReply(t), 'no', t);
  for (const t of ['直して', 'ちょっと待って', '修正して']) assert.equal(classifyReply(t), 'edit', t);
  for (const t of ['', 'はい、それはいいんですけど、もう少し詳しく説明してもらえますか', '今日の天気は？', 'ありがとう', 'こんにちは', 'お願い事があるんだけど長い話']) assert.equal(classifyReply(t), null, t);
});

test('build_status: queued -> working (Claude commented) -> PR (review) -> merged (done); summary of the last report; signature changes', async () => {
  await withEnv(async () => {
    let phase = 0;
    globalThis.fetch = async (u) => {
      u = String(u).replace('https://api.github.com', ''); const ok = (j) => ({ ok: true, status: 200, json: async () => j });
      if (u.startsWith('/repos/me/build/issues?')) return ok([{ number: 7, title: '[製作] 翻訳アプリ', state: phase >= 3 ? 'closed' : 'open', html_url: 'u7', updated_at: new Date().toISOString() }]);
      if (u.startsWith('/repos/me/build/pulls')) return ok(phase >= 2 ? [{ number: 8, body: 'Closes #7', head: { ref: 'claude/issue-7-x' }, html_url: 'p8', state: phase >= 3 ? 'closed' : 'open', merged_at: phase >= 3 ? '2026-11-04' : null, draft: false, title: 't' }] : []);
      if (u.startsWith('/repos/me/build/actions/runs')) return ok({ workflow_runs: [] });
      if (u.includes('/issues/7/comments')) return ok(phase >= 1 ? [{ id: 1, body: '## 依頼（E.L.V.A.R.より）\n@claude', user: { login: 'me' }, created_at: 'a' }, { id: 2, body: 'Claude Code: 実装しました。`npm start` で動きます。未対応：音声入力。', user: { login: 'claude[bot]' }, created_at: 'b' }] : [{ id: 1, body: '## 依頼（E.L.V.A.R.より）\n@claude', user: { login: 'me' }, created_at: 'a' }]);
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const sigs = [], states = [];
    for (phase = 0; phase <= 3; phase++) { const r = await buildStatus({}); const b = r.builds[0]; sigs.push(b.signature); states.push(b.state); if (phase >= 1) assert.match(b.summary, /実装しました/); }
    assert.deepEqual(states, ['queued', 'working', 'review', 'done']); assert.equal(new Set(sigs).size, 4, 'every step changes the signature');
  });
});

test('builds watcher: new states are announced, old finished builds and the one just requested are silent; the spoken note is honest', () => {
  const b = (o) => ({ number: 7, title: '翻訳アプリ', state: 'working', stateLabel: '作業中', summary: '実装しました', signature: 'working|2|', pr: null, ...o });
  assert.equal(diffBuilds([b({ state: 'done', signature: 'x' })], {}).length, 0, 'old finished, first sight: silent');
  assert.equal(diffBuilds([b({ state: 'queued', signature: 'q' })], {}).length, 0, 'just requested: silent');
  assert.equal(diffBuilds([b()], { 7: 'queued||' }).length, 1); assert.equal(diffBuilds([b()], { 7: 'working|2|' }).length, 0);
  assert.equal(diffBuilds([b({ state: 'review', signature: 'r' })], {}).length, 1, 'a build that moved on while away is announced');
  const n = noteForBuild(b({ state: 'review', stateLabel: 'PRができました（確認待ち）', pr: { number: 8, merged: false, draft: false } }));
  assert.match(n, /PR作成|PRができました/); assert.match(n, /確認は未了/); assert.match(n, /Pull Request #8/);
});

test('spec agent: writes only 製作/<名前>/*.md (create/append), its 企画書 is shown as a PDF card, it cannot send or build', async () => {
  const { AGENTS } = await import('../server/agents/registry.js'); const a = AGENTS.spec;
  assert.equal(a.guard('brain_write', { path: '製作/翻訳アプリ/企画書.md', mode: 'create' }), null);
  assert.ok(a.guard('brain_write', { path: '製作/企画書.md' })); assert.ok(a.guard('brain_write', { path: 'プロジェクト/x/00_概要.md' })); assert.ok(a.guard('brain_write', { path: '製作/a/企画書.md', mode: 'replace' }));
  assert.ok(a.artifactPattern.test('製作/翻訳アプリ/企画書.md') && !a.artifactPattern.test('製作/翻訳アプリ/結果.md'));
  assert.ok(!a.tools.some((t) => /build_|gmail_|tasks_|calendar_/.test(t))); assert.match(a.system(), /依頼はしない/);
});

test('self-modification: target=self goes to BUILD_SELF_REPO with the PR-only / tests-must-pass rules; approval says it changes ELVAR itself; status merges both repos with distinct keys', async () => {
  await withEnv(async () => {
    process.env.BUILD_SELF_REPO = 'me/elvar';
    const posts = [];
    globalThis.fetch = async (u, o = {}) => {
      u = String(u).replace('https://api.github.com', '');
      if (o.method === 'POST' && u.endsWith('/labels')) return { ok: true, status: 201, json: async () => ({}) };
      if (o.method === 'POST' && u.endsWith('/issues')) { posts.push([u, JSON.parse(o.body)]); return { ok: true, status: 201, json: async () => ({ number: 3, html_url: 'https://github.com/me/elvar/issues/3', title: JSON.parse(o.body).title }) }; }
      if (u.startsWith('/repos/me/elvar/issues?')) return { ok: true, status: 200, json: async () => ([{ number: 3, title: '[自己改造] シフト画面', state: 'open', html_url: 'u3', updated_at: new Date().toISOString() }]) };
      if (u.startsWith('/repos/me/build/issues?')) return { ok: true, status: 200, json: async () => ([{ number: 3, title: '[製作] 別のもの', state: 'open', html_url: 'u3b', updated_at: new Date(Date.now() - 1000).toISOString() }]) };
      if (/\/pulls|\/actions\/runs/.test(u)) return { ok: true, status: 200, json: async () => (u.includes('actions') ? { workflow_runs: [] } : []) };
      if (/\/comments/.test(u)) return { ok: true, status: 200, json: async () => [] };
      return { ok: false, status: 404, json: async () => ({ message: 'nf' }) };
    };
    const args = { title: 'シフト画面の改善', target: 'self', request: 'シフト画面のカレンダーに、祝日を表示してほしい。見た目は今のままで。' };
    const ask = await executeGoogle({ tool: 'build_request', args });
    assert.equal(ask.body.needsApproval, true); assert.ok(ask.body.summary.some((l) => /自身/.test(l)) && ask.body.summary.some((l) => /me\/elvar/.test(l)));
    assert.equal(posts.length, 0, 'nothing sent before approval');
    const done = await executeGoogle({ tool: 'build_request', args, ticket: ask.body.ticket });
    assert.equal(done.body.ok, true); assert.equal(done.body.result.target, 'self');
    const [url, b] = posts[0]; assert.equal(url, '/repos/me/elvar/issues'); assert.match(b.title, /^\[自己改造\]/);
    assert.ok(b.body.includes('main へ直接コミット') && b.body.includes('npm test') && b.body.includes('承認'), 'PR only, tests must pass, approval logic stays');
    const st = await buildStatus({ summarizeComments: false });
    assert.equal(st.builds.length, 2); assert.deepEqual(st.builds.map((x) => x.key).sort(), ['3', 'me/elvar#3']); assert.equal(st.builds.find((x) => x.self).title, 'シフト画面');
    process.env.BUILD_REPO = ''; assert.ok(buildConfigured(), 'self alone is enough to use the tool');
    await assert.rejects(() => buildRequest({ title: 'x', request: 'あいうえおかきくけこさしすせそ' }), /BUILD_REPO/);
  });
});

test('build progress: stage is derived from facts only (queued / working / draft PR / ready PR with failing checks / merged); percent is a stage indicator', async () => {
  const { progressOf, STAGES } = await import('../server/build.js');
  const issue = { state: 'open' };
  const at = (f) => progressOf({ issue, ...f });
  assert.equal(at({}).stage, 'received'); assert.equal(at({}).percent, 8);
  assert.equal(at({ runSeen: true }).stage, 'started'); assert.equal(at({ running: true }).stage, 'started');
  assert.equal(at({ botCommented: true, running: true }).stage, 'implementing');
  assert.equal(at({ pr: { draft: true } }).stage, 'pr');
  const bad = at({ pr: { draft: false }, checks: { state: 'failure' } });
  assert.equal(bad.stage, 'checks'); assert.match(bad.problem, /失敗/); assert.equal(at({ pr: { draft: false }, checks: { state: 'pending' } }).stage, 'checks');
  assert.equal(at({ pr: { draft: false }, checks: { state: 'success' } }).stage, 'review'); assert.equal(at({ pr: { draft: false }, checks: { state: 'unknown' } }).stage, 'review');
  const done = progressOf({ issue: { state: 'closed' }, pr: { merged_at: 'x' } });
  assert.equal(done.stage, 'done'); assert.equal(done.percent, 100); assert.ok(done.stages.every((s) => s.done && !s.current));
  const w = at({ botCommented: true }); assert.equal(w.stages.length, STAGES.length); assert.deepEqual(w.stages.map((s) => s.done), [true, true, false, false, false, false, false]); assert.equal(w.stages.filter((s) => s.current).length, 1);
  assert.match(w.note, /目安/); assert.match(w.note, /予測ではありません/);
});

test('build usage: runs are bucketed per hour (24h) and per JST day (7d); 5 h / 7 d totals; optional run limit gives a ratio; no limit -> no ratio', async () => {
  const { aggregateUsage, runMinutes } = await import('../server/build.js');
  const now = Date.parse('2026-11-05T12:00:00Z'), H = 3600e3;
  const run = (agoH, min, extra = {}) => ({ name: 'Claude Code', status: 'completed', run_started_at: new Date(now - agoH * H).toISOString(), created_at: new Date(now - agoH * H).toISOString(), updated_at: new Date(now - agoH * H + min * 60000).toISOString(), ...extra });
  const runs = [run(0.5, 10), run(1.5, 20), run(1.6, 5), run(4, 30), run(6, 12), run(30, 8), run(100, 15), run(200, 99)];
  const u = aggregateUsage(runs, now);
  assert.deepEqual(u.last5h, { runs: 4, minutes: 65 }); assert.deepEqual(u.last7d, { runs: 7, minutes: 100 });
  assert.equal(u.hourly.length, 24); assert.equal(u.hourly[23].runs, 1); assert.equal(u.hourly[22].runs, 2); assert.equal(u.hourly[22].minutes, 25); assert.equal(u.hourly.reduce((s, b) => s + b.runs, 0), 5);
  assert.equal(u.daily.length, 7); assert.equal(u.daily.at(-1).date, '2026-11-05'); assert.equal(u.daily.reduce((s, d) => s + d.runs, 0), 7);
  assert.equal(u.ratio5h, null); assert.equal(u.runLimit5h, null); assert.match(u.label, /直近5時間 4回・合計65分／直近7日 7回/); assert.match(u.caveat, /\/usage/);
  assert.equal(aggregateUsage(runs, now, '10').ratio5h, 0.4);
  assert.equal(Math.round(runMinutes({ status: 'in_progress', created_at: new Date(now - 7 * 60000).toISOString() }, now)), 7, 'a running run counts up to now');
  assert.equal(aggregateUsage([], now).last5h.runs, 0);
});

test('build limit detection: a sample bot comment is flagged (hedged), with excerpt and reset hint; ordinary comments and failed runs are not claimed as the limit', async () => {
  const { detectLimit, resetHintOf } = await import('../server/build.js');
  const now = Date.parse('2026-11-05T12:00:00Z'), at = new Date(now - 3600e3).toISOString();
  const hit = detectLimit({ botComments: [{ body: 'Claude AI usage limit reached|1762340400. Your limit resets at 3pm (Asia/Tokyo). See https://example.com/x', at }], now });
  assert.equal(hit.hit, true); assert.match(hit.text, /usage limit reached/); assert.ok(!/https?:/.test(hit.text)); assert.match(hit.resetHint, /resets at 3pm/); assert.match(hit.note, /思われる/);
  assert.equal(detectLimit({ botComments: [{ body: '実装しました。週の上限に達したと表示されました。2時間後にリセットされます', at }], now }).hit, true);
  assert.match(resetHintOf('2時間30分後にリセットされます'), /2時間30分後にリセット/); assert.equal(resetHintOf('ふつうの文章'), null);
  assert.equal(detectLimit({ botComments: [{ body: '実装しました。`npm start` で動きます。', at }], now }).hit, false);
  assert.equal(detectLimit({ botComments: [{ body: 'usage limit reached', at: new Date(now - 9 * 864e5).toISOString() }], now }).hit, false, 'old messages are not today\'s limit');
  const f = detectLimit({ botComments: [], latestRun: { conclusion: 'failure', updated_at: at }, now }); assert.equal(f.hit, false); assert.equal(f.suspect, true);
});

test('build_status end to end: progress / elapsed / PR stats / checks / run / usage / limit come from stubbed GitHub; missing permissions fail soft', async () => {
  await withEnv(async () => {
    delete process.env.BUILD_SELF_REPO; delete process.env.CLAUDE_SESSION_RUN_LIMIT;
    const now = Date.now(), iso = (agoMin) => new Date(now - agoMin * 60000).toISOString();
    let denyExtras = false;
    globalThis.fetch = async (u) => {
      u = String(u).replace('https://api.github.com', ''); const ok = (j) => ({ ok: true, status: 200, json: async () => j }), no = { ok: false, status: 403, json: async () => ({ message: 'Resource not accessible' }) };
      if (u.startsWith('/repos/me/build/issues?')) return ok([
        { number: 1, title: '[製作] 待ちの物', state: 'open', html_url: 'u1', created_at: iso(10), updated_at: iso(10) },
        { number: 2, title: '[製作] 作業中の物', state: 'open', html_url: 'u2', created_at: iso(60), updated_at: iso(5) },
        { number: 3, title: '[製作] チェック失敗の物', state: 'open', html_url: 'u3', created_at: iso(300), updated_at: iso(20) },
        { number: 4, title: '[製作] 完成した物', state: 'closed', html_url: 'u4', created_at: iso(600), closed_at: iso(100), updated_at: iso(100) }]);
      if (u.startsWith('/repos/me/build/pulls?')) return ok([
        { number: 13, body: 'Closes #3', head: { ref: 'claude/issue-3-x', sha: 'sha3' }, html_url: 'p13', state: 'open', merged_at: null, draft: false, title: 'PR3' },
        { number: 14, body: 'Closes #4', head: { ref: 'claude/issue-4-x', sha: 'sha4' }, html_url: 'p14', state: 'closed', merged_at: iso(100), draft: false, title: 'PR4' }]);
      if (u.startsWith('/repos/me/build/actions/runs')) return denyExtras ? no : ok({ workflow_runs: [
        { name: 'Claude Code', path: '.github/workflows/claude.yml', event: 'issues', status: 'in_progress', head_branch: 'main', display_title: '[製作] 作業中の物', run_started_at: iso(4), created_at: iso(4), updated_at: iso(1), html_url: 'r1' },
        { name: 'Claude Code', path: '.github/workflows/claude.yml', event: 'issue_comment', status: 'completed', conclusion: 'success', head_branch: 'claude/issue-3-x', display_title: 'x', run_started_at: iso(90), created_at: iso(90), updated_at: iso(60), html_url: 'r2' },
        { name: 'CI', path: '.github/workflows/ci.yml', event: 'push', status: 'completed', conclusion: 'success', run_started_at: iso(30), created_at: iso(30), updated_at: iso(20) }] });
      if (u.includes('/comments')) {
        const n = Number(u.match(/issues\/(\d+)/)[1]);
        return ok(n === 1 ? [] : n === 3 ? [{ id: 31, body: 'Claude Code: 実装しました', user: { login: 'claude[bot]' }, created_at: iso(30) }] : [{ id: n * 10, body: n === 2 ? 'Claude Code: usage limit reached. Your limit resets at 3pm.' : '完了', user: { login: 'claude[bot]' }, created_at: iso(6) }]);
      }
      if (u === '/repos/me/build/pulls/13') return denyExtras ? no : ok({ changed_files: 5, additions: 120, deletions: 7, commits: 3 });
      if (u.startsWith('/repos/me/build/commits/sha3/check-runs')) return denyExtras ? no : ok({ check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }] });
      if (u.startsWith('/repos/me/build/commits/sha3/status')) return denyExtras ? no : ok({ total_count: 0, statuses: [] });
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const r = await buildStatus({ summarizeComments: false });
    const by = Object.fromEntries(r.builds.map((b) => [b.number, b]));
    assert.deepEqual([1, 2, 3, 4].map((n) => by[n].progress.stage), ['received', 'implementing', 'checks', 'done']);
    assert.equal(by[3].progress.problem, 'チェックが失敗しています'); assert.deepEqual(by[3].pr.stats, { changedFiles: 5, additions: 120, deletions: 7, commits: 3 });
    assert.equal(by[3].pr.checks.state, 'failure'); assert.equal(by[3].pr.checks.failed, 1); assert.equal(by[3].pr.checks.passed, 1);
    assert.equal(by[4].pr.stats, null, 'a merged PR costs no extra calls'); assert.equal(by[4].progress.percent, 100);
    assert.equal(by[1].elapsedMin, 10); assert.equal(by[4].elapsedMin, 500, 'a finished build stops counting at the merge');
    assert.equal(by[2].run.status, 'in_progress'); assert.equal(by[3].run.count, 1); assert.equal(by[3].run.minutes, 30); assert.equal(by[1].run, null);
    assert.equal(r.usage.available, true); assert.equal(r.usage.last5h.runs, 2, 'the CI workflow is not Claude Code'); assert.equal(r.usage.last7d.runs, 2); assert.equal(r.usage.basis, 'claude-workflow');
    assert.equal(r.limit.hit, true); assert.match(r.limit.resetHint, /resets at 3pm/);
    // permissions missing: the same call still answers
    denyExtras = true;
    const d = await buildStatus({ summarizeComments: false }), by2 = Object.fromEntries(d.builds.map((b) => [b.number, b]));
    assert.equal(d.usage.available, false); assert.match(d.usage.error, /権限不足/); assert.equal(by2[3].pr.stats, null); assert.match(by2[3].pr.statsError, /権限不足/); assert.equal(by2[3].pr.checks.state, 'unknown'); assert.match(by2[3].pr.checks.error, /権限不足/);
    assert.equal(by2[3].progress.stage, 'review', 'unknown checks are not reported as failing'); assert.match(by2[1].run.error, /権限不足/); assert.equal(d.builds.length, 4);
    process.env.CLAUDE_SESSION_RUN_LIMIT = '10'; denyExtras = false; assert.equal((await buildStatus({ summarizeComments: false })).usage.ratio5h, 0.2); delete process.env.CLAUDE_SESSION_RUN_LIMIT;
  });
});

test('issueBody fills placeholders in our header only, never in the request text', () => {
  const b = issueBody('ページに「{{U}}」と{{A}}を表示する', 'request');
  assert.ok(!b.slice(0, b.indexOf('ページに')).includes('{{'), 'header filled');
  assert.ok(b.includes('ページに「{{U}}」と{{A}}を表示する'), 'request text untouched');
  const s = issueBody('{{TZ_LABEL}} のまま', 'self'); assert.ok(s.endsWith('{{TZ_LABEL}} のまま'));
});
