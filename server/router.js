// One route table for /api/elvar/* (Vercel: the single function api/elvar.js; local: server/index.js). Vercel's Hobby plan allows 12 functions, so new
// endpoints never get a file of their own.
//   auth: 'none'  - anyone (the public state page): protected by its own limits
//         'user'  - a signed-in user (Supabase access token); the handler gets `user` = { uid, db(fn), cfg, ... }  (server/auth/with-user.js)
//         'admin' - a signed-in admin (token claim AND a row in app.admins)
//         'device:<scope>' - a per-user device token with that scope (Android notification sync)
//         'cron'  - Vercel Cron (Authorization: Bearer CRON_SECRET); the handler gets `user` = { system }
//         'state' - a browser coming back from another site (an OAuth callback): no token, protected by a single-use `state`; it may answer HTML
//   authOpts: { allowPendingDeletion, freshAccount }  see server/auth/with-user.js
// Every route that is not 'none' / 'state' / 'cron' needs a cross-user test: test/routes-isolation.test.mjs (the "real route table" test fails otherwise).
import { runWithConfig } from './config/resolve.js';
import * as API from './account/api.js';
import { getState } from './account/state.js';
import * as GOOGLE from './google/connect.js';
import * as CX from './connectors/api.js';
import * as BUILDS from './account/builds.js';
import * as MEM from './account/notes.js';
import * as SYNC from './brain-sync.js';
import * as ADMIN from './admin/api.js';
import { dailyCron } from './admin/cron.js';
import { authenticate } from './auth/with-user.js';
import { strictConfig } from './auth/user-config.js';

const bad = (status, error) => ({ status, body: { error } });
const FRESH = { freshAccount: true };

export const ROUTES = [
  { method: 'GET', path: '/api/elvar/state', auth: 'none', handler: getState },
  // ---- the signed-in user's own data
  { method: 'GET', path: '/api/elvar/session', auth: 'user', handler: API.getSession },
  { method: 'GET', path: '/api/elvar/config', auth: 'user', handler: API.getConfigRoute },
  { method: 'PATCH', path: '/api/elvar/config', auth: 'user', authOpts: FRESH, handler: API.patchConfig },
  { method: 'POST', path: '/api/elvar/config/test', auth: 'user', handler: API.postConfigTest },
  { method: 'GET', path: '/api/elvar/profile', auth: 'user', handler: API.getProfile },
  { method: 'PUT', path: '/api/elvar/profile', auth: 'user', handler: API.putProfile },
  { method: 'GET', path: '/api/elvar/devices', auth: 'user', handler: API.listDevices },
  { method: 'POST', path: '/api/elvar/devices', auth: 'user', authOpts: FRESH, handler: API.createDevice },
  { method: 'DELETE', path: '/api/elvar/devices/:id', auth: 'user', handler: API.removeDevice },
  { method: 'GET', path: '/api/elvar/usage', auth: 'user', handler: API.getUsage },
  // ---- the account itself (principle 7)
  { method: 'GET', path: '/api/elvar/account/deletion', auth: 'user', authOpts: { allowPendingDeletion: true }, handler: API.getDeletion },
  { method: 'GET', path: '/api/elvar/account/export', auth: 'user', authOpts: FRESH, handler: API.exportData },
  { method: 'POST', path: '/api/elvar/account/delete', auth: 'user', authOpts: FRESH, handler: API.deleteAccount },
  { method: 'POST', path: '/api/elvar/account/delete/cancel', auth: 'user', authOpts: { allowPendingDeletion: true, freshAccount: true }, handler: API.cancelDeletion },
  // ---- admin: metadata only
  { method: 'GET', path: '/api/elvar/admin/users', auth: 'admin', handler: ADMIN.listUsers },
  { method: 'POST', path: '/api/elvar/admin/users/:id/suspend', auth: 'admin', authOpts: FRESH, handler: ADMIN.suspendUser },
  { method: 'POST', path: '/api/elvar/admin/users/:id/unsuspend', auth: 'admin', authOpts: FRESH, handler: ADMIN.unsuspendUser },
  // ---- cron
  { method: 'GET', path: '/api/elvar/cron/daily', auth: 'cron', handler: dailyCron },
  { method: 'POST', path: '/api/elvar/cron/daily', auth: 'cron', handler: dailyCron },
  // ---- Google, per user (decision O2: the user's OWN OAuth client). The callback is the platform's single URL; it has no token, only the single-use state.
  { method: 'GET', path: '/api/elvar/connect/google/status', auth: 'user', handler: GOOGLE.connectStatus },
  { method: 'POST', path: '/api/elvar/connect/google/start', auth: 'user', handler: GOOGLE.connectStart },
  { method: 'POST', path: '/api/elvar/connect/google/claim', auth: 'user', handler: GOOGLE.connectClaim },
  { method: 'POST', path: '/api/elvar/connect/google/disconnect', auth: 'user', handler: GOOGLE.connectDisconnect },
  { method: 'GET', path: '/api/elvar/connect/google/callback', auth: 'state', handler: GOOGLE.connectCallback },
  // ---- connectors (MCP servers and HTTP APIs), per user
  { method: 'GET', path: '/api/elvar/connectors', auth: 'user', handler: CX.listConnectors },
  { method: 'POST', path: '/api/elvar/connectors', auth: 'user', handler: CX.createConnector },
  { method: 'GET', path: '/api/elvar/connectors/export', auth: 'user', handler: CX.exportAll },
  { method: 'POST', path: '/api/elvar/connectors/delete-all', auth: 'user', handler: CX.deleteAll },
  { method: 'GET', path: '/api/elvar/connectors/:id', auth: 'user', handler: CX.getConnector },
  { method: 'PATCH', path: '/api/elvar/connectors/:id', auth: 'user', handler: CX.patchConnector },
  { method: 'DELETE', path: '/api/elvar/connectors/:id', auth: 'user', handler: CX.deleteConnector },
  { method: 'POST', path: '/api/elvar/connectors/:id/sync', auth: 'user', handler: CX.syncConnector },
  { method: 'POST', path: '/api/elvar/connectors/:id/oauth/start', auth: 'user', handler: CX.oauthStart },
  { method: 'POST', path: '/api/elvar/connectors/:id/oauth/claim', auth: 'user', handler: CX.oauthClaim },
  { method: 'GET', path: '/api/elvar/oauth/callback', auth: 'state', handler: CX.oauthCallback },
  // ---- the second brain (P4): the user's own notes - view, edit, trash, delete, older versions, search. The AI tools use the same notes but cannot delete.
  { method: 'GET', path: '/api/elvar/notes', auth: 'user', handler: MEM.listNotes },
  { method: 'POST', path: '/api/elvar/notes', auth: 'user', handler: MEM.createNote },
  { method: 'GET', path: '/api/elvar/notes/graph', auth: 'user', handler: MEM.notesGraph },
  { method: 'GET', path: '/api/elvar/notes/projects', auth: 'user', handler: MEM.notesProjects },
  { method: 'POST', path: '/api/elvar/notes/trash/empty', auth: 'user', handler: MEM.emptyTrash },
  { method: 'POST', path: '/api/elvar/notes/delete-all', auth: 'user', handler: MEM.deleteAllNotes },
  { method: 'GET', path: '/api/elvar/notes/:id', auth: 'user', handler: MEM.getNote },
  { method: 'PUT', path: '/api/elvar/notes/:id', auth: 'user', handler: MEM.updateNote },
  { method: 'DELETE', path: '/api/elvar/notes/:id', auth: 'user', handler: MEM.deleteNote },
  { method: 'POST', path: '/api/elvar/notes/:id/restore', auth: 'user', handler: MEM.restoreNote },
  { method: 'GET', path: '/api/elvar/notes/:id/revisions/:rev', auth: 'user', handler: MEM.getRevision },
  { method: 'POST', path: '/api/elvar/notes/:id/revisions/:rev/restore', auth: 'user', handler: MEM.restoreRevision },
  // ---- the conversation log (short-term memory): per user, with a retention setting, one-by-one and bulk deletion
  { method: 'POST', path: '/api/elvar/messages', auth: 'user', handler: MEM.postMessages },
  { method: 'GET', path: '/api/elvar/messages', auth: 'user', handler: MEM.listMessages },
  { method: 'POST', path: '/api/elvar/messages/purge', auth: 'user', handler: MEM.purgeMessages },
  { method: 'DELETE', path: '/api/elvar/messages/:id', auth: 'user', handler: MEM.deleteMessage },
  { method: 'GET', path: '/api/elvar/conversations', auth: 'user', handler: MEM.listConversations },
  { method: 'GET', path: '/api/elvar/conversations/:id', auth: 'user', handler: MEM.getConversation },
  { method: 'DELETE', path: '/api/elvar/conversations/:id', auth: 'user', handler: MEM.deleteConversation },
  // ---- the notification box (the bell panel)
  { method: 'GET', path: '/api/elvar/inbox', auth: 'user', handler: MEM.listInbox },
  { method: 'POST', path: '/api/elvar/inbox', auth: 'user', handler: MEM.addInbox },
  { method: 'DELETE', path: '/api/elvar/inbox', auth: 'user', handler: MEM.clearInbox },
  { method: 'POST', path: '/api/elvar/inbox/read-all', auth: 'user', handler: MEM.readAllInbox },
  { method: 'PATCH', path: '/api/elvar/inbox/:id', auth: 'user', handler: MEM.patchInbox },
  { method: 'DELETE', path: '/api/elvar/inbox/:id', auth: 'user', handler: MEM.deleteInbox },
  // ---- optional: mirror / import the notes with the user's OWN GitHub repository and token (connector github-brain)
  { method: 'GET', path: '/api/elvar/brain-sync/status', auth: 'user', handler: SYNC.syncStatusRoute },
  { method: 'POST', path: '/api/elvar/brain-sync/import', auth: 'user', handler: SYNC.syncImportRoute },
  { method: 'POST', path: '/api/elvar/brain-sync/push', auth: 'user', handler: SYNC.syncPushRoute },
  // ---- build requests (Claude Code through the user's own GitHub repository)
  { method: 'GET', path: '/api/elvar/builds', auth: 'user', handler: BUILDS.listBuilds },
  { method: 'DELETE', path: '/api/elvar/builds/:id', auth: 'user', handler: BUILDS.deleteBuild },
];

// Paths that existed before the router (the Google callback URL is what a user registered at Google, so it must not change). Vercel rewrites them
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
    if (isUserAuth(hit.r.auth)) {
      const a = await authenticate(hit.r.auth, req, hit.r.authOpts);
      if (!a.ok) return bad(a.status, a.error);
      if (a.ctx.loadConfig) await a.ctx.loadConfig();   // the user's own settings, secrets and profile
      const cfg = a.ctx.cfg;                            // strict: a user's (or cron's) request never reads the owner-mode environment
      return await runWithConfig(cfg, () => hit.r.handler({ req, body, query, params: hit.params, cfg, auth: { mode: a.ctx.kind }, user: a.ctx }));
    }
    if (hit.r.auth !== 'none' && hit.r.auth !== 'state') return bad(500, 'bad_auth_kind');   // a typo in a route's auth must never make it public
    const cfg = strictConfig({ mode: 'none' });
    return await runWithConfig(cfg, () => hit.r.handler({ req, body, query, params: hit.params, cfg, auth: { mode: 'none' } }));
  } catch (e) {
    if (e?.code === 'kek_missing' || e?.code === 'auth_unconfigured') { console.error('[elvar] platform is not configured:', e.code); return bad(503, 'platform_unconfigured'); }
    console.error('[elvar]', e?.code || e?.message || e);
    if (e?.status === 502 || e?.status === 503) return bad(e.status, e.code === 'db_unavailable' ? 'db_unavailable' : 'store_unavailable');
    return bad(e?.status && e.status < 500 ? e.status : 500, e?.status && e.status < 500 ? (e.code || 'error') : 'internal_error');
  }
}
