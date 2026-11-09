// Database selection. ELVAR_DB=memory (tests) > ELVAR_DB_URL (Postgres through Supavisor) > none.
// Nothing here is used by the old single-owner features: they keep their Redis / file store until P2.
// The Postgres driver is imported only when it is needed, so the memory mode and cold starts without a database never load it.
import { dbError } from './errors.js';
import { createMemoryDb } from './memory.js';

let cached = null, cachedSig = '';

export function dbKind(env = process.env) {
  if (env.ELVAR_DB === 'memory') return 'memory';
  if (env.ELVAR_DB_URL) return 'pg';
  return 'none';
}
export const dbConfigured = (env = process.env) => dbKind(env) !== 'none';

/** @returns {Promise<ReturnType<typeof createMemoryDb>>} the database (same interface for memory and Postgres). @throws db_unavailable (503) when none is configured */
export function getDb(env = process.env) {
  const kind = dbKind(env), sig = `${kind}|${kind === 'pg' ? env.ELVAR_DB_URL : ''}`;
  if (kind === 'none') return Promise.reject(dbError('db_unavailable', 503));
  if (cached && sig === cachedSig) return cached;
  cachedSig = sig;
  cached = kind === 'memory' ? Promise.resolve(createMemoryDb()) : import('./pool.js').then((m) => m.createPgDb(env.ELVAR_DB_URL));
  cached.catch(() => { if (cachedSig === sig) cached = null; });
  return cached;
}

/** Tests: drop the cached database (a fresh MemoryDb on the next call). */
export async function resetDb() {
  const c = cached; cached = null; cachedSig = '';
  if (c) { try { await (await c).close(); } catch { /* ignore */ } }
}
