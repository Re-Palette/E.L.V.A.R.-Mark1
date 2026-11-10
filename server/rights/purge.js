// Account deletion, the purge half (docs/ELVAR_MULTIUSER.md 7.4, principle 7). Runs for one account whose deletion is due:
//   1. revoke what the user connected elsewhere (P3: their Google refresh token at Google, MCP OAuth tokens where the server published a revocation
//      endpoint; server/rights/revoke.js). Failures are logged and do not stop the purge.
//   2. crypto-shred: remove the user's wrapped DEK (every secret, in the database and in any backup, becomes unreadable; user_secrets cascades).
//   3. delete the Auth user (service role): `on delete cascade` removes every app.* row.
//   4. verify: residual_check over every registered table must be zero.   5. record a receipt that carries no user id and no e-mail.
// P5: before the Auth user goes, every Storage object under users/<uid>/ is listed and removed in every bucket (service key); the residual check then counts the
// objects as well as the rows, so a deletion that left a file behind fails loudly. NOTE: the deletion request cascades away with the Auth user, so a purge that fails AFTER the user
// is deleted is NOT retried by purgeDue. Three things close the window in which something could still be written for a user who is going (docs/ELVAR_MULTIUSER.md 19):
//   1. before anything is removed the user's export jobs are failed and a purge lock is set (export steps check it and remove what they just wrote when their job is gone);
//   2. Storage is swept again AFTER the Auth user is deleted and before the residual check (an upload or an export part that landed in between);
//   3. the daily orphan sweep (sweepOrphanStorage) removes anything under users/<uid>/ in any bucket whose uid is no longer in auth.users.
// Idempotent: a user who is already gone is a success.
import { mintVerifiedUid } from '../db/verified-uid.js';
import { deleteAuthUser } from '../db/service.js';
import { residualCheck } from './residual.js';
import { getStorage, USER_BUCKETS } from '../storage/index.js';
import { revokeAll } from './revoke.js';
import { PURGE_LOCK } from './export-job.js';

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

/**
 * The optional confirmation hook: when ELVAR_DELETION_RECEIPT_WEBHOOK is set, the address the user left (read once from the deletion request) and a Japanese text are POSTed to it
 * AFTER the deletion was verified clean, so an operator can send the mail through their own provider. Nothing about the user is kept afterwards: the request row (with the
 * address) went with the account, the receipt has no id and no address. A failing hook is logged and never undoes or retries the deletion.
 */
export async function sendDeletionReceipt(email, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const url = String(env.ELVAR_DELETION_RECEIPT_WEBHOOK || '').trim();
  if (!url || !email) return false;
  try {
    const u = new URL(url); if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) return false;
    const r = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: email, subject: 'E.L.V.A.R. アカウントを削除しました', text: 'E.L.V.A.R. のアカウントと、保存していたデータ（ファイルを含む）の削除が完了しました。このメールが、削除の確認です。\n\nバックアップには、運営者の定める期間（最長7日）だけ残ることがあります。' }) });
    return r.ok;
  } catch (e) { console.error('[elvar] deletion receipt hook failed (the deletion itself is done):', e?.code || e?.message); return false; }
}

/** Stop the user's export jobs: the purge lock (steps respect it) and every running job marked failed, so a step in flight finds its job gone and removes its own part. */
async function stopExports(db, v) {
  try {
    await db.asUser(v, (r) => r.kv.set(PURGE_LOCK, { at: Date.now() }, { ttlSec: 3600 }));
    for (const j of await db.asUser(v, (r) => r.exportJobs.list())) if (['queued', 'running'].includes(j.status)) await db.system.updateExportJob(v, j.id, { status: 'failed', cursor: j.cursor, parts: j.parts, bytes: j.bytes, error: 'account_deleting' });
  } catch (e) { if (e?.code !== 'invalid_reference') console.error('[elvar] purge: could not stop the export jobs:', e?.code || e?.message); }
}

/**
 * The orphan sweep (daily): every owner found under users/ in any bucket that is not in auth.users any more loses everything under users/<uid>/. Catches what a race left behind
 * after a purge (an upload into a live reservation, an export part written by a step that was already running).
 * @returns {Promise<{owners:number, orphans:number, removed:number}>}
 */
export async function sweepOrphanStorage(db, storage, { limit = 50 } = {}) {
  const seen = new Set();
  for (const bucket of USER_BUCKETS) for (const uid of await storage.service.owners({ bucket })) seen.add(uid);
  const ids = [...seen], alive = new Set();
  for (let i = 0; i < ids.length; i += 1000) for (const id of await db.system.existingUsers(ids.slice(i, i + 1000))) alive.add(String(id).toLowerCase());
  const dead = ids.filter((id) => !alive.has(id)).slice(0, limit); let removed = 0;
  for (const uid of dead) removed += await sweepUserStorage(storage, uid);
  if (dead.length) console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event: 'orphan-storage-swept', orphans: dead.length, removed }));
  return { owners: ids.length, orphans: dead.length, removed };
}

export async function purgeAccount(db, uid, { deleteUser = deleteAuthUser, revoke = null, fetchImpl = null, storage = null, email = null, notify = sendDeletionReceipt } = {}) {
  const v = mintVerifiedUid(uid, 'purge');
  const revokers = revoke || [async (vu) => { const res = await revokeAll(db, vu, { fetchImpl }); console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event: 'purge-revoked', google: res.google, connectors: res.connectors, failed: res.failed })); }];
  for (const fn of revokers) { try { await fn(v); } catch (e) { console.error('[elvar] purge: could not revoke an external grant:', e?.code || e?.message); } }
  await stopExports(db, v);
  const store = storage || await getStorage();
  await sweepUserStorage(store, v.uid);   // a failure stops the purge BEFORE the account goes: the request stays due and is retried (the objects are still findable)
  try { await db.asUser(v, (r) => r.keys.del()); } catch (e) { if (e?.code !== 'invalid_reference') throw e; }
  await deleteUser(uid);
  await sweepUserStorage(store, v.uid);   // again, now that nothing of the user can be authorised any more: whatever landed since the first sweep (the account's rows are gone, so a leftover is not retried: the orphan sweep is the net)
  const res = await residualCheck(db, v, { storage: store });
  if (!res.clean) {
    console.error('[elvar] ALERT purge left data behind:', JSON.stringify({ nonzero: res.nonzero, missing: res.missing, unknown: res.unknown, storage: res.storageLeft }));
    throw Object.assign(new Error('purge_incomplete'), { code: 'purge_incomplete', status: 500 });
  }
  await db.system.recordReceipt(res.tablesChecked);
  const mailed = email ? await notify(email) : false;   // optional; the address is not kept anywhere after this
  return { tablesChecked: res.tablesChecked, storageChecked: res.storage.length, mailed };
}

/** The cron step: every account whose deletion is due. @returns {Promise<{purged:number, failed:number}>} */
export async function purgeDue(db, opts = {}) {
  let purged = 0, failed = 0;
  for (const d of await db.system.dueDeletions(20)) {
    try { await purgeAccount(db, d.userId, { email: d.email, ...opts }); purged++; } catch (e) { failed++; console.error('[elvar] purge failed (retried on the next run while the account still exists; the daily orphan sweep removes any leftover object):', e?.code || e?.message); }
  }
  return { purged, failed };
}
