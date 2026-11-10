// Vercel Cron: /api/elvar/cron/daily (Authorization: Bearer CRON_SECRET). Daily housekeeping, each step independent (one failing does not stop the others):
//   1. sweep expired short-lived rows (kv, rate limits, ticket uses, oauth pending)
//   2. bootstrap admin: the confirmed account whose e-mail equals ELVAR_BOOTSTRAP_ADMIN_EMAIL becomes an admin (table row + signed claim)
//   3. purge the accounts whose deletion is due (the 7-day grace is over)
//   4b. the data exports (P7): expired and abandoned export jobs are deleted (the zip parts first, then the job)
//   4. the file vault (P5): remove the Storage objects of deleted files and of uploads that never finished (service key), drop their rows, and recount every user's storage usage
import { setAppMetadata } from '../db/service.js';
import { purgeDue } from '../rights/purge.js';
import { getStorage, USER_BUCKET } from '../storage/index.js';
import { sweepExports } from '../rights/export-job.js';
import { envMaxFileBytes } from '../config/platform-limits.js';

export async function dailyCron({ user: ctx }, { env = process.env, setClaim = setAppMetadata, purge = purgeDue } = {}) {
  const out = { swept: null, admin: null, purge: null, errors: [] };
  const step = async (name, fn) => { try { return await fn(); } catch (e) { out.errors.push(name); console.error(`[elvar] cron ${name}:`, e?.code || e?.message || e); return null; } };
  out.swept = await step('sweep', () => ctx.system.purgeExpired());
  const email = String(env.ELVAR_BOOTSTRAP_ADMIN_EMAIL || '').trim();
  if (email) out.admin = await step('bootstrap-admin', async () => {
    const id = await ctx.system.bootstrapAdmin(email);
    if (!id) return { granted: false };
    await setClaim(id, { elvar_role: 'admin' });   // the claim only the service key can write; the app trusts it together with the table row
    return { granted: true };
  });
  out.purge = await step('purge', async () => purge(await (await import('../db/index.js')).getDb()));
  out.files = await step('files-sweep', () => sweepFiles(ctx.system));
  out.limits = await step('limits-sync', async () => { const n = envMaxFileBytes(env); if (n === null) return { synced: false }; return { synced: true, maxFileBytes: await ctx.system.setMaxFileBytes(n) }; });
  out.exports = await step('exports-sweep', async () => sweepExports({ system: ctx.system, storage: await getStorage() }));
  out.reconciled = await step('storage-reconcile', () => ctx.system.reconcileStorage());
  return { status: 200, body: out };
}

/** Stale file rows (deleting, or a reservation that ran out 5 minutes ago): the object first, then the row. A failure on one file does not stop the others. */
export async function sweepFiles(system, { storage = null, limit = 200 } = {}) {
  const st = storage || await getStorage();
  let removed = 0, failed = 0;
  for (const f of await system.staleFiles(limit)) {
    try { await st.service.remove([f.objectPath], { bucket: USER_BUCKET }); if (await system.dropStaleFile(f.userId, f.id)) removed++; }
    catch (e) { failed++; console.error('[elvar] cron: could not sweep a file:', e?.code || e?.message); }
  }
  return { removed, failed };
}
