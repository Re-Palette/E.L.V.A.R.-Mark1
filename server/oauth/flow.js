// Generic OAuth 2.0 authorization-code flow with PKCE for providers that need a client secret (Google with the user's OWN client: decision O2;
// MCP servers). Per user, on the platform (docs/ELVAR_MULTIUSER.md 8.3):
//
//   start()    [user]    random 32-byte `state`; the pending flow (client id/secret, PKCE verifier, redirect URI, scopes) is sealed under a key derived
//                        from `state` itself and stored in the user's own row of app.oauth_pending under sha256(state), TTL 10 minutes. The database never
//                        sees `state`, so a leaked database alone cannot read a pending flow.
//   callback() [state]   the browser comes back from the provider WITHOUT any token. The platform finds the row by the hash of the state
//                        (system.oauthPendingOwner), and from then on acts AS the user who started it (server/oauth/pending.js). The flow is taken exactly
//                        once (started -> exchanging, one atomic update), the code is exchanged for tokens on the server (the client secret never reaches
//                        the browser) and the result is written back into the same row.
//   claim()    [user]    the signed-in user presents the same `state`; only their own rows are visible, so nobody else can take the result.
//                        The caller stores the tokens (sealed under the user's DEK) and discards the record.
// Codes, tokens and secrets are never logged.
//
// `pending` is the small interface of server/oauth/pending.js: { put, begin, settle, get, take } for ONE user.
import crypto from 'node:crypto';
import { sealBytes, openBytes, hkdf } from '../crypto/envelope.js';
import { newVerifier, challengeS256 } from './pkce.js';
import { bindOk } from './browser-bind.js';

export const PENDING_TTL = 600;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const aadOf = (hash) => `elvar:oauth-pending:v2|${hash.toString('hex')}`;
const stateKey = (state) => hkdf(Buffer.from(String(state)), Buffer.alloc(0), 'elvar-oauth-pending-v2');
export const STATE_RE = /^[A-Za-z0-9_-]{43}$/;
export const stateHashOf = (state) => sha(state);
/** iv (12 bytes) || ciphertext+tag: raw bytes, so a long token still fits the 8 KB column */
const pack = (state, obj) => { const r = sealBytes(stateKey(state), JSON.stringify(obj), aadOf(sha(state))); return Buffer.concat([r.iv, r.ct]); };
function unpack(state, sealed) {
  try { const b = Buffer.from(sealed); return JSON.parse(openBytes(stateKey(state), { iv: b.subarray(0, 12), ct: b.subarray(12) }, aadOf(sha(state))).toString()); } catch { return null; }
}

/**
 * @param {object} o  pending (the user's), provider, authUrl, tokenUrl, clientId, clientSecret, redirectUri, scopes[], params? (extra authorize parameters), tokenParams?, requireRefresh?, meta?
 * @returns {{url:string, state:string, pendingId:string, expiresInSec:number}}
 */
export async function startFlow({ bind = null, pending, provider, authUrl, tokenUrl, clientId, clientSecret, redirectUri, scopes, params = {}, tokenParams = {}, requireRefresh = true, meta = null, now = Date.now() }) {
  const state = crypto.randomBytes(32).toString('base64url'), verifier = newVerifier();
  await pending.put({ stateHash: sha(state), provider, sealed: pack(state, { v: 2, phase: 'started', provider, redirectUri, clientId, clientSecret, tokenUrl, verifier, scopes, tokenParams, requireRefresh, meta, nonceHash: bind?.nonceHash, who: bind?.who, exp: now + PENDING_TTL * 1000 }), ttl: PENDING_TTL });
  const url = authUrl + '?' + new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '), state,
    code_challenge: challengeS256(verifier), code_challenge_method: 'S256', ...params,
  });
  return { url, state, pendingId: sha(state).toString('hex'), expiresInSec: PENDING_TTL };
}

const short = (s, n = 200) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);

/**
 * The browser's return from the provider. `openPending(stateHash)` answers the pending interface of the user who owns that state (or null).
 * @returns {Promise<{ok:boolean, reason?:string, error?:string, provider?:string}>}
 * reason: 'bad_state' | 'unknown_state' (never started, expired or already claimed) | 'used' | 'denied' | 'exchange_failed' | 'no_refresh_token' | 'network'
 */
export async function handleCallback({ openPending, expectProvider, tokenUrl = null, cookieNonce = '', confirmed = false, state, code, error, fetchImpl = fetch, now = Date.now() }) {
  // The callback names the kind of flow it serves ('google' | 'mcp'); a state of another kind is "unknown" and is NOT consumed (the lookup, the single-use
  // update and the stored token URL all depend on it). `tokenUrl` pins the exchange endpoint (Google: always Google's); otherwise the URL sealed at start is used,
  // which for an MCP flow came from the server's own metadata - its fetchImpl must be the one that refuses private addresses (safeFetchAsFetch).
  if (expectProvider !== 'google' && expectProvider !== 'mcp') throw new Error('handleCallback: expectProvider is required');
  if (!STATE_RE.test(String(state || ''))) return { ok: false, reason: 'bad_state' };
  const hash = sha(state), pending = await openPending(hash);
  if (!pending) return { ok: false, reason: 'unknown_state' };
  // Is this the browser that started the flow? Peek first: a callback that must wait for the user's click may not consume the flow.
  const peek = await pending.get(hash);
  if (peek && peek.phase === 'started') { const p0 = unpack(state, peek.sealed); if (p0 && p0.provider === expectProvider && !bindOk(p0, { cookieNonce, confirmed })) return { ok: false, reason: 'confirm_required', who: p0.who || '', provider: p0.provider }; }
  // single use: only the first callback for this state may continue (two parallel callbacks cannot both exchange the code)
  const sealed = await pending.begin(hash, expectProvider);
  if (!sealed) return { ok: false, reason: (await pending.get(hash)) ? 'used' : 'unknown_state' };
  const p = unpack(state, sealed);
  if (!p || !(p.exp > now) || p.provider !== expectProvider) { await pending.take(hash).catch(() => {}); return { ok: false, reason: 'unknown_state' }; }
  const settle = (patch, phase) => pending.settle(hash, { sealed: pack(state, { ...p, clientSecret: undefined, verifier: undefined, ...patch }), phase });
  if (error || !code) { await settle({ phase: 'error', error: short(error || 'no_code', 60) }, 'error'); return { ok: false, reason: 'denied', error: short(error || 'no_code', 60), provider: p.provider }; }
  let j = {};
  try {
    const r = await fetchImpl(tokenUrl || p.tokenUrl, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: String(code), client_id: p.clientId, ...(p.clientSecret ? { client_secret: p.clientSecret } : {}), redirect_uri: p.redirectUri, grant_type: 'authorization_code', code_verifier: p.verifier, ...(p.tokenParams || {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    j = await r.json().catch(() => ({}));
    if (!r.ok) { await settle({ phase: 'error', error: short(j.error || r.status, 60), description: short(j.error_description) }, 'error'); return { ok: false, reason: 'exchange_failed', error: short(j.error || r.status, 60), provider: p.provider }; }
  } catch {
    await settle({ phase: 'error', error: 'network' }, 'error');
    return { ok: false, reason: 'network', provider: p.provider };
  }
  if (!j.refresh_token && p.requireRefresh !== false) { await settle({ phase: 'error', error: 'no_refresh_token' }, 'error'); return { ok: false, reason: 'no_refresh_token', provider: p.provider }; }
  await settle({ phase: 'done', tokens: { refresh_token: j.refresh_token || '', access_token: j.access_token || '', expires_in: Number(j.expires_in) || 3600, scope: short(j.scope, 2000) } }, 'done');
  return { ok: true, provider: p.provider };
}

export const discardPending = (pending, state) => (STATE_RE.test(String(state || '')) ? pending.take(sha(state)).then((x) => Boolean(x)) : Promise.resolve(false));

/**
 * The signed-in user takes the result. The record stays until the caller has stored the tokens and calls discardPending().
 * `pending` belongs to the signed-in user: another user's flow is simply not there.
 * @returns {Promise<{status:'missing'}|{status:'pending'}|{status:'error', error:string, description?:string}|{status:'ok', provider:string, tokens:object, scopes:string[], clientId:string, redirectUri:string}>}
 */
export async function claimFlow({ pending, state, now = Date.now() }) {
  if (!STATE_RE.test(String(state || ''))) return { status: 'missing' };
  const rec = await pending.get(sha(state));
  if (!rec) return { status: 'missing' };
  if (rec.phase === 'started' || rec.phase === 'exchanging') return { status: 'pending' };
  const p = unpack(state, rec.sealed);
  if (!p || !(p.exp > now)) return { status: 'missing' };
  if (p.phase === 'error') { await discardPending(pending, state); return { status: 'error', error: p.error || 'error', description: p.description || '' }; }
  if (p.phase !== 'done' || !(p.tokens?.refresh_token || (p.requireRefresh === false && p.tokens?.access_token))) return { status: 'missing' };
  return { status: 'ok', provider: p.provider, tokens: p.tokens, scopes: p.scopes || [], clientId: p.clientId, redirectUri: p.redirectUri, tokenUrl: p.tokenUrl, meta: p.meta || null };
}
