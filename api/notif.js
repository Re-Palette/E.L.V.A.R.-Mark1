// Vercel Function: GET/POST /api/notif  (see vercel.json rewrites). Encrypted relay of phone notifications to the PC, per user: a signed-in user, or the user's
// own device token (scope notif:push to upload, notif:pull to download). Ciphertext only (server/notif-relay.js).
import { sendJson } from '../server/http.js';
import { withUserOrDevice } from '../server/auth/with-user.js';
import { handleNotif } from '../server/notif-relay.js';

export default withUserOrDevice((req) => (req.method === 'GET' ? 'notif:pull' : 'notif:push'))(async (req, res, ctx) => {
  const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  sendJson(res, await handleNotif({ user: ctx, method: req.method, query: q, body: req.body && typeof req.body === 'object' ? req.body : {} }));
});
