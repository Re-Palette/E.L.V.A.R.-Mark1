// Vercel Function: GET/POST /api/notif  (see vercel.json rewrites). Relay of phone notifications to the PC: a signed-in user, or the user's own device token
// (scope notif:push to upload, notif:pull to download). The relay itself moves to the database in P4; until then it answers "coming soon" after the caller has
// been authenticated (nothing is read or written).
import { sendJson } from '../server/http.js';
import { withUserOrDevice } from '../server/auth/with-user.js';
import { comingSoon } from '../server/account/coming-soon.js';

const soon = comingSoon('notifications');
export default withUserOrDevice((req) => (req.method === 'GET' ? 'notif:pull' : 'notif:push'))(async (req, res) => { sendJson(res, soon()); });
