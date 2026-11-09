// Device tokens for the Android background notification sync (docs/ELVAR_MULTIUSER.md 2.3): "elv2.<deviceId 16 hex>.<secret 43 base64url>".
// Per user, limited to the scopes in app.devices.scopes, usable on /api/notif only. The server stores sha256(secret) and nothing else.
import crypto from 'node:crypto';

const TOKEN_RE = /^elv2\.([0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;
export const hashSecret = (secret) => crypto.createHash('sha256').update(String(secret)).digest();

/** @returns {{deviceId:string, secret:string, token:string, hash:Buffer}} the token is shown to the user once; store `hash` and `deviceId` */
export function newDeviceToken() {
  const deviceId = crypto.randomBytes(8).toString('hex'), secret = crypto.randomBytes(32).toString('base64url');
  return { deviceId, secret, token: `elv2.${deviceId}.${secret}`, hash: hashSecret(secret) };
}
export function parseDeviceToken(token) {
  const m = TOKEN_RE.exec(String(token || ''));
  return m ? { deviceId: m[1], secret: m[2], hash: hashSecret(m[2]) } : null;
}
/** The token from x-elvar-token (what the Android sync already sends) or `Authorization: Bearer`. */
export function deviceTokenFrom(req) {
  const h = req?.headers || {};
  const raw = h['x-elvar-token'] || (/^Bearer[ \t]+(\S+)$/i.exec(String(h.authorization || '').trim()) || [])[1];
  return typeof raw === 'string' && raw.startsWith('elv2.') ? raw : null;
}
