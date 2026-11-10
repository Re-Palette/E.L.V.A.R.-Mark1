// The file vault end to end on the memory database and the fake Storage (docs/ELVAR_MULTIUSER.md 3.3, 6.2, 8.2; principles 4 and 6):
// reserve -> direct upload -> finalize (real size and SHA-256 are checked) -> list / text / download / search / edit / delete, the quota in every state, and what
// a second user can never reach. The cross-user case of every ROUTE is in test/routes-isolation.test.mjs.
import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/api-harness.mjs';
import { getStorage } from '../server/storage/index.js';
import { mintVerifiedUid } from '../server/db/verified-uid.js';
import { sweepFiles } from '../server/admin/cron.js';

const MB = 1024 * 1024;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let h, st, A, B, a, b;
test.before(async () => {
  h = await startHarness(); st = await getStorage();
  a = h.mkUser('a@example.test'); b = h.mkUser('b@example.test');
  A = await h.bearer(a, { email: 'a@example.test' }); B = await h.bearer(b, { email: 'b@example.test' });
  await h.call('GET', '/api/elvar/session', A); await h.call('GET', '/api/elvar/session', B);
});
test.after(() => h.stop());

/** What the browser does with the answer of /files/reserve: PUT the bytes to the signed link. */
async function putTo(upload, bytes) {
  const tok = new URL(upload.url).searchParams.get('token');
  assert.equal(upload.method, 'PUT');
  return st.uploadWithToken(tok, bytes, { contentType: upload.headers['content-type'] });
}
const reserve = (who, bytes, name = 'メモ.txt', extra = {}) => h.call('POST', '/api/elvar/files/reserve', who, { name, size: bytes.length, sha256: sha(bytes), ...extra });
/** reserve + upload + finalize */
async function addFile(who, bytes, { name = 'メモ.txt', text = '', analysis = {}, extra = {}, ...rest } = {}) {
  const r = await reserve(who, bytes, name, { textBytes: Buffer.byteLength(text), ...extra }); assert.equal(r.status, 200, JSON.stringify(r.body));
  if (r.body.duplicate) return r;
  await putTo(r.body.upload, bytes);
  return h.call('POST', `/api/elvar/files/${r.body.fileId}/finalize`, who, { text, analysis, ...rest });
}

test('upload: reserve -> PUT to the signed link -> finalize; the file is listed with its memory, text, download link, and the quota meter moves', async () => {
  const bytes = Buffer.from('領収書 合計 12,000円 2026年11月3日'), text = '領収書 合計 12,000円 2026年11月3日';
  const r = await reserve(A, bytes, '領収書.txt', { textBytes: Buffer.byteLength(text), source: 'drop' });
  assert.equal(r.status, 200); assert.ok(r.body.fileId); assert.match(r.body.upload.url, /\/storage\/v1\/object\/upload\/sign\/user-files\/users\/[0-9a-f-]{36}\/files\//);
  const mid = (await h.call('GET', '/api/elvar/files', A)).body;
  assert.deepEqual(mid.files, [], 'a pending upload is not in the library'); assert.equal(mid.usage.reservedBytes, bytes.length + Buffer.byteLength(text), 'but its room is reserved');
  await putTo(r.body.upload, bytes);
  const f = await h.call('POST', `/api/elvar/files/${r.body.fileId}/finalize`, A, { text, title: '領収書', docKind: '領収書・請求書', keywords: ['領収書', '合計'], snippet: '領収書 合計 12,000円', analysis: { ext: 'txt', pages: 1, headings: ['領収書'] }, related: null });
  assert.equal(f.status, 200, JSON.stringify(f.body)); assert.equal(f.body.file.name, '領収書.txt'); assert.equal(f.body.file.kind, 'text'); assert.equal(f.body.file.sha256, sha(bytes)); assert.equal(f.body.file.source, 'drop');
  assert.equal(JSON.stringify(f.body).includes('users/'), false, 'the Storage path never leaves the server');
  const list = (await h.call('GET', '/api/elvar/files', A)).body;
  assert.equal(list.files.length, 1); assert.deepEqual(list.files[0].keywords, ['領収書', '合計']); assert.equal(list.files[0].analysis.pages, 1);
  assert.deepEqual(list.usage.breakdown, { files: bytes.length, text: Buffer.byteLength(text), notes: 0, messages: 0 }); assert.equal(list.usage.reservedBytes, 0);
  assert.equal(list.usage.quotaBytes, 524288000);
  assert.equal((await h.call('GET', `/api/elvar/files/${f.body.file.id}/text`, A)).body.text, text);
  const dl = (await h.call('GET', `/api/elvar/files/${f.body.file.id}/download`, A)).body; assert.ok(dl.url.includes('/storage/v1/object/sign/user-files/')); assert.equal(dl.name, '領収書.txt');
  const got = await st.downloadWithToken(new URL(dl.url).searchParams.get('token')); assert.deepEqual(got.bytes, bytes);
  assert.equal((await h.call('POST', `/api/elvar/files/${f.body.file.id}/finalize`, A, { text })).status, 200, 'finalize is idempotent');
  assert.equal((await h.call('GET', '/api/elvar/usage', A)).body.storage.filesBytes, bytes.length, 'the usage screen reads the same numbers');
});

test('the same content is not stored twice (per user): the reservation answers with the existing file; "keep anyway" is the owner\'s choice; another user is not told', async () => {
  const bytes = Buffer.from('dedupe-me ' + crypto.randomUUID());
  const first = await addFile(A, bytes, { name: 'a1.txt' }); assert.equal(first.status, 200);
  const dup = await reserve(A, bytes, 'a2.txt'); assert.deepEqual(dup.body, { duplicate: { id: first.body.file.id, name: 'a1.txt' } });
  const keep = await addFile(A, bytes, { name: 'a2.txt', extra: { allowDuplicate: true } }); assert.equal(keep.status, 200); assert.notEqual(keep.body.file.id, first.body.file.id);
  const other = await reserve(B, bytes, 'b1.txt'); assert.ok(other.body.fileId && !other.body.duplicate, 'B has its own library: A\'s file does not exist for B');
  await h.call('POST', `/api/elvar/files/${other.body.fileId}/cancel`, B);
});

test('finalize looks at the REAL object: different bytes, a missing upload and a size that differs are refused, and nothing stays behind', async () => {
  const bytes = Buffer.from('declared content ' + crypto.randomUUID());
  // different bytes of the same length
  let r = await reserve(A, bytes, 'liar.txt'); await putTo(r.body.upload, Buffer.from(bytes.toString().split('').reverse().join('')));
  let f = await h.call('POST', `/api/elvar/files/${r.body.fileId}/finalize`, A, {}); assert.equal(f.status, 422); assert.equal(f.body.error, 'upload_mismatch');
  assert.equal((await h.call('GET', `/api/elvar/files/${r.body.fileId}`, A)).status, 404, 'the row is gone');
  assert.equal(st.testing.list().some((k) => k.includes(r.body.fileId)), false, 'and so is the object');
  // a larger object than the one reserved
  r = await reserve(A, bytes, 'big.txt'); await putTo(r.body.upload, Buffer.concat([bytes, Buffer.from('more')]));
  assert.equal((await h.call('POST', `/api/elvar/files/${r.body.fileId}/finalize`, A, {})).status, 422);
  // nothing uploaded at all
  r = await reserve(A, bytes, 'none.txt'); f = await h.call('POST', `/api/elvar/files/${r.body.fileId}/finalize`, A, {}); assert.equal(f.status, 409); assert.equal(f.body.error, 'upload_missing');
  await h.call('POST', `/api/elvar/files/${r.body.fileId}/cancel`, A);
  // the reservations were all given back
  assert.equal((await h.call('GET', '/api/elvar/files', A)).body.usage.reservedBytes, 0);
});

test('the quota: reserved bytes count, the announced text counts, a refusal is in Japanese with the numbers, and nothing is reserved by a refused request', async () => {
  const c = h.mkUser('c@example.test'), C = await h.bearer(c); await h.call('GET', '/api/elvar/session', C);
  h.db.testing.setQuota(c, 1000);
  const ok1 = await reserve(C, Buffer.alloc(600, 1), 'x.txt'); assert.equal(ok1.status, 200);
  const no = await reserve(C, Buffer.alloc(500, 2), 'y.txt'); assert.equal(no.status, 413); assert.equal(no.body.error, 'storage_quota_exceeded');
  assert.match(no.body.message, /保存容量の上限に達しました/); assert.match(no.body.message, /使用中/); assert.equal(no.body.quotaBytes, 1000); assert.equal(no.body.neededBytes, 500);
  assert.equal((await h.call('GET', '/api/elvar/files', C)).body.usage.reservedBytes, 600, 'the refused request reserved nothing');
  const withText = await reserve(C, Buffer.alloc(300, 3), 'z.txt', { textBytes: 200 }); assert.equal(withText.status, 413, '300 + the 200 bytes of text announced do not fit in the 400 that are left');
  assert.equal((await reserve(C, Buffer.alloc(300, 3), 'z.txt', { textBytes: 100 })).status, 200, '300 + 100 does');
  // a text larger than announced is refused at finalize, and the file is not kept
  const b2 = Buffer.alloc(10, 9), r = await reserve(C, b2, 'small.txt', { textBytes: 1 }); assert.equal(r.status, 413, 'no room left (600 + 400 = 1000)');
  assert.equal(h.db.testing.usage(c).reservedBytes, 1000);
  // an expired reservation gives its room back (the next reserve sweeps it)
  h.db.testing.advance(31 * 60_000);
  assert.equal((await reserve(C, Buffer.alloc(900, 4), 'after.txt')).status, 200, 'the room of the abandoned uploads is free again');
  // an admin raising the quota is the only way past it
  h.db.testing.setQuota(c, 100);
  assert.equal((await reserve(C, Buffer.alloc(200, 5), 'over.txt')).status, 413);
});

test('a text that is bigger than what was announced is refused at finalize (the reservation covers exactly the announced bytes) and the upload is discarded', async () => {
  const bytes = Buffer.from('size check ' + crypto.randomUUID()), r = await reserve(A, bytes, 'text-lie.txt', { textBytes: 5 });
  await putTo(r.body.upload, bytes);
  const f = await h.call('POST', `/api/elvar/files/${r.body.fileId}/finalize`, A, { text: 'x'.repeat(50) }); assert.equal(f.status, 413); assert.equal(f.body.error, 'storage_quota_exceeded');
  assert.equal((await h.call('GET', `/api/elvar/files/${r.body.fileId}`, A)).status, 404);
  assert.equal(st.testing.list().some((k) => k.includes(r.body.fileId)), false);
});

test('per-file limit: 60 MB, an empty file, a type that is not supported, a name that tries a path; the admin can lower the limit per user', async () => {
  const sizeOnly = (size, name = 'big.pdf') => h.call('POST', '/api/elvar/files/reserve', A, { name, size, sha256: 'a'.repeat(64) });
  const over = await sizeOnly(60 * MB + 1); assert.equal(over.status, 413); assert.equal(over.body.error, 'file_too_large'); assert.match(over.body.message, /60 MB/);
  assert.equal((await sizeOnly(0)).status, 400);
  assert.equal((await sizeOnly(10, 'evil.html')).status, 415); assert.equal((await sizeOnly(10, 'x.svg')).status, 415); assert.equal((await sizeOnly(10, 'noext')).status, 415);
  const r = await sizeOnly(5, '../../etc/passwd.txt'); assert.equal(r.status, 200); assert.equal(r.body.name, 'passwd.txt', 'the path part of a name is dropped');
  await h.call('POST', `/api/elvar/files/${r.body.fileId}/cancel`, A);
  const d = h.mkUser(), D = await h.bearer(d); await h.call('GET', '/api/elvar/session', D);
  h.db.testing.setHardLimits(d, { maxFileBytes: 100 });
  const small = await h.call('POST', '/api/elvar/files/reserve', D, { name: 'small.txt', size: 100, sha256: 'b'.repeat(64) }); assert.equal(small.status, 200);
  const lowered = await h.call('POST', '/api/elvar/files/reserve', D, { name: 'bigger.txt', size: 101, sha256: 'c'.repeat(64) }); assert.equal(lowered.status, 413); assert.equal(lowered.body.error, 'file_too_large'); assert.match(lowered.body.message, /1ファイルは 100 B までです/);
});

test('metadata edits: tags, memo, kind label, rename (the extension stays), the AI summary; the memory replaces the text and the quota follows', async () => {
  const bytes = Buffer.from('edit me ' + crypto.randomUUID()), f = (await addFile(A, bytes, { name: 'edit.txt', text: 'old text' })).body.file;
  const p = await h.call('PATCH', `/api/elvar/files/${f.id}`, A, { tags: ['#経費', ' 経費 ', '2026'], memo: 'メモです', kindLabel: '契約書', name: 'renamed.txt', analysis: { summaryAI: '要約です', summaryAt: 1 } });
  assert.equal(p.status, 200, JSON.stringify(p.body)); assert.deepEqual(p.body.file.tags, ['経費', '2026']); assert.equal(p.body.file.memo, 'メモです'); assert.equal(p.body.file.kindLabel, '契約書'); assert.equal(p.body.file.name, 'renamed.txt'); assert.equal(p.body.file.analysis.summaryAI, '要約です');
  assert.equal((await h.call('PATCH', `/api/elvar/files/${f.id}`, A, { name: 'renamed.pdf' })).status, 400, 'the extension cannot change');
  assert.equal((await h.call('PATCH', `/api/elvar/files/${f.id}`, A, { tags: 'not-a-list' })).status, 400);
  const before = (await h.call('GET', '/api/elvar/files', A)).body.usage.breakdown.text;
  const put = await h.call('PUT', `/api/elvar/files/${f.id}/text`, A, { text: 'new longer text 日本語', title: 'タイトル', keywords: ['日本語'], snippet: 'new', analysis: { ocrAI: true } });
  assert.equal(put.status, 200, JSON.stringify(put.body)); assert.equal(put.body.file.analysis.ocrAI, true); assert.equal(put.body.file.title, 'タイトル'); assert.equal(put.body.file.memo, 'メモです', 'the owner\'s memo is kept');
  assert.equal((await h.call('GET', `/api/elvar/files/${f.id}/text`, A)).body.text, 'new longer text 日本語');
  assert.equal((await h.call('GET', '/api/elvar/files', A)).body.usage.breakdown.text, before - Buffer.byteLength('old text') + Buffer.byteLength('new longer text 日本語'));
});

test('search over the owner\'s own files on the server: the name, the tags, the memory and the extracted text; B finds nothing of A\'s', async () => {
  const bytes = Buffer.from('search ' + crypto.randomUUID()), mark = 'ユニークな検索語' + crypto.randomBytes(3).toString('hex');
  const f = (await addFile(A, bytes, { name: '企画書.txt', text: `これは本文です。${mark} が書いてあります。`, title: '企画書', keywords: ['企画'], snippet: 'これは本文です' })).body.file;
  const byText = (await h.call('GET', '/api/elvar/files/search', A, {}, { q: mark })).body; assert.equal(byText.results[0].id, f.id); assert.ok(byText.results[0].matched.includes('本文'));
  assert.equal((await h.call('GET', '/api/elvar/files/search', A, {}, { q: '企画書' })).body.results[0].id, f.id, 'by name');
  assert.ok(byText.forModel[0].snippet.length <= 120, 'what goes to the AI is a short snippet, never the text');
  assert.equal(JSON.stringify(byText.forModel).includes(mark), false, 'the full text is not in the model-facing list');
  assert.deepEqual((await h.call('GET', '/api/elvar/files/search', B, {}, { q: mark })).body.results, []);
  assert.deepEqual((await h.call('GET', '/api/elvar/files/search', B, {}, { q: '企画書' })).body.results, []);
  assert.equal((await h.call('GET', '/api/elvar/files/search', A, {}, { q: '' })).status, 400);
});

test('delete: the Storage object and the row are gone and the room is free; a Storage failure keeps the file hidden (deleting) and the sweep finishes it', async () => {
  const bytes = Buffer.from('delete me ' + crypto.randomUUID()), f = (await addFile(A, bytes, { name: 'del.txt', text: 'abc' })).body.file;
  const used = (await h.call('GET', '/api/elvar/files', A)).body.usage.breakdown;
  const path = st.testing.list().find((k) => k.includes(f.id)); assert.ok(path);
  const d = await h.call('DELETE', `/api/elvar/files/${f.id}`, A); assert.equal(d.status, 200); assert.equal(d.body.freedBytes, bytes.length);
  assert.equal(st.testing.list().some((k) => k.includes(f.id)), false); assert.equal((await h.call('GET', `/api/elvar/files/${f.id}`, A)).status, 404);
  const after = (await h.call('GET', '/api/elvar/files', A)).body.usage.breakdown; assert.equal(after.files, used.files - bytes.length); assert.equal(after.text, used.text - 3);
  // Storage is down: the file disappears from the list, the bytes stay counted until the sweep
  const g = (await addFile(A, Buffer.from('stuck ' + crypto.randomUUID()), { name: 'stuck.txt' })).body.file;
  const real = st.forUser; st.forUser = (x) => ({ ...real(x), remove: async () => { throw Object.assign(new Error('down'), { status: 502, code: 'storage_unreachable' }); } });
  try { const r = await h.call('DELETE', `/api/elvar/files/${g.id}`, A); assert.equal(r.status, 502); assert.equal(r.body.error, 'storage_unavailable'); } finally { st.forUser = real; }
  assert.ok(st.testing.list().some((k) => k.includes(g.id)), 'the object is still there');
  const swept = await sweepFiles(h.db.system, { storage: st }); assert.ok(swept.removed >= 1); assert.equal(st.testing.list().some((k) => k.includes(g.id)), false, 'the daily sweep (service key) removed it');
  assert.equal((await h.call('GET', '/api/elvar/files', A)).body.usage.breakdown.files, after.files, 'and the bytes are free');
  // the same recovery happens on the owner's next request, without waiting for the daily sweep
  const g2 = (await addFile(A, Buffer.from('stuck too ' + crypto.randomUUID()), { name: 'stuck2.txt' })).body.file;
  st.forUser = (x) => ({ ...real(x), remove: async () => { throw Object.assign(new Error('down'), { status: 502, code: 'storage_unreachable' }); } });
  try { assert.equal((await h.call('DELETE', `/api/elvar/files/${g2.id}`, A)).status, 502); } finally { st.forUser = real; }
  assert.ok(st.testing.list().some((k) => k.includes(g2.id)));
  const listed = (await h.call('GET', '/api/elvar/files', A)).body; assert.equal(listed.files.some((x) => x.id === g2.id), false, 'hidden from the list');
  assert.equal(st.testing.list().some((k) => k.includes(g2.id)), false, 'and the listing request cleaned up after the failed delete');
  assert.equal(listed.usage.breakdown.files, after.files);
  // the daily recount agrees with the running figures
  assert.equal(await h.db.system.reconcileStorage(), 0);
});

test('notes, versions and messages count too (the P4 TODO): one meter for everything, and a full account refuses new notes as well as new files', async () => {
  const c = h.mkUser(), C = await h.bearer(c); await h.call('GET', '/api/elvar/session', C);
  const V = mintVerifiedUid(c, 'test');
  await h.db.asUser(V, async (r) => { await r.notes.put({ path: 'メモ/a.md', content: '1234567890' }); await r.notes.put({ path: 'メモ/a.md', content: 'abcdefghijklmnop' }); await r.messages.append({ turns: [{ role: 'user', text: 'こんにちは', at: Date.now() }] }); });
  const u = (await h.call('GET', '/api/elvar/files', C)).body.usage;
  assert.deepEqual(u.breakdown, { files: 0, text: 0, notes: 10 + 16, messages: Buffer.byteLength('こんにちは') }, 'the note and its older version, the message');
  assert.equal(u.usedBytes, 26 + 15);
  h.db.testing.setQuota(c, 40);
  await assert.rejects(h.db.asUser(V, (r) => r.notes.put({ path: 'メモ/b.md', content: 'x'.repeat(30) })), (e) => e.code === 'storage_quota_exceeded' && e.status === 413);
  assert.equal((await reserve(C, Buffer.alloc(30, 1), 'f.txt')).status, 413, 'the notes use up the room the file would need');
});

test('delete everything (principle 7) needs the confirmation word and removes every object of the caller only', async () => {
  const c = h.mkUser(), C = await h.bearer(c); await h.call('GET', '/api/elvar/session', C);
  for (let i = 0; i < 3; i++) await addFile(C, Buffer.from('c-file-' + i + crypto.randomUUID()), { name: `c${i}.txt`, text: 'cc' });
  const aBefore = st.testing.list().filter((k) => k.includes(`users/${a}/`)).length; assert.ok(aBefore > 0);
  assert.equal((await h.call('POST', '/api/elvar/files/delete-all', C, {})).status, 400);
  const r = await h.call('POST', '/api/elvar/files/delete-all', C, { confirm: 'delete' }); assert.deepEqual(r.body, { ok: true, deleted: 3 });
  assert.equal(st.testing.list().filter((k) => k.includes(`users/${c}/`)).length, 0);
  assert.equal(st.testing.list().filter((k) => k.includes(`users/${a}/`)).length, aBefore, 'A\'s files are untouched');
  assert.deepEqual((await h.call('GET', '/api/elvar/files', C)).body.usage.breakdown, { files: 0, text: 0, notes: 0, messages: 0 });
});

test('the export lists the files (metadata, memory, text) and a download path for every original; the Storage path is not in it', async () => {
  const x = (await h.call('GET', '/api/elvar/account/export', A)).body.files['files.json'];
  assert.ok(x.files.length >= 1); assert.ok(x.files.every((f) => 'text' in f && !('objectPath' in f)));
  assert.equal(x.originals.length, x.files.length); assert.ok(x.originals.every((o) => o.downloadPath === `/api/elvar/files/${o.id}/download` && o.exportPath.startsWith(`files/${o.id}-`)));
  assert.equal(JSON.stringify(x).includes(`users/${a}`), false);
});

test('account deletion removes every Storage object of the user (all buckets) and the residual check verifies it; B\'s files survive', async () => {
  const c = h.mkUser('c2@example.test'), C = await h.bearer(c, { email: 'c2@example.test' }); await h.call('GET', '/api/elvar/session', C);
  const cf = (await addFile(C, Buffer.from('to be deleted ' + crypto.randomUUID()), { name: 'gone.txt', text: 'gone' })).body.file;
  st.testing.put(`users/${c}/exports/job1/part-1.zip`, Buffer.from('zip'), { bucket: 'user-exports' }); st.testing.put(`users/${c}/greetings/x.pcm`, Buffer.from('pcm'), { bucket: 'user-cache' });
  const bf = (await addFile(B, Buffer.from('b survives ' + crypto.randomUUID()), { name: 'b.txt' })).body.file;
  assert.ok(st.testing.list().some((k) => k.includes(cf.id)));
  const d = await h.call('POST', '/api/elvar/account/delete', C, { graceDays: 0 }); assert.equal(d.status, 200, JSON.stringify(d.body)); assert.equal(d.body.deleted, true);
  assert.deepEqual(st.testing.list().filter((k) => k.includes(`users/${c}/`)), [], 'nothing of C is left in any bucket');
  assert.ok(st.testing.list().some((k) => k.includes(bf.id)), 'B\'s file is untouched');
  assert.equal((await h.call('GET', `/api/elvar/files/${bf.id}`, B)).status, 200);
});

test('the purge does not finish while a Storage object is left behind (the residual check counts objects, not only rows)', async () => {
  const { purgeAccount } = await import('../server/rights/purge.js'), { residualCheck } = await import('../server/rights/residual.js');
  const c = h.mkUser(); st.testing.put(`users/${c}/files/zz/leftover`, Buffer.from('x'));
  const stubborn = { ...st, service: { list: async () => [], remove: async () => 0, count: (p, o) => st.service.count(p, o) } };   // a sweep that silently fails to list
  await assert.rejects(purgeAccount(h.db, c, { deleteUser: async (u) => h.db.testing.deleteUser(u), storage: stubborn, revoke: [] }), (e) => e.code === 'purge_incomplete');
  const res = await residualCheck(h.db, mintVerifiedUid(c, 'purge'), { storage: st }); assert.equal(res.clean, false); assert.deepEqual(res.storageLeft, [{ bucket: 'user-files', n: 1 }]);
  await st.service.remove([`users/${c}/files/zz/leftover`]);
  assert.equal((await residualCheck(h.db, mintVerifiedUid(c, 'purge'), { storage: st })).clean, true);
});

test('a signed upload link outlives the reservation (2 hours): bytes written through it after the file was deleted are removed by the sweep once the link is dead, and a user cannot pile up reservations to hold links', async () => {
  const c = h.mkUser(), C = await h.bearer(c); await h.call('GET', '/api/elvar/session', C);
  const bytes = Buffer.from('late write ' + crypto.randomUUID()), r = await reserve(C, bytes, 'late.txt'), path = st.testing.list().length; void path;
  const cancel = await h.call('POST', `/api/elvar/files/${r.body.fileId}/cancel`, C, {}); assert.equal(cancel.status, 200);
  assert.equal((await h.call('GET', '/api/elvar/files', C)).body.usage.reservedBytes, 0, 'the room is free at once');
  await putTo(r.body.upload, Buffer.alloc(5000, 1));   // the link still works: the object appears, and nobody counts it
  assert.ok(st.testing.list().some((k) => k.includes(r.body.fileId)), 'the late write landed');
  assert.equal((await h.call('GET', '/api/elvar/files', C)).body.usage.breakdown.files, 0);
  assert.ok(st.testing.list().some((k) => k.includes(r.body.fileId)), 'a young tombstone is not swept: the link could still be used');
  h.db.testing.advance(131 * 60_000);   // the link is dead now
  await h.call('GET', '/api/elvar/files', C);   // the owner's next request (or the daily sweep) removes it for good
  assert.equal(st.testing.list().some((k) => k.includes(r.body.fileId)), false, 'the late object is gone');
  assert.equal(h.db.testing.usage(c).filesBytes, 0);
  // the cap on recent rows: 40 reservations that were given up, the 41st is refused with a plain message
  const d = h.mkUser(), D = await h.bearer(d); await h.call('GET', '/api/elvar/session', D);
  for (let i = 0; i < 40; i++) { const x = await reserve(D, Buffer.from('cap ' + i + crypto.randomUUID()), `cap${i}.txt`); assert.equal(x.status, 200); await h.call('POST', `/api/elvar/files/${x.body.fileId}/cancel`, D, {}); }
  const over = await reserve(D, Buffer.from('cap over ' + crypto.randomUUID()), 'over.txt'); assert.equal(over.status, 409); assert.equal(over.body.error, 'too_many_uploads');
});
