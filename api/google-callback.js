// Vercel Function: GET /api/google/callback  (Google redirects the browser here; protected by the signed `state`)
import { sendHtml } from '../server/http.js';
import { withConfig } from '../server/config/with-owner.js';
import { handleCallback } from '../server/google/oauth-web.js';

export default withConfig(async (req, res) => {
  const r = await handleCallback(req);
  sendHtml(res, r.status, r.html);
});
