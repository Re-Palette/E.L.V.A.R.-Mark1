// PKCE (RFC 7636), S256 only.
import crypto from 'node:crypto';

/** 64 URL-safe characters (the RFC allows 43 to 128). */
export const newVerifier = () => crypto.randomBytes(48).toString('base64url');
export const challengeS256 = (verifier) => crypto.createHash('sha256').update(String(verifier)).digest('base64url');
