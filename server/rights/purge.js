// Account deletion, the purge half (docs/ELVAR_MULTIUSER.md 7.4, principle 7). Runs for one account whose deletion is due:
//   1. revoke what the user connected elsewhere (P3: their Google refresh token at Google, MCP OAuth tokens where the server published a revocation
//      endpoint; server/rights/revoke.js). Failures are logged and do not stop the purge.
//   2. crypto-shred: remove the user's wrapped DEK (every secret, in the database and in any backup, becomes unreadable; user_secrets cascades).
//   3. delete the Auth user (service role): `on delete cascade` removes every app.* row.
//   4. verify: residual_check over every registered table must be zero.   5. record a receipt that carries no user id and no e-mail.
// P5: before the Auth user goes, every Storage object under users/<uid>/ is listed and removed in every bucket (service key); the residual check then counts the
// objects as well as the rows, so a deletion that left a file behind fails loudly and is retried.
// Idempotent: a user who is already gone is a success.
import { mintVerifiedUid } from '../db/verified-uid.js';
import { deleteAuthUser } from '../db/service.js';
import { residualCheck } from './residual.js';
import { getStorage, USER_BUCKETS } from '../storage/index.js';
import { revokeAll } from './revoke.js';

/**
 * @param {object} db   the database (getDb())
 * @param {string} uid  the user's id (taken from a deletion request, never from a client)
 * @param {{ deleteUser?: Function, revoke?: Array<Function>, fetchImpl?: Function }} [o]  revoke: extra revokers (the default one revokes Google and MCP tokens); fetchImpl: tests
 */
/** Remove everything the user has in Storage (all buckets). Repeats while anything is left (a listing can be paged). @returns {Promise<number>} objects removed */
export async function sweepUserStorage(storage, uid) {
  let removed = 0;
  for (const bucket of USER_BUCKETS) {
    for (let round = 0; round < 50; round++) {
      const paths = await storage.service.list(`users/${uid}/`, { bucket });
      if (!paths.length) break;
      for (let i = 0; i < paths.length; i += 1000) removed += await storage.service.remove(paths.slice(i, i + 1000), { bucket });
    }
  }
  return removed;
}

export async function purgeAccount(db, uid, { deleteUser = deleteAuthUser, revoke = null, fetchImpl = null, storage = null } = {}) {
  const v = mintVerifiedUid(uid, 'purge');
  const revokers = revoke || [async (vu) => { const res = await revokeAll(db, vu, { fetchImpl }); console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event: 'purge-revoked', google: res.google, connectors: res.connectors, failed: res.failed })); }];
  for (const fn of revokers) { try { await fn(v); } catch (e) { console.error('[elvar] purge: could not revoke an external grant:', e?.code || e?.message); } }
  const store = storage || await getStorage();
  await sweepUserStorage(store, v.uid);   // a failure stops the purge BEFORE the account goes: the request stays due and is retried (the objects are still findable)
  try { await db.asUser(v, (r) => r.keys.del()); } catch (e) { if (e?.code !== 'invalid_reference') throw e; }
  await deleteUser(uid);
  const res = await residualCheck(db, v, { storage: store });
  if (!res.clean) {
    console.error('[elvar] ALERT purge left data behind:', JSON.stringify({ nonzero: res.nonzero, missing: res.missing, unknown: res.unknown, storage: res.storageLeft }));
    throw Object.assign(new Error('purge_incomplete'), { code: 'purge_incomplete', status: 500 });
  }
  await db.system.recordReceipt(res.tablesChecked);
  return { tablesChecked: res.tablesChecked, storageChecked: res.storage.length };
}

/** The cron step: every account whose deletion is due. @returns {Promise<{purged:number, failed:number}>} */
export async function purgeDue(db, opts = {}) {
  let purged = 0, failed = 0;
  for (const d of await db.system.dueDeletions(20)) {
    try { await purgeAccount(db, d.userId, opts); purged++; } catch (e) { failed++; console.error('[elvar] purge failed (will retry on the next run):', e?.code || e?.message); }
  }
  return { purged, failed };
}
