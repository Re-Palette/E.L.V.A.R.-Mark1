// Entry point for the Google tools: validation, the read/write approval gate, audit log, status probe.
import { TOOLS, declarations } from './tools.js';
import { googleConfig, googleConfigured, googleReauthRequired, googleState, googleToolAllowed } from './config.js';
import { executeTool, coerceArgs } from '../tools/execute.js';
import { accessToken, REAUTH_MESSAGE } from './http.js';

export { googleConfigured, googleReauthRequired, declarations, coerceArgs };
/** The old name of the tool entry point (kept as an alias: it now also runs the owner's connector tools). */
export const executeGoogle = executeTool;


/** Is Google reachable with the stored refresh token? (no data is read) */
export async function googleStatus({ probe = false } = {}) {
  const cfg = googleConfig();
  const configured = googleConfigured(cfg);
  const tools = TOOLS.filter((t) => googleToolAllowed(t, cfg.scopes));
  const out = { configured, state: googleState(cfg), reauthRequired: googleReauthRequired(cfg), tools: tools.length, read: tools.filter((t) => t.kind === 'read').length, write: tools.filter((t) => t.kind === 'write').length };
  if (configured && probe && !out.reauthRequired) {
    try { await accessToken(cfg); out.authenticated = true; } catch (e) { out.authenticated = false; out.error = String(e.message || e); out.reauthRequired = e?.code === 'invalid_grant'; }
  } else if (configured && out.reauthRequired) { out.authenticated = false; out.error = REAUTH_MESSAGE; }
  return out;
}
