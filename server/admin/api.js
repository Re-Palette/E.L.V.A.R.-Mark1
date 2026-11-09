// The minimal admin (docs/ELVAR_MULTIUSER.md 2.4, M11): list users (e-mail, dates, status, quota, usage counters), suspend and lift. An admin can NOT see
// anybody's persona, settings, conversations, notes, files, connectors or secrets: there is no admin policy on any table, and the only things the admin
// repos can call are the two definer functions that return metadata (app.admin_users, app.admin_set_status). Every action is written to the target's
// own audit log (actor 'admin'), so the user can see it.
import { requireFresh, invalidateAccount } from '../auth/with-user.js';
import { invalidateUserConfig } from '../auth/load-user-config.js';
import { setBan } from '../db/service.js';
import { isUuid } from '../db/verified-uid.js';

const bad = (status, error, message) => ({ status, body: { error, ...(message ? { message } : {}) } });
const audit = (event, extra) => console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event, ...extra }));
const int = (v, d, lo, hi) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

export async function listUsers({ user, query }) {
  const limit = int(query?.limit, 100, 1, 500), offset = int(query?.offset, 0, 0, 1_000_000);
  const users = await user.db((r) => r.admin.listUsers({ limit, offset }));
  return { status: 200, body: { users, limit, offset } };
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
