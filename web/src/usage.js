// The page's side of usage metering (docs/ELVAR_MULTIUSER.md 6.1). The server is the source of truth (GET /api/elvar/usage): it counts every provider call itself.
// What only the browser can see is reported here, clearly labelled "client-reported" on the screens:
//   Gemini Live time (the browser talks to Gemini Live directly) - liveTick() every few seconds while a session is open
//   which tools were used                                       - tool(name)
// Both are sent as ONE small report every 30 seconds (and when the page is hidden). The server clamps the Live seconds to the time that really passed.
// Nothing about the user's data is in the report: seconds and tool names only. Groq's own rate-limit reading stays on this device (it is a header, not usage).
import { authHeaders } from './elvar/auth.js';

const QUOTA_KEY = 'elvar_groq_quota';
let pendingSeconds = 0, pendingSessions = 0, pendingTools = {}, timer = null, summary = null, summaryAt = 0, inflight = null;
const listeners = new Set();

async function flush() {
  const seconds = Math.min(600, Math.round(pendingSeconds)), tools = pendingTools;
  if (!seconds && !Object.keys(tools).length) return;
  pendingSeconds -= seconds; pendingTools = {}; pendingSessions = 0;
  try {
    const r = await fetch('/api/elvar/usage/report', { method: 'POST', cache: 'no-store', keepalive: true, headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify({ liveSeconds: seconds, tools }) });
    if (r.status >= 500 || r.status === 429) throw new Error(String(r.status));
  } catch { pendingSeconds += seconds; for (const [k, v] of Object.entries(tools)) pendingTools[k] = (pendingTools[k] || 0) + v; }   // try again with the next one
}
function start() {
  if (timer || typeof setInterval === 'undefined') return;
  timer = setInterval(flush, 30_000);
  try { addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); }); } catch { /* not in a page */ }
}

export const usage = {
  /** Called every few seconds while a Live session is open (seconds = 0 when none). */
  liveTick(seconds, newSession) { start(); if (seconds > 0) pendingSeconds += seconds; if (newSession) pendingSessions++; },
  tool(name) { start(); const n = String(name || '').slice(0, 40); if (/^[A-Za-z0-9_.:-]+$/.test(n)) pendingTools[n] = Math.min(500, (pendingTools[n] || 0) + 1); },
  /** The real limit Groq reported in its response headers (kept on this device only). */
  quota(api, q) { try { const j = JSON.parse(localStorage.getItem(QUOTA_KEY) || '{}'); j[api] = { ...q, at: new Date().toISOString() }; localStorage.setItem(QUOTA_KEY, JSON.stringify(j)); } catch { /* storage blocked */ } },
  groqQuota() { try { return JSON.parse(localStorage.getItem(QUOTA_KEY) || '{}').groq || null; } catch { return null; } },
  flush,
  /** The account's numbers from the server (cached for 30 s; force = read now). Listeners are told about every fresh reading. */
  async summary({ force = false } = {}) {
    if (!force && summary && Date.now() - summaryAt < 30_000) return summary;
    if (inflight) return inflight;
    inflight = (async () => {
      try { await flush(); const r = await fetch('/api/elvar/usage', { cache: 'no-store', headers: authHeaders() }); if (r.ok) { summary = await r.json(); summaryAt = Date.now(); for (const f of listeners) { try { f(summary); } catch { /* a listener must not break the others */ } } } }
      catch { /* offline: the last reading stays */ }
      finally { inflight = null; }
      return summary;
    })();
    return inflight;
  },
  onSummary(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  last: () => summary,
};
