// The data export as an asynchronous job (docs/ELVAR_MULTIUSER.md 7.3, 19; principle 7). The user asks (a recent sign-in is needed, one export a day by default, one running job
// at a time); the server then builds the export in STEPS, each step closes one zip PART (about 100 MB at most, or 60,000 entries, plus the one file that crosses the line) and
// uploads it with the service key to the private bucket `user-exports` (users/<uid>/exports/<job>/part-<n>.zip). The page asks for the next step while it is open; a job that
// stops moving for 30 minutes is marked failed by the daily sweep. When the last part is written the job is `done` and its links live for 24 hours; after that the job and its objects
// are deleted.
//
// What goes in (test/export-job.test.mjs and test/export-complete.test.mjs check it against the registry, the manifest's counts and the objects in Storage):
//   manifest.json            format, job, every registry table with the file that carries it, the rows file(s) and the number of rows (tables that are never exported say why)
//   data/<file>.json         one JSON per registry export file (account, profile, settings, secrets as NAMES and last four characters only, a note on how to read the rows, ...)
//   rows/<table>-part<n>.jsonl  EVERY row of every table that can be any size (notes, revisions, conversations, messages, inbox, audit log, usage events and daily totals, builds, files,
//                            extracted texts), walked page by page with a keyset cursor (export-pages.js): nothing is cut at a fixed number
//   notes/<path>.md          every note as a Markdown file (Obsidian opens the folder as it is), trash included under the same path
//   conversations/<day>.<n>.jsonl  the conversation log by day, one JSON line per message
//   files/index-part<n>.json, files/<id>-<name>   the file vault: the index (name, hash, ...) and every ORIGINAL
//   export-report.json       (last part) how many rows of each table went in against the manifest, how many originals went in, which ones could not be read, which objects were left out on purpose
// Never in the export: ciphertext, wrapped keys, token hashes (the registry's exportExclude), the Storage paths, anybody else's data (every read runs as the user).
//
// Races with a deletion (the account may be deleted while a step runs): a step takes a per-job lock (two steps never run at once), checks a purge lock before it writes, and if the job is
// gone (updateExportJob reports false) it removes the part it just wrote. purgeAccount fails the user's jobs and sets the purge lock first (purge.js).
import crypto from 'node:crypto';
import { createZip, MAX_ENTRIES } from './zip.js';
import { REGISTRY, exportPlan } from './registry.js';
import { EXPORTERS, exportedFiles, rowsFileOf, originalPath, objectPathOf } from './export.js';
import { PAGED, PAGED_ORDER } from './export-pages.js';
import { USER_BUCKET, USER_BUCKETS } from '../storage/index.js';

export const EXPORT_BUCKET = 'user-exports';
export const PART_BYTES = 100 * 1024 * 1024;
export const LINK_TTL_SEC = 24 * 3600;
export const PURGE_LOCK = 'purge-lock';
const day = (iso) => String(iso || '').slice(0, 10) || 'unknown';
const json = (v) => Buffer.from(JSON.stringify(v, null, 2));
export const partPath = (uid, jobId, n) => `users/${uid}/exports/${jobId}/part-${n}.zip`;
const todayKey = (now) => `export-count:${new Date(now).toISOString().slice(0, 10)}`;

/** Pure: the manifest of an export from the row counts the user's repos report. */
export function buildManifest({ uid, email, jobId, counts, now }) {
  const carrier = new Map(); for (const f of exportPlan()) for (const t of f.tables) carrier.set(t.table, f.file);
  const tables = {};
  for (const e of REGISTRY) {
    const file = carrier.get(e.table) || null;
    tables[e.table] = { exportedIn: file ? `data/${file}` : null, ...(PAGED[e.table] ? { rowsIn: `rows/${e.table}-part*.jsonl` } : {}), rows: counts[e.table] ?? 0, ...(e.exportExclude.length ? { columnsNeverExported: [...e.exportExclude] } : {}), ...(file ? {} : { notExported: 'working data of the service (keys, counters, one-time records), not yours to keep' }), ...(e.deleteVia === 'cascade+storage' ? { originals: 'files/' } : {}) };
  }
  return { format: 'elvar-export-v2', exportedAt: new Date(now).toISOString(), jobId, user: { id: uid, email: email ?? null }, tables, originals: 'files/ (see export-report.json for how many went in)', note: 'APIキーなどの秘密の値は含まれません（名前と末尾4桁だけ）。ノートは notes/ の Markdown、すべての行は rows/ にあります。' };
}

/**
 * Start an export for the signed-in user (the route has checked the recent sign-in and the day's limit). Creates the job and runs the first step.
 * @returns {Promise<object>} the job as described by describeJob()
 */
export async function startExport(user, o = {}) {
  const id = await user.system.createExportJob(user.uid);   // conflict (409) while another job is queued or running
  return stepExport(user, id, o);
}

const purging = (user) => user.db((r) => r.kv.get(PURGE_LOCK)).then((v) => v !== null && v !== undefined, () => false);

/**
 * One step: builds the next part, uploads it, records progress. Safe to call again while a step runs (a per-job lock: the second call gets the job as it is).
 * @param {{storage: {service: {put:Function, get:Function, remove:Function, list:Function}}, budgetMs?: number, partBytes?: number, maxEntries?: number, now?: () => number}} o
 * @returns the job as it is now, or null when it does not exist (any more)
 */
export async function stepExport(user, id, { storage, budgetMs = 12_000, partBytes = PART_BYTES, maxEntries = MAX_ENTRIES, now = () => Date.now() } = {}) {
  const job = await user.db((r) => r.exportJobs.get(id)); if (!job) return null;
  if (!['queued', 'running'].includes(job.status)) return job;
  const took = await user.db((r) => r.kv.setNx(`export-step:${id}`, { at: now() }, { ttlSec: 120 }));
  if (!took) return job;   // a step of this job is running: do not build the same part twice
  try { return await runStep(user, id, job, { storage, budgetMs, partBytes, maxEntries, now }); }
  finally { await user.db((r) => r.kv.del(`export-step:${id}`)).catch(() => {}); }
}

async function runStep(user, id, job, { storage, budgetMs, partBytes, maxEntries, now }) {
  const t0 = now(), uid = user.uid.uid;
  const c = job.cursor?.v === 2 ? job.cursor : { v: 2, stage: 'data', ti: 0, after: null, fileAfter: null, part: 1, originals: 0, missing: [], rows: {}, expected: {} };
  const zip = createZip({ now }), pending = new Map(), days = new Map(), index = [];   // pending: table -> JSON lines of this part
  let buffered = 0, done = false;
  const over = () => now() - t0 > budgetMs || zip.size + buffered >= partBytes || zip.entries >= maxEntries;
  const note = (map, k, line) => { (map.get(k) || map.set(k, []).get(k)).push(line); buffered += line.length + 1; };
  const fail = async (error) => { await user.system.updateExportJob(user.uid, id, { status: 'failed', cursor: c, parts: job.parts, bytes: job.bytes, error }).catch(() => {}); return user.db((r) => r.exportJobs.get(id)).catch(() => null); };
  try {
    if (await purging(user)) return await fail('account_deleting');
    if (c.stage === 'data') {
      await user.db(async (r) => {
        const counts = await r.rights.counts(); c.expected = Object.fromEntries(PAGED_ORDER.map((t) => [t, counts[t] ?? 0]));
        zip.add('manifest.json', json(buildManifest({ uid, email: user.email, jobId: id, counts, now: t0 })));
        for (const name of exportedFiles()) zip.add(`data/${name}`, json(await EXPORTERS[name](r)));
      });
      c.stage = 'rows';
    }
    // ---- the rows of every table that can be any size, page by page (each page is its own short transaction: no connection is held while the part is built or uploaded)
    while (c.stage === 'rows' && !over()) {
      const table = PAGED_ORDER[c.ti], { rows, next } = await user.db((r) => r.rights.exportPage(table, { after: c.after }));
      for (const row of rows) {
        let out = row;
        if (table === 'notes') { const file = zip.add(`notes/${row.path}`, Buffer.from(row.content ?? '')); const { content, ...meta } = row; void content; out = { ...meta, file }; buffered += (row.content || '').length; }
        if (table === 'messages') note(days, `${day(row.at)}`, JSON.stringify({ conversation: row.conversation_id, role: row.role, at: row.at, text: row.text }));
        if (table === 'files') index.push({ ...row, exportPath: originalPath({ id: row.id, name: row.name }) });
        note(pending, table, JSON.stringify(out));
      }
      c.rows[table] = (c.rows[table] || 0) + rows.length;
      if (next) c.after = next; else { c.ti++; c.after = null; if (c.ti >= PAGED_ORDER.length) c.stage = 'originals'; }
    }
    // ---- the originals (Storage reads happen between short transactions, never inside one)
    if (c.stage === 'originals' && !over()) {
      for (;;) {
        const { rows, next } = await user.db((r) => r.rights.exportPage('files', { after: c.fileAfter }));
        let stopped = false;
        for (const f of rows) {
          if (zip.entries > 0 && over()) { stopped = true; break; }
          if (f.status === 'ready') {
            const bytes = await storage.service.get(objectPathOf(uid, f), { bucket: USER_BUCKET });
            if (!bytes || bytes.length !== f.size_bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== f.sha256) c.missing.push({ id: f.id, name: f.name, why: bytes ? 'the stored copy differs from the recorded hash' : 'the stored copy is missing' });
            if (bytes) { zip.add(originalPath(f), bytes); c.originals++; }
          }
          c.fileAfter = [f.id];
        }
        if (stopped) break;
        if (!next) { done = true; break; }
        c.fileAfter = next;
      }
    }
    for (const [t, lines] of pending) zip.add(rowsFileOf(t, c.part), Buffer.from(lines.join('\n') + '\n'));
    for (const [d, lines] of [...days].sort()) zip.add(`conversations/${d}.${c.part}.jsonl`, Buffer.from(lines.join('\n') + '\n'));
    if (index.length) zip.add(`files/index-part${c.part}.json`, json({ files: index }));
    if (done) {
      const left = {}; for (const b of USER_BUCKETS) if (b !== USER_BUCKET) left[b] = (await storage.service.list(`users/${uid}/`, { bucket: b })).length;
      const rowsReport = Object.fromEntries(PAGED_ORDER.map((t) => [t, { exported: c.rows[t] || 0, manifest: c.expected[t] ?? 0 }]));
      zip.add('export-report.json', json({ parts: c.part, rows: rowsReport, rowsComplete: PAGED_ORDER.every((t) => (c.rows[t] || 0) >= (c.expected[t] ?? 0)), originalsIncluded: c.originals, originalsMissing: c.missing, objectsLeftOutOnPurpose: { 'user-exports': 'this export itself', 'user-cache': 'rebuildable caches (greeting audio and the like)', counts: left }, finishedAt: new Date(now()).toISOString() }));
    }
    const buf = zip.finish();
    if (await purging(user)) return await fail('account_deleting');
    await storage.service.put(partPath(uid, id, c.part), buf, { bucket: EXPORT_BUCKET, contentType: 'application/zip' });
    const parts = c.part, bytes = job.bytes + buf.length;
    let kept;
    if (done) kept = await user.system.updateExportJob(user.uid, id, { status: 'done', cursor: { ...c, stage: 'done' }, parts, bytes, expiresAt: new Date(now() + LINK_TTL_SEC * 1000).toISOString() });
    else { c.part++; kept = await user.system.updateExportJob(user.uid, id, { status: 'running', cursor: c, parts, bytes }); }
    if (!kept) {   // the job is gone (the account was deleted, the user removed the export, the sweep took it): what was just written would be left behind for good
      await storage.service.remove([partPath(uid, id, parts)], { bucket: EXPORT_BUCKET }).catch((e) => console.error('[elvar] export: could not remove a part of a job that is gone:', e?.code || e?.message));
      return null;
    }
    if (done) await user.db(async (r) => {
      // a finished export counts for the day's limit; a failed one does not (createExport reads this)
      try { const k = todayKey(now()), cur = await r.kv.get(k); await r.kv.set(k, { n: (cur?.n || 0) + 1 }, { ttlSec: 2 * 86400 }); } catch { /* the job is done either way */ }
      try { await r.inbox.add({ kind: 'notice', title: 'データの書き出しが完了しました', body: '「私のデータ」から、24時間のあいだダウンロードできます。' }); } catch { /* the job is done either way */ }
    });
  } catch (e) {
    console.error('[elvar] export step failed:', e?.code || e?.message || e);
    await user.system.updateExportJob(user.uid, id, { status: 'failed', cursor: c, parts: job.parts, bytes: job.bytes, error: 'step_failed' }).catch(() => {});
  }
  return user.db((r) => r.exportJobs.get(id)).catch(() => null);
}

/** How many exports of the day this user has finished (a failed job is not counted). */
export async function exportsToday(user, now = Date.now()) { return (await user.db((r) => r.kv.get(todayKey(now))))?.n || 0; }

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
