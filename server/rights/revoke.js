// Revoking what a user connected elsewhere (docs/ELVAR_MULTIUSER.md 7.4 step 1): the Google refresh token at Google, an MCP connector's token at its
// authorization server when it published a revocation endpoint. Used when the user disconnects and when their account is deleted. Best effort: a provider
// that cannot be reached must not keep the user's data (their tokens become unreadable when their key is shredded right after).
//   revokeAll(db, vuid, { fetchImpl })   opens the user's tokens (their DEK), revokes each one, returns { google, connectors, failed }
import { getKeyring } from '../auth/keyring.js';
import { safeFetch } from '../net/safe-fetch.js';

export const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
const TIMEOUT = 10_000;

/** One token. google -> plain fetch to Google (or the mock origin of the dev stack / tests); an MCP connector -> safeFetch to the URL its server published. @returns {Promise<boolean>} */
export async function revokeToken({ provider, data, revokeUrl }, { fetchImpl = null, googleUrl = GOOGLE_REVOKE } = {}) {
  try {
    if (provider === 'google') {
      if (!data?.refreshToken) return false;
      const url = googleUrl || revokeUrl || GOOGLE_REVOKE, f = fetchImpl || globalThis.fetch;
      const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: data.refreshToken }), signal: AbortSignal.timeout(TIMEOUT) });
      return Boolean(r.ok);
    }
    const token = data?.refresh_token || data?.access_token;
    if (!token || !revokeUrl) return false;
    const body = new URLSearchParams({ token, token_type_hint: data.refresh_token ? 'refresh_token' : 'access_token', ...(data.clientId ? { client_id: data.clientId } : {}), ...(data.clientSecret ? { client_secret: data.clientSecret } : {}) }).toString();
    const r = fetchImpl ? await fetchImpl(revokeUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(TIMEOUT) })
      : await safeFetch(revokeUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, timeoutMs: TIMEOUT, maxBytes: 8192 });
    return Boolean(r.ok);
  } catch { return false; }
}

/** The mock origin only the local dev stack may use (never in production): same rule as server/google/config.js. */
const devGoogleUrl = (e = process.env) => (e.ELVAR_DEV_AUTH === '1' && !e.VERCEL && e.NODE_ENV !== 'production' && e.GOOGLE_API_MOCK_ORIGIN ? `${e.GOOGLE_API_MOCK_ORIGIN}/revoke` : GOOGLE_REVOKE);

/**
 * Revoke every token of the user. Runs BEFORE their key is shredded (the tokens are opened with it).
 * @param {{asUser:Function}} db  @param {object} vuid  @returns {Promise<{google:boolean|null, connectors:number, failed:number}>}
 */
export async function revokeAll(db, vuid, { fetchImpl = null } = {}) {
  const toks = await db.asUser(vuid, (r) => getKeyring().allTokens(r));
  let google = null, connectors = 0, failed = 0;
  for (const t of toks) {
    const ok = await revokeToken(t, { fetchImpl, googleUrl: fetchImpl ? t.revokeUrl || GOOGLE_REVOKE : devGoogleUrl() });
    if (t.provider === 'google') google = ok; else if (ok) connectors++;
    if (!ok) failed++;
  }
  return { google, connectors, failed };
}
