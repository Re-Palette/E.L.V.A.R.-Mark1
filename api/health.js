// Vercel Function: GET /api/health
import { readConfig, handleHealth, sendJson } from '../server/live-token-core.js';

export default function handler(req, res) {
  sendJson(res, handleHealth(readConfig()));
}
