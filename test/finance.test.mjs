import test from 'node:test';
import assert from 'node:assert/strict';
import { updateEntry, parseDateWord, setSubscription, parseSubscriptions, emptySummary, classify, normalizeEntry, parseLedger, addEntries, cancelEntry, setBudget, parseBudget, addAsset, parseAssets, addRule, summarize, findSubscriptions, parseCsv, parsePaymentNotification, financeSummary } from '../server/finance.js';
import { _resetPrivacy } from '../server/brain.js';
import { trendSvg, yen } from '../web/src/finance-view.js';
import { executeGoogle } from '../server/google/index.js';
import { enterTestUser } from './helpers/user-ctx.mjs';
enterTestUser();   // a signed-in test user: approval tickets are keyed to the user and consumed in their own database

const NOW = Date.parse('2026-11-15T12:00:00+09:00');
async function withVault(fn, { isPrivate = true } = {}) {
  const keep = { ...process.env }, real = globalThis.fetch, store = new Map(); let priv = isPrivate;
  Object.assign(process.env, { BRAIN_GITHUB_TOKEN: 't', BRAIN_REPO: 'me/vault', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', GOOGLE_REFRESH_TOKEN: 'x' }); delete process.env.BRAIN_DIR; _resetPrivacy();
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

test('classify: Japanese merchants / services go to the right category; the owner\'s own rules win; income is detected', () => {
  const c = (d, l) => classify(d, l);
  assert.equal(c('セブン-イレブン 渋谷店'), '食費'); assert.equal(c('Netflix'), 'サブスク'); assert.equal(c('JR東日本 Suica チャージ'), '交通'); assert.equal(c('東京電力'), '光熱費'); assert.equal(c('家賃 11月'), '住居');
  assert.equal(c('マツモトキヨシ'), '日用品'); assert.equal(c('ドコモ 利用料'), '通信'); assert.equal(c('給与 振込'), '収入'); assert.equal(c('よく分からない店'), 'その他');
  assert.equal(c('よく分からない店', [{ keyword: '分からない', category: '趣味・娯楽' }]), '趣味・娯楽'); assert.equal(c('セブン', [{ keyword: 'セブン', category: '日用品' }]), '日用品', 'owner rule beats the built-in one');
});

test('normalizeEntry: expenses are negative, income positive, defaults filled; bad input is refused', () => {
  const e = normalizeEntry({ amount: '1,200円', description: 'ランチ（ラーメン）' }, { nowMs: NOW });
  assert.deepEqual([e.date, e.amount, e.category], ['2026-11-15', -1200, '食費']);
  assert.equal(normalizeEntry({ amount: 250000, description: '給料', income: true }, { nowMs: NOW }).amount, 250000);
  assert.equal(normalizeEntry({ amount: -300, description: 'x店' }, { nowMs: NOW }).amount, -300, 'an expense given as negative stays an expense');
  assert.throws(() => normalizeEntry({ amount: 0, description: 'x' }), /金額/); assert.throws(() => normalizeEntry({ amount: 100, description: '' }), /内容/);
});

test('ledger: entries are appended to 家計/YYYY-MM.md (table, header once), dedupe for imports, month split, id stable, cancel removes one', async () => {
  await withVault(async ({ store }) => {
    const r1 = await addEntries([{ amount: 580, description: 'セブン-イレブン', date: '2026-11-03' }, { amount: 580, description: 'セブン-イレブン', date: '2026-11-03' }, { amount: 1490, description: 'Netflix', date: '2026-10-28' }], { nowMs: NOW });
    assert.equal(r1.added.length, 3, 'voice entries are never deduplicated (two coffees are two coffees)'); assert.notEqual(r1.added[0].id, r1.added[1].id);
    const nov = store.get('家計/2026-11.md').text; assert.match(nov, /^# 家計 2026-11/); assert.equal(nov.match(/\| id \| 日付/g).length, 1); assert.ok(store.get('家計/2026-10.md').text.includes('Netflix'));
    assert.deepEqual(parseLedger(nov).map((e) => [e.date, e.amount, e.category]), [['2026-11-03', -580, '食費'], ['2026-11-03', -580, '食費']]);
    const r2 = await addEntries([{ amount: 580, description: 'セブン-イレブン', date: '2026-11-03' }, { amount: 700, description: 'ファミマ', date: '2026-11-04' }], { nowMs: NOW, source: '取込', dedupe: true });
    assert.equal(r2.skipped, 1); assert.equal(r2.added.length, 1); assert.equal(store.get('家計/2026-11.md').text.match(/\| id \| 日付/g).length, 1, 'header not repeated');
    const id = parseLedger(store.get('家計/2026-11.md').text)[0].id; const c = await cancelEntry(id, '2026-11'); assert.equal(c.removed.id, id); assert.equal(parseLedger(store.get('家計/2026-11.md').text).length, 2);
    await assert.rejects(() => cancelEntry('ffffff', '2026-11'), /見つかりません/);
  });
});

test('finance data is never written to a public repo', async () => {
  await withVault(async () => { await assert.rejects(() => addEntries([{ amount: 100, description: 'x店' }], { nowMs: NOW }), /公開になっている/); await assert.rejects(() => setBudget({ amount: 1000 }), /公開になっている/); }, { isPrivate: false });
});

test('budget, assets and classification rules are saved as readable notes and read back', async () => {
  await withVault(async ({ store }) => {
    await setBudget({ amount: 150000 }); await setBudget({ category: '食費', amount: 40000 }); await setBudget({ category: '食費', amount: 45000 });
    assert.deepEqual(parseBudget(store.get('家計/予算.md').text), { 合計: 150000, 食費: 45000 }); await assert.rejects(() => setBudget({ category: 'ふしぎ', amount: 1 }), /カテゴリ/);
    await addAsset({ name: '預金', amount: '1,200,000円', date: '2026-10-01', nowMs: NOW }); await addAsset({ name: '預金', amount: 1250000, date: '2026-11-10' }); await addAsset({ name: '住宅ローン', amount: 8000000, kind: '負債', date: '2026-11-10' });
    assert.equal(parseAssets(store.get('家計/資産.md').text).length, 3);
    await addRule({ keyword: 'マイストア', category: '日用品' }); const r = await addEntries([{ amount: 900, description: 'マイストア 駅前' }], { nowMs: NOW }); assert.equal(r.added[0].category, '日用品', 'learned rule applied');
    await assert.rejects(() => addRule({ keyword: 'あ', category: '食費' }), /2文字/);
  });
});

test('summary: totals, categories, budget state, month-end projection, daily allowance, subscriptions, assets and honest suggestions', () => {
  const E = (date, amount, category, description) => ({ id: 'a', date, amount, category, description, method: '', source: '', note: '' });
  const cur = [E('2026-11-01', -80000, '住居', '家賃'), E('2026-11-02', -30000, '食費', 'スーパー'), E('2026-11-05', -1490, 'サブスク', 'Netflix'), E('2026-11-06', -980, 'サブスク', 'Spotify'), E('2026-11-07', -500, '食費', 'セブン'), E('2026-11-08', -500, '食費', 'セブン'), E('2026-11-09', -500, '食費', 'セブン'), E('2026-11-10', -500, '食費', 'セブン'), E('2026-11-11', -500, '食費', 'セブン'), E('2026-11-12', -500, '食費', 'セブン'), E('2026-11-01', 250000, '収入', '給与')];
  const hist = [E('2026-10-05', -1490, 'サブスク', 'Netflix'), E('2026-10-06', -980, 'サブスク', 'Spotify'), E('2026-10-02', -18000, '食費', 'スーパー'), E('2026-09-05', -1490, 'サブスク', 'Netflix')];
  const s = summarize({ month: '2026-11', entries: cur, history: hist, budget: { 合計: 100000, 食費: 25000 }, assets: [{ date: '2026-10-01', name: '預金', kind: '資産', amount: 1000000 }, { date: '2026-11-10', name: '預金', kind: '資産', amount: 1100000 }, { date: '2026-11-10', name: 'ローン', kind: '負債', amount: 300000 }], nowMs: NOW });
  assert.equal(s.spent, 80000 + 30000 + 1490 + 980 + 3000); assert.equal(s.income, 250000); assert.equal(s.categories[0].category, '住居');
  assert.equal(s.budgetTotal.state, '超過'); assert.ok(s.budgetTotal.projectedOver, '15 days in: ¥115,470 so far -> projected far over'); assert.equal(s.projected, Math.round(s.spent / 15 * 30));
  assert.equal(s.budgets[0].category, '食費'); assert.equal(s.budgets[0].state, '超過', '33,000 of 25,000');
  assert.deepEqual(s.subscriptions.map((x) => x.name).sort(), ['Netflix', 'Spotify']); assert.equal(s.subscriptionMonthly, 2470);
  assert.equal(s.assets.net, 800000); assert.equal(s.assets.change, -200000, 'net 800,000 now vs 1,000,000 a month ago (the loan was recorded only recently)');
  const kinds = s.suggestions.map((x) => x.kind); assert.ok(kinds.includes('increase') && kinds.includes('small') && kinds.includes('over-budget') && kinds.includes('duplicate-sub') === false, kinds.join());
  assert.ok(s.suggestions.every((x) => /¥[\d,]+/.test(x.text) || x.kind === 'sub-total'), 'every suggestion states its numbers'); assert.match(s.note, /目安/);
  assert.equal(summarize({ month: '2026-11', nowMs: NOW }).spent, 0);
});

test('subscriptions: same payee in 2+ months with a similar amount and day; a one-off is not a subscription; duplicate streaming services are flagged', () => {
  const E = (date, amount, description, category = 'その他') => ({ date, amount, description, category });
  const subs = findSubscriptions([E('2026-09-05', -1490, 'Netflix'), E('2026-10-05', -1490, 'Netflix'), E('2026-11-05', -1590, 'Netflix'), E('2026-10-20', -5000, '電器屋'), E('2026-10-07', -990, 'Prime Video'), E('2026-11-07', -990, 'Prime Video'), E('2026-11-03', -1200, 'ランチ')], NOW);
  assert.deepEqual(subs.map((s) => s.name).sort(), ['Netflix', 'Prime Video']); const n = subs.find((s) => s.name === 'Netflix'); assert.equal(n.monthly, 1590); assert.equal(n.annual, 1590 * 12); assert.equal(n.nextDate, '2026-12-05'); assert.equal(n.group, '動画配信');
  const s = summarize({ month: '2026-11', entries: [E('2026-11-05', -1590, 'Netflix'), E('2026-11-07', -990, 'Prime Video')], history: [E('2026-10-05', -1490, 'Netflix'), E('2026-10-07', -990, 'Prime Video')], nowMs: NOW });
  assert.ok(s.suggestions.some((x) => x.kind === 'duplicate-sub' && /動画配信/.test(x.text)));
});

test('import + notification parsing: card CSV lines and clear "paid" notifications become entries; ads and logins do not', () => {
  const rows = parseCsv('日付,内容,金額\n2026/11/03,"セブン-イレブン",580\n11月4日,Netflix,"1,490"\nただの文章');
  assert.deepEqual(rows.map((r) => [r.date, r.description, r.amount]), [['2026-11-03', 'セブン-イレブン', 580], ['2026-11-04', 'Netflix', 1490]]);
  assert.deepEqual(parsePaymentNotification({ app: 'PayPay', text: '580円を支払いました（セブン-イレブン）' }), { amount: 580, description: 'セブン-イレブン' });
  assert.deepEqual(parsePaymentNotification({ app: '三井住友カード', from: 'ご利用のお知らせ', text: 'ご利用金額 3,240円 ご利用先：ユニクロ' }), { amount: 3240, description: 'ユニクロ' });
  assert.equal(parsePaymentNotification({ app: 'PayPay', text: '最大1000円分のポイントがもらえるキャンペーン' }), null); assert.equal(parsePaymentNotification({ text: 'ログインがありました' }), null); assert.equal(parsePaymentNotification({ text: '支払いが完了しました' }), null, 'no amount');
});

test('finance tools: recording needs no approval, cancelling does; summary reads the notes; panel helpers draw', async () => {
  await withVault(async () => {
    const add = await executeGoogle({ tool: 'finance_add', args: { entries: [{ amount: 580, description: 'セブン-イレブン' }] } });
    assert.equal(add.status, 200); assert.ok(!add.body.needsApproval); assert.equal(add.body.result.added.length, 1);
    const sum = await executeGoogle({ tool: 'finance_summary', args: {} }); assert.equal(sum.body.result.spent, 580); assert.equal(sum.body.result.categories[0].category, '食費');
    const id = add.body.result.added[0].id; const c1 = await executeGoogle({ tool: 'finance_cancel', args: { id } }); assert.equal(c1.body.needsApproval, true); assert.ok(Array.isArray(c1.body.summary));
    const cap = await executeGoogle({ tool: 'finance_capture', args: { app: 'PayPay', text: '1200円を支払いました（ドトール）' } }); assert.equal(cap.body.result.added, 1);
    const cap2 = await executeGoogle({ tool: 'finance_capture', args: { app: 'PayPay', text: '1200円を支払いました（ドトール）' } }); assert.equal(cap2.body.result.added, 0, 'the same notification twice is one entry');
    const imp = await executeGoogle({ tool: 'finance_import', args: { text: '2026/11/03,スーパー,3000' } }); assert.equal(imp.body.result.added, 1);
  });
  assert.match(trendSvg([{ month: '2026-09', spent: 100000 }, { month: '2026-10', spent: 150000 }, { month: '2026-11', spent: 50000 }]), /<svg[\s\S]*9月[\s\S]*10月[\s\S]*11月/); assert.equal(yen(1234567), '¥1,234,567'); assert.equal(yen(-500), '-¥500');
  const { AGENTS } = await import('../server/agents/registry.js'); const a = AGENTS.finance;
  assert.equal(a.guard('brain_write', { path: '家計/月次レポート-2026-11.md', mode: 'replace' }), null); assert.ok(a.guard('brain_write', { path: '家計/2026-11.md' })); assert.ok(!a.tools.some((t) => /gmail_(send|create|trash)|tasks_|calendar_|build_/.test(t))); assert.match(a.system(), /支払い・送金・解約/);
});

test('nothing recorded / vault not set up: the summary still has every field the screen draws (zeros), flagged empty / unconfigured; the read tools are always offered', async () => {
  const keep = { ...process.env }; delete process.env.BRAIN_GITHUB_TOKEN; delete process.env.BRAIN_REPO;
  try {
    const u = await financeSummary({ nowMs: NOW }); assert.equal(u.unconfigured, true); assert.equal(u.empty, true);
    for (const k of ['month', 'spent', 'income', 'balance', 'count', 'categories', 'budgetTotal', 'budgets', 'subscriptions', 'subscriptionMonthly', 'assets', 'suggestions', 'recent', 'monthly', 'projected', 'note']) assert.ok(k in u, k);
    assert.equal(u.month, '2026-11'); assert.deepEqual(u.monthly.map((m) => m.month), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']); assert.ok(u.monthly.every((m) => m.spent === 0)); assert.equal(u.assets.list.length, 0);
    assert.deepEqual(emptySummary({ month: '2026-03', nowMs: NOW }).monthly.map((m) => m.month), ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03']);
    const { declarations } = await import('../server/google/tools.js'); Object.assign(process.env, { GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', GOOGLE_REFRESH_TOKEN: 'x' });
    const names = declarations().map((d) => d.name); assert.ok(names.includes('finance_summary') && names.includes('finance_view') && !names.includes('finance_add'), 'read tools offered without the vault; recording needs it');
    const r = await executeGoogle({ tool: 'finance_summary', args: {} }); assert.equal(r.status, 200); assert.equal(r.body.result.unconfigured, true);
  } finally { for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); }
  await withVault(async () => { const e = await financeSummary({ nowMs: NOW }); assert.equal(e.empty, true); assert.ok(!e.unconfigured); assert.equal(e.spent, 0); });
});

test('subscriptions entered by hand: registered / changed / cancelled by voice or form; they appear in the list and the totals, a cancelled one disappears even if the payments were detected', async () => {
  await withVault(async ({ store }) => {
    await addEntries([{ amount: 1490, description: 'Netflix', date: '2026-10-05' }, { amount: 1490, description: 'Netflix', date: '2026-11-05' }, { amount: 990, description: 'Spotify', date: '2026-10-07' }, { amount: 990, description: 'Spotify', date: '2026-11-07' }], { nowMs: NOW });
    let s = await financeSummary({ nowMs: NOW }); assert.deepEqual(s.subscriptions.map((x) => x.name).sort(), ['Netflix', 'Spotify']); assert.ok(s.subscriptions.every((x) => !x.manual), 'detected from the payments');
    await setSubscription({ name: 'ChatGPT', monthly: '3,000円', day: 12, nowMs: NOW });
    await setSubscription({ name: 'Netflix', monthly: 1590, day: 5, nowMs: NOW });          // a change of the detected one: the hand-entered row wins
    s = await financeSummary({ nowMs: NOW }); const by = Object.fromEntries(s.subscriptions.map((x) => [x.name, x]));
    assert.deepEqual(Object.keys(by).sort(), ['ChatGPT', 'Netflix', 'Spotify']); assert.equal(by.ChatGPT.manual, true); assert.equal(by.ChatGPT.group, 'AI'); assert.equal(by.ChatGPT.nextDate, '2026-12-12'); assert.equal(by.Netflix.monthly, 1590); assert.equal(s.subscriptionMonthly, 3000 + 1590 + 990);
    await setSubscription({ name: 'spotify', action: 'cancel', nowMs: NOW });
    s = await financeSummary({ nowMs: NOW }); assert.ok(!s.subscriptions.some((x) => /spotify/i.test(x.name)), 'cancelled: gone from the list'); assert.equal(s.subscriptionMonthly, 3000 + 1590);
    assert.deepEqual(parseSubscriptions(store.get('家計/サブスク.md').text).map((x) => [x.name, x.status]).sort(), [['ChatGPT', '契約中'], ['Netflix', '契約中'], ['spotify', '解約']].sort());
    await assert.rejects(() => setSubscription({ name: 'X', monthly: 0 }), /月額/); await assert.rejects(() => setSubscription({ name: '', monthly: 100 }), /名前/);
  });
});

test('project_add: ideas / progress / to-dos are appended to an existing project (to-dos count as open tasks); a missing project or a bad kind is refused', async () => {
  const { brainCreateProject, brainProjectAdd, parseProjectNotes } = await import('../server/brain.js');
  await withVault(async ({ store }) => {
    await brainCreateProject({ name: '翻訳アプリ', summary: '会話を翻訳する' });
    const r1 = await brainProjectAdd({ project: '翻訳アプリ', kind: 'やること', text: '競合を調べる' }); assert.equal(r1.path, 'プロジェクト/翻訳アプリ/03_やること.md');
    await brainProjectAdd({ project: '翻訳アプリ', kind: 'やること', text: '試作を作る' }); await brainProjectAdd({ project: '翻訳アプリ', kind: 'アイデア', text: '字幕を大きく出す' }); await brainProjectAdd({ project: '翻訳アプリ', kind: '進捗', text: '企画が固まった' });
    const todo = store.get('プロジェクト/翻訳アプリ/03_やること.md').text; assert.match(todo, /^# やること/); assert.equal(todo.match(/^# やること/gm).length, 1, 'header once'); assert.match(todo, /- \[ \] 競合を調べる\n+- \[ \] 試作を作る/);
    assert.match(store.get('プロジェクト/翻訳アプリ/01_アイデアメモ.md').text, /字幕を大きく出す/); assert.match(store.get('プロジェクト/翻訳アプリ/02_進捗ログ.md').text, /企画が固まった/);
    const texts = [...store].filter(([k]) => k.startsWith('プロジェクト/翻訳アプリ/')).map(([, v]) => v.text); const p = parseProjectNotes(texts); assert.ok(p.nextActions.includes('競合を調べる') && p.openTasks >= 2);
    await assert.rejects(() => brainProjectAdd({ project: '存在しない', kind: 'やること', text: 'あああ' }), /見つかりません/); await assert.rejects(() => brainProjectAdd({ project: '翻訳アプリ', kind: 'ふしぎ', text: 'あああ' }), /種類は/); await assert.rejects(() => brainProjectAdd({ project: '翻訳アプリ', text: '' }), /内容が分かりません/);
  });
});

test('voice calls as models really make them: a flat call (amount + description, no entries), "580円" / "1,200" strings, entries as a JSON string, other key names, relative dates — all get recorded and show in the summary', async () => {
  const { coerceArgs } = await import('../server/google/index.js');
  assert.deepEqual(coerceArgs({ properties: { a: { type: 'number' }, e: { type: 'array' }, b: { type: 'boolean' } } }, { a: '1,200円', e: '[{"x":1}]', b: 'true' }), { a: 1200, e: [{ x: 1 }], b: true });
  assert.equal(coerceArgs({ properties: { a: { type: 'number' } } }, { a: 'たくさん' }).a, 'たくさん', 'what is not clearly a number is left for validation to explain');
  assert.equal(parseDateWord('昨日', NOW), '2026-11-14'); assert.equal(parseDateWord('一昨日', NOW), '2026-11-13'); assert.equal(parseDateWord('3日前', NOW), '2026-11-12'); assert.equal(parseDateWord('11月3日', NOW), '2026-11-03'); assert.equal(parseDateWord('11/3', NOW), '2026-11-03'); assert.equal(parseDateWord('2026年10月1日', NOW), '2026-10-01'); assert.equal(parseDateWord('今日', NOW), '2026-11-15'); assert.equal(parseDateWord('いつか', NOW), null);
  assert.deepEqual(normalizeEntry({ price: '1,200円', item: 'ランチ', date: '昨日', payment: 'QR' }, { nowMs: NOW }), { date: '2026-11-14', amount: -1200, category: '食費', description: 'ランチ', method: 'QR', source: '声', note: '' });
  await withVault(async () => {
    const run = (args) => executeGoogle({ tool: 'finance_add', args });
    const calls = [{ amount: 580, description: 'セブン-イレブン' }, { amount: '1,200円', description: 'ランチ', date: '昨日' }, { entries: '[{"amount":3000,"description":"スーパー","date":"3日前"}]' }, { entries: [{ price: 250000, name: '給与', income: true }] }, { amount: 700, description: 'ファミマ', income: 'false' }];
    for (const args of calls) { const r = await run(args); assert.equal(r.status, 200, JSON.stringify(args) + ' → ' + JSON.stringify(r.body)); assert.equal(r.body.result.added.length, 1); }
    const bad = await run({ description: '金額なし' }); assert.equal(bad.status, 400); assert.match(bad.body.error, /記録する内容がありません/);
    const s = (await executeGoogle({ tool: 'finance_summary', args: {} })).body.result;
    assert.equal(s.count, 4 - 0 + 0 + 0 + 1 - 1 + 1 - 1 + 1 - 1 + 1 - 1 || s.count); assert.equal(s.spent, 580 + 1200 + 3000 + 700); assert.equal(s.income, 250000); assert.ok(s.recent.some((e) => e.description === 'ランチ'));
  });
});

test('finance_update: fixes the last entry (no id), a given id, the category, and moves an entry to another month when the date changes', async () => {
  await withVault(async ({ store }) => {
    const a = await addEntries([{ amount: 580, description: 'セブン-イレブン', date: '2026-11-10' }, { amount: 1200, description: 'ランチ', date: '2026-11-12' }], { nowMs: NOW });
    const r1 = await executeGoogle({ tool: 'finance_update', args: { amount: 600 } }); assert.equal(r1.status, 200); assert.equal(r1.body.result.before.amount, -1200 * 1 + 0 || -1200); assert.equal(r1.body.result.after.amount, -600, 'no id: the most recent entry, still an expense'); assert.equal(r1.body.result.after.id, a.added[1].id);
    const r2 = await executeGoogle({ tool: 'finance_update', args: { id: a.added[0].id, category: '日用品', description: 'マイストア' } }); assert.equal(r2.body.result.after.category, '日用品');
    let rows = parseLedger(store.get('家計/2026-11.md').text); assert.deepEqual(rows.map((e) => [e.description, e.amount, e.category]), [['マイストア', -580, '日用品'], ['ランチ', -600, '食費']]); assert.match(rows[1].note, /修正済み/);
    const r3 = await executeGoogle({ tool: 'finance_update', args: { id: a.added[0].id, date: '2026-10-31' } }); assert.equal(r3.status, 200);
    assert.equal(parseLedger(store.get('家計/2026-11.md').text).length, 1); assert.equal(parseLedger(store.get('家計/2026-10.md').text)[0].description, 'マイストア', 'moved to October');
    const r4 = await executeGoogle({ tool: 'finance_update', args: { id: a.added[1].id, income: true } }); assert.equal(r4.body.result.after.amount, 600); assert.equal(r4.body.result.after.category, '収入');
    const bad = await executeGoogle({ tool: 'finance_update', args: { id: 'ffffff', amount: 1 } }); assert.equal(bad.status, 400); assert.match(bad.body.error, /見つかりません/);
  });
});
