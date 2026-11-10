// The data export as a job (docs/ELVAR_MULTIUSER.md 7.3; principle 7): a zip in parts in the private bucket, links that expire, the job removed after its expiry, one a day,
// one running job at a time - and the part that must never rot: the export covers EVERY registry table and EVERY object the user has in Storage.
import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startHarness } from './helpers/api-harness.mjs';
import { runExport } from './helpers/export.mjs';
import { browserUpload } from './helpers/upload.mjs';
import { getStorage, pathOwner } from '../server/storage/index.js';
import { _setExportOptions } from '../server/account/exports.js';
import { sweepExports, partPath, EXPORT_BUCKET } from '../server/rights/export-job.js';
import { REGISTRY } from '../server/rights/registry.js';
import { readZip, createZip } from '../server/rights/zip.js';
import { mintVerifiedUid } from '../server/db/verified-uid.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const KEY = 'AIzaSy-EXPORT-SECRET-KEY-1234', CXTOKEN = 'EXPORT-CONNECTOR-TOKEN-777';
let h, st, a, b, A, B;
test.before(async () => {
  h = await startHarness(); st = await getStorage();
  a = h.mkUser('a@example.test'); b = h.mkUser('b@example.test'); A = await h.bearer(a, { email: 'a@example.test' }); B = await h.bearer(b, { email: 'b@example.test' });
  for (const w of [A, B]) await h.call('GET', '/api/elvar/session', w);
});
test.after(async () => { _setExportOptions(null); await h.stop(); });

async function addFile(who, bytes, name, text = '') {
  const r = await h.call('POST', '/api/elvar/files/reserve', who, { name, size: bytes.length, sha256: sha(bytes), textBytes: Buffer.byteLength(text) }); assert.equal(r.status, 200, JSON.stringify(r.body));
  await browserUpload(st, pathOwner(new URL(r.body.upload.url).pathname.replace('/storage/v1/object/user-files/', '')), r.body.upload, bytes);
  const f = await h.call('POST', `/api/elvar/files/${r.body.fileId}/finalize`, who, { text }); assert.equal(f.status, 200, JSON.stringify(f.body)); return f.body.file;
}
async function fill(who, uid, tag) {
  await h.call('PATCH', '/api/elvar/config', who, { secrets: { GEMINI_API_KEY: KEY + tag }, settings: { BRAIN_REPO: `${tag}/notes` } });
  await h.call('POST', '/api/elvar/devices', who, { name: tag + '-phone' });
  await h.call('POST', '/api/elvar/notes', who, { path: `${tag}/メモ.md`, content: `${tag} のノート本文` }); await h.call('POST', '/api/elvar/notes', who, { path: `家計/${tag}.md`, content: `${tag} の家計` });
  await h.call('POST', '/api/elvar/messages', who, { turns: [{ at: Date.now(), user: `${tag}の質問`, model: `${tag}の答え` }] });
  await h.call('POST', '/api/elvar/inbox', who, { title: `${tag}の通知` });
  await h.call('POST', '/api/elvar/connectors', who, { type: 'http', name: tag + 'API', http: { baseUrl: `https://${tag}.example.com` }, auth: { type: 'bearer', secret: CXTOKEN + tag }, tools: [{ name: 'ping', method: 'GET', path: '/ping', readOnly: true, approval: 'auto', description: 'ping', inputSchema: { type: 'object', properties: {} } }] });
  await h.db.asUser(mintVerifiedUid(uid, 'test'), (r) => r.usage.record({ provider: 'gemini', metric: 'calls', amount: 3 }));
  const files = [];
  for (let i = 0; i < 4; i++) files.push({ name: `${tag}-資料${i}.bin`.replace('.bin', '.txt'), bytes: crypto.randomBytes(3000) });
  const meta = []; for (const f of files) meta.push(await addFile(who, f.bytes, f.name, `${tag} 抽出テキスト ${f.name}`));
  st.testing.put(`users/${uid}/greetings/${tag}.pcm`, Buffer.from('cache-' + tag), { bucket: 'user-cache' });
  return { files, meta };
}

test('the export covers EVERY registry table and EVERY object the user has in Storage, in several parts, and none of anybody else\'s', async () => {
  const fa = await fill(A, a, 'alpha'), fb = await fill(B, b, 'bravo'), countsOf = (u) => h.db.asUser(mintVerifiedUid(u, 'test'), (r) => r.rights.counts()), pre = await countsOf(a);
  _setExportOptions({ partBytes: 5000, budgetMs: 12000 });
  const x = await runExport(h, A);
  assert.ok(x.parts.length >= 3, `several parts (got ${x.parts.length}: ${x.parts.map((p) => p.bytes)})`);
  assert.ok(x.parts[0].names.includes('manifest.json') && x.parts.slice(1).every((p) => !p.names.includes('manifest.json')), 'the manifest is in the first part only'); assert.ok(x.parts.at(-1).names.includes('export-report.json'));
  // ---- every registry table is accounted for in the manifest, with the file that carries it
  const man = x.json('manifest.json'), counts = await countsOf(a);
  assert.deepEqual(Object.keys(man.tables).sort(), REGISTRY.map((e) => e.table).sort(), 'the manifest names every registry table');
  for (const e of REGISTRY) {
    const t = man.tables[e.table]; assert.ok(t.rows >= pre[e.table] && t.rows <= counts[e.table], `${e.table}: the manifest counts the rows at the start of the export (${pre[e.table]} <= ${t.rows} <= ${counts[e.table]})`);
    if (e.exportAs === 'none') { assert.equal(t.exportedIn, null, e.table); assert.ok(t.notExported, e.table); }
    else { assert.equal(t.exportedIn, `data/${e.exportAs}`, e.table); assert.ok(x.files[t.exportedIn], `${e.table}: ${t.exportedIn} is in the zip`); }
  }
  assert.ok(counts.notes >= 2 && counts.messages >= 2 && counts.files >= 4 && counts.connectors >= 1 && counts.devices >= 1 && counts.usage_daily >= 1, 'the fixture really touched the tables');
  // ---- every object in Storage: every original is in the zip, byte for byte; the rest is listed as left out on purpose
  const objects = st.testing.list().filter((k) => k.startsWith(`user-files/users/${a}/`));
  assert.equal(objects.length, 4);
  for (const k of objects) { const bytes = st.testing.get(k.replace(/^user-files\//, '')), hit = Object.entries(x.files).filter(([n]) => n.startsWith('files/') && n !== 'files/index.json' && sha(x.files[n]) === sha(bytes)); assert.equal(hit.length, 1, `the original ${k} is in the zip exactly once`); }
  for (const f of fa.files) assert.ok(Object.entries(x.files).some(([n, d]) => n.endsWith(f.name) && d.equals(f.bytes)), f.name);
  const report = x.json('export-report.json'); assert.equal(report.originalsIncluded, 4); assert.deepEqual(report.originalsMissing, []);
  assert.deepEqual(report.objectsLeftOutOnPurpose.counts, { 'user-exports': x.parts.length - 1, 'user-cache': 1 }, 'what is left out is counted, not forgotten (the parts written before the last one, and the one cache object)');
  // ---- notes as Markdown, conversations by day, the index of the files
  assert.equal(x.files['notes/alpha/メモ.md'].toString(), 'alpha のノート本文\n'); assert.ok(x.files['notes/家計/alpha.md']);
  const jl = Object.entries(x.files).filter(([n]) => n.startsWith('conversations/') && n.endsWith('.jsonl')); assert.equal(jl.length, 1); assert.match(jl[0][1].toString(), /alphaの質問/);
  assert.equal(x.json('files/index.json').files.length, 4);
  // ---- secrets and ciphertext never leave; nothing of B is in A's export
  const all = Object.values(x.files).map((d) => d.toString('latin1')).join('\n'), allU = Object.values(x.files).map((d) => d.toString('utf8')).join('\n');
  for (const secret of [KEY + 'alpha', CXTOKEN + 'alpha']) assert.ok(!all.includes(secret), 'a secret value left in the export');
  assert.ok(allU.includes('alpha/notes') && !/token_hash/.test(Object.entries(x.files).filter(([n]) => n !== 'manifest.json').map(([, d]) => d.toString()).join('')));
  for (const s of ['bravo', 'b@example.test', KEY + 'bravo', CXTOKEN + 'bravo', b]) assert.ok(!allU.includes(s) && !all.includes(s), `B's "${s}" is in A's export`);
  for (const f of fb.files) assert.ok(!Object.values(x.files).some((d) => d.equals(f.bytes)), 'B\'s file is in A\'s export');
  // ---- a real unzip accepts every part (when the tool is there)
  if (spawnSync('unzip', ['-v']).status === 0) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elvar-zip-')); let n = 0;
    try { for (const d of x.job.downloads) { const f = path.join(dir, `p${++n}.zip`); fs.writeFileSync(f, (await st.downloadWithToken(new URL(d.url).searchParams.get('token'))).bytes); const r = spawnSync('unzip', ['-tq', f], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stdout + r.stderr); } } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // ---- the parts are in the private bucket under the user's own prefix only; the user cannot write there
  const keys = st.testing.list().filter((k) => k.startsWith('user-exports/')); assert.ok(keys.length === x.parts.length && keys.every((k) => k.startsWith(`user-exports/users/${a}/exports/${x.job.id}/`)));
  await assert.rejects(st.forUser({ uid: a }).uploadTarget(`users/${a}/exports/${x.job.id}/part-9.zip`).then((t) => { assert.match(t.url, /\/object\/user-files\//, 'an upload target only exists for user-files'); throw new Error('ok'); }), /ok/);
  _setExportOptions(null);
});

test('a finished export lives 24 hours (links are signed for at most the time that is left), then the job and its parts are deleted', async () => {
  // a finished export is deleted after its 24 hours (the link has expired by then: signed for at most the time that is left)
  _setExportOptions(null); const e = h.mkUser('e@example.test'), E = await h.bearer(e, { email: 'e@example.test' }); await h.call('GET', '/api/elvar/session', E); await h.call('POST', '/api/elvar/notes', E, { path: 'x.md', content: 'x' });
  const ex = await runExport(h, E); assert.equal(ex.job.linkExpiresInSec, 86400); assert.ok(Date.parse(ex.job.expiresAt) - Date.now() > 86300_000 && Date.parse(ex.job.expiresAt) - Date.now() <= 86400_000, 'the job lives 24 hours');
  assert.deepEqual(await sweepExports({ system: h.db.system, storage: st }), { removed: 0, failed: 0 }, 'not yet');
  h.db.testing.advance(25 * 3600_000); assert.ok((await sweepExports({ system: h.db.system, storage: st })).removed >= 1, 'the finished jobs of the earlier tests (also past their 24 hours) go too');
  assert.equal((await h.call('GET', `/api/elvar/export/${ex.job.id}`, E)).status, 404, 'the job is gone'); assert.ok(!st.testing.list().some((k) => k.startsWith(`user-exports/users/${e}/`)));
});

test('a missing or altered original is reported (never silently dropped); a job at a time; one a day; stalled and expired jobs are swept, objects first', async () => {
  const c = h.mkUser('c@example.test'), C = await h.bearer(c, { email: 'c@example.test' }); await h.call('GET', '/api/elvar/session', C);
  const f1 = await addFile(C, crypto.randomBytes(2500), 'one.txt'), f2 = await addFile(C, crypto.randomBytes(2500), 'two.txt');
  st.testing.put(`users/${c}/files/${f2.id}/${f2.sha256}`, Buffer.from('tampered'));   // altered behind the app's back
  await st.service.remove([`users/${c}/files/${f1.id}/${f1.sha256}`]);                 // and one gone
  h.db.testing.setHardLimits(c, { exportsPerDay: 1000 });
  const x = await runExport(h, C); const rep = x.json('export-report.json');
  assert.deepEqual(rep.originalsMissing.map((m) => m.id).sort(), [f1.id, f2.id].sort()); assert.match(JSON.stringify(rep.originalsMissing), /missing/); assert.match(JSON.stringify(rep.originalsMissing), /differs/);
  // one running job at a time (tiny parts keep it running), and then one a day
  const d = h.mkUser('d@example.test'), D = await h.bearer(d, { email: 'd@example.test' }); await h.call('GET', '/api/elvar/session', D);
  await addFile(D, crypto.randomBytes(2500), 'a.txt'); await addFile(D, crypto.randomBytes(2500), 'b.txt'); _setExportOptions({ partBytes: 100 });
  const first = await h.call('POST', '/api/elvar/export', D, {}); assert.equal(first.status, 200); assert.equal(first.body.job.status, 'running');
  const second = await h.call('POST', '/api/elvar/export', D, {}); assert.equal(second.status, 409); assert.equal(second.body.error, 'export_running'); assert.match(second.body.message, /作っています/);
  // the job stops moving: after 30 minutes it is failed, after two days it is swept with the parts written so far
  const rows = () => h.db.asUser(mintVerifiedUid(d, 'test'), (r) => r.exportJobs.list());
  assert.ok(st.testing.list().some((k) => k.startsWith(`user-exports/users/${d}/exports/${first.body.job.id}/`)));
  h.db.testing.advance(31 * 60_000); assert.ok(!(await h.db.system.expiredExportJobs()).some((j) => j.userId === d), 'a failed job is not swept at once'); assert.deepEqual((await rows()).map((j) => [j.status, j.error]), [['failed', 'stalled']]);
  assert.equal((await h.call('POST', '/api/elvar/export', D, {})).status, 429, 'a failed job still used the day\'s one export');
  h.db.testing.advance(2 * 86400_000 + 1000); const swept = await sweepExports({ system: h.db.system, storage: st }); assert.ok(swept.removed >= 1);
  assert.deepEqual(await rows(), []); assert.ok(!st.testing.list().some((k) => k.startsWith(`user-exports/users/${d}/`)), 'the parts went with the job');
});

test('the zip writer: UTF-8 names, deflate and store, CRC checked, duplicate and unsafe names refused', () => {
  const z = createZip(); z.add('メモ/今日.md', '日本語'.repeat(100)); z.add('a.pdf', Buffer.from('%PDF')); z.add('small.txt', 'x');
  const r = readZip(z.finish()); assert.deepEqual(Object.keys(r).sort(), ['a.pdf', 'small.txt', 'メモ/今日.md'].sort()); assert.equal(r['メモ/今日.md'].toString(), '日本語'.repeat(100));
  const z2 = createZip(); z2.add('x', 'y'); assert.throws(() => z2.add('x', 'z'), /duplicate/); for (const bad of ['../x', 'a/../b', '', 'a//b']) assert.throws(() => z2.add(bad, 'q'), /bad zip entry/);
  const buf = createZip(); buf.add('c.txt', 'checksum me please, checksum me please, checksum me please, checksum me please', { store: true }); const raw = buf.finish(); raw[raw.indexOf(Buffer.from('checksum')) + 3] ^= 1;
  assert.throws(() => readZip(raw), /checksum|incorrect|invalid/i);
});

test('part paths and the bucket are the user\'s own prefix only', () => { assert.equal(partPath(a, 'job1', 2), `users/${a}/exports/job1/part-2.zip`); assert.equal(EXPORT_BUCKET, 'user-exports'); });
