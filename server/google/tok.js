// The Google login kept in the vault: `elvar:v1:tok:google` = { refreshToken, scopes[], clientId, status:'connected'|'reauth_required', reason?, connectedAt, verifiedAt, reauthAt? }.
// Encrypted under the vault key like the rest; access tokens are NOT stored (they live in memory only, see http.js), so this record changes only when
// the owner connects / disconnects, on a failed refresh (invalid_grant) and when a status check succeeds.
import { getStore } from '../store/index.js';
import * as V from '../config/vault.js';
import { _clearWarmCache } from '../config/resolve.js';
import { TOK_KEY, GSTATE_KEY, loadLogin, tokHash } from './login-record.js';

export { TOK_KEY, GSTATE_KEY, loadLogin };

export async function readTok(store, dek) { return V.readRecord(store, dek, TOK_KEY); }

/** Read-modify-write with a retry on version conflicts. fn(current|null) returns the next record, or null to delete it. */
export async function updateTok(store, dek, fn) {
  for (let i = 0; i < 6; i++) {
    const cur = await readTok(store, dek);
    const next = fn(cur ? structuredClone(cur.data) : null);
    if (next === null) { await store.del(TOK_KEY); return null; }
    if (await V.writeRecord(store, dek, TOK_KEY, next, cur ? cur.ver : 0)) return next;
  }
  throw Object.assign(new Error('conflict'), { code: 'conflict', status: 409 });
}

/**
 * Other instances cache the decrypted doc (and this record) while meta.docVer is unchanged: bump it so they re-read at once.
 * (The doc carries a harmless counter, `googleRev`.)
 */
export async function bumpGoogleRev(store, dek) {
  await V.updateDoc(store, dek, (d) => { d.googleRev = (d.googleRev || 0) + 1; return d; });
  _clearWarmCache();
}

/** A refresh was refused (invalid_grant): remember it (a plain flag, no vault key needed) so the UI asks for a reconnect and tools stop calling Google. Best effort. */
export async function markReauth(refreshToken, reason = 'invalid_grant') {
  try {
    const store = getStore(); if (!store || !refreshToken) return;
    const h = tokHash(refreshToken), cur = await store.get(GSTATE_KEY);
    if (cur?.h === h && cur.status === 'reauth_required') return;
    await store.set(GSTATE_KEY, { h, status: 'reauth_required', reason: String(reason).slice(0, 40), at: Date.now() });
    _clearWarmCache();
    console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event: 'google-reauth-required', reason }));
  } catch (e) { console.error('[elvar] could not record the Google reauth state:', e?.code || e?.message); }
}
