// One route table for /api/elvar/* (Vercel: the single function api/elvar.js; local: server/index.js). Vercel's Hobby plan allows 12 functions, so new
// endpoints never get a file of their own.
//   auth: 'none'  - anyone (state, login, claim: protected by their own checks and rate limits)
//         'owner' - a valid device token (or the env token / local loopback before setup)   [single-owner mode, removed in P2]
//         'user'  - a signed-in user (Supabase access token); the handler gets `user` = { uid, db(fn), cfg, ... }  (server/auth/with-user.js)
//         'admin' - a signed-in admin (token claim AND a row in app.admins)
//         'device:<scope>' - a per-user device token with that scope (Android notification sync)
//         'cron'  - Vercel Cron (Authorization: Bearer CRON_SECRET); the handler gets `user` = { system }
//         'state' - a browser coming back from another site (the Google callback): no device token, protected by a single-use `state`; it may answer HTML
import { getConfig, runWithConfig, envConfig } from './config/resolve.js';
import * as A from './config/auth.js';
import * as API from './elvar-api.js';
import * as G from './google/connect.js';
import * as CX from './connectors/api.js';
import { authenticate } from './auth/with-user.js';

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
  { method: 'GET', path: '/api/elvar/connect/google/status', auth: 'owner', handler: G.connectStatus },
  { method: 'POST', path: '/api/elvar/connect/google/start', auth: 'owner', handler: G.connectStart },
  { method: 'POST', path: '/api/elvar/connect/google/claim', auth: 'owner', handler: G.connectClaim },
  { method: 'POST', path: '/api/elvar/connect/google/disconnect', auth: 'owner', handler: G.connectDisconnect },
  { method: 'GET', path: '/api/elvar/connect/google/callback', auth: 'state', handler: G.connectCallback },
  { method: 'GET', path: '/api/elvar/connectors', auth: 'owner', handler: CX.listConnectors },
  { method: 'POST', path: '/api/elvar/connectors', auth: 'owner', handler: CX.createConnector },
  { method: 'GET', path: '/api/elvar/connectors/export', auth: 'owner', handler: CX.exportAll },
  { method: 'POST', path: '/api/elvar/connectors/delete-all', auth: 'owner', handler: CX.deleteAll },
  { method: 'GET', path: '/api/elvar/connectors/:id', auth: 'owner', handler: CX.getConnector },
  { method: 'PATCH', path: '/api/elvar/connectors/:id', auth: 'owner', handler: CX.patchConnector },
  { method: 'DELETE', path: '/api/elvar/connectors/:id', auth: 'owner', handler: CX.deleteConnector },
  { method: 'POST', path: '/api/elvar/connectors/:id/sync', auth: 'owner', handler: CX.syncConnector },
  { method: 'POST', path: '/api/elvar/connectors/:id/oauth/start', auth: 'owner', handler: CX.oauthStart },
  { method: 'POST', path: '/api/elvar/connectors/:id/oauth/claim', auth: 'owner', handler: CX.oauthClaim },
  { method: 'GET', path: '/api/elvar/oauth/callback', auth: 'state', handler: CX.oauthCallback },
];

// Paths that existed before the router (the callback URL is what the owner registers at Google, so it must not change). Vercel rewrites them
// into this router (vercel.json); the local server hands them over here too.
export const ALIASES = {
  '/api/google/callback': '/api/elvar/connect/google/callback',
  '/api/google/status': '/api/elvar/connect/google/status',
};
export const isRouterPath = (pathname) => pathname.startsWith('/api/elvar/') || Object.hasOwn(ALIASES, pathname.replace(/\/+$/, ''));

export const isUserAuth = (a) => a === 'user' || a === 'admin' || a === 'cron' || /^device:[a-z][a-z:]*$/.test(String(a));

const compile = (routes) => routes.map((r) => ({ ...r, parts: r.path.split('/').filter(Boolean) }));
const compiled = compile(ROUTES);
function match(pathname, compiled) {
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
export const routeElvar = (req, o) => dispatch(compiled, req, o);

/** A router over another route table (tests use it with routes that exercise the user / admin / device / cron authentication). */
export const createRouter = (routes) => { const c = compile(routes); return (req, o) => dispatch(c, req, o); };

async function dispatch(compiled, req, { pathname, query = {}, body = {} }) {
  pathname = ALIASES[pathname.replace(/\/+$/, '')] || pathname;
  let hits;
  try { hits = match(pathname, compiled); } catch { return bad(400, 'bad_path'); }   // a malformed %-escape
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
    if (isUserAuth(hit.r.auth)) {
      const a = await authenticate(hit.r.auth, req, hit.r.authOpts);
      if (!a.ok) return bad(a.status, a.error);
      const cfg = a.ctx.cfg;   // undefined for cron: runWithConfig falls back to the plain env config
      return await runWithConfig(cfg, () => hit.r.handler({ req, body, query, params: hit.params, cfg, auth: { mode: a.ctx.kind }, user: a.ctx }));
    }
    if (hit.r.auth !== 'none' && hit.r.auth !== 'state') return bad(500, 'bad_auth_kind');   // a typo in a route's auth must never make it public
    const cfg = envConfig({ mode: 'none' });
    return await runWithConfig(cfg, () => hit.r.handler({ req, body, query, params: hit.params, cfg, auth: { mode: 'none' } }));
  } catch (e) {
    console.error('[elvar]', e?.code || e?.message || e);
    if (e?.status === 502 || e?.status === 503) return bad(e.status, 'store_unavailable');
    return bad(e?.status && e.status < 500 ? e.status : 500, e?.status && e.status < 500 ? (e.code || 'error') : 'internal_error');
  }
}
