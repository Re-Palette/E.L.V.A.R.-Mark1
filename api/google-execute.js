// Vercel Function: POST /api/google/execute  (see vercel.json rewrites)
import { readConfig, isAuthorized, sendJson } from '../server/live-token-core.js';
import { executeGoogle } from '../server/google/index.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, { status: 405, body: { error: 'method_not_allowed' } });
  if (!isAuthorized(req, readConfig())) return sendJson(res, { status: 401, body: { error: 'unauthorized' } });
  sendJson(res, await executeGoogle(req.body || {}));
}
