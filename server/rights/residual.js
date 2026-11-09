// The deletion check (docs/ELVAR_MULTIUSER.md 7.4 step 6): after an account is deleted, every registered table must hold zero rows for the user.
// Works on both database implementations (db.system.residualCheck). A registered table missing from the answer counts as a failure, never as clean.
import { registryTables } from './registry.js';

import { USER_BUCKETS } from '../storage/index.js';

/**
 * @param {{system:{residualCheck:Function}}} db  @param {object} vuid a VerifiedUid (minted 'purge' by the deletion job)
 * @param {{ storage?: { service: { count: Function } } }} [o]  with a storage, every bucket that can hold the user's objects is counted too (principle 7: the files are part of the deletion)
 */
export async function residualCheck(db, vuid, { storage = null } = {}) {
  const rows = await db.system.residualCheck(vuid);
  const seen = new Map(rows.map((r) => [r.table, r.n]));
  const expected = new Set(registryTables());
  const missing = [...expected].filter((t) => !seen.has(t));
  const unknown = [...seen.keys()].filter((t) => !expected.has(t));
  const nonzero = rows.filter((r) => r.n > 0);
  const objects = [];   // [{ bucket, n }] of the user's Storage objects
  if (storage) for (const bucket of USER_BUCKETS) objects.push({ bucket, n: await storage.service.count(`users/${vuid.uid}/`, { bucket }) });
  const leftObjects = objects.filter((o) => o.n > 0);
  return { clean: !missing.length && !unknown.length && !nonzero.length && !leftObjects.length, nonzero, missing, unknown, tablesChecked: rows.length, storage: objects, storageLeft: leftObjects };
}
