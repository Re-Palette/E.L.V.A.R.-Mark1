// Vercel Function: POST /api/google/execute  (see vercel.json rewrites)
import { sendJson } from '../server/http.js';
import { withUser } from '../server/auth/with-user.js';
import { executeTool } from '../server/tools/execute.js';

export default withUser(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, { status: 405, body: { error: 'method_not_allowed' } });
  sendJson(res, await executeTool(req.body || {}));
});
