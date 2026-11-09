// A small harness for tests of the real route table: MemoryDb, locally signed access tokens, the router, stubs for the calls the server makes to Supabase
// Auth (token freshness, global sign-out, admin ban / delete / claim) so no network is needed.
import crypto from 'node:crypto';
import * as jose from 'jose';
import { getDb, resetDb } from '../../server/db/index.js';
import { createJwtVerifier, _setVerifierForTests } from '../../server/auth/jwt.js';
import { _clearAccountCache, _setAuthFetch } from '../../server/auth/with-user.js';
import { _clearUserConfigCache } from '../../server/auth/load-user-config.js';
import { routeElvar } from '../../server/router.js';
import { _setServiceFetch } from '../../server/db/service.js';
import { makeKey, jwksOf, signToken, SUPABASE_URL } from './jwt-keys.mjs';

const key = await makeKey('harness');
const verifier = createJwtVerifier({ supabaseUrl: SUPABASE_URL, getKey: jose.createLocalJWKSet(jwksOf(key)) });
export { SUPABASE_URL };

export async function startHarness() {
  await resetDb(); _clearAccountCache(); _clearUserConfigCache(); _setVerifierForTests(verifier);
  const saved = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY, CRON_SECRET: process.env.CRON_SECRET };
  process.env.SUPABASE_URL = SUPABASE_URL; process.env.SUPABASE_PUBLISHABLE_KEY = 'pub-key'; process.env.SUPABASE_SECRET_KEY = 'service-key-for-tests'; process.env.CRON_SECRET = 'c'.repeat(32);
  const db = await getDb();
  const calls = [];   // what the server asked Supabase Auth to do
  const authFetch = async (url, init = {}) => {
    url = String(url); calls.push({ method: init.method || 'GET', url, auth: init.headers?.authorization, apikey: init.headers?.apikey, body: init.body ? JSON.parse(init.body) : undefined });
    const m = /\/auth\/v1\/(user|logout|admin\/users\/([0-9a-f-]{36}))/.exec(url);
    if (m?.[1] === 'user') { const who = harness.tokenOwner(init.headers?.authorization); return { ok: Boolean(who), status: who ? 200 : 401, json: async () => ({ id: who }), text: async () => '' }; }
    if (init.method === 'DELETE' && m?.[2]) db.testing.deleteUser(m[2]);   // the Auth admin API deletes the user: every row cascades
    return { ok: true, status: init.method === 'DELETE' && m?.[2] ? 200 : 204, text: async () => '', json: async () => ({}) };
  };
  _setAuthFetch(authFetch); _setServiceFetch(authFetch);
  const owners = new Map();   // token -> uid
  const harness = {
    db, calls, tokenOwner: (h) => owners.get(String(h || '').replace(/^Bearer /, '')) || null,
    mkUser: (email = null) => db.testing.newUser(crypto.randomUUID(), email),
    /** Authorization header for a user (fresh token by default; pass { iat } for an old one). */
    async bearer(uid, claims = {}, opts) { const t = await signToken(key, { sub: uid, ...claims }, opts); owners.set(t, uid); return { authorization: 'Bearer ' + t }; },
    async adminBearer(uid) { db.testing.makeAdmin(uid); return harness.bearer(uid, { app_metadata: { elvar_role: 'admin' } }); },
    /** call(method, path, headers, body, query) -> { status, body, headers?, html? } */
    call: (method, pathname, headers = {}, body = {}, query = {}) => routeElvar({ method, headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '203.0.113.7' } }, { pathname, body, query }),
    async stop() {
      _setVerifierForTests(null); _setAuthFetch(null); _setServiceFetch(null);
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await resetDb(); _clearAccountCache(); _clearUserConfigCache();
    },
  };
  return harness;
}
