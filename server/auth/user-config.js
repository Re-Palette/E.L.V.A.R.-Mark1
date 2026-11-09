// The configuration of a request made by a signed-in user, and of a cron run. Both are STRICT (docs/ELVAR_MULTIUSER.md M5, review P1-4/5):
// in this context the platform environment supplies only the keys that the ledger (server/config/keys.js) marks `platform: true` (model names, tuning,
// public URLs). A user's API keys, owner personal settings (BRAIN_REPO, BUILD_*, WEATHER_PLACE, GOOGLE_*, ELVAR_PROFILE ...), infrastructure keys and
// unknown names are undefined unless the user has set them: an allowlist, not a block-list of secrets. P2 fills `get` from the user's own
// app.profiles / app.settings / app.user_secrets (server/auth/load-user-config.js); until a value is loaded, it is simply absent.
import { DEFAULT_PROFILE } from '../profile/defaults.js';
import { isPlatformDefault } from '../config/keys.js';

/** The platform's value for a key, if (and only if) the ledger allows users to inherit it. */
export const platformValue = (name) => (isPlatformDefault(name) ? process.env[name] : undefined);

/** @param {object} auth  what the config reports as its auth ({ mode, userId?, deviceId? }) @param {object} [own] the user's own values: { get?, ... } overrides */
export function strictConfig(auth, own = {}) {
  return {
    get: platformValue, source: (name) => (platformValue(name) ? 'env' : 'default'),
    secretStatus: () => ({}),
    profile: DEFAULT_PROFILE, connectors: [], features: DEFAULT_PROFILE.features || {}, version: 0, google: null, cxSecret: () => '',
    ...own,
    auth,
    strictUser: true,   // env() falls back to process.env only for platform keys
  };
}

export function userConfigShell(ctx) { return strictConfig({ mode: 'user', userId: ctx.uid.uid, deviceId: ctx.deviceId }); }
/** Cron: no user, no secrets, no personal settings. */
export const cronConfig = () => strictConfig({ mode: 'cron' });
