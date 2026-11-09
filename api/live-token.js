// Vercel Function: POST /api/live-token
import { sendJson } from '../server/http.js';
import { withUser } from '../server/auth/with-user.js';
import { readConfig, handleLiveToken } from '../server/live-token-core.js';

export default withUser(async (req, res) => {
  sendJson(res, await handleLiveToken(req, readConfig()));
});
