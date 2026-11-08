// The one entry point every tool call goes through (Gemini Live, standard chat and sub-agents all reach it): Google / built-in tools and the owner's
// connector tools. Validation, the read/write approval gate, the single-use ticket and the audit log are the same for all of them.
import { TOOL_MAP } from '../google/tools.js';
import { googleConfigured, googleReauthRequired, googleToolAllowed, serviceLabel } from '../google/config.js';
import { signTicket, verifyTicket } from '../google/ticket.js';
import { GoogleError, REAUTH_MESSAGE } from '../google/http.js';
import { currentConfig } from '../config/resolve.js';
import { findConnectorTool } from '../connectors/index.js';
import { ConnectorError } from '../connectors/errors.js';
import { cleanMessage } from '../connectors/manifest.js';
import { validateArgs, coerceArgs } from './validate.js';

export { coerceArgs };
const audit = (o) => console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), ...o }));
const summarizeArgs = (a) => JSON.parse(JSON.stringify(a, (k, v) => (typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v)));

/**
 * @param {{tool:string, args?:object, ticket?:string}} req
 * @returns {Promise<{status:number, body:object}>}
 */
export async function executeTool({ tool, args = {}, ticket }) {
  let t = TOOL_MAP[tool];
  if (!t && !Object.hasOwn(TOOL_MAP, tool)) { try { t = findConnectorTool(currentConfig(), String(tool)) || undefined; } catch { t = undefined; } }
  if (!t) return { status: 404, body: { ok: false, error: `未知のツールです: ${tool}` } };
  // Only the Google services need the Google login; notes (GitHub), build requests, web search etc. work with their own settings. Connector tools have their own checks.
  const NOT_SET = 'Google連携が設定されていません（アプリの設定の「Google」から連携してください）';
  if (t.external || tool === 'connector_tools') { /* own gating in connectors/policy.js */ }
  else if (/^(calendar|gmail|drive|sheets|docs|tasks|contacts)_/.test(tool)) {
    if (!googleConfigured()) return { status: 503, body: { ok: false, error: NOT_SET } };
    if (googleReauthRequired()) return { status: 401, body: { ok: false, error: REAUTH_MESSAGE, reauthRequired: true } };
    if (!googleToolAllowed(t)) return { status: 403, body: { ok: false, error: `${serviceLabel(tool)}は、Googleの連携で許可されていません。設定の「Google」でサービスを選んで、もう一度連携してください` } };
  }
  else if (t.enabled && !t.enabled()) return { status: 503, body: { ok: false, error: `${tool} は使えません（必要な設定が未完了です）` } };
  else if (!t.enabled && !googleConfigured() && !['current_datetime', 'weather', 'news', 'deep_think', 'jp_text', 'web_search', 'web_sources', 'briefing_data'].includes(tool)) return { status: 503, body: { ok: false, error: NOT_SET } };
  args = coerceArgs(t.schema, args);
  const bad = validateArgs(t.schema, args);
  if (bad) return { status: 400, body: { ok: false, error: bad } };
  // the connector gateway decides kind / danger / text per call from the stored manifest (the ticket still covers the outer call exactly)
  let eff = t;
  if (typeof t.plan === 'function') { const p = t.plan(args); if (p.error) return { status: p.status || 400, body: { ok: false, error: p.error } }; eff = p; }
  const ext = eff.external ? { connector: eff.connectorId, host: eff.host } : null;
  const logResult = (r) => (eff.external ? { chars: JSON.stringify(r ?? null).length } : r);   // what a connected service sent back may be personal: the audit log keeps only its size
  try {
    if (eff.kind === 'read') {
      const result = await eff.run(args);
      if (eff.external && eff.name !== 'connector_tools') audit({ tool, outcome: 'executed-auto', ...ext, danger: eff.danger, args: summarizeArgs(args), result: logResult(result) });
      return { status: 200, body: { ok: true, result } };
    }

    // ---- write that the owner has waived approval for (calendar add/change on their own calendar): run now, audit it
    if (!ticket && typeof eff.auto === 'function' && eff.auto(args)) {
      const result = await eff.run(args);
      audit({ tool, outcome: 'executed-auto', danger: eff.danger, args: summarizeArgs(args), result });
      return { status: 200, body: { ok: true, result } };
    }
    // ---- write: preview first, run only with a ticket for exactly these args
    if (!ticket) {
      const summary = await eff.describe(args);
      return { status: 200, body: { ok: true, needsApproval: true, tool, danger: eff.danger || 'normal', summary, ...(eff.via ? { via: eff.via } : {}), ticket: signTicket(tool, args) } };
    }
    const v = await verifyTicket(ticket, tool, args);
    if (!v.ok) { audit({ tool, outcome: 'refused', reason: v.reason, ...(ext || {}) }); return { status: 403, body: { ok: false, error: v.reason } }; }
    const result = await eff.run(args);
    audit({ tool, outcome: 'executed', ...(ext || {}), danger: eff.danger, args: summarizeArgs(args), result: logResult(result) });
    return { status: 200, body: { ok: true, result } };
  } catch (e) {
    audit({ tool, outcome: 'error', ...(ext || {}), message: cleanMessage(e?.message || e, 200) });
    if (e instanceof ConnectorError) return { status: e.status >= 400 && e.status < 600 ? e.status : 502, body: { ok: false, error: cleanMessage(e.message, 300) } };
    const status = e instanceof GoogleError ? (e.status === 401 ? 401 : e.status === 404 ? 404 : 502) : 400;
    return { status, body: { ok: false, error: String(e?.message || e) } };
  }
}
