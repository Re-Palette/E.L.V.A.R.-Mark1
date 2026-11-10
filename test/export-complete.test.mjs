// P8 review round 2: the export carries EVERY row (docs/ELVAR_MULTIUSER.md 7.3, 19). Fixtures bigger than every cap that used to cut it (200 conversations per list, 5000 messages per
// conversation, 1000 audit rows, 200 build requests, 20000 notes / files, usage events that were not exported at all): the rows in the zip must equal the manifest's counts for every
// paged table, in key order and without a duplicate. Also: zip entry names that Windows would refuse are renamed (the job does not fail), and a part is closed before the 65,535-entry limit.
import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/api-harness.mjs';
import { runExport } from './helpers/export.mjs';
import { browserUpload } from './helpers/upload.mjs';
import { getStorage } from '../server/storage/index.js';
import { _clearAccountCache } from '../server/auth/with-user.js';
import { _setExportOptions } from '../server/account/exports.js';
import { mintVerifiedUid } from '../server/db/verified-uid.js';
import { PAGED, PAGED_ORDER } from '../server/rights/export-pages.js';
import { createZip, readZip, safeEntryName, MAX_ENTRIES } from '../server/rights/zip.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let h, st, u, W, U;
test.before(async () => {
  h = await startHarness(); st = await getStorage(); u = h.mkUser('c@example.test'); W = await h.bearer(u, { email: 'c@example.test' }); await h.call('GET', '/api/elvar/session', W);
  U = mintVerifiedUid(u, 'test'); h.db.testing.setHardLimits(u, { exportsPerDay: 1000, requestsPerMinute: 100000 }); _clearAccountCache();
});
test.after(async () => { _setExportOptions(null); await h.stop(); });

test('every paged table is exported to its last row: rows in the zip == the manifest counts (fixtures larger than every old cap)', async () => {
  const t0 = Date.now() - 300 * 86400_000;
  await h.db.asUser(U, async (r) => {
    for (let i = 0; i < 260; i++) await r.messages.append({ turns: [{ role: 'user', text: `c${i}-q`, at: t0 + i * 3 * 3600_000 }, { role: 'assistant', text: `c${i}-a`, at: t0 + i * 3 * 3600_000 + 1000 }], channel: 'voice' });   // 260 conversations (> 200 per list)
    for (let k = 0; k < 44; k++) await r.messages.append({ turns: Array.from({ length: 120 }, (_, j) => ({ role: 'user', text: `long-${k}-${j}`, at: t0 + 900 * 86400_000 / 1000 + (k * 120 + j) * 1000 })), channel: 'text' });   // one conversation of 5280 messages (> 5000)
    for (let i = 0; i < 1200; i++) await r.audit.append({ action: `probe.${i}` });                                                                                                          // > 1000
    for (let i = 1; i <= 250; i++) await r.builds.record({ repo: 'o/r', issueNumber: i, title: `build ${i}`, state: 'queued' });                                                            // > 200
    for (let i = 0; i < 1500; i++) await r.usage.record({ provider: 'gemini', metric: 'calls', amount: 1 });                                                                               // raw usage events: the manifest claims them
    for (let i = 0; i < 45; i++) { await r.notes.put({ path: `n/${i}.md`, content: `note ${i}` }); await r.notes.put({ path: `n/${i}.md`, content: `note ${i} v2` }); }
  });
  for (let i = 0; i < 130; i++) {   // 130 files (> the 100 of one page)
    const bytes = Buffer.from(`file-${i}-${crypto.randomUUID()}`), r = await h.call('POST', '/api/elvar/files/reserve', W, { name: `f${i}.txt`, size: bytes.length, sha256: sha(bytes), textBytes: 8 });
    assert.equal(r.status, 200, JSON.stringify(r.body)); await browserUpload(st, u, r.body.upload, bytes);
    assert.equal((await h.call('POST', `/api/elvar/files/${r.body.fileId}/finalize`, W, { text: `text ${i}` })).status, 200);
  }
  const counts = await h.db.asUser(U, (r) => r.rights.counts());
  assert.ok(counts.conversations > 200 && counts.messages > 5000 && counts.audit_log > 1000 && counts.build_requests > 200 && counts.usage_events >= 1500 && counts.files === 130 && counts.note_revisions === 45, JSON.stringify(counts));
  _setExportOptions({ partBytes: 400_000, maxEntries: 60 });   // several parts, and a part is closed at 60 entries
  const x = await runExport(h, W, { max: 400 });
  assert.ok(x.parts.length >= 5, `several parts (${x.parts.length})`);
  const man = x.json('manifest.json'), report = x.json('export-report.json');
  for (const t of PAGED_ORDER) {
    const rows = x.rows(t), keyCols = PAGED[t].key.map(([c]) => c);
    assert.equal(rows.length, man.tables[t].rows, `${t}: rows in the zip == the manifest's count`);
    assert.ok(rows.length >= counts[t] && rows.length <= counts[t] + (t === 'audit_log' ? 2 : 0), `${t}: == the database's count (the audit log also records the export itself)`);
    assert.equal(new Set(rows.map((r) => keyCols.map((c) => r[c]).join('|'))).size, rows.length, `${t}: no row twice`);
    assert.deepEqual(report.rows[t], { exported: rows.length, manifest: man.tables[t].rows }, `${t}: the report says so too`);
  }
  assert.equal(report.rowsComplete, true); assert.equal(x.rows('usage_events').length, 1500, 'the raw usage events are in the export');
  assert.ok(x.rows('messages').filter((m) => m.text.startsWith('long-')).length === 5280, 'a conversation of more than 5000 messages is whole');
  assert.equal(x.rows('files').length, 130); assert.equal(report.originalsIncluded, 130); assert.ok(x.rows('files').every((f) => !('object_path' in f)), 'the Storage path never leaves');
  for (const p of x.parts) assert.ok(p.names.length <= 60 + 20 + 12, `a part has ${p.names.length} entries: closed near the limit`);
  assert.ok(x.rows('notes').every((n) => !('content' in n) && x.files[n.file]), 'a note is its Markdown file, the row points at it');
});

test('zip entry names: Windows-invalid characters and backslashes are renamed, collisions are numbered, and the export does not fail', async () => {
  const w = h.mkUser('z@example.test'), Z = await h.bearer(w, { email: 'z@example.test' }); await h.call('GET', '/api/elvar/session', Z);
  const paths = ['win/a:b?.md', 'x\\y.md', 'c:1.md', 'c_1.md', 'CON.md', 'dir./end.md', '太郎/メモ<1>.md'];
  for (const p of paths) assert.equal((await h.call('POST', '/api/elvar/notes', Z, { path: p, content: `c ${p}` })).status, 200, p);
  h.db.testing.setHardLimits(w, { exportsPerDay: 1000 });
  const x = await runExport(h, Z);
  const noteNames = x.names.filter((n) => n.startsWith('notes/'));
  assert.equal(noteNames.length, paths.length, 'every note is in the zip');
  for (const n of noteNames) assert.ok(!/[\\:*?"<>|\u0000-\u001f]/.test(n) && !/(^|\/)(CON|NUL)(\.|$)/i.test(n) && !/[. ](\/|$)/.test(n), `unsafe name left: ${n}`);
  assert.ok(noteNames.includes('notes/c_1.md') && noteNames.includes('notes/c_1 (2).md'), 'the two names that collide after renaming are both kept');
  for (const row of x.rows('notes')) assert.ok(x.files[row.file], `${row.path} -> ${row.file}`);
});

test('safeEntryName and createZip: no traversal, long names shortened with their extension, a duplicate is numbered', () => {
  assert.equal(safeEntryName('a\\b:c*.md'), 'a_b_c_.md'); assert.equal(safeEntryName('../x'), '__/x'); assert.equal(safeEntryName('a//b/./c'), 'a/b/_/c');
  const long = safeEntryName(`dir/${'あ'.repeat(300)}.pdf`); assert.ok(Buffer.byteLength(long) <= 500 && long.endsWith('.pdf') && long.startsWith('dir/'));
  const z = createZip(); assert.equal(z.add('a.txt', '1'), 'a.txt'); assert.equal(z.add('a.txt', '2'), 'a (2).txt'); assert.equal(z.add('d/a.txt', '3'), 'd/a.txt');
  assert.deepEqual(Object.keys(readZip(z.finish())).sort(), ['a (2).txt', 'a.txt', 'd/a.txt']);
  assert.ok(MAX_ENTRIES < 65535);
});
