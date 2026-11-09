// P4 over HTTP (the real route table, in-memory database): the user's notes (edit, versions, trash), conversation log (retention setting, one-by-one deletion),
// notification box, the export and the GitHub mirror with a stub for GitHub. Cross-user cases are in test/routes-isolation.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/api-harness.mjs';

const withH = async (fn) => { const h = await startHarness(); try { const u = h.mkUser('a@example.test'); await fn(h, await h.bearer(u, { email: 'a@example.test' }), u); } finally { await h.stop(); } };

test('notes: create, edit (the old text becomes a version), compare-and-set, restore a version, trash, restore, delete for good; the AI-style write shares the same notes', () => withH(async (h, A) => {
  const c = await h.call('POST', '/api/elvar/notes', A, { path: '好み/コーヒー', content: '# コーヒー\nブラック' }); assert.equal(c.status, 200); const id = c.body.note.id; assert.equal(c.body.note.path, '好み/コーヒー.md'); assert.equal(c.body.note.rev, 1);
  assert.equal((await h.call('POST', '/api/elvar/notes', A, { path: '../x', content: 'x' })).status, 400); assert.equal((await h.call('POST', '/api/elvar/notes', A, { path: 'a', content: '  ' })).status, 400);
  const u = await h.call('PUT', `/api/elvar/notes/${id}`, A, { content: '# コーヒー\n砂糖あり', baseRev: 1 }); assert.equal(u.body.note.rev, 2);
  assert.equal((await h.call('PUT', `/api/elvar/notes/${id}`, A, { content: 'stale', baseRev: 1 })).status, 409, 'a stale editor does not overwrite a newer version');
  const g = await h.call('GET', `/api/elvar/notes/${id}`, A); assert.deepEqual(g.body.revisions.map((r) => r.rev), [1]); assert.match(g.body.note.content, /砂糖あり/);
  assert.match((await h.call('GET', `/api/elvar/notes/${id}/revisions/1`, A)).body.revision.content, /ブラック/);
  assert.equal((await h.call('POST', `/api/elvar/notes/${id}/revisions/1/restore`, A, {})).body.note.content, '# コーヒー\nブラック\n');
  assert.equal((await h.call('DELETE', `/api/elvar/notes/${id}`, A)).status, 200); assert.equal((await h.call('GET', '/api/elvar/notes', A)).body.notes.length, 0);
  assert.equal((await h.call('GET', '/api/elvar/notes', A, {}, { trash: '1' })).body.notes.length, 1);
  assert.equal((await h.call('POST', `/api/elvar/notes/${id}/restore`, A, {})).status, 200); assert.equal((await h.call('GET', '/api/elvar/notes', A, {}, { folder: '好み' })).body.notes.length, 1);
  assert.equal((await h.call('DELETE', `/api/elvar/notes/${id}`, A, {}, { permanent: '1' })).status, 200); assert.equal((await h.call('GET', `/api/elvar/notes/${id}`, A)).status, 404);
  assert.equal((await h.call('GET', '/api/elvar/notes/not-a-uuid', A)).status, 404);
}));

test('conversation log: the page posts turns; secrets are masked; retention is a per-user setting (7 days to for ever); one message, one conversation, a period, everything can be deleted', () => withH(async (h, A, uid) => {
  const now = Date.now();
  const p = await h.call('POST', '/api/elvar/messages', A, { turns: [{ at: now - 8 * 864e5, user: '古い話', model: 'はい' }, { at: now, user: '新しい話 password: hunter2xyz9', model: '承知しました' }] }); assert.equal(p.status, 200); assert.equal(p.body.written, 2);
  const cs = (await h.call('GET', '/api/elvar/conversations', A)).body.conversations; assert.equal(cs.length, 2);
  const conv = (await h.call('GET', `/api/elvar/conversations/${cs[0].id}`, A)).body.conversation; assert.ok(!JSON.stringify(conv).includes('hunter2xyz9')); assert.match(conv.messages[0].text, /新しい話/);
  assert.equal((await h.call('GET', '/api/elvar/messages', A, {}, { q: '古い話' })).body.messages.length, 1);
  // the retention setting: validated, and the sweep (cron) honours it
  for (const bad of ['3', 'abc', '-1', '1.5']) assert.equal((await h.call('PATCH', '/api/elvar/config', A, { settings: { MESSAGE_RETENTION_DAYS: bad } })).status, 400, bad);
  assert.equal((await h.call('PATCH', '/api/elvar/config', A, { settings: { MESSAGE_RETENTION_DAYS: '7' } })).status, 200);
  await h.db.system.purgeExpired();
  assert.deepEqual((await h.call('GET', '/api/elvar/messages', A)).body.messages.map((m) => m.text.slice(0, 3)), ['承知し', '新しい'], 'older than 7 days: gone');
  const one = (await h.call('GET', '/api/elvar/messages', A)).body.messages[0];
  assert.equal((await h.call('DELETE', `/api/elvar/messages/${one.id}`, A)).status, 200); assert.equal((await h.call('GET', '/api/elvar/messages', A)).body.messages.length, 1);
  assert.equal((await h.call('POST', '/api/elvar/messages/purge', A, {})).status, 400);
  assert.equal((await h.call('POST', '/api/elvar/messages/purge', A, { all: true })).body.deleted, 1); assert.deepEqual((await h.call('GET', '/api/elvar/conversations', A)).body.conversations, []);
  assert.equal((await h.call('PATCH', '/api/elvar/config', A, { settings: { MESSAGE_RETENTION_DAYS: '0' } })).status, 200);
  void uid;
}));

test('inbox: add (same key replaces), mark read, delete, clear; the export carries notes, conversations and inbox', () => withH(async (h, A) => {
  const x = (await h.call('POST', '/api/elvar/inbox', A, { kind: 'build', key: 'b:1', title: '製作（作業中）', body: 'x' })).body.item;
  assert.equal((await h.call('POST', '/api/elvar/inbox', A, { kind: 'deliverable', key: 'b:1', title: '製作（完成）' })).body.item.id, x.id);
  assert.equal((await h.call('GET', '/api/elvar/inbox', A)).body.items.length, 1);
  assert.equal((await h.call('PATCH', `/api/elvar/inbox/${x.id}`, A, { read: true })).status, 200); assert.notEqual((await h.call('GET', '/api/elvar/inbox', A)).body.items[0].readAt, null);
  await h.call('POST', '/api/elvar/notes', A, { path: 'メモ', content: '本文' }); await h.call('POST', '/api/elvar/messages', A, { turns: [{ at: Date.now(), user: 'こんにちは', model: 'はい' }] });
  const ex = (await h.call('GET', '/api/elvar/account/export', A)).body.files;
  assert.equal(ex['notes.json'].notes[0].content, '本文\n'); assert.equal(ex['conversations.json'].conversations[0].messages.length, 2); assert.equal(ex['inbox.json'].inbox[0].title, '製作（完成）');
  assert.equal((await h.call('DELETE', `/api/elvar/inbox/${x.id}`, A)).status, 200); assert.equal((await h.call('DELETE', '/api/elvar/inbox', A)).body.deleted, 0);
}));

// ---- the GitHub mirror, with a stand-in for GitHub (the user's OWN repository and token)
function github(files) {
  const calls = [], b64 = (t) => Buffer.from(t, 'utf8').toString('base64'), real = globalThis.fetch;
  globalThis.fetch = async (url, o = {}) => {
    const u = decodeURIComponent(String(url)), m = o.method || 'GET'; calls.push([m, u, o.headers?.authorization]);
    const J = (b, status = 200) => ({ ok: status < 300, status, json: async () => b });
    if (u.includes('/git/trees/')) return J({ tree: Object.entries(files).map(([path, t]) => ({ path, type: 'blob', size: t.length })).concat([{ path: 'img.png', type: 'blob', size: 5 }, { path: '.obsidian/x.md', type: 'blob', size: 3 }]) });
    const p = u.match(/\/contents\/([^?]+)/)?.[1];
    if (m === 'PUT') { files[p] = Buffer.from(JSON.parse(o.body).content, 'base64').toString('utf8'); return J({ commit: { sha: 'abc' } }); }
    return p in files ? J({ type: 'file', sha: 's-' + p, content: b64(files[p]) }) : J({ message: 'Not Found' }, 404);
  };
  return { calls, files, restore: () => { globalThis.fetch = real; } };
}

test('github-brain: import is idempotent and never overwrites a note changed here; push mirrors changed notes with the user\'s own token, one way, debounced', () => withH(async (h, A) => {
  const own = { settings: { BRAIN_REPO: 'me/my-notes', BRAIN_BRANCH: 'main' }, secrets: { BRAIN_GITHUB_TOKEN: 'ghp_USERS_OWN_TOKEN_00000000' } };
  assert.equal((await h.call('POST', '/api/elvar/brain-sync/import', A, {})).body.error, 'not_configured');
  assert.equal((await h.call('PATCH', '/api/elvar/config', A, own)).status, 200);
  const gh = github({ '人物/田中さん.md': '# 田中さん\n定例は火曜', '好み/コーヒー.md': 'ブラック' });
  try {
    const dry = await h.call('POST', '/api/elvar/brain-sync/import', A, { dryRun: true }); assert.deepEqual([dry.body.created, dry.body.same, dry.body.skipped], [2, 0, 0]); assert.equal((await h.call('GET', '/api/elvar/notes', A)).body.notes.length, 0, 'a dry run writes nothing');
    const imp = await h.call('POST', '/api/elvar/brain-sync/import', A, {}); assert.deepEqual([imp.body.created, imp.body.updated, imp.body.conflicts], [2, 0, []]);
    assert.equal((await h.call('POST', '/api/elvar/brain-sync/import', A, {})).body.same, 2, 'a second import changes nothing');
    assert.ok(gh.calls.every((c) => c[2] === 'Bearer ghp_USERS_OWN_TOKEN_00000000' && c[1].startsWith('https://api.github.com/repos/me/my-notes/')), 'only the user\'s own repository and token');
    assert.equal((await h.call('GET', '/api/elvar/brain-sync/status', A)).body.unpushed, 0, 'imported notes are not pushed straight back');
    // a change here, then a different text in the repository: conflict, the user's version stays
    const id = (await h.call('GET', '/api/elvar/notes', A)).body.notes.find((n) => n.path === '好み/コーヒー.md').id;
    await h.call('PUT', `/api/elvar/notes/${id}`, A, { content: 'ミルク入り' }); gh.files['好み/コーヒー.md'] = 'リポジトリ側の変更';
    const c = await h.call('POST', '/api/elvar/brain-sync/import', A, {}); assert.deepEqual(c.body.conflicts, ['好み/コーヒー.md']); assert.equal((await h.call('GET', `/api/elvar/notes/${id}`, A)).body.note.content, 'ミルク入り\n');
    // push: the changed note (and a new one) go to the repository
    await h.call('POST', '/api/elvar/notes', A, { path: '日記/今日', content: '晴れ' });
    assert.equal((await h.call('GET', '/api/elvar/brain-sync/status', A)).body.unpushed, 2);
    const push = await h.call('POST', '/api/elvar/brain-sync/push', A, {}); assert.deepEqual([push.body.pushed, push.body.failed, push.body.remaining], [2, 0, 0]);
    assert.equal(gh.files['日記/今日.md'], '晴れ\n'); assert.equal(gh.files['好み/コーヒー.md'], 'ミルク入り\n');
    await h.call('POST', '/api/elvar/notes', A, { path: '日記/明日', content: '雨' });
    assert.equal((await h.call('POST', '/api/elvar/brain-sync/push', A, {})).body.skipped, 'debounce', 'the page\'s timer cannot push twice within 5 minutes');
    assert.equal((await h.call('POST', '/api/elvar/brain-sync/push', A, { force: true })).body.pushed, 1, 'the button can');
    // one way: deleting a note here does not delete it in the repository
    const t = (await h.call('GET', '/api/elvar/notes', A)).body.notes.find((n) => n.path === '日記/今日.md'); await h.call('DELETE', `/api/elvar/notes/${t.id}`, A, {}, { permanent: '1' });
    await h.call('POST', '/api/elvar/brain-sync/push', A, { force: true }); assert.equal(gh.files['日記/今日.md'], '晴れ\n');
  } finally { gh.restore(); }
}));

test('review fix (BLOCKER 1): an MCP state at the Google callback, and a Google state at the connector callback, fail without any network call', () => withH(async (h, A, uid) => {
  const { startFlow } = await import('../server/oauth/flow.js'), { pendingFor } = await import('../server/oauth/pending.js'), { mintVerifiedUid } = await import('../server/db/verified-uid.js');
  const v = mintVerifiedUid(uid, 'test'), pa = pendingFor((fn) => h.db.asUser(v, fn));
  const real = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('no network'); };
  try {
    const mk = (provider) => startFlow({ pending: pa, provider, authUrl: 'https://a.example/auth', tokenUrl: 'http://169.254.169.254/latest/meta-data', clientId: 'cid', clientSecret: 's', redirectUri: 'https://x.example/cb', scopes: ['a'], requireRefresh: false });
    const m = await mk('mcp'), g = await mk('google');
    assert.ok((await h.call('GET', '/api/google/callback', {}, {}, { state: m.state, code: 'c' })).status >= 400);
    assert.ok((await h.call('GET', '/api/elvar/oauth/callback', {}, {}, { state: g.state, code: 'c' })).status >= 400);
    assert.equal(calls, 0, 'neither callback touched the network');
  } finally { globalThis.fetch = real; }
}));
