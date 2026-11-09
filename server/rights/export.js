// The export of a user's data (docs/ELVAR_MULTIUSER.md 7.3, principle 7). One entry per registry `exportAs` file; test/export.test.mjs requires every
// registered table that is exported to be covered here, so a new table cannot be added without deciding what leaves with the user.
// Ciphertext, wrapped keys and token hashes never leave (the registry's exportExclude): secrets are listed by NAME and last four characters only.
import { REGISTRY } from './registry.js';

const dayStr = (d) => d.toISOString().slice(0, 10);

/** exportAs file -> async (repos) => json. Keys must be exactly the files named by the registry (except 'none'). */
export const EXPORTERS = {
  'account.json': async (r) => ({ account: await r.accounts.get(), deletion: await r.accounts.deletion() }),
  'profile.json': async (r) => ({ profile: await r.profile.get() }),
  'settings.json': async (r) => ({ settings: await r.settings.get() }),
  'secrets.json': async (r) => ({ secrets: (await r.secrets.list()).map((s) => ({ name: s.name, last4: s.last4, updatedAt: s.updatedAt })), note: 'キーの値は、安全のため書き出しません（名前と末尾4桁だけ）' }),
  'devices.json': async (r) => ({ devices: await r.devices.list() }),
  'audit.json': async (r) => ({ audit: await r.audit.list({ limit: 1000 }) }),
  'usage.json': async (r) => {
    const to = new Date(), from = new Date(to.getTime() - 400 * 86400_000);
    return { daily: await r.usage.daily({ from: dayStr(from), to: dayStr(to) }), limits: await r.usageLimits.list(), storage: await r.usage.storage() };
  },
};

export const exportedFiles = () => [...new Set(REGISTRY.map((e) => e.exportAs).filter((f) => f !== 'none'))].sort();

/** @param {object} r repos of the user (inside asUser) @returns {Promise<{format:string, exportedAt:string, files:object}>} */
export async function buildExport(r, { user } = {}) {
  const files = {};
  for (const f of exportedFiles()) {
    if (!EXPORTERS[f]) throw Object.assign(new Error('export_incomplete'), { code: 'export_incomplete', status: 500 });
    files[f] = await EXPORTERS[f](r);
  }
  return { format: 'elvar-export-v1', exportedAt: new Date().toISOString(), user: user ? { id: user.id, email: user.email ?? null } : undefined, files };
}
