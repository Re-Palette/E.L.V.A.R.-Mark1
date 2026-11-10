// The minimal admin (docs/ELVAR_MULTIUSER.md 2.4, M11): list users (e-mail, dates, status, quota, usage counters), suspend and lift. An admin can NOT see
// anybody's persona, settings, conversations, notes, files, connectors or secrets: there is no admin policy on any table, and the only things the admin
// repos can call are the two definer functions that return metadata (app.admin_users, app.admin_set_status). Every action is written to the target's
// own audit log (actor 'admin'), so the user can see it.
import { requireFresh, invalidateAccount } from '../auth/with-user.js';
import { invalidateUserConfig } from '../auth/load-user-config.js';
import { invalidateUsage } from '../usage.js';
import { setBan } from '../db/service.js';
import { isUuid } from '../db/verified-uid.js';
import { HARD_LIMITS, effectiveHardLimits, isHardLimitKey } from '../usage-limits.js';

const bad = (status, error, message) => ({ status, body: { error, ...(message ? { message } : {}) } });
const audit = (event, extra) => console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event, ...extra }));
const int = (v, d, lo, hi) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

export async function listUsers({ user, query }) {
  const limit = int(query?.limit, 100, 1, 500), offset = int(query?.offset, 0, 0, 1_000_000);
  const users = (await user.db((r) => r.admin.listUsers({ limit, offset }))).map((u) => ({ ...u, appliedLimits: effectiveHardLimits({ hardLimits: u.hardLimits }) }));
  return { status: 200, body: { users, limit, offset, limitCatalog: HARD_LIMITS } };
}

async function setStatus(user, params, status, reason) {
  if (!isUuid(params.id)) return bad(404, 'not_found');
  const id = params.id.toLowerCase();
  if (id === user.uid.uid) return bad(400, 'not_yourself', '自分自身は停止できません');
  await requireFresh(user);
  await user.db((r) => r.admin.setStatus(id, status, reason));   // throws forbidden for an admin, not_found, conflict while the user deletes the account
  invalidateAccount(id); invalidateUserConfig(id);
  let banApplied = false;
  try { await setBan(id, status === 'suspended' ? '876000h' : 'none'); banApplied = true; }   // also stops Auth from refreshing the user's session
  catch (e) { console.error('[elvar] admin: the Auth ban could not be applied (the account status still blocks the API):', e?.code || e?.message); }
  audit(status === 'suspended' ? 'admin-suspend' : 'admin-unsuspend', { by: user.uid.uid, target: id, banApplied });
  return { status: 200, body: { status, banApplied } };
}

export const suspendUser = ({ user, params, body }) => {
  const reason = typeof body?.reason === 'string' ? body.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : '';
  return setStatus(user, params, 'suspended', reason || null);
};
export const unsuspendUser = ({ user, params }) => setStatus(user, params, 'active', null);

/** The storage quota of one user, in bytes (O1: the default is 500 MB; this changes it for that user only). Recorded in the user's own audit log (actor admin). */
export async function setQuota({ user, params, body }) {
  if (!isUuid(params.id)) return bad(404, 'not_found');
  const id = params.id.toLowerCase(), bytes = body?.bytes;
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > 1099511627776) return bad(400, 'bad_quota', '容量は 0 以上、1TB 以下のバイト数で指定してください');
  await requireFresh(user);
  await user.db((r) => r.admin.setQuota(id, bytes));   // throws forbidden for a non-admin, not_found for an unknown user
  invalidateAccount(id);
  audit('admin-set-quota', { by: user.uid.uid, target: id, bytes });
  return { status: 200, body: { storageQuotaBytes: bytes } };
}

/**
 * The hard limits of one user (docs 6.3): { limits: { key: whole number | null } }, null removes the account's own value (the platform default applies again).
 * Numbers only; the keys are the catalog of server/usage-limits.js. Written to the target's own audit log (actor admin), so the user can see it.
 */
export async function setLimits({ user, params, body }) {
  if (!isUuid(params.id)) return bad(404, 'not_found');
  const id = params.id.toLowerCase(), limits = body?.limits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits) || !Object.keys(limits).length || Object.keys(limits).length > 20) return bad(422, 'bad_limits', '変更する上限を指定してください');
  for (const [k, v] of Object.entries(limits)) {
    if (!isHardLimitKey(k)) return bad(422, 'bad_limits', `知らない上限です: ${String(k).slice(0, 40)}`);
    if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= 2_000_000_000)) return bad(422, 'bad_limits', `${HARD_LIMITS[k].label}は、0 以上の整数（または空で既定に戻す）で指定してください`);
    if (k === 'maxFileBytes' && v !== null && v > 62914560) return bad(422, 'bad_limits', '1ファイルの最大サイズは 60 MB（62914560）までです');
  }
  await requireFresh(user);
  const after = await user.db((r) => r.admin.setLimits(id, limits));   // forbidden for a non-admin, not_found for an unknown user
  invalidateAccount(id); invalidateUsage(id);
  audit('admin-set-limits', { by: user.uid.uid, target: id, keys: Object.keys(limits) });
  return { status: 200, body: { hardLimits: after, appliedLimits: effectiveHardLimits({ hardLimits: after }) } };
}

/** One user's usage numbers per day, provider and metric (numbers only: no content, no secrets, no per-tool counts). */
export async function userUsage({ user, params, query }) {
  if (!isUuid(params.id)) return bad(404, 'not_found');
  const days = int(query?.days, 14, 1, 60);
  const rows = await user.db((r) => r.admin.userUsage(params.id.toLowerCase(), days));
  return { status: 200, body: { userId: params.id.toLowerCase(), days, usage: rows } };
}
