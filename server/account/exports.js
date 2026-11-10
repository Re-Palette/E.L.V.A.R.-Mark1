// The data export over HTTP (docs/ELVAR_MULTIUSER.md 7.3; principle 7). Every call runs as the signed-in user: another user's job id is simply "not found".
//   POST   /api/elvar/export            ask for an export (recent sign-in; one a day by default; one running job at a time) and run its first step
//   GET    /api/elvar/export            my jobs (expired ones are removed first)
//   GET    /api/elvar/export/:id        one job: progress, and while it is ready one link per zip part (they expire after 24 hours)
//   POST   /api/elvar/export/:id/step   the page asks for the next part while it is open
//   DELETE /api/elvar/export/:id        remove the export now (the zip parts and the job)
import { requireFresh } from '../auth/with-user.js';
import { getStorage } from '../storage/index.js';
import { hardLimit } from '../usage.js';
import { rateMessage } from '../usage-limits.js';
import { startExport, stepExport, describeJob, deleteExport, exportsToday } from '../rights/export-job.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (status, error, message) => ({ status, body: { error, ...(message ? { message } : {}) } });
const audit = (event, extra) => console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event, ...extra }));
let testOpts = {};
/** Tests: a smaller part size / time budget (null restores the defaults). */
export const _setExportOptions = (o) => { testOpts = o || {}; };

const sweepOwn = async (user, storage) => {
  try { for (const j of await user.db((r) => r.exportJobs.list())) if (j.status === 'done' && j.expiresAt && Date.parse(j.expiresAt) <= Date.now()) await deleteExport({ system: user.system, storage }, user.uid.uid, j.id); }
  catch (e) { console.error('[elvar] export: could not remove an expired export:', e?.code || e?.message); }
};

export async function createExport({ user }) {
  await requireFresh(user);
  const storage = await getStorage();
  await sweepOwn(user, storage);
  if ((await user.db((r) => r.exportJobs.list())).some((j) => ['queued', 'running'].includes(j.status))) return bad(409, 'export_running', 'すでに書き出しを作っています。終わるまでお待ちください');
  const lim = await hardLimit('exportsPerDay');   // only FINISHED exports count against it: a failed job does not use up the day
  if (lim !== null && lim !== undefined && (await exportsToday(user)) >= lim) return bad(429, 'rate_limited', `${rateMessage('データの書き出し', '1日あたり')}（1日 ${lim} 回まで）。明日、もう一度お試しください`);
  let job;
  try { job = await startExport(user, { storage, ...testOpts }); }
  catch (e) { if (e?.code === 'conflict') return bad(409, 'export_running', 'すでに書き出しを作っています。終わるまでお待ちください'); throw e; }
  audit('export-requested', { uid: user.uid.uid, status: job?.status });
  return { status: 200, body: { job: await describeJob(job, { storage, uid: user.uid.uid }) } };
}

export async function listExports({ user }) {
  const storage = await getStorage();
  await sweepOwn(user, storage);
  const jobs = await user.db((r) => r.exportJobs.list());
  return { status: 200, body: { jobs: await Promise.all(jobs.map((j) => describeJob(j, { storage, uid: user.uid.uid }))) } };
}

export async function getExport({ user, params }) {
  if (!UUID.test(params.id)) return bad(404, 'not_found');
  const job = await user.db((r) => r.exportJobs.get(params.id)); if (!job) return bad(404, 'not_found');
  return { status: 200, body: { job: await describeJob(job, { storage: await getStorage(), uid: user.uid.uid }) } };
}

export async function stepExportRoute({ user, params }) {
  if (!UUID.test(params.id)) return bad(404, 'not_found');
  if (!(await user.cfg.hit('export-step', 60, 30))) return bad(429, 'rate_limited', '少し待ってから、もう一度お試しください');
  const storage = await getStorage(), job = await stepExport(user, params.id, { storage, ...testOpts }); if (!job) return bad(404, 'not_found');
  return { status: 200, body: { job: await describeJob(job, { storage, uid: user.uid.uid }) } };
}

export async function deleteExportRoute({ user, params }) {
  if (!UUID.test(params.id)) return bad(404, 'not_found');
  if (!(await user.db((r) => r.exportJobs.get(params.id)))) return bad(404, 'not_found');
  await deleteExport({ system: user.system, storage: await getStorage() }, user.uid.uid, params.id);
  return { status: 200, body: { ok: true } };
}
