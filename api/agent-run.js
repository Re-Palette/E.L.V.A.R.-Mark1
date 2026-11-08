// Vercel Function: POST /api/agent/run  (see vercel.json). Runs one sub-agent job and returns its report.
import { sendJson } from '../server/http.js';
import { withOwner } from '../server/config/with-owner.js';
import { runAgent } from '../server/agents/runner.js';

export default withOwner(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, { status: 405, body: { error: 'method_not_allowed' } });
  const { agent, task } = req.body || {};
  sendJson(res, { status: 200, body: await runAgent({ agent: String(agent || ''), task: String(task || '') }) });
});
