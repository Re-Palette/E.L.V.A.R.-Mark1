// Vercel Function: GET /api/hud/data  (see vercel.json rewrites). Real data for the HUD cards.
import { sendJson } from '../server/http.js';
import { withOwner } from '../server/config/with-owner.js';
import { buildHudData } from '../server/hud-data.js';

export default withOwner(async (req, res) => {
  sendJson(res, { status: 200, body: await buildHudData() });
});
