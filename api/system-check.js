// Vercel Function: GET/POST /api/system/check  (see vercel.json rewrites). ?deep=1 adds probes that use a little quota.
import { sendJson } from '../server/http.js';
import { withUser } from '../server/auth/with-user.js';
import { runServerChecks } from '../server/system-check.js';

export default withUser(async (req, res) => {
  const deep = new URL(req.url, 'http://x').searchParams.get('deep') === '1';
  sendJson(res, { status: 200, body: await runServerChecks({ deep }) });
});
