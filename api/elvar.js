// Vercel Function: every /api/elvar/* endpoint (setup, login, devices, config, profile, session). vercel.json rewrites /api/elvar/:path* to /api/elvar?p=:path*
// so that all of them share ONE function (the Hobby plan allows 12).
import { sendJson } from '../server/http.js';
import { routeElvar } from '../server/router.js';

export default async function handler(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.searchParams.get('p');
  u.searchParams.delete('p');
  const pathname = p !== null ? `/api/elvar/${p}` : u.pathname;
  sendJson(res, await routeElvar(req, { pathname, query: Object.fromEntries(u.searchParams), body: req.body && typeof req.body === 'object' ? req.body : {} }));
}
