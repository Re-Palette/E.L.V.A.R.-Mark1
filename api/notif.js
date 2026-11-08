// Vercel Function: GET/POST /api/notif  (see vercel.json rewrites). Encrypted relay of phone notifications to the PC.
import { sendJson } from '../server/http.js';
import { withOwner } from '../server/config/with-owner.js';
import { handleNotif } from '../server/notif-sync.js';

export default withOwner(async (req, res, { auth }) => {
  if (auth.mode === 'local') return sendJson(res, { status: 403, body: { error: '通知の同期には、先にセットアップ（オーナーパスワードの設定）が必要です（暗号化の鍵に使います）' } });
  const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  sendJson(res, await handleNotif({ method: req.method, query: q, body: req.body || {} }));
});
