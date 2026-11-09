// GET /api/elvar/state: public facts the sign-in / sign-up screens need before anybody is signed in. Nothing about any user.
import { VERSION } from '../version.js';
import { dbConfigured, dbKind, getDb } from '../db/index.js';
import { devAuthEnabled } from '../dev/dev-auth-guard.js';

export function platformState(env = process.env, dbMode = null) {
  const dev = devAuthEnabled(env);
  const mode = String(dbMode || env.ELVAR_SIGNUP || 'open').toLowerCase();   // the database (app.platform_config, what the Auth hook enforces) wins; ELVAR_SIGNUP only where there is no database to ask
  return {
    signup: ['open', 'invite', 'closed'].includes(mode) ? mode : 'open',
    captchaSiteKey: dev ? (env.ELVAR_DEV_CAPTCHA === '1' ? 'dev-captcha' : '') : String(env.ELVAR_TURNSTILE_SITE_KEY || ''),
    supabaseUrl: dev ? '/dev-supabase' : String(env.SUPABASE_URL || '').replace(/\/+$/, ''),
    publishableKey: dev ? 'dev-publishable-key' : String(env.SUPABASE_PUBLISHABLE_KEY || ''),
    googleSignIn: true,
    configured: dev || Boolean(env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY && dbConfigured(env)),
    devAuth: dev,
    version: VERSION,
  };
}
let cached = { at: 0, mode: null };
/** The policy as the Auth hook sees it (cached 30 s). A database that cannot answer falls back to the environment value. */
async function signupModeFromDb(env, now) {
  if (dbKind(env) !== 'pg') return null;
  if (now - cached.at < 30_000) return cached.mode;
  try { cached = { at: now, mode: await (await getDb(env)).system.signupMode() }; } catch { cached = { at: now - 25_000, mode: cached.mode }; }
  return cached.mode;
}
export const _resetSignupCache = () => { cached = { at: 0, mode: null }; };
export async function getState() { return { status: 200, body: platformState(process.env, await signupModeFromDb(process.env, Date.now())) }; }
