import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, brainAppendConversation, brainProjectMaterial, catalogFrom } from '../server/brain.js';
import { useVault } from './helpers/vault.mjs';
const V = useVault();   // a signed-in test user: the conversation log is theirs
import { loggable } from '../web/src/conv-log.js';
import { declarations, TOOL_MAP } from '../server/google/tools.js';

test('redactSecrets masks keys, tokens, passwords and card numbers but leaves normal talk alone', () => {
  const t = redactSecrets('キーは AIzaSyA1234567890abcdefghijklmnopqrstuvw です。パスワードは hunter2xyz。カードは 4111 1111 1111 1111。ghp_' + 'a'.repeat(36) + ' 明日は10時に会議');
  assert.ok(!/AIzaSy|hunter2xyz|4111|ghp_/.test(t), t); assert.match(t, /明日は10時に会議/); assert.match(t, /伏せました/);
  assert.equal(redactSecrets('電話は 03-1234-5678 です'), '電話は 03-1234-5678 です');
});

test('conversation log: turns become messages in the user\'s own conversations (secrets masked, 30-minute conversations), readable as project material', async () => {
  const at = Date.parse('2026-11-04T21:05:00+09:00');
  const r1 = await brainAppendConversation({ turns: [{ at, user: '明日の予定は？ パスワードは abc12345 です', model: '明日は10時に打ち合わせがございます。' }] });
  assert.equal(r1.turns, 1); assert.equal(r1.added, 2);
  await brainAppendConversation({ turns: [{ at: at + 120000, user: 'ありがとう', model: '' }, { at: at + 86400e3, user: '翌日の話', model: 'はい' }] });
  const cs = await V.db.asUser(V.v, (r) => r.messages.conversations({}));
  assert.equal(cs.length, 2, 'two minutes later = the same conversation; the next day = a new one');
  const day1 = await V.db.asUser(V.v, (r) => r.messages.conversation(cs[1].id));
  assert.deepEqual(day1.messages.map((m) => [m.role, /abc12345/.test(m.text)]), [['user', false], ['assistant', false], ['user', false]]); assert.match(day1.messages[0].text, /伏せました/);
  await assert.rejects(() => brainAppendConversation({ turns: [] }), /記録する会話がありません/);
  const m = await brainProjectMaterial({ now: at + 2 * 864e5 }); assert.deepEqual(m.conversations.map((c) => c.date), ['2026-11-04', '2026-11-05']);
  assert.match(m.conversations[0].text, /### 21:05/); assert.match(m.conversations[0].text, /\*\*ご主人様\*\*：明日の予定は？/); assert.match(m.conversations[0].text, /\*\*エルヴァー\*\*：明日は10時/);
  await V.db.asUser(V.v, (r) => r.messages.purge({}));
});

test('conversation log plumbing: hidden auto-write tool (not offered to the voice model), page filter drops system notes, 会話 is treated as external in the catalog', () => {
  assert.equal(TOOL_MAP.conversation_log, undefined, 'the page sends turns to POST /api/elvar/messages now; there is no tool');
  assert.equal(loggable({ user: '[システム] 朝のブリーフィングを開始', model: 'x' }), null); assert.equal(loggable({ user: ' ', model: '' }), null);
  assert.deepEqual(loggable({ user: ' こんにちは ', model: ' はい ', at: 5 }), { user: 'こんにちは', model: 'はい', at: 5 });
  assert.match(catalogFrom(['会話/2026-11-04.md', '会話/2026-11-05.md', '好み/コーヒー.md']), /会話（2件）/);
});
