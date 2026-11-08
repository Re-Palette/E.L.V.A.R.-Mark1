// Response headers for the web app (static files). The same values are in vercel.json (a test keeps them equal).
// CSP: only our own scripts (+ WebAssembly for MediaPipe), no inline scripts; Gemini Live (wss) and the MediaPipe model download are the only
// other hosts the browser talks to; nobody may frame the app (clickjacking).
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://generativelanguage.googleapis.com wss://generativelanguage.googleapis.com https://storage.googleapis.com",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const PAGE_HEADERS = {
  'content-security-policy': CSP,
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(self), microphone=(self), geolocation=()',
};
/** For every API response (JSON / the OAuth callback page has its own inline script, so no CSP here). */
export const API_HEADERS = { 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' };
