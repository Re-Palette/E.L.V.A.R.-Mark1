// Vercel Function: POST /api/google/connect
import { readConfig, isAuthorized, sendJson } from '../server/live-token-core.js';
import { buildConnect } from '../server/google/oauth-web.js';

export default function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, { status: 405, body: { error: 'method_not_allowed' } });
  if (!isAuthorized(req, readConfig())) return sendJson(res, { status: 401, body: { error: 'unauthorized' } });
  sendJson(res, buildConnect(req));
}
