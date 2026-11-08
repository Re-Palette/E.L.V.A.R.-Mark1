// Vercel Function: POST /api/google/connect
import { sendJson } from '../server/http.js';
import { withOwner } from '../server/config/with-owner.js';
import { buildConnect } from '../server/google/oauth-web.js';

export default withOwner((req, res) => {
  if (req.method !== 'POST') return sendJson(res, { status: 405, body: { error: 'method_not_allowed' } });
  sendJson(res, buildConnect(req));
});
