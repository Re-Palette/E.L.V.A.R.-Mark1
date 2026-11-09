// The deletion check (docs/ELVAR_MULTIUSER.md 7.4 step 6): after an account is deleted, every registered table must hold zero rows for the user.
// Works on both database implementations (db.system.residualCheck). A registered table missing from the answer counts as a failure, never as clean.
import { registryTables } from './registry.js';

/** @param {{system:{residualCheck:Function}}} db  @param {object} vuid a VerifiedUid (minted 'purge' by the deletion job) */
export async function residualCheck(db, vuid) {
  const rows = await db.system.residualCheck(vuid);
  const seen = new Map(rows.map((r) => [r.table, r.n]));
  const expected = new Set(registryTables());
  const missing = [...expected].filter((t) => !seen.has(t));
  const unknown = [...seen.keys()].filter((t) => !expected.has(t));
  const nonzero = rows.filter((r) => r.n > 0);
  return { clean: !missing.length && !unknown.length && !nonzero.length, nonzero, missing, unknown, tablesChecked: rows.length };
}
