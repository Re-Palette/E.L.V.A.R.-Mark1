// Vercel Function: GET/POST /api/system/check  (see vercel.json rewrites). ?deep=1 adds probes that use a little quota.
import { readConfig, isAuthorized, sendJson } from '../server/live-token-core.js';
import { runServerChecks } from '../server/system-check.js';

export default async function handler(req, res) {
  if (!isAuthorized(req, readConfig())) return sendJson(res, { status: 401, body: { error: 'unauthorized' } });
  const deep = new URL(req.url, 'http://x').searchParams.get('deep') === '1';
  sendJson(res, { status: 200, body: await runServerChecks({ deep }) });
}
