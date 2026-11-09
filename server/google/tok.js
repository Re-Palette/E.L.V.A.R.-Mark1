// A refused Google refresh token (invalid_grant) is discovered deep inside a tool call: remember it, for THIS user only (their own row of app.oauth_tokens,
// status = 'reauth_required'), so tools stop calling Google until they connect again. Settings and the HUD read the flag from the user's request config.
import { currentConfig } from '../config/resolve.js';
import { getKeyring } from '../auth/keyring.js';
import { invalidateUserConfig } from '../auth/load-user-config.js';

export const GOOGLE = 'google';

export async function markReauth(refreshToken, reason = 'invalid_grant') {
  const cfg = currentConfig();
  if (typeof cfg.db !== 'function' || !refreshToken) return;   // no signed-in user (scripts): nothing to record
  try {
    const changed = await cfg.db(async (r) => {
      const t = await getKeyring().getToken(r, GOOGLE);
      if (!t || t.data.refreshToken !== refreshToken || t.status === 'reauth_required') return false;   // reconnected meanwhile, or already flagged
      return r.oauthTokens.setStatus(GOOGLE, 'reauth_required', String(reason).slice(0, 40));
    });
    if (changed) { invalidateUserConfig(cfg.uid); console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event: 'google-reauth-required', uid: String(cfg.uid?.uid ?? cfg.uid), reason })); }
  } catch (e) { console.error('[elvar] could not record the Google reauth state:', e?.code || e?.message); }
}
