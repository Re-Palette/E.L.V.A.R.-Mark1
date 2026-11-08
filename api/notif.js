// Vercel Function: GET/POST /api/notif  (see vercel.json rewrites). Encrypted relay of phone notifications to the PC.
import { readConfig, isAuthorized, sendJson } from '../server/live-token-core.js';
import { handleNotif } from '../server/notif-sync.js';

export default async function handler(req, res) {
  const cfg = readConfig();
  if (!isAuthorized(req, cfg)) return sendJson(res, { status: 401, body: { error: 'unauthorized' } });
  if (!cfg.accessToken) return sendJson(res, { status: 403, body: { error: 'ELVAR_ACCESS_TOKEN が未設定のため、通知の同期は使えません（暗号化の鍵に使います）' } });
  const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  sendJson(res, await handleNotif({ method: req.method, query: q, body: req.body || {} }));
}
