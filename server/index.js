// E.L.V.A.R. Mark1 — minimal personal server for LOCAL development (Phase 1).
// On Vercel the same logic runs as Functions in /api (see api/*.js); this file is not used there.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, handleLiveToken, handleHealth, sendJson, sendHtml, isAuthorized } from './live-token-core.js';
import { buildConnect, handleCallback } from './google/oauth-web.js';
import { executeGoogle, googleStatus } from './google/index.js';
import { runAgent } from './agents/runner.js';
import { runServerChecks } from './system-check.js';
import { buildHudData } from './hud-data.js';
import { handleNotif } from './notif-sync.js';
import { handleChat } from './chat-api.js';
import { getConfig, runWithConfig } from './config/resolve.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../web/dist');
const PORT = Number(process.env.PORT || 8787);

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
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// The configuration is resolved per request (never frozen at start-up): a changed setting applies to the next request.
const server = http.createServer(async (req, res) => {
  const { cfg: appCfg } = await getConfig(req);
  return runWithConfig(appCfg, () => handle(req, res));
});

async function handle(req, res) {
  const cfg = readConfig();
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/api/health') return sendJson(res, handleHealth(cfg));
    if (pathname === '/api/live-token') return sendJson(res, await handleLiveToken(req, cfg));
    if (pathname === '/api/google/connect') {
      if (req.method !== 'POST') return sendJson(res, { status: 405, body: { error: 'method_not_allowed' } });
      if (!isAuthorized(req, cfg)) return sendJson(res, { status: 401, body: { error: 'unauthorized' } });
      return sendJson(res, buildConnect(req));
    }
    if (pathname === '/api/google/callback') { const r = await handleCallback(req); return sendHtml(res, r.status, r.html); }
    if (pathname === '/api/google/execute' || pathname === '/api/google/status') {
      if (!isAuthorized(req, cfg)) return sendJson(res, { status: 401, body: { error: 'unauthorized' } });
      if (pathname === '/api/google/status') return sendJson(res, { status: 200, body: await googleStatus({ probe: new URL(req.url, 'http://x').searchParams.get('probe') === '1' }) });
      if (req.method !== 'POST') return sendJson(res, { status: 405, body: { error: 'method_not_allowed' } });
      return sendJson(res, await executeGoogle(await readJson(req)));
    }
    if (pathname === '/api/system/check') {
      if (!isAuthorized(req, cfg)) return sendJson(res, { status: 401, body: { error: 'unauthorized' } });
      return sendJson(res, { status: 200, body: await runServerChecks({ deep: new URL(req.url, 'http://x').searchParams.get('deep') === '1' }) });
    }
    if (pathname === '/api/chat') {
      if (!isAuthorized(req, cfg)) return sendJson(res, { status: 401, body: { error: 'unauthorized' } });
      return sendJson(res, await handleChat({ method: req.method, body: req.method === 'POST' ? await readJson(req) : {} }));
    }
    if (pathname === '/api/notif') {
      if (!isAuthorized(req, cfg)) return sendJson(res, { status: 401, body: { error: 'unauthorized' } });
      if (!cfg.accessToken) return sendJson(res, { status: 403, body: { error: 'ELVAR_ACCESS_TOKEN が未設定のため、通知の同期は使えません' } });
      const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      return sendJson(res, await handleNotif({ method: req.method, query: q, body: req.method === 'POST' ? await readJson(req) : {} }));
    }
    if (pathname === '/api/hud/data') {
      if (!isAuthorized(req, cfg)) return sendJson(res, { status: 401, body: { error: 'unauthorized' } });
      return sendJson(res, { status: 200, body: await buildHudData() });
    }
    if (pathname === '/api/agent/run') {
      if (!isAuthorized(req, cfg)) return sendJson(res, { status: 401, body: { error: 'unauthorized' } });
      if (req.method !== 'POST') return sendJson(res, { status: 405, body: { error: 'method_not_allowed' } });
      const b = await readJson(req);
      return sendJson(res, { status: 200, body: await runAgent({ agent: String(b.agent || ''), task: String(b.task || '') }) });
    }
    if (pathname.startsWith('/api/')) return sendJson(res, { status: 404, body: { error: 'not_found' } });
    return serveStatic(req, res);
  } catch (e) {
    console.error('[server]', e?.message || e);
    return sendJson(res, { status: 500, body: { error: 'internal_error' } });
  }
}

server.listen(PORT, () => {
  const cfg = readConfig();
  console.log(`[elvar] server on :${PORT} (gemini ${cfg.apiKey ? 'configured' : 'NOT configured'}, model ${cfg.model})`);
  if (!cfg.accessToken) console.log('[elvar] ELVAR_ACCESS_TOKEN not set → /api/live-token accepts localhost only');
});
