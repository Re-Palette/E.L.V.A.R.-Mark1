// Usage metering (docs/ELVAR_MULTIUSER.md 6.1): every call that costs the user quota is counted in the user's own app.usage_daily through
// app.record_usage. Always awaited by the caller (the request's identity is not available after the response), never throws, never blocks on failure.
import { currentConfig } from './config/resolve.js';

/** @param {string} provider 'gemini' | 'groq' | ...   @param {string} metric 'calls' | 'input_tokens' | 'output_tokens' | 'live_sessions' | 'live_seconds' */
export async function recordUsage(provider, metric, amount = 1, source = 'server') {
  const c = currentConfig();
  if (typeof c.record !== 'function' || !(amount >= 0)) return;
  try { await c.record(provider, metric, amount, source); } catch (e) { console.error('[elvar] usage not recorded:', e?.code || e?.message); }
}

/** Gemini's usageMetadata -> calls + tokens. */
export async function recordGemini(json) {
  await recordUsage('gemini', 'calls', 1);
  const u = json?.usageMetadata;
  if (u?.promptTokenCount) await recordUsage('gemini', 'input_tokens', Number(u.promptTokenCount) || 0);
  if (u?.candidatesTokenCount) await recordUsage('gemini', 'output_tokens', Number(u.candidatesTokenCount) || 0);
}
