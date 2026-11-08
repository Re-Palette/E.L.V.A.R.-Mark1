// Vercel Function: GET /api/health
import { sendJson } from '../server/http.js';
import { withConfig } from '../server/config/with-owner.js';
import { readConfig, handleHealth } from '../server/live-token-core.js';

export default withConfig((req, res) => {
  sendJson(res, handleHealth(readConfig()));
});
