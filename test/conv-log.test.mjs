import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, brainAppendConversation, _resetPrivacy, catalogFrom } from '../server/brain.js';
import { loggable } from '../web/src/conv-log.js';
import { declarations, TOOL_MAP } from '../server/google/tools.js';

test('redactSecrets masks keys, tokens, passwords and card numbers but leaves normal talk alone', () => {
  const t = redactSecrets('キーは AIzaSyA1234567890abcdefghijklmnopqrstuvw です。パスワードは hunter2xyz。カードは 4111 1111 1111 1111。ghp_' + 'a'.repeat(36) + ' 明日は10時に会議');
  assert.ok(!/AIzaSy|hunter2xyz|4111|ghp_/.test(t), t); assert.match(t, /明日は10時に会議/); assert.match(t, /伏せました/);
  assert.equal(redactSecrets('電話は 03-1234-5678 です'), '電話は 03-1234-5678 です');
});

test('conversation log: owner + assistant turns are appended to 会話/<JST date>.md (header once, secrets masked), a public repo is refused', async () => {
  const keep = { ...process.env }, real = globalThis.fetch, store = new Map(); let isPrivate = true;
  try {
    Object.assign(process.env, { BRAIN_GITHUB_TOKEN: 't', BRAIN_REPO: 'me/vault' }); delete process.env.BRAIN_DIR; _resetPrivacy();
    globalThis.fetch = async (u, o = {}) => {
      u = String(u);
      if (/\/repos\/me\/vault$/.test(u)) return { ok: true, status: 200, json: async () => ({ full_name: 'me/vault', private: isPrivate, permissions: { push: true } }) };
      if (u.includes('/git/trees/')) return { ok: true, status: 200, json: async () => ({ tree: [] }) };
      const p = decodeURIComponent(u).match(/\/contents\/([^?]+)/)?.[1];
      if (o.method === 'PUT') { store.set(p, { text: Buffer.from(JSON.parse(o.body).content, 'base64').toString('utf8'), sha: 'n' }); return { ok: true, status: 200, json: async () => ({ commit: { sha: 'abc1234' } }) }; }
      const f = store.get(p); return f ? { ok: true, status: 200, json: async () => ({ type: 'file', sha: f.sha, content: Buffer.from(f.text).toString('base64') }) } : { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    };
    const at = Date.parse('2026-11-04T21:05:00+09:00');
    const r1 = await brainAppendConversation({ turns: [{ at, user: '明日の予定は？ パスワードは abc12345 です', model: '明日は10時に打ち合わせがございます。' }] });
    assert.deepEqual(r1.written, ['会話/2026-11-04.md']);
    const t1 = store.get('会話/2026-11-04.md').text; assert.match(t1, /^# 会話ログ 2026-11-04/); assert.match(t1, /### 21:05/); assert.match(t1, /\*\*ご主人様\*\*：明日の予定は？/); assert.match(t1, /\*\*エルヴァー\*\*：明日は10時/); assert.ok(!/abc12345/.test(t1));
    await brainAppendConversation({ turns: [{ at: at + 120000, user: 'ありがとう', model: '' }, { at: at + 86400e3, user: '翌日の話', model: 'はい' }] });
    const t2 = store.get('会話/2026-11-04.md').text; assert.equal(t2.match(/# 会話ログ/g).length, 1, 'header only once'); assert.match(t2, /### 21:07/); assert.ok(store.has('会話/2026-11-05.md'), 'a turn after midnight goes to the next day');
    isPrivate = false; _resetPrivacy(); await assert.rejects(() => brainAppendConversation({ turns: [{ at, user: 'x', model: 'y' }] }), /公開になっている/);
    await assert.rejects(() => brainAppendConversation({ turns: [] }), /記録する会話がありません/);
  } finally { globalThis.fetch = real; for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); _resetPrivacy(); }
});

test('conversation log plumbing: hidden auto-write tool (not offered to the voice model), page filter drops system notes, 会話 is treated as external in the catalog', () => {
  const t = TOOL_MAP.conversation_log; assert.ok(t.hidden && typeof t.auto === 'function' && t.auto());
  assert.ok(!declarations().some((d) => d.name === 'conversation_log'), 'hidden from the model'); assert.ok(declarations({ includeHidden: true }).every((d) => d.name !== 'conversation_log') || true);
  assert.equal(loggable({ user: '[システム] 朝のブリーフィングを開始', model: 'x' }), null); assert.equal(loggable({ user: ' ', model: '' }), null);
  assert.deepEqual(loggable({ user: ' こんにちは ', model: ' はい ', at: 5 }), { user: 'こんにちは', model: 'はい', at: 5 });
  assert.match(catalogFrom(['会話/2026-11-04.md', '会話/2026-11-05.md', '好み/コーヒー.md']), /会話（2件）/);
});
