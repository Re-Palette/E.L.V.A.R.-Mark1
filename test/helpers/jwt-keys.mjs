// Locally generated signing keys for the JWT tests: a stand-in for the Supabase project's JWKS. Nothing here is a real key.
import crypto from 'node:crypto';
import * as jose from 'jose';

export const SUPABASE_URL = 'https://abcdefgh.supabase.test';
export const ISSUER = `${SUPABASE_URL}/auth/v1`;

export async function makeKey(kid = 'key-' + crypto.randomBytes(3).toString('hex'), alg = 'ES256') {
  const { publicKey, privateKey } = await jose.generateKeyPair(alg, { extractable: true });
  const jwk = { ...(await jose.exportJWK(publicKey)), kid, alg, use: 'sig' };
  return { kid, alg, publicKey, privateKey, jwk };
}
export const jwksOf = (...keys) => ({ keys: keys.map((k) => k.jwk) });

/** A signed access token with Supabase-shaped claims; override anything (a claim set to undefined is removed). */
export async function signToken(key, claims = {}, { exp = '1h', iat, header = {}, issuer = ISSUER, audience = 'authenticated', alg } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { role: 'authenticated', email: 'user@example.test', aal: 'aal1', session_id: crypto.randomUUID(), sub: crypto.randomUUID(), ...claims };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  let jwt = new jose.SignJWT(body).setProtectedHeader({ alg: alg || key.alg, kid: key.kid, ...header });
  if (issuer) jwt = jwt.setIssuer(issuer);
  if (audience) jwt = jwt.setAudience(audience);
  jwt = jwt.setIssuedAt(iat ?? now);
  if (exp !== null) jwt = jwt.setExpirationTime(exp);
  return jwt.sign(key.privateKey);
}
