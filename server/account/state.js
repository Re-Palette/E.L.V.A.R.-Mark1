// GET /api/elvar/state: public facts the sign-in / sign-up screens need before anybody is signed in. Nothing about any user.
import { VERSION } from '../version.js';
import { dbConfigured } from '../db/index.js';
import { devAuthEnabled } from '../dev/dev-auth-guard.js';

export function platformState(env = process.env) {
  const dev = devAuthEnabled(env);
  const mode = String(env.ELVAR_SIGNUP || 'open').toLowerCase();
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
export const getState = () => ({ status: 200, body: platformState() });
