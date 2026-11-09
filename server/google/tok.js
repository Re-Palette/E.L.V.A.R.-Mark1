// A refused Google refresh token (invalid_grant) is discovered deep inside a tool call: remember it so tools stop calling Google until the user connects
// again. The Google connection itself moves to the platform in P3 (docs/ELVAR_MULTIUSER.md 8.3: tokens in app.oauth_tokens, per user); until then nothing
// is connected, `markReauth` is only reached by code that holds a refresh token (none on the platform yet) and it keeps its flag in the test store only.
import crypto from 'node:crypto';
import { getStore } from '../store/index.js';

export const GSTATE_KEY = 'elvar:v1:gstate';
export const tokHash = (refreshToken) => crypto.createHash('sha256').update(String(refreshToken)).digest('hex');

export async function markReauth(refreshToken, reason = 'invalid_grant') {
  try {
    const store = getStore(); if (!store || !refreshToken) return;
    const h = tokHash(refreshToken), cur = await store.get(GSTATE_KEY);
    if (cur?.h === h && cur.status === 'reauth_required') return;
    await store.set(GSTATE_KEY, { h, status: 'reauth_required', reason: String(reason).slice(0, 40), at: Date.now() });
    console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event: 'google-reauth-required', reason }));
  } catch (e) { console.error('[elvar] could not record the Google reauth state:', e?.code || e?.message); }
}
