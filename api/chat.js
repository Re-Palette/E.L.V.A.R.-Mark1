// Vercel Function: POST /api/chat  (see vercel.json). Backend of the standard voice mode (used when the Gemini Live quota is used up).
import { readConfig, isAuthorized, sendJson } from '../server/live-token-core.js';
import { handleChat } from '../server/chat-api.js';

export default async function handler(req, res) {
  if (!isAuthorized(req, readConfig())) return sendJson(res, { status: 401, body: { error: 'unauthorized' } });
  sendJson(res, await handleChat({ method: req.method, body: req.body || {} }));
}
