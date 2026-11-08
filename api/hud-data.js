// Vercel Function: GET /api/hud/data  (see vercel.json rewrites). Real data for the HUD cards.
import { readConfig, isAuthorized, sendJson } from '../server/live-token-core.js';
import { buildHudData } from '../server/hud-data.js';

export default async function handler(req, res) {
  if (!isAuthorized(req, readConfig())) return sendJson(res, { status: 401, body: { error: 'unauthorized' } });
  sendJson(res, { status: 200, body: await buildHudData() });
}
