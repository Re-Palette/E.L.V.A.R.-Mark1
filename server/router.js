// One route table for /api/elvar/* (Vercel: the single function api/elvar.js; local: server/index.js). Vercel's Hobby plan allows 12 functions, so new
// endpoints never get a file of their own.
//   auth: 'none'  - anyone (state, login, claim: protected by their own checks and rate limits)
//         'owner' - a valid device token (or the env token / local loopback before setup)
import { getConfig, runWithConfig, envConfig } from './config/resolve.js';
import * as A from './config/auth.js';
import * as API from './elvar-api.js';

const bad = (status, error) => ({ status, body: { error } });

export const ROUTES = [
  { method: 'GET', path: '/api/elvar/state', auth: 'none', handler: ({ req }) => A.setupState(req) },
  { method: 'POST', path: '/api/elvar/setup/claim', auth: 'none', handler: ({ req, body }) => A.claim(req, body) },
  { method: 'POST', path: '/api/elvar/auth/login', auth: 'none', handler: ({ req, body }) => A.login(req, body) },
  { method: 'POST', path: '/api/elvar/auth/logout', auth: 'owner', handler: ({ auth }) => A.logout(auth) },
  { method: 'POST', path: '/api/elvar/auth/password', auth: 'owner', handler: ({ req, auth, body }) => A.changeOwnerPassword(req, auth, body) },
  { method: 'GET', path: '/api/elvar/devices', auth: 'owner', handler: ({ auth }) => A.listDevices(auth) },
  { method: 'DELETE', path: '/api/elvar/devices/:id', auth: 'owner', handler: ({ auth, params }) => A.removeDevice(auth, params.id) },
  { method: 'GET', path: '/api/elvar/config', auth: 'owner', handler: API.getConfigRoute },
  { method: 'PATCH', path: '/api/elvar/config', auth: 'owner', handler: API.patchConfig },
  { method: 'POST', path: '/api/elvar/config/test', auth: 'owner', handler: API.postConfigTest },
  { method: 'GET', path: '/api/elvar/profile', auth: 'owner', handler: API.getProfile },
  { method: 'PUT', path: '/api/elvar/profile', auth: 'owner', handler: API.putProfile },
  { method: 'GET', path: '/api/elvar/session', auth: 'owner', handler: API.getSession },
];

const compiled = ROUTES.map((r) => ({ ...r, parts: r.path.split('/').filter(Boolean) }));
function match(pathname) {
  const segs = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  const hits = [];
  for (const r of compiled) {
    if (r.parts.length !== segs.length) continue;
    const params = {}; let ok = true;
    for (let i = 0; i < segs.length; i++) { if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = decodeURIComponent(segs[i]); else if (r.parts[i] !== segs[i]) { ok = false; break; } }
    if (ok) hits.push({ r, params });
  }
  return hits;
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {{pathname:string, query?:object, body?:object}} o
 * @returns {Promise<{status:number, body:object}>}
 */
export async function routeElvar(req, { pathname, query = {}, body = {} }) {
  let hits;
  try { hits = match(pathname); } catch { return bad(400, 'bad_path'); }   // a malformed %-escape
  if (!hits.length) return bad(404, 'not_found');
  const hit = hits.find((h) => h.r.method === req.method);
  if (!hit) return bad(405, 'method_not_allowed');
  // Writes must be JSON: a cross-site <form> or a text/plain fetch cannot send that without a CORS preflight (which we never answer).
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return bad(415, 'json_required');
  try {
    if (hit.r.auth === 'owner') {
      const g = await getConfig(req);
      if (!g.ok) return bad(g.status, g.error);
      return await runWithConfig(g.cfg, () => hit.r.handler({ req, body, query, params: hit.params, cfg: g.cfg, auth: g.auth }));
    }
    const cfg = envConfig({ mode: 'none' });
    return await runWithConfig(cfg, () => hit.r.handler({ req, body, query, params: hit.params, cfg, auth: { mode: 'none' } }));
  } catch (e) {
    console.error('[elvar]', e?.code || e?.message || e);
    if (e?.status === 502 || e?.status === 503) return bad(e.status, 'store_unavailable');
    return bad(e?.status && e.status < 500 ? e.status : 500, e?.status && e.status < 500 ? (e.code || 'error') : 'internal_error');
  }
}
