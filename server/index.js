// E.L.V.A.R. Mark1: the LOCAL server. On Vercel the same logic runs as Functions in /api (see api/*.js); this file is not used there.
// It serves the built web app (web/dist) and the same handlers as Vercel (the api/*.js files are imported, not copied), so a local run and a deployment behave
// alike: every request is authenticated as a Supabase user (Authorization: Bearer <access token>); there is no owner mode and no loopback shortcut.
//
// Local development without a Supabase project: ELVAR_DB=memory ELVAR_DEV_AUTH=1 npm run dev:server  starts a FAKE Auth issuer under /dev-supabase
// (server/dev/fake-auth.js), an in-memory database and throw-away keys, so sign-up -> wizard -> HUD -> settings can be tried. Data is lost on restart.
// That mode is refused unless the server listens on this computer only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sendJson } from './http.js';
import { routeElvar, isRouterPath } from './router.js';
import { PAGE_HEADERS, API_HEADERS } from './security-headers.js';
import { devAuthEnabled, isLoopbackHost } from './dev/dev-auth-guard.js';
import { getDb } from './db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../web/dist');
const PORT = Number(process.env.PORT || 8787);
// Only this computer by default. HOST=0.0.0.0 opts into the LAN (then put HTTPS in front of it). Never with the dev login.
const HOST = process.env.HOST || '127.0.0.1';
const DEV_AUTH = devAuthEnabled();
if (DEV_AUTH && !isLoopbackHost(HOST)) { console.error('[elvar] ELVAR_DEV_AUTH is for this computer only: set HOST=127.0.0.1 (or unset ELVAR_DEV_AUTH)'); process.exit(1); }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.webmanifest': 'application/manifest+json',
};

function readJson(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 6_000_000) req.destroy(); /* room for a base64 PDF upload */ });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  else if (!path.extname(rel) && fs.existsSync(path.join(DIST, rel, 'index.html'))) { res.writeHead(301, { location: rel + '/' }).end(); return; }
  const file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST + path.sep) && file !== DIST) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', ...PAGE_HEADERS });
    res.end(buf);
  });
}

// The same functions Vercel runs (api/*.js), loaded on first use. A Vercel function is handler(req, res) with req.body already parsed.
const FUNCTIONS = {
  '/api/health': () => import('../api/health.js'), '/api/live-token': () => import('../api/live-token.js'), '/api/chat': () => import('../api/chat.js'),
  '/api/google/execute': () => import('../api/google-execute.js'), '/api/system/check': () => import('../api/system-check.js'), '/api/notif': () => import('../api/notif.js'),
  '/api/hud/data': () => import('../api/hud-data.js'), '/api/agent/run': () => import('../api/agent-run.js'),
};
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
let fakeAuth = null;

const server = http.createServer((req, res) => {
  if (String(req.url || '').startsWith('/api/')) for (const [k, v] of Object.entries(API_HEADERS)) res.setHeader(k, v);
  handle(req, res);
});

async function handle(req, res) {
  try {
    const { pathname, searchParams } = new URL(req.url, 'http://x');
    if (fakeAuth && pathname.startsWith('/dev-supabase/') && (await fakeAuth.handle(req, res, pathname, Object.fromEntries(searchParams)))) return;
    if (isRouterPath(pathname)) {
      return sendJson(res, await routeElvar(req, { pathname, query: Object.fromEntries(searchParams), body: BODY_METHODS.has(req.method) ? await readJson(req) : {} }));
    }
    if (!pathname.startsWith('/api/')) return serveStatic(req, res);
    const load = FUNCTIONS[pathname];
    if (!load) return sendJson(res, { status: 404, body: { error: 'not_found' } });
    if (BODY_METHODS.has(req.method)) req.body = await readJson(req);
    return await (await load()).default(req, res);
  } catch (e) {
    console.error('[server]', e?.message || e);
    if (!res.headersSent) return sendJson(res, { status: 500, body: { error: 'internal_error' } });
    res.end();
  }
}

server.listen(PORT, HOST, async () => {
  const port = server.address()?.port || PORT;
  console.log(`[elvar] server on ${HOST}:${port}`);
  try {
    if (DEV_AUTH) {
      // everything the platform normally gets from Supabase and the environment, made up for this process only
      process.env.SUPABASE_URL = `http://127.0.0.1:${port}/dev-supabase`;
      process.env.SUPABASE_PUBLISHABLE_KEY = 'dev-publishable-key';
      process.env.SUPABASE_SECRET_KEY = 'dev-service-key';
      process.env.ELVAR_KEK ||= `dev:${crypto.randomBytes(32).toString('base64')}`;
      process.env.CRON_SECRET ||= crypto.randomBytes(24).toString('hex');
      const { createFakeAuth } = await import('./dev/fake-auth.js');
      fakeAuth = await createFakeAuth({ db: await getDb(), issuerBase: `http://127.0.0.1:${port}` });
      console.log(`[elvar] DEV LOGIN is on (fake Auth, in-memory database; data is lost on restart). Confirmation mails: http://127.0.0.1:${port}/dev-supabase/dev/mailbox`);
    } else if (!process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY) {
      console.log('[elvar] Supabase is not configured (see .env.example: the Supabase URL and publishable key, the database URL, the key-encryption key): see docs/ELVAR_MULTIUSER.md section 9, or try ELVAR_DB=memory ELVAR_DEV_AUTH=1');
    }
  } catch (e) { console.error('[elvar] start-up check failed:', e?.message || e); }
});
