// Vercel Cron: /api/elvar/cron/daily (Authorization: Bearer CRON_SECRET). Daily housekeeping, each step independent (one failing does not stop the others):
//   1. sweep expired short-lived rows (kv, rate limits, ticket uses, oauth pending)
//   2. bootstrap admin: the confirmed account whose e-mail equals ELVAR_BOOTSTRAP_ADMIN_EMAIL becomes an admin (table row + signed claim)
//   3. purge the accounts whose deletion is due (the 7-day grace is over)
import { setAppMetadata } from '../db/service.js';
import { purgeDue } from '../rights/purge.js';

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
  return { status: 200, body: out };
}
