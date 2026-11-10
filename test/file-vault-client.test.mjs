// The browser side of the file vault (web/src/file-store.js, file-legacy.js, shared/file-record.js) against the REAL server routes on the memory database and the fake Storage:
// the same code path the screen takes (reserve -> PUT -> finalize), with the HTTP and the signed-link transfers replaced by direct calls.
import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/api-harness.mjs';
import { getStorage } from '../server/storage/index.js';
import { createFileStore, capText, TEXT_MAX_CHARS } from '../web/src/file-store.js';
import { migrateLibrary } from '../web/src/file-legacy.js';
import { toColumns, indexOf, metaOf } from '../shared/file-record.js';
import { buildIndex, sha256Hex } from '../web/src/file-index.js';
import { meterModel, accountQuotaText, checkQuota, LIMITS, MB } from '../web/src/file-lib.js';

let h, st, A, B, a;
test.before(async () => {
  h = await startHarness(); st = await getStorage();
  a = h.mkUser('a@example.test'); const b = h.mkUser('b@example.test');
  A = await h.bearer(a, { email: 'a@example.test' }); B = await h.bearer(b, { email: 'b@example.test' });
  await h.call('GET', '/api/elvar/session', A); await h.call('GET', '/api/elvar/session', B);
});
test.after(() => h.stop());

/** The page's `api(path, {method, body})` for one signed-in user, answered by the real router. */
const apiFor = (who, log = []) => async (path, { method = 'GET', body } = {}) => {
  const u = new URL(path, 'http://x'); log.push(`${method} ${u.pathname}`);
  const r = await h.call(method, u.pathname, who, body ?? {}, Object.fromEntries(u.searchParams)); return { status: r.status, body: r.body };
};
const transfer = {
  upload: async (up, blob) => { await st.uploadWithToken(new URL(up.url).searchParams.get('token'), Buffer.from(await blob.arrayBuffer()), { contentType: up.headers['content-type'] }); },
  download: async (url) => new Blob([(await st.downloadWithToken(new URL(url).searchParams.get('token'))).bytes]),
};
const newStore = (who, extra = {}) => createFileStore({ api: apiFor(who), idb: null, storage: null, ...transfer, ...extra });
const analysed = async (name, text) => { const bytes = new TextEncoder().encode(text), { index, text: t } = buildIndex({ text, status: 'ok' }, { name, ext: name.split('.').pop(), size: bytes.length, sha256: await sha256Hex(bytes) }); return { blob: new Blob([bytes], { type: 'text/plain' }), index, text: t }; };

test('put -> list / indexes / text / blob: the screen\'s store API works on top of the account vault, with the memory round-tripping through the columns', async () => {
  const s = newStore(A), { blob, index, text } = await analysed('領収書.txt', '領収書\n合計 12,000円\n2026年11月3日 株式会社テスト');
  const progress = []; const meta = await s.put({ name: '領収書.txt', type: 'text/plain', kind: 'text', size: blob.size, addedAt: 1700000000000, source: 'drop' }, blob, { ...index, tags: ['経費'], memo: '提出済み', kind: '領収書・請求書' }, text, { onProgress: (p) => progress.push(p.stage) });
  assert.equal(meta.name, '領収書.txt'); assert.equal(meta.addedAt, 1700000000000, 'a moved file keeps its date'); assert.equal(meta.source, 'drop');
  assert.ok(progress.includes('確認中'));
  assert.deepEqual((await s.list()).map((f) => f.name), ['領収書.txt']);
  const ix = (await s.indexes()).get(meta.id);
  assert.deepEqual([ix.tags, ix.memo, ix.kind, ix.sha256, ix.docKind === index.docKind, ix.keywords], [['経費'], '提出済み', '領収書・請求書', index.sha256, true, index.keywords], 'the owner\'s fields and the guess round-trip');
  assert.equal(ix.status, 'ok'); assert.deepEqual(ix.dates, index.dates); assert.equal(ix.chars, index.chars);
  assert.equal(await s.getText(meta.id), text); assert.equal((await s.usage()).breakdown.files, blob.size);
  const back = await s.blob(meta.id); assert.equal(back.type, 'text/plain', 'typed by what the server knows, not by what Storage says'); assert.equal(await back.text(), await blob.text());
  assert.ok((await s.search('合計 12,000円')).some((r) => r.id === meta.id));
  // a second browser (the same account) sees it; another account does not
  assert.equal((await newStore(A).list()).length, 1); assert.deepEqual(await newStore(B).list(), []);
  await s.remove(meta.id); assert.deepEqual(await s.list(), []); assert.equal(st.testing.list().some((k) => k.includes(meta.id)), false);
});

test('patchIndex / putIndex: tags, memo, kind go to their columns, the AI summary and the note path into the memory, a re-read replaces the text; the owner\'s fields survive', async () => {
  const s = newStore(A), { blob, index, text } = await analysed('メモ2.txt', '議事録 参加者 田中 2026-11-05 次回の予定'), meta = await s.put({ name: 'メモ2.txt', source: 'picker' }, blob, index, text);
  let ix = await s.patchIndex(meta.id, { tags: ['会議', '2026'], memo: 'メモ', kind: '議事録', summaryAI: 'AIの要約', summaryAt: 5, brainPath: 'ファイル/メモ2.md' });
  assert.deepEqual([ix.tags, ix.memo, ix.kind, ix.summaryAI, ix.summaryAt, ix.brainPath], [['会議', '2026'], 'メモ', '議事録', 'AIの要約', 5, 'ファイル/メモ2.md']);
  ix = await s.patchIndex(meta.id, { kind: '' }); assert.equal(ix.kind, '', 'back to the guess');
  const re = buildIndex({ text: 'OCRで読み取った新しい文字', status: 'ok' }, { name: 'メモ2.txt', ext: 'txt', size: blob.size, sha256: index.sha256 });
  ix = await s.putIndex(meta.id, { ...re.index, ocrAI: true }, re.text);
  assert.equal(await s.getText(meta.id), 'OCRで読み取った新しい文字'); assert.equal(ix.ocrAI, true); assert.deepEqual(ix.tags, ['会議', '2026'], 'tags stay'); assert.equal(ix.memo, 'メモ');
  assert.equal(ix.summaryAI, 'AIの要約', 'the AI summary made before stays too');
  await assert.rejects(s.patchIndex('00000000-0000-4000-8000-000000000000', { memo: 'x' }), /保存できません/);
  await s.remove(meta.id);
});

test('duplicates and the quota arrive as errors the screen can show: the server\'s own Japanese message, the existing file for a duplicate, cancel gives the room back', async () => {
  const s = newStore(A), x = await analysed('dup.txt', '同じ内容の文書 ' + crypto.randomUUID()), first = await s.put({ name: 'dup.txt' }, x.blob, x.index, x.text);
  await assert.rejects(s.put({ name: 'dup2.txt' }, x.blob, x.index, x.text), (e) => e.code === 'duplicate' && e.duplicate.id === first.id);
  const second = await s.put({ name: 'dup2.txt' }, x.blob, x.index, x.text, { allowDuplicate: true }); assert.notEqual(second.id, first.id);
  const c = h.mkUser(), C = await h.bearer(c); await h.call('GET', '/api/elvar/session', C); h.db.testing.setQuota(c, 100);
  const sc = newStore(C), big = await analysed('big.txt', 'x'.repeat(500));
  await assert.rejects(sc.put({ name: 'big.txt' }, big.blob, big.index, big.text), (e) => e.code === 'storage_quota_exceeded' && /保存容量の上限に達しました/.test(e.message) && e.body.quotaBytes === 100);
  // the upload fails half way: the reservation is given back, nothing stays pending
  const failing = newStore(A, { upload: async () => { throw Object.assign(new Error('中止しました'), { cancelled: true }); } }), y = await analysed('cancel.txt', 'cancel ' + crypto.randomUUID());
  await assert.rejects(failing.put({ name: 'cancel.txt' }, y.blob, y.index, y.text), (e) => e.cancelled === true);
  assert.equal((await h.call('GET', '/api/elvar/files', A)).body.usage.reservedBytes, 0, 'the reservation was cancelled');
  await s.remove(first.id); await s.remove(second.id);
});

test('offline: the last list is read from the cache (read only), changes are refused with a clear message', async () => {
  const mem = new Map(), idb = null; void idb;
  let online = true; const real = apiFor(A);
  const s = createFileStore({ api: async (p, o) => { if (!online) throw new Error('net'); return real(p, o); }, idb: null, storage: null, ...transfer });
  const x = await analysed('off.txt', 'offline ' + crypto.randomUUID()); const meta = await s.put({ name: 'off.txt' }, x.blob, x.index, x.text);
  online = false; s.invalidate();
  await assert.rejects(s.list(), (e) => e.code === 'offline', 'without a cache (no IndexedDB here) there is nothing to read');
  void mem; online = true; await s.remove(meta.id);
});

test('a blob whose size differs from the record is refused (a tampered download), and a failed download is an error, not an empty file', async () => {
  const x = await analysed('tamper.txt', 'tamper ' + crypto.randomUUID()), s = newStore(A), meta = await s.put({ name: 'tamper.txt' }, x.blob, x.index, x.text);
  const bad = newStore(A, { download: async () => new Blob(['short']) }); await assert.rejects(bad.blob(meta.id), /大きさが一致しません/);
  const gone = newStore(A, { download: async () => { throw new Error('ファイルを取得できませんでした'); } }); await assert.rejects(gone.blob(meta.id), /取得できません/);
  assert.equal(await newStore(B).blob(meta.id), undefined, 'B cannot even ask for it'); await s.remove(meta.id);
});

test('migrating the old local library: one by one, memory and tags kept, the original date kept, duplicates skipped (and removed locally), the account\'s quota stops it, local copies are deleted only after they are in the account', async () => {
  const c = h.mkUser(), C = await h.bearer(c); await h.call('GET', '/api/elvar/session', C);
  const s = newStore(C), have = await analysed('already.txt', '既にアカウントにある文書 ' + crypto.randomUUID()); await s.put({ name: 'already.txt' }, have.blob, have.index, have.text);
  const items = []; for (const [n, t] of [['old1.txt', '昔のファイル1 ' + crypto.randomUUID()], ['old2.txt', '昔のファイル2 ' + crypto.randomUUID()]]) { const x = await analysed(n, t); items.push({ meta: { id: n, name: n, type: 'text/plain', kind: 'text', size: x.blob.size, addedAt: 1600000000000 + items.length * 1000 }, blob: x.blob, index: { ...x.index, tags: ['昔'], memo: 'メモ' }, text: x.text }); }
  items.push({ meta: { id: 'dup', name: 'already-copy.txt', type: 'text/plain', kind: 'text', size: have.blob.size, addedAt: 1 }, blob: have.blob, index: have.index, text: have.text });
  items.push({ meta: { id: 'noindex', name: 'noindex.txt', type: 'text/plain', kind: 'text', size: 5, addedAt: 2 }, blob: new Blob(['plain']), index: null, text: '' });
  const local = new Map(items.map((i) => [i.meta.id, i])), destroyed = []; const progress = [];
  const lib = { summary: async () => ({ count: local.size, bytes: 1 }), async *records() { for (const i of [...local.values()]) yield i; }, remove: async (id) => { local.delete(id); }, destroy: async () => { destroyed.push(1); } };
  const r = await migrateLibrary(lib, { store: s, onProgress: (p) => progress.push(p.name), analyse: async (blob) => ({ index: buildIndex({ text: 'plain', status: 'ok' }, { name: 'noindex.txt', ext: 'txt', size: blob.size, sha256: await sha256Hex(new Uint8Array(await blob.arrayBuffer())) }), text: 'plain', sha256: await sha256Hex(new Uint8Array(await blob.arrayBuffer())) }) });
  assert.deepEqual([r.moved, r.skipped, r.failed, r.stopped, r.remaining], [3, ['already-copy.txt'], [], null, 0]);
  assert.equal(local.size, 0, 'every local copy was removed after it was in the account'); assert.equal(destroyed.length, 1, 'and the emptied library was deleted');
  assert.ok(progress.includes('old1.txt') && progress.includes('noindex.txt'));
  const files = await s.list(), by = Object.fromEntries(files.map((f) => [f.name, f])); assert.equal(files.length, 4);
  assert.equal(by['old1.txt'].addedAt, 1600000000000, 'the date it was added on this device'); const ix = (await s.indexes()).get(by['old1.txt'].id); assert.deepEqual([ix.tags, ix.memo, ix.status], [['昔'], 'メモ', 'ok']);
  assert.equal(await s.getText(by['noindex.txt'].id), 'plain');
  // an account that is full: the rest stays on the device
  const d = h.mkUser(), D = await h.bearer(d); await h.call('GET', '/api/elvar/session', D); h.db.testing.setQuota(d, 200);
  const small = await analysed('s.txt', 'x'.repeat(80) + crypto.randomUUID().slice(0, 4)), big = await analysed('b.txt', 'y'.repeat(300));
  const loc2 = new Map([['s', { meta: { id: 's', name: 's.txt', type: 'text/plain', kind: 'text', size: small.blob.size, addedAt: 1 }, blob: small.blob, index: small.index, text: small.text }], ['b', { meta: { id: 'b', name: 'b.txt', type: 'text/plain', kind: 'text', size: big.blob.size, addedAt: 2 }, blob: big.blob, index: big.index, text: big.text }]]);
  const lib2 = { summary: async () => ({ count: loc2.size, bytes: 1 }), async *records() { for (const i of [...loc2.values()]) yield i; }, remove: async (id) => { loc2.delete(id); }, destroy: async () => { destroyed.push(2); } };
  const r2 = await migrateLibrary(lib2, { store: newStore(D) });
  assert.deepEqual([r2.moved, r2.stopped, r2.remaining], [1, 'quota', 1]); assert.match(r2.message, /保存容量の上限に達しました/); assert.deepEqual([...loc2.keys()], ['b'], 'the one that did not fit is still on the device'); assert.equal(destroyed.length, 1, 'the library is not deleted while files remain');
  // cancel
  const loc3 = new Map([['z', { meta: { id: 'z', name: 'z.txt', type: 'text/plain', kind: 'text', size: 3, addedAt: 1 }, blob: new Blob(['zzz']), index: null, text: '' }]]);
  const r3 = await migrateLibrary({ summary: async () => ({ count: 1, bytes: 3 }), async *records() { yield* loc3.values(); }, remove: async () => {}, destroy: async () => { destroyed.push(3); } }, { store: newStore(C), shouldStop: () => true });
  assert.deepEqual([r3.moved, r3.stopped], [0, 'cancelled']); assert.equal(destroyed.length, 1);
  // a file over 60 MB or empty is reported, not sent
  const r4 = await migrateLibrary({ summary: async () => ({ count: 2, bytes: 1 }), async *records() { yield { meta: { id: 'e', name: 'empty.txt', type: 'text/plain', kind: 'text', size: 0 }, blob: new Blob([]), index: null, text: '' }; yield { meta: { id: 'f', name: 'huge.bin', type: 'text/plain', kind: 'text', size: 61 * MB }, blob: { size: 61 * MB }, index: null, text: '' }; }, remove: async () => {}, destroy: async () => { destroyed.push(4); } }, { store: newStore(C) });
  assert.deepEqual(r4.failed.map((f) => f.name), ['empty.txt', 'huge.bin']); assert.equal(destroyed.length, 1, 'a library with failures is kept');
});

test('shared/file-record: the index splits into columns and rebuilds; the meta record keeps the original date', () => {
  const index = { version: 1, sha256: 'a'.repeat(64), size: 5, ext: 'txt', status: 'ok', title: 'T', docKind: '議事録', kind: '', tags: ['x'], memo: 'm', keywords: ['k1', 'k2'], snippet: 's', headings: ['h'], dates: ['2026-11-05'], related: { id: 'r', name: 'n', score: 0.5, extra: 'dropped' } };
  const cols = toColumns(index); assert.deepEqual(Object.keys(cols).sort(), ['analysis', 'docKind', 'keywords', 'related', 'snippet', 'title']);
  assert.equal(cols.analysis.sha256, undefined); assert.equal(cols.analysis.tags, undefined); assert.deepEqual(cols.analysis.headings, ['h']); assert.deepEqual(cols.related, { id: 'r', name: 'n', score: 0.5 });
  const file = { id: 'i', name: 'f.txt', mime: 'text/plain', kind: 'text', size: 5, sha256: 'a'.repeat(64), source: 'drop', createdAt: '2026-11-09T00:00:00.000Z', tags: ['x'], memo: 'm', kindLabel: null, title: 'T', docKind: '議事録', keywords: ['k1', 'k2'], snippet: 's', related: cols.related, analysis: cols.analysis };
  const back = indexOf(file); assert.deepEqual([back.tags, back.memo, back.kind, back.docKind, back.keywords, back.headings, back.ext], [['x'], 'm', '', '議事録', ['k1', 'k2'], ['h'], 'txt']);
  assert.equal(metaOf(file).addedAt, Date.parse(file.createdAt)); assert.equal(metaOf({ ...file, analysis: { addedAt: 42 } }).addedAt, 42);
});

test('the quota meter and the pre-check use the account\'s numbers: used / quota, the parts, the warning at 80%, the per-file limit', () => {
  const u = { usedBytes: 100 * MB, reservedBytes: 10 * MB, quotaBytes: 500 * MB, maxFileBytes: 60 * MB, breakdown: { files: 80 * MB, text: 10 * MB, notes: 6 * MB, messages: 4 * MB } };
  const m = meterModel(u); assert.equal(m.pct, 22); assert.equal(m.hot, false); assert.equal(m.full, false); assert.deepEqual(m.parts.map((p) => p.label), ['ファイルの原本', '読み取った文字', 'ノート', '会話の記録', 'アップロード中']);
  assert.equal(meterModel({ ...u, usedBytes: 400 * MB }).hot, true); assert.equal(meterModel({ ...u, usedBytes: 495 * MB }).full, true); assert.equal(meterModel(null), null);
  assert.match(accountQuotaText(u), /使用中 110 MB \/ 500 MB（22%）・1ファイル 60 MB まで・あなたのアカウントにだけ保存/);
  const lim = { ...LIMITS, perFile: u.maxFileBytes, total: u.quotaBytes };
  assert.equal(checkQuota({ name: 'a.pdf', size: 30 * MB, used: 110 * MB }, lim).ok, true); const no = checkQuota({ name: 'a.pdf', size: 30 * MB, used: 480 * MB }, lim); assert.equal(no.ok, false); assert.match(no.reason, /上限.*500 MB.*残り 20 MB/);
  assert.equal(checkQuota({ name: 'b.pdf', size: 61 * MB, used: 0 }, lim).ok, false);
});

test('checkQuota in account mode words the refusal like the server (used / limit / what is needed); the device wording is unchanged', () => {
  const lim = { ...LIMITS, account: true, perFile: 60 * MB, total: 500 * MB }, no = checkQuota({ name: 'a.pdf', size: 30 * MB, used: 480 * MB }, lim);
  assert.equal(no.ok, false); assert.match(no.reason, /保存容量の上限に達しました（使用中 480 MB ／ 上限 500 MB）.*このファイル（30 MB）.*あと 10 MB の空きが必要.*削除/);
  assert.match(checkQuota({ name: 'a.pdf', size: 20 * MB, used: 590 * MB }).reason, /保存の上限（合計 600 MB）/);
});

test('a very long extracted text is capped at what one request can carry (and says so); the cut never splits a surrogate pair', async () => {
  assert.equal(capText('abc'), 'abc'); assert.equal(capText('あ'.repeat(TEXT_MAX_CHARS + 50)).length, TEXT_MAX_CHARS);
  const edge = 'x'.repeat(TEXT_MAX_CHARS - 1) + '😀'; assert.equal(capText(edge).length, TEXT_MAX_CHARS - 1, 'the half of a pair is dropped');
  const s = newStore(A), big = 'い'.repeat(TEXT_MAX_CHARS + 1000), bytes = new TextEncoder().encode('long text file ' + crypto.randomUUID());
  const index = buildIndex({ text: 'い'.repeat(500), status: 'ok' }, { name: 'long.txt', ext: 'txt', size: bytes.length, sha256: await sha256Hex(bytes) });
  const meta = await s.put({ name: 'long.txt' }, new Blob([bytes]), index.index, big);
  const f = (await h.call('GET', `/api/elvar/files/${meta.id}`, A)).body.file; assert.equal(f.analysis.textTruncated, true); assert.ok(f.analysis.notes.some((n) => /130万字/.test(n)));
  assert.equal((await s.getText(meta.id)).length, TEXT_MAX_CHARS); await s.remove(meta.id);
});
