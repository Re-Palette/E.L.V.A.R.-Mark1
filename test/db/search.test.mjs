// The search functions (migrations 05, 06, 07) called the way the server calls them: as `authenticated`, with a search_path that does not include `extensions`.
// On Supabase this runs the PGroonga branch (operator &@|, resolved in schema extensions), on plain Postgres the trigram branch; run it with
// ELVAR_TEST_DB_IMAGE=groonga/pgroonga:latest-debian-17 to check the PGroonga branch too. Each user only ever finds their own rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { admin, rawApp, newUser, deleteUser, asRole } from './support/pg.mjs';

const app = rawApp(2);
test.after(async () => { await app.end({ timeout: 5 }); await admin.end({ timeout: 5 }); });

test('search_notes / search_messages / search_files find the caller\'s own Japanese text and nothing of another user', async () => {
  const a = await newUser(), b = await newUser();
  try {
    for (const [u, word] of [[a, '寿司'], [b, '寿司']]) {
      await admin`insert into app.notes (user_id, path, content) values (${u}, '好み/食べ物.md', ${'東京で' + word + 'を食べた'})`;
      const [c] = await admin`insert into app.conversations (user_id) values (${u}) returning id`;
      await admin`insert into app.messages (user_id, conversation_id, role, text, at) values (${u}, ${c.id}, 'user', '明日の天気は晴れ', now())`;
      const [f] = await admin`insert into app.files (user_id, id, name, mime, kind, size_bytes, sha256, object_path, status)
                              select ${u}, x.id, 'memo.txt', 'text/plain', 'text', 10, repeat('b', 64), 'users/' || ${u}::text || '/files/' || x.id::text || '/' || repeat('b', 64), 'ready'
                              from (select gen_random_uuid() as id) x returning id`;
      await admin`insert into app.file_texts (user_id, file_id, text) values (${u}, ${f.id}, '請求書 合計 三千円')`;
    }
    const run = (uid, q) => asRole(app, { uid }, async (tx) => { await tx`set local search_path = pg_catalog`; return tx.unsafe(q); });
    const notes = await run(a, `select path from app.search_notes(array['寿司'], array['%寿司%'])`);
    assert.deepEqual(notes.map((r) => r.path), ['好み/食べ物.md']);
    assert.equal((await run(a, `select 1 from app.search_notes(array['ラーメン'], array['%ラーメン%'])`)).length, 0);
    assert.equal((await run(a, `select 1 from app.search_messages(array['天気'], array['%天気%'])`)).length, 1, 'own message only, not b\'s');
    assert.equal((await run(a, `select 1 from app.search_files(array['請求書'], array['%請求書%'])`)).length, 1, 'own file text only, not b\'s');
  } finally { await deleteUser(a); await deleteUser(b); }
});
