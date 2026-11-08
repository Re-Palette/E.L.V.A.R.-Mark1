// Vercel Function: POST /api/live-token
import { sendJson } from '../server/http.js';
import { withOwner } from '../server/config/with-owner.js';
import { readConfig, handleLiveToken } from '../server/live-token-core.js';

export default withOwner(async (req, res) => {
  sendJson(res, await handleLiveToken(req, readConfig()));
});
