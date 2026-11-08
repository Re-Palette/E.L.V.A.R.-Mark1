// Vercel Function: GET /api/google/status[?probe=1]
import { readConfig, isAuthorized, sendJson } from '../server/live-token-core.js';
import { googleStatus } from '../server/google/index.js';

export default async function handler(req, res) {
  if (!isAuthorized(req, readConfig())) return sendJson(res, { status: 401, body: { error: 'unauthorized' } });
  const probe = new URL(req.url, 'http://x').searchParams.get('probe') === '1';
  sendJson(res, { status: 200, body: await googleStatus({ probe }) });
}
