// Account deletion, the purge half (docs/ELVAR_MULTIUSER.md 7.4, principle 7). Runs for one account whose deletion is due:
//   1. revoke what the user connected elsewhere (P3: Google refresh token, MCP OAuth). Failures are logged and do not stop the purge.
//   2. crypto-shred: remove the user's wrapped DEK (every secret, in the database and in any backup, becomes unreadable; user_secrets cascades).
//   3. delete the Auth user (service role): `on delete cascade` removes every app.* row.
//   4. verify: residual_check over every registered table must be zero.   5. record a receipt that carries no user id and no e-mail.
// Idempotent: a user who is already gone is a success. Storage objects (P5) are swept in step 3 of the full design when that bucket exists.
import { mintVerifiedUid } from '../db/verified-uid.js';
import { deleteAuthUser } from '../db/service.js';
import { residualCheck } from './residual.js';

/**
 * @param {object} db   the database (getDb())
 * @param {string} uid  the user's id (taken from a deletion request, never from a client)
 * @param {{ deleteUser?: Function, revoke?: Array<Function> }} [o]
 */
export async function purgeAccount(db, uid, { deleteUser = deleteAuthUser, revoke = [] } = {}) {
  const v = mintVerifiedUid(uid, 'purge');
  for (const fn of revoke) { try { await fn(v); } catch (e) { console.error('[elvar] purge: could not revoke an external grant:', e?.code || e?.message); } }
  try { await db.asUser(v, (r) => r.keys.del()); } catch (e) { if (e?.code !== 'invalid_reference') throw e; }
  await deleteUser(uid);
  const res = await residualCheck(db, v);
  if (!res.clean) {
    console.error('[elvar] ALERT purge left rows behind:', JSON.stringify({ nonzero: res.nonzero, missing: res.missing, unknown: res.unknown }));
    throw Object.assign(new Error('purge_incomplete'), { code: 'purge_incomplete', status: 500 });
  }
  await db.system.recordReceipt(res.tablesChecked);
  return { tablesChecked: res.tablesChecked };
}

/** The cron step: every account whose deletion is due. @returns {Promise<{purged:number, failed:number}>} */
export async function purgeDue(db, opts = {}) {
  let purged = 0, failed = 0;
  for (const d of await db.system.dueDeletions(20)) {
    try { await purgeAccount(db, d.userId, opts); purged++; } catch (e) { failed++; console.error('[elvar] purge failed (will retry on the next run):', e?.code || e?.message); }
  }
  return { purged, failed };
}
