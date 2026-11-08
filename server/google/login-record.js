// The Google login in the vault: `elvar:v1:tok:google` = { refreshToken, scopes[], clientId, status:'connected', connectedAt, verifiedAt } (encrypted under the vault key),
// plus a small plain flag `elvar:v1:gstate` = { h: sha256(refresh token), status:'reauth_required', reason, at }.
// The flag exists because a refused refresh token (invalid_grant) is discovered deep inside a tool call, where the vault key is deliberately NOT available
// (it is never put on cfg). The flag holds only a hash of the token it applies to; connecting again replaces the token, so a stale flag is simply ignored.
import crypto from 'node:crypto';
import * as V from '../config/vault.js';

export const TOK_KEY = V.tokKey('google');
export const GSTATE_KEY = 'elvar:v1:gstate';
export const tokHash = (refreshToken) => crypto.createHash('sha256').update(String(refreshToken)).digest('hex');

/** The login with the reauth flag applied, or null. */
export async function loadLogin(store, dek) {
  const [rec, flag] = await Promise.all([V.readRecord(store, dek, TOK_KEY), store.get(GSTATE_KEY)]);
  if (!rec) return null;
  const d = rec.data;
  if (flag?.status === 'reauth_required' && flag.h === tokHash(d.refreshToken)) return { ...d, status: 'reauth_required', reason: flag.reason || 'invalid_grant', reauthAt: flag.at || 0 };
  return d;
}
