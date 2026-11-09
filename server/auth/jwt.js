// Supabase access-token verification (docs/ELVAR_MULTIUSER.md section 2.2). Asymmetric signatures only, checked against the project's JWKS,
// which is fetched once and cached in the instance (a token never costs a network round trip; an unknown key id triggers one refetch, at most
// every 30 s). A token must carry: a valid signature (ES256 or RS256, never HS256), issuer <SUPABASE_URL>/auth/v1, audience "authenticated",
// a not-expired exp, role "authenticated", a uuid sub, and must not be anonymous.
import { jwtVerify, createRemoteJWKSet, errors } from 'jose';
import { mintVerifiedUid, isUuid } from '../db/verified-uid.js';

export class AuthError extends Error {
  constructor(code, status = 401) { super(code); this.name = 'AuthError'; this.code = code; this.status = status; }
}
const ALGS = ['ES256', 'RS256'];

/** Supabase URL -> { issuer, jwksUrl }. https only (loopback may use http for a local Supabase). */
export function supabaseEndpoints(supabaseUrl) {
  let u; try { u = new URL(String(supabaseUrl || '')); } catch { throw new AuthError('auth_unconfigured', 503); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new AuthError('auth_unconfigured', 503);
  const base = u.origin + u.pathname.replace(/\/+$/, '');
  return { issuer: `${base}/auth/v1`, jwksUrl: new URL(`${base}/auth/v1/.well-known/jwks.json`) };
}

const classify = (e) => {
  if (e instanceof AuthError) return e;
  if (e instanceof errors.JWTExpired) return new AuthError('token_expired');
  // Could not get the keys (network, timeout, a non-200 answer): not the caller's fault, and never "accepted".
  if (e instanceof errors.JWKSTimeout || !(e instanceof errors.JOSEError) || e?.code === 'ERR_JOSE_GENERIC') return new AuthError('auth_unavailable', 503);
  return new AuthError('invalid_token');
};

/**
 * @param {{ supabaseUrl?: string, getKey?: Function, clockToleranceSec?: number, cacheMs?: number, cooldownMs?: number }} o
 *   getKey: a jose key resolver. Default: the remote JWKS of the project. Tests pass createLocalJWKSet(...) with locally generated keys.
 */
export function createJwtVerifier({ supabaseUrl, getKey, clockToleranceSec = 5, cacheMs = 10 * 60_000, cooldownMs = 30_000 } = {}) {
  const { issuer, jwksUrl } = supabaseEndpoints(supabaseUrl);
  const keys = getKey || createRemoteJWKSet(jwksUrl, { cacheMaxAge: cacheMs, cooldownDuration: cooldownMs, timeoutDuration: 5000 });
  /** @returns {Promise<{uid: object, email: string|null, role: 'user'|'admin', iat: number, exp: number, aal: string|null, sessionId: string|null}>} uid is a VerifiedUid */
  return async function verifyAccessToken(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 8192 || token.split('.').length !== 3) throw new AuthError('invalid_token');
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, { issuer, audience: 'authenticated', algorithms: ALGS, clockTolerance: clockToleranceSec, requiredClaims: ['sub', 'exp', 'iat'] }));
    } catch (e) { throw classify(e); }
    if (payload.role !== 'authenticated' || payload.is_anonymous === true || !isUuid(payload.sub)) throw new AuthError('invalid_token');
    const admin = payload.app_metadata?.elvar_role === 'admin';   // app_metadata can only be written with the service key, never by the user
    return {
      uid: mintVerifiedUid(payload.sub, 'jwt'),
      email: typeof payload.email === 'string' ? payload.email : null,
      role: admin ? 'admin' : 'user',
      iat: payload.iat, exp: payload.exp,
      aal: typeof payload.aal === 'string' ? payload.aal : null,
      sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
    };
  };
}

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerFrom(req) {
  const h = String(req?.headers?.authorization || '');
  const m = /^Bearer[ \t]+([A-Za-z0-9._~+/=-]+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

// One verifier per Supabase URL for the process (the JWKS cache lives in it).
const verifiers = new Map();
let override = null;
export function getVerifier(env = process.env) {
  if (override) return override;
  const url = String(env.SUPABASE_URL || ''); if (!url) throw new AuthError('auth_unconfigured', 503);
  if (!verifiers.has(url)) verifiers.set(url, createJwtVerifier({ supabaseUrl: url }));
  return verifiers.get(url);
}
/** Tests: use this verifier (a function(token)) instead of the project's. Pass null to restore. */
export function _setVerifierForTests(fn) { override = fn; }
export const _clearVerifiers = () => verifiers.clear();
