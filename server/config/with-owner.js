// Wrappers for Vercel functions (api/*.js) and the local server: resolve the request's configuration so that values saved in the vault apply
// everywhere, and (withOwner) refuse anything that is not the owner.
import { getConfig, runWithConfig } from './resolve.js';
import { sendJson } from '../http.js';

const guard = (e) => { console.error('[elvar]', e?.message || e); return { status: 500, body: { error: 'internal_error' } }; };

/** Owner only: 401 without a valid device token (or the env token / local loopback before the vault exists). handler(req, res, { cfg, auth }) */
export function withOwner(handler) {
  return async (req, res) => {
    try {
      const r = await getConfig(req);
      if (!r.ok) return sendJson(res, { status: r.status, body: { error: r.error } });
      return await runWithConfig(r.cfg, () => handler(req, res, { cfg: r.cfg, auth: r.auth }));
    } catch (e) { return sendJson(res, guard(e)); }
  };
}

/** No authentication required, but the configuration is resolved (vault values when the caller is the owner, env otherwise). */
export function withConfig(handler) {
  return async (req, res) => {
    try {
      const r = await getConfig(req);
      return await runWithConfig(r.cfg, () => handler(req, res, { cfg: r.cfg, auth: r.auth, ok: r.ok }));
    } catch (e) { return sendJson(res, guard(e)); }
  };
}
