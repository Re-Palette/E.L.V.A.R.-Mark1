// The local development login (a fake Auth issuer, server/dev/fake-auth.js) must be impossible to enable in production. This module is the only gate:
// it needs ALL of: ELVAR_DEV_AUTH=1, ELVAR_DB=memory (no real database at all), no Vercel, no NODE_ENV=production, and no Postgres URL.
// It is also checked when the issuer starts and when the local server binds to an address (server/index.js refuses non-loopback binds in dev auth).
// Importing it has no side effects (the state endpoint uses it).
export function devAuthEnabled(env = process.env) {
  return env.ELVAR_DEV_AUTH === '1' && env.ELVAR_DB === 'memory' && !env.VERCEL && env.NODE_ENV !== 'production' && !env.ELVAR_DB_URL;
}
export function assertDevAuthAllowed(env = process.env) {
  if (!devAuthEnabled(env)) throw new Error('the dev auth issuer needs ELVAR_DEV_AUTH=1 and ELVAR_DB=memory, and is refused on Vercel, in production, or with a database URL');
}
export const isLoopbackHost = (h) => ['127.0.0.1', '::1', 'localhost', '[::1]'].includes(String(h));
