// Vercel Function: POST /api/agent/run  (see vercel.json). Runs one sub-agent job and returns its report.
import { readConfig, isAuthorized, sendJson } from '../server/live-token-core.js';
import { runAgent } from '../server/agents/runner.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, { status: 405, body: { error: 'method_not_allowed' } });
  if (!isAuthorized(req, readConfig())) return sendJson(res, { status: 401, body: { error: 'unauthorized' } });
  const { agent, task } = req.body || {};
  sendJson(res, { status: 200, body: await runAgent({ agent: String(agent || ''), task: String(task || '') }) });
}
