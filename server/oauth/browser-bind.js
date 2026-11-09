// Binding an OAuth flow to the BROWSER that finishes it (review fix). The flow is bound to the account that started it, but the consent link can be sent to
// somebody else: if a victim approves an attacker's link, the victim's tokens would land in the attacker's account. So:
//   * web: at start the server sets an HttpOnly, SameSite=Lax cookie holding a random nonce (only its hash is kept in the sealed flow). The callback is a top-level
//     GET, so the cookie comes along only in the browser that started the flow. No cookie (or another nonce) = a different browser.
//   * where cookies cannot work (the Android Custom Tab, the desktop's external browser start the flow in the app but finish it elsewhere), and for any
//     different browser: the callback does NOT exchange the code. It shows the masked e-mail of the E.L.V.A.R. account that would receive the login and needs a click.
// The nonce is never put in a URL and never logged.
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
export const maskEmail = (e) => { const m = /^([^@]{1,320})@(.{1,255})$/.exec(String(e || '')); return m ? `${[...m[1]][0]}***@${m[2]}` : '（不明）'; };
export const newBind = (email) => { const nonce = crypto.randomBytes(24).toString('base64url'); return { nonce, bind: { nonceHash: sha(nonce).toString('hex'), who: maskEmail(email) } }; };
export const cookieName = (state) => 'eo_' + sha('cookie|' + state).toString('hex').slice(0, 12);
export const bindCookie = (state, nonce, { secure = true } = {}) => `${cookieName(state)}=${nonce}; HttpOnly; SameSite=Lax; Path=/api; Max-Age=600${secure ? '; Secure' : ''}`;
export function nonceFromReq(req, state) {
  const want = cookieName(state);
  for (const part of String(req?.headers?.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === want) return part.slice(i + 1).trim(); }
  return '';
}
/** @returns {boolean} true when the flow may continue in this browser */
export function bindOk(p, { cookieNonce = '', confirmed = false } = {}) {
  if (!p?.nonceHash) return true;   // a flow started before binding existed
  if (confirmed) return true;       // the user looked at the account name and clicked
  return Boolean(cookieNonce) && crypto.timingSafeEqual(sha(cookieNonce), Buffer.from(p.nonceHash, 'hex'));
}
