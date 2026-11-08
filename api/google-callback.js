// Vercel Function: GET /api/google/callback  (Google redirects the browser here; protected by the signed `state`)
import { sendHtml } from '../server/live-token-core.js';
import { handleCallback } from '../server/google/oauth-web.js';

export default async function handler(req, res) {
  const r = await handleCallback(req);
  sendHtml(res, r.status, r.html);
}
