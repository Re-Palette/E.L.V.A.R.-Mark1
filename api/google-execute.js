// Vercel Function: POST /api/google/execute  (see vercel.json rewrites)
import { sendJson } from '../server/http.js';
import { withOwner } from '../server/config/with-owner.js';
import { executeTool } from '../server/tools/execute.js';

export default withOwner(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, { status: 405, body: { error: 'method_not_allowed' } });
  sendJson(res, await executeTool(req.body || {}));
});
