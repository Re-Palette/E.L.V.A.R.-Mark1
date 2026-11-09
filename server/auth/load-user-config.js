// The request configuration of a signed-in user (docs/ELVAR_MULTIUSER.md 2.1): their own settings (app.settings), secrets (app.user_secrets, decrypted
// with their own DEK), and profile (app.profiles) first; then only the platform defaults the ledger allows (keys.js `platform: true`).
// A user's API keys NEVER come from the platform environment (M5). Everything is read in ONE transaction as that user (Row Level Security applies).
//
// Warm cache: the decrypted result is kept per user for 10 seconds on this instance and dropped at once when this instance writes the user's
// config (invalidateUserConfig). Another instance sees a change within 10 seconds. A secret the user removes is gone everywhere in at most 10 s.
import crypto from 'node:crypto';
import { KEYS, keyInfo, isPlatformDefault } from '../config/keys.js';
import { FROM_PROFILE, secretStatus } from '../config/resolve.js';
import { mergeProfile } from '../profile/defaults.js';
import { strictConfig, platformValue } from './user-config.js';
import { getKeyring } from './keyring.js';

const TTL_MS = 10_000, MAX = 500;
const cache = new Map();   // uid -> { data, at }
export const invalidateUserConfig = (uid) => { cache.delete(String(uid?.uid ?? uid)); };
export const _clearUserConfigCache = () => cache.clear();

export const NOTIF_SECRET = 'NOTIF_SECRET';
/** Names stored in user_secrets that are not editable keys of the ledger (internal material). */
const INTERNAL_SECRETS = new Set([NOTIF_SECRET]);

async function readData(ctx) {
  const ring = getKeyring();
  return ctx.db(async (r) => {
    const [profile, settings, names] = await Promise.all([r.profile.get(), r.settings.get(), r.secrets.list()]);
    const secrets = {}, cxSecrets = {};
    for (const s of names) { const v = await ring.getSecret(r, s.name); if (/^cx:/.test(s.name)) cxSecrets[s.name] = v; else secrets[s.name] = v; }   // cx:<connector id>:* are the connectors' own secrets
    const k = await ring.dek(r);   // created on the first request of a new user
    // the user's connections (P3): their connectors with the tools they approved, and their own Google login (never anybody else's)
    const connectors = await r.connectors.list();
    const g = await ring.getToken(r, 'google');
    const mcp = Object.fromEntries((await r.oauthTokens.list()).filter((t) => t.provider.startsWith('cx:')).map((t) => [t.provider.slice(3), { status: t.status, reason: t.reason }]));
    return { profile: profile || null, settings: settings || {}, secrets, cxSecrets, connectors, google: g ? { ...g.data, scopes: g.scopes, status: g.status === 'ok' ? 'connected' : 'reauth_required', reason: g.reason || '' } : null, mcp, ticketKey: await ring.ticketKey(r), dekVer: k.dekVer };
  });
}

/** @returns {Promise<object>} cfg for runWithConfig */
export async function loadUserConfig(ctx, { fresh = false } = {}) {
  const uid = ctx.uid.uid, now = Date.now();
  let hit = fresh ? null : cache.get(uid);
  if (!hit || now - hit.at >= TTL_MS) {
    hit = { data: await readData(ctx), at: now };
    cache.set(uid, hit);
    while (cache.size > MAX) cache.delete(cache.keys().next().value);
  }
  return buildConfig(ctx, hit.data);
}

const last4 = (v) => (typeof v === 'string' && v.length >= 8 ? v.slice(-4) : null);

export function buildConfig(ctx, data) {
  const profile = mergeProfile(data.profile || {});
  const own = (name) => {
    if (FROM_PROFILE[name]) return FROM_PROFILE[name](profile);
    const info = keyInfo(name);
    if (!info || info.kind === 'infra') return undefined;
    const v = info.kind === 'secret' ? data.secrets[name] : data.settings[name];
    return v === undefined || v === null || v === '' ? undefined : v;
  };
  const get = (name) => { const v = own(name); return v !== undefined ? v : platformValue(name); };
  const source = (name) => (own(name) !== undefined ? 'app' : platformValue(name) ? 'env' : 'default');
  return strictConfig({ mode: ctx.kind === 'device' ? 'device' : 'user', userId: ctx.uid.uid, deviceId: ctx.deviceId }, {
    get, source,
    secretStatus: () => secretStatus((n) => data.secrets[n], () => 'app'),
    profile, features: profile.features || {}, version: data.dekVer,
    ticketKey: data.ticketKey, notifSecret: data.secrets[NOTIF_SECRET] || null,
    // connections: only this user's (the router builds the request from THEIR rows; the platform environment never supplies a Google login or a connector secret)
    connectors: data.connectors, google: data.google, mcpState: (id) => data.mcp[id] || null,
    cxSecret: (id, what = 'auth') => data.cxSecrets[`cx:${id}:${what}`] || '',
    // the user's own database access and per-user counters, for code that runs deep inside a request
    uid: ctx.uid.uid, db: ctx.db,
    hit: async (bucket, windowSec, limit) => (await ctx.system.rlHit({ bucket, who: ctx.uid.uid, windowSec, userId: ctx.uid })) <= limit,
    record: (provider, metric, amount = 1, src = 'server') => ctx.db((r) => r.usage.record({ provider, metric, amount, source: src })),
  });
}

export const randomNotifSecret = () => crypto.randomBytes(32).toString('base64url');
export { INTERNAL_SECRETS, KEYS, isPlatformDefault, last4 };
