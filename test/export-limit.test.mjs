// The export under a small platform upload limit (docs/ELVAR_MULTIUSER.md 7.3, 19; principle 7): the Supabase Free plan refuses any Storage object over 50 MB, so a zip part may never weigh more than
// the platform's per-file limit, and an original that cannot fit a part (a file may be as big as the limit itself) is delivered by a short-lived signed link instead - still exactly once, still complete.
// Here the limit is 1 MB (the smallest one an operator can set) so that "near the limit" is cheap to test.
import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/api-harness.mjs';
import { runExport } from './helpers/export.mjs';
import { browserUpload } from './helpers/upload.mjs';
import { getStorage, pathOwner } from '../server/storage/index.js';
import { _setExportOptions } from '../server/account/exports.js';
import { _resetPlatformMax } from '../server/account/files.js';
import { mintVerifiedUid } from '../server/db/verified-uid.js';
import { partBudget, isLinked, describeJob, MIB } from '../server/rights/export-job.js';
import { envMaxFileBytes } from '../server/config/platform-limits.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const LIMIT = 1048576;
let h, st, a, b, A, B;
test.before(async () => {
  h = await startHarness(); st = await getStorage();
  a = h.mkUser('a@example.test'); b = h.mkUser('b@example.test'); A = await h.bearer(a, { email: 'a@example.test' }); B = await h.bearer(b, { email: 'b@example.test' });
  for (const w of [A, B]) await h.call('GET', '/api/elvar/session', w);
  await h.db.system.setMaxFileBytes(LIMIT); _resetPlatformMax();
});
test.after(async () => { await h.db.system.setMaxFileBytes(62914560); _resetPlatformMax(); _setExportOptions(null); await h.stop(); });

async function addFile(who, bytes, name) {
  const r = await h.call('POST', '/api/elvar/files/reserve', who, { name, size: bytes.length, sha256: sha(bytes), textBytes: 0 }); assert.equal(r.status, 200, JSON.stringify(r.body));
  await browserUpload(st, pathOwner(new URL(r.body.upload.url).pathname.replace('/storage/v1/object/user-files/', '')), r.body.upload, bytes);
  const f = await h.call('POST', `/api/elvar/files/${r.body.fileId}/finalize`, who, { text: '' }); assert.equal(f.status, 200, JSON.stringify(f.body)); return f.body.file;
}

test('partBudget: the platform limit less a margin (1 MB, a quarter of a tiny limit), never above the limit; the 50 MB Free plan leaves 49 MB', () => {
  assert.equal(partBudget(50 * MIB), 49 * MIB); assert.equal(partBudget(60 * MIB), 59 * MIB); assert.equal(partBudget(LIMIT), LIMIT - LIMIT / 4);
  for (const l of [1, 1000, MIB, 4 * MIB, 5 * MIB, 50 * MIB, 60 * MIB, 5 * 1024 * MIB]) { const p = partBudget(l); assert.ok(p >= 1 && p <= l, `${l}: ${p}`); if (l >= 4 * MIB) assert.ok(l - p >= MIB, `${l}: a margin of at least 1 MB`); }
  assert.equal(partBudget(null), 59 * MIB, 'no limit known: the O1 default');
  assert.equal(isLinked({ status: 'ready', size_bytes: 49 * MIB, id: crypto.randomUUID(), name: 'a.txt' }, partBudget(50 * MIB)), true, 'a file near the 50 MB limit cannot share a 49 MB part');
  assert.equal(isLinked({ status: 'ready', size_bytes: 1000, id: crypto.randomUUID(), name: 'a.txt' }, partBudget(50 * MIB)), false);
});

test('the per-file limit is clamped to the 60 MB ceiling that app.files.size_bytes enforces (ELVAR_MAX_FILE_BYTES and setMaxFileBytes)', async () => {
  assert.equal(envMaxFileBytes({ ELVAR_MAX_FILE_BYTES: '5368709120' }), 62914560); assert.equal(envMaxFileBytes({ ELVAR_MAX_FILE_BYTES: '104857600' }), 62914560);
  assert.equal(envMaxFileBytes({ ELVAR_MAX_FILE_BYTES: '52428800' }), 52428800); assert.equal(envMaxFileBytes({ ELVAR_MAX_FILE_BYTES: '1000' }), null); assert.equal(envMaxFileBytes({}), null);
  assert.equal(await h.db.system.setMaxFileBytes(5368709120), 62914560); assert.equal(await h.db.system.maxFileBytes(), 62914560);
  await assert.rejects(h.db.system.setMaxFileBytes(10)); await h.db.system.setMaxFileBytes(LIMIT); _resetPlatformMax(); assert.equal(await h.db.system.maxFileBytes(), LIMIT);
});

test('with a 1 MB limit: parts never exceed it; files near the limit go by signed link, exactly once, scoped to the owner, expiring; B\'s data never appears', async (t) => {
  const mine = [], theirs = [];
  for (const [name, size] of [['exactly-limit.txt', LIMIT], ['near-limit.txt', LIMIT - 500], ['big.txt', 900_000], ['mid-1.txt', 380_000], ['mid-2.txt', 350_000], ['mid-3.txt', 300_000], ['small.txt', 2000], ['tiny.txt', 40]]) {
    const bytes = crypto.randomBytes(size); mine.push({ name, bytes, meta: await addFile(A, bytes, name) });
  }
  for (const [name, size] of [['bravo-limit.txt', LIMIT], ['bravo-mid.txt', 300_000], ['bravo-small.txt', 3000]]) { const bytes = crypto.randomBytes(size); theirs.push({ name, bytes, meta: await addFile(B, bytes, name) }); }
  await addFile(A, Buffer.from('note for notes'), 'last.txt');
  h.db.testing.setHardLimits(a, { exportsPerDay: 1000 });
  const budget = partBudget(LIMIT), linkedNames = mine.filter((f) => f.bytes.length + 400 > budget).map((f) => f.name);
  assert.deepEqual(linkedNames.sort(), ['big.txt', 'exactly-limit.txt', 'near-limit.txt'], 'the fixture really has files that cannot fit a part');

  _setExportOptions({ budgetMs: 12000 });   // no partBytes: the budget comes from the platform's limit
  const x = await runExport(h, A, { max: 200 });
  // ---- no part is bigger than the limit (what Storage would accept), downloaded size and stored size alike
  assert.ok(x.parts.length >= 2, `several parts (got ${x.parts.length})`);
  for (const p of x.parts) assert.ok(p.bytes <= LIMIT, `part ${p.part} is ${p.bytes} bytes > the ${LIMIT} byte limit`);
  const stored = st.testing.list().filter((k) => k.startsWith(`user-exports/users/${a}/exports/${x.job.id}/`)); assert.equal(stored.length, x.parts.length);
  for (const k of stored) assert.ok(st.testing.get(k.replace(/^user-exports\//, ''), 'user-exports').length <= LIMIT, `${k} would be refused by Storage`);
  // ---- completeness: every user-files object of A is in exactly one place: inside a part, or in the linked list
  const objects = st.testing.list().filter((k) => k.startsWith(`user-files/users/${a}/`)); assert.equal(objects.length, mine.length + 1);
  const linked = x.job.linkedOriginals, report = x.json('export-report.json');
  assert.deepEqual(linked.map((l) => l.name).sort(), linkedNames.sort());
  for (const k of objects) {
    const bytes = st.testing.get(k.replace(/^user-files\//, '')), inPart = Object.entries(x.files).filter(([n]) => n.startsWith('files/') && !n.startsWith('files/index-part') && sha(x.files[n]) === sha(bytes)).length;
    const viaLink = (report.originalsLinked || []).filter((l) => l.sha256 === sha(bytes)).length;
    assert.equal(inPart + viaLink, 1, `the original ${k} is in the export exactly once (in a part: ${inPart}, by link: ${viaLink})`);
  }
  assert.equal(report.originalsIncluded + report.originalsLinked.length, objects.length); assert.deepEqual(report.originalsMissing, []); assert.equal(report.originalsIncluded, objects.length - 3);
  assert.equal(x.job.progress.linked, 3); assert.ok(report.partBudgetBytes <= LIMIT);
  // ---- the index and the report say "別ダウンロード", with an expiry
  const idx = x.names.filter((n) => n.startsWith('files/index-part')).flatMap((n) => x.json(n).files), sep = idx.filter((f) => f.separateDownload);
  assert.deepEqual(sep.map((f) => f.name).sort(), linkedNames.sort()); assert.ok(sep.every((f) => f.exportPath === null && f.download === '別ダウンロード'));
  assert.ok(idx.filter((f) => !f.separateDownload && f.status === 'ready').every((f) => f.exportPath && x.files[f.exportPath]), 'every other index entry points at an original inside the zip');
  assert.equal(report.originalsLinked.length, 3); for (const l of report.originalsLinked) { assert.equal(l.download, '別ダウンロード'); assert.ok(l.url && l.expiresAt && Date.parse(l.expiresAt) > Date.now()); assert.equal(l.exportPath, null); }
  assert.match(report.originalsLinkedNote, /別ダウンロード/);
  // ---- links: the owner's own object only, byte for byte, never B's; expiring
  const urls = [...linked.map((l) => l.url), ...report.originalsLinked.map((l) => l.url)];
  for (const l of linked) assert.ok(l.available && l.label === '別ダウンロード' && l.expiresAt === x.job.expiresAt, 'the page gets the label and the expiry');
  for (const u of urls) {
    const url = new URL(u), tok = url.searchParams.get('token'), p = decodeURIComponent(url.pathname.replace(/^.*\/object\/sign\/user-files\//, ''));
    assert.ok(p.startsWith(`users/${a}/files/`) && !p.includes(b), `the link names A's own object only: ${p}`);
    const mineF = mine.find((f) => p.endsWith(f.meta.sha256) && p.includes(f.meta.id)); assert.ok(mineF, 'it is one of A\'s files');
    assert.deepEqual((await st.downloadWithToken(tok, { bucket: 'user-files', path: p })).bytes, mineF.bytes);
    for (const other of theirs) await assert.rejects(st.downloadWithToken(tok, { bucket: 'user-files', path: `users/${b}/files/${other.meta.id}/${other.meta.sha256}` }), (e) => e.status === 401, 'the link opens nothing of B\'s');
    await assert.rejects(st.downloadWithToken(tok, { bucket: 'user-exports', path: p }), (e) => e.status === 401);
  }
  // ---- nothing of B anywhere in A's export (zip bytes and links)
  const all = Object.values(x.files).map((d) => d.toString('latin1')).join('\n') + urls.join('\n') + JSON.stringify(x.job);
  for (const s of ['bravo', 'b@example.test', b]) assert.ok(!all.includes(s), `B's "${s}" is in A's export`);
  for (const f of theirs) assert.ok(!Object.values(x.files).some((d) => d.equals(f.bytes)), 'B\'s file is in A\'s export');
  // ---- B cannot see A's job
  assert.equal((await h.call('GET', `/api/elvar/export/${x.job.id}`, B)).status, 404);
  // ---- the listing (what the page reads) carries the links too; a file the owner removed since is reported as not available, not as a crash
  const list = await h.call('GET', '/api/elvar/export', A); assert.equal(list.status, 200); assert.equal(list.body.jobs[0].linkedOriginals.length, 3);
  const gone = mine.find((f) => f.name === 'big.txt'); await st.service.remove([`users/${a}/files/${gone.meta.id}/${gone.meta.sha256}`]);
  const after = (await h.call('GET', `/api/elvar/export/${x.job.id}`, A)).body.job; assert.equal(after.linkedOriginals.find((l) => l.name === 'big.txt').available, false); assert.equal(after.linkedOriginals.filter((l) => l.available).length, 2);
  // ---- the links expire: 25 hours later neither the parts nor the originals can be fetched
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); t.mock.timers.tick(25 * 3600_000);
  for (const u of urls.filter((v) => !v.includes(gone.meta.id))) await assert.rejects(st.downloadWithToken(new URL(u).searchParams.get('token')), (e) => e.status === 401, 'an expired link');
  for (const d of x.job.downloads) await assert.rejects(st.downloadWithToken(new URL(d.url).searchParams.get('token')), (e) => e.status === 401);
  const expired = await describeJob(await h.db.asUser(mintVerifiedUid(a, 'test'), (r) => r.exportJobs.get(x.job.id)), { storage: st, uid: a });
  assert.equal(expired.linkedOriginals, undefined); assert.equal(expired.downloads, undefined, 'after the expiry the page gets no links at all');
});

test('a missing or altered original that is too big for a part is reported, not linked; with the default 60 MB limit nothing small goes by link', async () => {
  const c = h.mkUser('c@example.test'), C = await h.bearer(c, { email: 'c@example.test' }); await h.call('GET', '/api/elvar/session', C); h.db.testing.setHardLimits(c, { exportsPerDay: 1000 });
  const big = crypto.randomBytes(LIMIT - 10), f = await addFile(C, big, 'big.txt'); st.testing.put(`users/${c}/files/${f.id}/${f.sha256}`, Buffer.from('tampered'));
  const x = await runExport(h, C, { max: 100 }), rep = x.json('export-report.json');
  assert.deepEqual(x.job.linkedOriginals, []); assert.deepEqual(rep.originalsLinked, []); assert.deepEqual(rep.originalsMissing.map((m) => m.id), [f.id]); assert.match(JSON.stringify(rep.originalsMissing), /differs/);
  await h.db.system.setMaxFileBytes(62914560); _resetPlatformMax();
  const d = h.mkUser('d@example.test'), D = await h.bearer(d, { email: 'd@example.test' }); await h.call('GET', '/api/elvar/session', D); h.db.testing.setHardLimits(d, { exportsPerDay: 1000 });
  await addFile(D, crypto.randomBytes(LIMIT - 10), 'near-1mb.txt');
  const y = await runExport(h, D, { max: 100 }); assert.deepEqual(y.json('export-report.json').originalsLinked, []); assert.equal(y.json('export-report.json').originalsIncluded, 1); assert.equal(y.json('export-report.json').partBudgetBytes, 59 * MIB);
});
