// Configuration access. `env(name)` is the synchronous accessor used all over server/; AsyncLocalStorage carries the request's cfg through awaits.
//
// A request made by a signed-in user (or by cron) always runs inside a STRICT cfg (server/auth/user-config.js, server/auth/load-user-config.js):
// the user's own settings, secrets and profile first, then only the platform defaults the ledger allows (keys.js `platform: true`). Outside any
// request (scripts, tests) `env()` reads process.env as before. There is no owner mode any more (O8).
import { AsyncLocalStorage } from 'node:async_hooks';
import { DEFAULT_PROFILE, mergeProfile } from '../profile/defaults.js';
import { KEYS, keyInfo, isSecret, isPlatformDefault } from './keys.js';

const als = new AsyncLocalStorage();

// ELVAR_PROFILE (one line of JSON) is a scripts-and-tests convenience for code that runs OUTSIDE a request. A signed-in user's request never sees it:
// their cfg carries their own profile (server/auth/load-user-config.js).
function envProfile() {
  const raw = process.env.ELVAR_PROFILE;
  if (!raw) return DEFAULT_PROFILE;
  try { return mergeProfile(JSON.parse(raw)); } catch { return DEFAULT_PROFILE; }
}

/** cfg: { get(name), source(name), secretStatus(), profile, connectors, features, version, auth } for code that runs outside a request. */
export function envConfig(auth = { mode: 'env' }) {
  return {
    get profile() { return envProfile(); },
    get features() { return envProfile().features || {}; },
    get: (name) => process.env[name],
    source: (name) => (process.env[name] ? 'env' : 'default'),
    secretStatus: () => secretStatus((n) => process.env[n], () => 'env'),
    connectors: [], version: 0, google: null, cxSecret: () => '',
    auth: { mode: auth.mode, deviceId: auth.deviceId },
  };
}

const last4 = (v) => (typeof v === 'string' && v.length >= 8 ? v.slice(-4) : null);
export function secretStatus(get, source) {
  const out = {};
  for (const k of KEYS) if (k.kind === 'secret') { const v = get(k.name); out[k.name] = { set: Boolean(v), source: v ? source(k.name) : 'default', last4: v ? last4(String(v)) : null }; }
  return out;
}

// Settings that live in the profile (the profile wins over a setting of the same name).
export const FROM_PROFILE = {
  GEMINI_LIVE_VOICE: (p) => p.assistant.voice,
  GEMINI_LIVE_INPUT_LANGS: (p) => p.locale.inputLangs.join(','),
  GOOGLE_TIMEZONE: (p) => p.locale.timeZone,
  WEATHER_PLACE: (p) => p.home.city,
};
export const PROFILE_KEYS = Object.keys(FROM_PROFILE);

export const runWithConfig = (cfg, fn) => als.run(cfg, fn);
/** Tests only: make `cfg` the configuration of the current async context (and everything it starts), e.g. a test file's whole run. */
export const _enterConfigForTests = (cfg) => als.enterWith(cfg);
export const currentConfig = () => als.getStore() || envConfig();

/** Synchronous accessor: cfg.get(name) -> (outside a request: process.env) -> undefined. In a user or cron request only platform defaults come from the environment. */
export function env(name) {
  const cfg = currentConfig();
  const v = cfg.get(name);
  if (v !== undefined && v !== null) return v;
  if (cfg.strictUser && !isPlatformDefault(name)) return undefined;   // M5: a user's API keys, personal settings and infrastructure never come from the platform environment
  return process.env[name];
}

/** An env-shaped object backed by env(); for `fn(env = process.env)` style parameters. */
export const cfgEnv = new Proxy({}, {
  get: (_t, k) => (typeof k === 'string' ? env(k) : undefined),
  has: (_t, k) => typeof k === 'string' && env(k) !== undefined,
});

export const configDefault = (name) => keyInfo(name)?.default;
export { isSecret };
