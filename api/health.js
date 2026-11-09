// Vercel Function: GET /api/health. Public: platform liveness only (nothing about any user).
import { sendJson } from '../server/http.js';
import { handleHealth } from '../server/live-token-core.js';

export default function handler(req, res) { sendJson(res, handleHealth()); }
