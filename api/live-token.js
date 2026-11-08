// Vercel Function: POST /api/live-token
import { readConfig, handleLiveToken, sendJson } from '../server/live-token-core.js';

export default async function handler(req, res) {
  sendJson(res, await handleLiveToken(req, readConfig()));
}
