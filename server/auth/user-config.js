// The configuration of a request made by a signed-in user. P1 gives it its shape and the one rule that matters from the start (M5):
// a user's API keys never fall back to the platform's environment. Reading the user's own values from app.profiles / app.settings /
// app.user_secrets replaces `get` in P2; until then secrets are simply absent and settings fall back to the platform's defaults.
import { DEFAULT_PROFILE } from '../profile/defaults.js';
import { keyInfo } from '../config/keys.js';

export function userConfigShell(ctx) {
  const get = (name) => (keyInfo(name)?.kind === 'secret' ? undefined : process.env[name]);
  return {
    get, source: (name) => (get(name) ? 'env' : 'default'),
    secretStatus: () => ({}),
    profile: DEFAULT_PROFILE, connectors: [], features: DEFAULT_PROFILE.features || {}, version: 0, google: null, cxSecret: () => '',
    auth: { mode: 'user', userId: ctx.uid.uid, deviceId: ctx.deviceId },
    strictUser: true,   // env() must not fall back to process.env for secrets
  };
}
