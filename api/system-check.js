// Vercel Function: GET/POST /api/system/check  (see vercel.json rewrites). ?deep=1 adds probes that use a little quota.
import { sendJson } from '../server/http.js';
import { withOwner } from '../server/config/with-owner.js';
import { runServerChecks } from '../server/system-check.js';

export default withOwner(async (req, res) => {
  const deep = new URL(req.url, 'http://x').searchParams.get('deep') === '1';
  sendJson(res, { status: 200, body: await runServerChecks({ deep }) });
});
