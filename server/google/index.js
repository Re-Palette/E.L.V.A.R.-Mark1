// Entry point for the Google tools: validation, the read/write approval gate, audit log, status probe.
import { TOOL_MAP, TOOLS, declarations } from './tools.js';
import { googleConfig, googleConfigured } from './config.js';
import { signTicket, verifyTicket } from './ticket.js';
import { accessToken, GoogleError } from './http.js';

export { googleConfigured, declarations };

function validate(schema, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return '引数はオブジェクトで指定してください';
  for (const k of schema.required || []) if (args[k] === undefined || args[k] === null || args[k] === '') return `必須の項目がありません: ${k}`;
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties?.[k];
    if (!p) return `未知の項目です: ${k}`;
    if (p.type === 'string' && typeof v !== 'string') return `${k} は文字列で指定してください`;
    if (p.type === 'number' && typeof v !== 'number') return `${k} は数値で指定してください`;
    if (p.type === 'boolean' && typeof v !== 'boolean') return `${k} は true/false で指定してください`;
    if (p.type === 'array' && !Array.isArray(v)) return `${k} は配列で指定してください`;
    if (p.enum && !p.enum.includes(v)) return `${k} は ${p.enum.join(' / ')} のいずれかです`;
    if (typeof v === 'string' && v.length > (p.maxLength || 20000)) return `${k} が長すぎます`;
  }
  return null;
}

/** Voice models often send "580円" / "1,200" for a number, a JSON string for an array, "true" for a boolean: convert what is clearly meant. Pure (tested). */
export function coerceArgs(schema, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args;
  const out = { ...args };
  for (const [k, p] of Object.entries(schema?.properties || {})) {
    const v = out[k]; if (v === undefined || v === null) continue;
    if (p.type === 'number' && typeof v === 'string') { const t = v.replace(/[,，円¥￥\s]/g, ''); if (/^-?\d+(\.\d+)?$/.test(t)) out[k] = Number(t); }
    else if (p.type === 'array' && typeof v === 'string') { try { const j = JSON.parse(v); if (Array.isArray(j)) out[k] = j; } catch { /* leave it: validation explains */ } }
    else if (p.type === 'boolean' && typeof v === 'string' && /^(true|false)$/i.test(v)) out[k] = /^true$/i.test(v);
  }
  return out;
}
const audit = (o) => console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), ...o }));

/**
 * @param {{tool:string, args?:object, ticket?:string}} req
 * @returns {Promise<{status:number, body:object}>}
 */
export async function executeGoogle({ tool, args = {}, ticket }) {
  const t = TOOL_MAP[tool];
  if (!t) return { status: 404, body: { ok: false, error: `未知のツールです: ${tool}` } };
  // Only the Google services need the Google login; notes (GitHub), build requests, web search etc. work with their own settings.
  if (/^(calendar|gmail|drive|sheets|docs|tasks|contacts)_/.test(tool)) { if (!googleConfigured()) return { status: 503, body: { ok: false, error: 'Google連携が設定されていません（docs/GOOGLE_INTEGRATION.md）' } }; }
  else if (t.enabled && !t.enabled()) return { status: 503, body: { ok: false, error: `${tool} は使えません（必要な設定が未完了です）` } };
  else if (!t.enabled && !googleConfigured() && !['current_datetime', 'weather', 'news', 'deep_think', 'jp_text', 'web_search', 'web_sources', 'briefing_data'].includes(tool)) return { status: 503, body: { ok: false, error: 'Google連携が設定されていません（docs/GOOGLE_INTEGRATION.md）' } };
  args = coerceArgs(t.schema, args);
  const bad = validate(t.schema, args);
  if (bad) return { status: 400, body: { ok: false, error: bad } };
  try {
    if (t.kind === 'read') return { status: 200, body: { ok: true, result: await t.run(args) } };

    // ---- write that the owner has waived approval for (calendar add/change on their own calendar): run now, audit it
    if (!ticket && typeof t.auto === 'function' && t.auto(args)) {
      const result = await t.run(args);
      audit({ tool, outcome: 'executed-auto', danger: t.danger, args: summarizeArgs(args), result });
      return { status: 200, body: { ok: true, result } };
    }
    // ---- write: preview first, run only with a ticket for exactly these args
    if (!ticket) {
      const summary = await t.describe(args);
      return { status: 200, body: { ok: true, needsApproval: true, tool, danger: t.danger || 'normal', summary, ticket: signTicket(tool, args) } };
    }
    const v = verifyTicket(ticket, tool, args);
    if (!v.ok) { audit({ tool, outcome: 'refused', reason: v.reason }); return { status: 403, body: { ok: false, error: v.reason } }; }
    const result = await t.run(args);
    audit({ tool, outcome: 'executed', danger: t.danger, args: summarizeArgs(args), result });
    return { status: 200, body: { ok: true, result } };
  } catch (e) {
    audit({ tool, outcome: 'error', message: String(e?.message || e).slice(0, 200) });
    const status = e instanceof GoogleError ? (e.status === 401 ? 401 : e.status === 404 ? 404 : 502) : 400;
    return { status, body: { ok: false, error: String(e?.message || e) } };
  }
}

const summarizeArgs = (a) => JSON.parse(JSON.stringify(a, (k, v) => (typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v)));

/** Is Google reachable with the stored refresh token? (no data is read) */
export async function googleStatus({ probe = false } = {}) {
  const cfg = googleConfig();
  const configured = googleConfigured(cfg);
  const out = { configured, tools: TOOLS.length, read: TOOLS.filter((t) => t.kind === 'read').length, write: TOOLS.filter((t) => t.kind === 'write').length };
  if (configured && probe) {
    try { await accessToken(cfg); out.authenticated = true; } catch (e) { out.authenticated = false; out.error = String(e.message || e); }
  }
  return out;
}
