// The data export as an asynchronous job (docs/ELVAR_MULTIUSER.md 7.3, principle 7). The user asks (a recent sign-in is needed, one export a day by default, one running job
// at a time); the server then builds the export in STEPS, each step closes one zip PART (about 100 MB at most, plus the one file that crosses the line) and uploads it with the
// service key to the private bucket `user-exports` (users/<uid>/exports/<job>/part-<n>.zip). The page asks for the next step while it is open; a job that stops moving for 30
// minutes is marked failed by the daily sweep. When the last part is written the job is `done` and its links live for 24 hours; after that the job and its objects are deleted.
//
// What goes in (test/export-job.test.mjs checks it against the registry and against the objects in Storage):
//   manifest.json            format, job, every registry table with the file that carries it and the number of rows (tables that are never exported say why), the originals planned
//   data/<file>.json         one JSON per registry export file (account, profile, settings, secrets as NAMES and last four characters only, notes, conversations, ...)
//   notes/<path>.md          every note as a Markdown file (Obsidian opens the folder as it is), trash included under the same path
//   conversations/<day>.jsonl  the conversation log, one JSON line per message
//   files/index.json, files/<id>-<name>   the file vault: the index (name, tags, memo, hash, extracted text) and every ORIGINAL
//   export-report.json       (last part) how many originals went in, which ones could not be read, and which objects were left out on purpose (the export itself, caches)
// Never in the export: ciphertext, wrapped keys, token hashes (the registry's exportExclude), the Storage paths, anybody else's data (every read runs as the user).
import crypto from 'node:crypto';
import { createZip } from './zip.js';
import { REGISTRY, exportPlan } from './registry.js';
import { EXPORTERS, exportedFiles, originalsPlan } from './export.js';
import { USER_BUCKET, USER_BUCKETS } from '../storage/index.js';

export const EXPORT_BUCKET = 'user-exports';
export const PART_BYTES = 100 * 1024 * 1024;
export const LINK_TTL_SEC = 24 * 3600;
const safeName = (n) => String(n).replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').slice(0, 100);
const day = (iso) => String(iso || '').slice(0, 10) || 'unknown';
const json = (v) => Buffer.from(JSON.stringify(v, null, 2));
export const partPath = (uid, jobId, n) => `users/${uid}/exports/${jobId}/part-${n}.zip`;

/** Pure: the manifest of an export from the row counts the user's repos report. */
export function buildManifest({ uid, email, jobId, counts, originals, now }) {
  const carrier = new Map(); for (const f of exportPlan()) for (const t of f.tables) carrier.set(t.table, f.file);
  const tables = {};
  for (const e of REGISTRY) {
    const file = carrier.get(e.table) || null;
    tables[e.table] = { exportedIn: file ? `data/${file}` : null, rows: counts[e.table] ?? 0, ...(e.exportExclude.length ? { columnsNeverExported: [...e.exportExclude] } : {}), ...(file ? {} : { notExported: 'working data of the service (keys, counters, one-time records), not yours to keep' }), ...(e.deleteVia === 'cascade+storage' ? { originals: 'files/' } : {}) };
  }
  return { format: 'elvar-export-v2', exportedAt: new Date(now).toISOString(), jobId, user: { id: uid, email: email ?? null }, tables, originals: originals.length, note: 'APIキーなどの秘密の値は含まれません（名前と末尾4桁だけ）。ノートは notes/ の Markdown です。' };
}

async function addData(zip, name, r) {
  const data = await EXPORTERS[name](r);
  zip.add(`data/${name}`, json(data));
  if (name === 'notes.json') for (const n of data.notes) zip.add(`notes/${n.path}`, Buffer.from(n.content ?? ''));   // paths were validated when the note was saved
  if (name === 'conversations.json') {
    const byDay = new Map(); for (const c of data.conversations) for (const m of c.messages || []) { const d = day(m.at); (byDay.get(d) || byDay.set(d, []).get(d)).push(JSON.stringify({ conversation: c.id, channel: c.channel ?? null, ...m })); }
    for (const [d, lines] of [...byDay].sort()) zip.add(`conversations/${d}.jsonl`, Buffer.from(lines.join('\n') + '\n'));
  }
  if (name === 'files.json') zip.add('files/index.json', json({ files: data.files.map((f) => ({ ...f, exportPath: `files/${f.id}-${safeName(f.name)}` })), originals: originalsPlan(data.files) }));
}

/**
 * Start an export for the signed-in user (the route has checked the recent sign-in and the rate limit). Creates the job and runs the first step.
 * @returns {Promise<object>} the job as described by describeJob()
 */
export async function startExport(user, o = {}) {
  const id = await user.system.createExportJob(user.uid);   // conflict (409) while another job is queued or running
  return stepExport(user, id, o);
}

/**
 * One step: builds the next part, uploads it, records progress. Safe to call again while a step runs (the second call gets the job as it is).
 * @param {{storage: {service: {put:Function, get:Function}}, budgetMs?: number, partBytes?: number, now?: () => number}} o
 */
export async function stepExport(user, id, { storage, budgetMs = 12_000, partBytes = PART_BYTES, now = () => Date.now() } = {}) {
  let job = await user.db((r) => r.exportJobs.get(id)); if (!job) return null;
  if (!['queued', 'running'].includes(job.status)) return job;
  const t0 = now(), uid = user.uid.uid, c = job.cursor || { stage: 'data', dataIdx: 0, fileAfter: null, part: 1, originals: 0, missing: [] };
  const names = exportedFiles(), zip = createZip({ now });
  let done = false;
  try {
    await user.db(async (r) => {
      if (c.part === 1 && c.stage === 'data' && c.dataIdx === 0) zip.add('manifest.json', json(buildManifest({ uid, email: user.email, jobId: id, counts: await r.rights.counts(), originals: await r.files.list({ limit: 20000 }), now: t0 })));
      while (c.stage === 'data' && c.dataIdx < names.length) { await addData(zip, names[c.dataIdx], r); c.dataIdx++; if (now() - t0 > budgetMs || zip.size >= partBytes) break; }
      if (c.stage === 'data' && c.dataIdx >= names.length) { c.stage = 'files'; }
      if (c.stage === 'files' && !(now() - t0 > budgetMs || zip.size >= partBytes)) {
        const list = (await r.files.list({ limit: 20000 })).sort((a, b) => (a.id < b.id ? -1 : 1)).filter((f) => c.fileAfter === null || f.id > c.fileAfter);
        let finished = true;
        for (const f of list) {
          if (zip.entries > 0 && (zip.size >= partBytes || now() - t0 > budgetMs)) { finished = false; break; }
          const bytes = await storage.service.get(f.objectPath, { bucket: USER_BUCKET });
          if (!bytes || bytes.length !== f.size || crypto.createHash('sha256').update(bytes).digest('hex') !== f.sha256) c.missing.push({ id: f.id, name: f.name, why: bytes ? 'the stored copy differs from the recorded hash' : 'the stored copy is missing' });
          if (bytes) { zip.add(`files/${f.id}-${safeName(f.name)}`, bytes); c.originals++; }
          c.fileAfter = f.id;
        }
        if (finished) done = true;
      }
    });
    if (done) {
      const left = {}; for (const b of USER_BUCKETS) if (b !== USER_BUCKET) left[b] = (await storage.service.list(`users/${uid}/`, { bucket: b })).length;
      zip.add('export-report.json', json({ parts: c.part, originalsIncluded: c.originals, originalsMissing: c.missing, objectsLeftOutOnPurpose: { 'user-exports': 'this export itself', 'user-cache': 'rebuildable caches (greeting audio and the like)', counts: left }, finishedAt: new Date(now()).toISOString() }));
    }
    const buf = zip.finish();
    await storage.service.put(partPath(uid, id, c.part), buf, { bucket: EXPORT_BUCKET, contentType: 'application/zip' });
    const parts = c.part, bytes = job.bytes + buf.length;
    if (done) await user.system.updateExportJob(user.uid, id, { status: 'done', cursor: { ...c, stage: 'done' }, parts, bytes, expiresAt: new Date(now() + LINK_TTL_SEC * 1000).toISOString() });
    else { c.part++; await user.system.updateExportJob(user.uid, id, { status: 'running', cursor: c, parts, bytes }); }
    if (done) await user.db(async (r) => { try { await r.inbox.add({ kind: 'notice', title: 'データの書き出しが完了しました', body: '「私のデータ」から、24時間のあいだダウンロードできます。' }); } catch { /* the job is done either way */ } });
  } catch (e) {
    console.error('[elvar] export step failed:', e?.code || e?.message || e);
    await user.system.updateExportJob(user.uid, id, { status: 'failed', cursor: c, parts: job.parts, bytes: job.bytes, error: 'step_failed' }).catch(() => {});
  }
  return user.db((r) => r.exportJobs.get(id));
}

/** The job as the page sees it: progress in plain numbers (never the cursor with its file ids) and, while it is ready, a link per part that expires. */
export async function describeJob(job, { storage, uid, now = () => Date.now() } = {}) {
  if (!job) return null;
  const out = { id: job.id, status: job.status, parts: job.parts, bytes: job.bytes, createdAt: job.createdAt, expiresAt: job.expiresAt, error: job.error ?? null, progress: { originals: job.cursor?.originals ?? 0, missing: (job.cursor?.missing || []).length, stage: job.cursor?.stage ?? 'data' } };
  if (job.status === 'done' && job.expiresAt && Date.parse(job.expiresAt) > now()) {
    const ttl = Math.max(1, Math.min(LINK_TTL_SEC, Math.ceil((Date.parse(job.expiresAt) - now()) / 1000)));
    out.downloads = [];
    for (let n = 1; n <= job.parts; n++) out.downloads.push({ part: n, name: `elvar-export-${job.createdAt.slice(0, 10)}-part${n}.zip`, url: await storage.service.sign(partPath(uid, job.id, n), { bucket: EXPORT_BUCKET, expiresInSec: ttl, name: `elvar-export-${job.createdAt.slice(0, 10)}-part${n}.zip` }) });
    out.linkExpiresInSec = ttl;
  }
  return out;
}

/** Remove one job: its objects first, then the row. @returns {Promise<boolean>} */
export async function deleteExport({ system, storage }, userId, id) {
  const paths = (await storage.service.list(`users/${userId}/`, { bucket: EXPORT_BUCKET })).filter((p) => p.startsWith(`users/${userId}/exports/${id}/`));
  if (paths.length) await storage.service.remove(paths, { bucket: EXPORT_BUCKET });
  return system.dropExportJob(userId, id);
}

/** The daily sweep (and the caller's own listing): every expired or abandoned job goes, objects first. */
export async function sweepExports({ system, storage }, { limit = 100 } = {}) {
  let removed = 0, failed = 0;
  for (const j of await system.expiredExportJobs(limit)) { try { if (await deleteExport({ system, storage }, j.userId, j.id)) removed++; } catch (e) { failed++; console.error('[elvar] export sweep:', e?.code || e?.message); } }
  return { removed, failed };
}
