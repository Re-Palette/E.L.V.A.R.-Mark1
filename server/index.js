// E.L.V.A.R. Mark1 — personal server for LOCAL use.
// On Vercel the same logic runs as Functions in /api (see api/*.js); this file is not used there.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, handleLiveToken, handleHealth, sendJson } from './live-token-core.js';
import { executeGoogle } from './google/index.js';
import { runAgent } from './agents/runner.js';
import { runServerChecks } from './system-check.js';
import { buildHudData } from './hud-data.js';
import { handleNotif } from './notif-sync.js';
import { handleChat } from './chat-api.js';
import { getConfig, runWithConfig } from './config/resolve.js';
import { routeElvar, isRouterPath } from './router.js';
import { getStore, storeKind } from './store/index.js';
import { loadMeta } from './config/vault.js';
import { ensureSetupCode } from './config/auth.js';
import { PAGE_HEADERS, API_HEADERS } from './security-headers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../web/dist');
const PORT = Number(process.env.PORT || 8787);
// Only this computer by default. HOST=0.0.0.0 opts into the LAN (then put HTTPS in front of it).
const HOST = process.env.HOST || '127.0.0.1';

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

// The configuration is resolved per request (never frozen at start-up): a changed setting applies to the next request.
const server = http.createServer((req, res) => {
  if (String(req.url || '').startsWith('/api/')) for (const [k, v] of Object.entries(API_HEADERS)) res.setHeader(k, v);
  handle(req, res);
});

const OWNER_API = new Set(['/api/live-token', '/api/google/execute', '/api/system/check', '/api/chat', '/api/notif', '/api/hud/data', '/api/agent/run']);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

async function handle(req, res) {
  try {
    const { pathname, searchParams } = new URL(req.url, 'http://x');
    if (isRouterPath(pathname)) {
      return sendJson(res, await routeElvar(req, { pathname, query: Object.fromEntries(searchParams), body: BODY_METHODS.has(req.method) ? await readJson(req) : {} }));
    }
    if (!pathname.startsWith('/api/')) return serveStatic(req, res);
    // Resolve who is calling and with which configuration (vault > env > default), then run the endpoint inside that configuration.
    const g = await getConfig(req);
    if (OWNER_API.has(pathname) && !g.ok) return sendJson(res, { status: g.status, body: { error: g.error } });
    return await runWithConfig(g.cfg, () => api(req, res, pathname, searchParams, g));
  } catch (e) {
    console.error('[server]', e?.message || e);
    if (!res.headersSent) return sendJson(res, { status: 500, body: { error: 'internal_error' } });
    res.end();
  }
}

async function api(req, res, pathname, q, g) {
  if (pathname === '/api/health') return sendJson(res, handleHealth(readConfig()));
  if (pathname === '/api/live-token') return sendJson(res, await handleLiveToken(req, readConfig()));
  if (pathname === '/api/google/execute') {
    if (req.method !== 'POST') return sendJson(res, { status: 405, body: { error: 'method_not_allowed' } });
    return sendJson(res, await executeGoogle(await readJson(req)));
  }
  if (pathname === '/api/system/check') return sendJson(res, { status: 200, body: await runServerChecks({ deep: q.get('deep') === '1' }) });
  if (pathname === '/api/chat') return sendJson(res, await handleChat({ method: req.method, body: req.method === 'POST' ? await readJson(req) : {} }));
  if (pathname === '/api/notif') {
    if (g.auth.mode === 'local') return sendJson(res, { status: 403, body: { error: '通知の同期には、先にセットアップ（オーナーパスワードの設定）が必要です（暗号化の鍵に使います）' } });
    return sendJson(res, await handleNotif({ method: req.method, query: Object.fromEntries(q), body: req.method === 'POST' ? await readJson(req) : {} }));
  }
  if (pathname === '/api/hud/data') return sendJson(res, { status: 200, body: await buildHudData() });
  if (pathname === '/api/agent/run') {
    if (req.method !== 'POST') return sendJson(res, { status: 405, body: { error: 'method_not_allowed' } });
    const b = await readJson(req);
    return sendJson(res, { status: 200, body: await runAgent({ agent: String(b.agent || ''), task: String(b.task || '') }) });
  }
  return sendJson(res, { status: 404, body: { error: 'not_found' } });
}

server.listen(PORT, HOST, async () => {
  const kind = storeKind();
  const port = server.address()?.port || PORT;
  console.log(`[elvar] server on ${HOST}:${port} (store: ${kind})`);
  try {
    const store = getStore();
    if (!store) return console.log('[elvar] no storage configured: add Upstash Redis (UPSTASH_REDIS_REST_URL / _TOKEN) to enable app-side setup');
    if (await loadMeta(store)) return console.log('[elvar] owner account exists: sign in from the app');
    if (process.env.ELVAR_ACCESS_TOKEN) console.log('[elvar] ELVAR_ACCESS_TOKEN is set: env mode until the owner account is created in the app');
    // prints "ELVAR SETUP CODE: ..." and a one-time setup link (shown here only, never over the network)
    const code = await ensureSetupCode(store, { rotate: true, port });
    if (code && process.env.ELVAR_DEV_URL) console.log(`[elvar] (dev) or: ${process.env.ELVAR_DEV_URL.replace(/\/+$/, '')}/?setup=${code}`);
  } catch (e) { console.error('[elvar] start-up check failed:', e?.message || e); }
});
