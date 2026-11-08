// Vercel Function: GET /api/google/status[?probe=1]
import { sendJson } from '../server/http.js';
import { withOwner } from '../server/config/with-owner.js';
import { googleStatus } from '../server/google/index.js';

export default withOwner(async (req, res) => {
  const probe = new URL(req.url, 'http://x').searchParams.get('probe') === '1';
  sendJson(res, { status: 200, body: await googleStatus({ probe }) });
});
