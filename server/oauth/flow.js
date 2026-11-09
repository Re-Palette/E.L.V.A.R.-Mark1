// Generic OAuth 2.0 authorization-code flow with PKCE for providers that need a client secret (docs/ELVAR_ARCHITECTURE.md 4.1).
//
//   start()    [owner]   random 32-byte `state`; the pending flow (client id/secret, PKCE verifier, redirect URI, scopes) is stored ENCRYPTED under a key
//                        derived from `state` itself, at `elvar:v1:pending:<sha256(state)>`, TTL 10 minutes. The store never sees `state`.
//   callback() [state]   the browser comes back from the provider WITHOUT any device token, so nothing owner-side can be used here. The state is looked up,
//                        used at most once (a SET NX latch), the code is exchanged for tokens on the server (the client secret never reaches the
//                        browser), and the result is written back into the same pending record.
//   claim()    [owner]   the signed-in app presents the same `state`, takes the tokens out and (the caller) stores them in the vault; the record is
//                        then deleted. A leaked Redis alone cannot read a pending flow: it needs the state, which only exists in the authorize URL.
// Codes, tokens and secrets are never logged.
import crypto from 'node:crypto';
import { seal, open, hkdf } from '../crypto/envelope.js';
import { newVerifier, challengeS256 } from './pkce.js';

export const PENDING_TTL = 600;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const pendingKey = (state) => `elvar:v1:pending:${sha(state)}`;
const latchKey = (state) => `elvar:v1:pendinglock:${sha(state)}`;
const stateKey = (state) => hkdf(Buffer.from(String(state)), Buffer.alloc(0), 'elvar-oauth-pending-v1');
export const STATE_RE = /^[A-Za-z0-9_-]{43}$/;

async function writePending(store, state, obj, ttlSec = PENDING_TTL) {
  const key = pendingKey(state);
  await store.set(key, seal(stateKey(state), JSON.stringify(obj), key), { ttlSec });
}
async function readPending(store, state, now = Date.now()) {
  if (!STATE_RE.test(String(state || ''))) return null;
  const key = pendingKey(state), rec = await store.get(key);
  if (!rec) return null;
  try {
    const p = JSON.parse(open(stateKey(state), rec, key).toString());
    return p && p.exp > now ? p : null;
  } catch { return null; }
}
export const discardPending = (store, state) => (STATE_RE.test(String(state || '')) ? store.del(pendingKey(state)) : Promise.resolve(false));

/**
 * @param {object} o  store, provider, authUrl, tokenUrl, clientId, clientSecret, redirectUri, scopes[], createdBy?, params? (extra authorize parameters)
 * @returns {{url:string, state:string, pendingId:string, expiresInSec:number}}
 */
export async function startFlow({ store, provider, authUrl, tokenUrl, clientId, clientSecret, redirectUri, scopes, createdBy = null, params = {}, tokenParams = {}, requireRefresh = true, meta = null, now = Date.now() }) {
  const state = crypto.randomBytes(32).toString('base64url'), verifier = newVerifier();
  await writePending(store, state, { v: 1, phase: 'started', provider, redirectUri, clientId, clientSecret, tokenUrl, verifier, scopes, createdBy, tokenParams, requireRefresh, meta, exp: now + PENDING_TTL * 1000 });
  const url = authUrl + '?' + new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '), state,
    code_challenge: challengeS256(verifier), code_challenge_method: 'S256', ...params,
  });
  return { url, state, pendingId: sha(state), expiresInSec: PENDING_TTL };
}

const short = (s, n = 200) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);

/**
 * The browser's return from the provider. @returns {Promise<{ok:boolean, reason?:string, error?:string, provider?:string}>}
 * reason: 'bad_state' | 'unknown_state' (never started, expired or already claimed) | 'used' | 'denied' | 'exchange_failed' | 'no_refresh_token' | 'network'
 */
export async function handleCallback({ store, state, code, error, fetchImpl = fetch, now = Date.now() }) {
  if (!STATE_RE.test(String(state || ''))) return { ok: false, reason: 'bad_state' };
  const p = await readPending(store, state, now);
  if (!p) return { ok: false, reason: 'unknown_state' };
  if (p.phase !== 'started') return { ok: false, reason: 'used' };
  // single use: only the first callback for this state may continue (two parallel callbacks cannot both exchange the code)
  if (!(await store.set(latchKey(state), 1, { nx: true, ttlSec: PENDING_TTL }))) return { ok: false, reason: 'used' };
  const settle = (patch) => writePending(store, state, { ...p, clientSecret: undefined, verifier: undefined, ...patch });
  if (error || !code) { await settle({ phase: 'error', error: short(error || 'no_code', 60) }); return { ok: false, reason: 'denied', error: short(error || 'no_code', 60), provider: p.provider }; }
  let j = {};
  try {
    const r = await fetchImpl(p.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: String(code), client_id: p.clientId, ...(p.clientSecret ? { client_secret: p.clientSecret } : {}), redirect_uri: p.redirectUri, grant_type: 'authorization_code', code_verifier: p.verifier, ...(p.tokenParams || {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    j = await r.json().catch(() => ({}));
    if (!r.ok) { await settle({ phase: 'error', error: short(j.error || r.status, 60), description: short(j.error_description) }); return { ok: false, reason: 'exchange_failed', error: short(j.error || r.status, 60), provider: p.provider }; }
  } catch {
    await settle({ phase: 'error', error: 'network' });
    return { ok: false, reason: 'network', provider: p.provider };
  }
  if (!j.refresh_token && p.requireRefresh !== false) { await settle({ phase: 'error', error: 'no_refresh_token' }); return { ok: false, reason: 'no_refresh_token', provider: p.provider }; }
  await settle({ phase: 'done', tokens: { refresh_token: j.refresh_token || '', access_token: j.access_token || '', expires_in: Number(j.expires_in) || 3600, scope: short(j.scope, 2000) } });
  return { ok: true, provider: p.provider };
}

/**
 * The signed-in app takes the result. The record stays until the caller has stored the tokens and calls discardPending().
 * @returns {Promise<{status:'missing'}|{status:'pending'}|{status:'error', error:string, description?:string}|{status:'ok', provider:string, tokens:object, scopes:string[], clientId:string, redirectUri:string}>}
 */
export async function claimFlow({ store, state, now = Date.now() }) {
  const p = await readPending(store, state, now);
  if (!p) return { status: 'missing' };
  if (p.phase === 'started') return { status: 'pending' };
  if (p.phase === 'error') { await discardPending(store, state); return { status: 'error', error: p.error || 'error', description: p.description || '' }; }
  if (p.phase !== 'done' || !(p.tokens?.refresh_token || (p.requireRefresh === false && p.tokens?.access_token))) return { status: 'missing' };
  return { status: 'ok', provider: p.provider, tokens: p.tokens, scopes: p.scopes || [], clientId: p.clientId, redirectUri: p.redirectUri, tokenUrl: p.tokenUrl, meta: p.meta || null };
}
