// Vercel Function: POST /api/chat  (see vercel.json). Backend of the standard voice mode (used when the Gemini Live quota is used up).
import { sendJson } from '../server/http.js';
import { withOwner } from '../server/config/with-owner.js';
import { handleChat } from '../server/chat-api.js';

export default withOwner(async (req, res) => {
  sendJson(res, await handleChat({ method: req.method, body: req.body || {} }));
});
