// Configuration access. Priority: vault (set in the app) > env > default. `getConfig(req)` authenticates the request and builds the
// per-request cfg; `env(name)` is the synchronous accessor used all over server/ (AsyncLocalStorage carries the cfg through awaits).
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DEFAULT_PROFILE, mergeProfile } from '../profile/defaults.js';
import { KEYS, keyInfo, isSecret } from './keys.js';
import { authenticate } from './auth.js';
import { getStore } from '../store/index.js';
import { readDoc, ticketKeyFromDek, connectorKeyFromDek } from './vault.js';
import { loadLogin } from '../google/login-record.js';

const als = new AsyncLocalStorage();

function envProfile() {
  const raw = process.env.ELVAR_PROFILE;
  if (!raw) return DEFAULT_PROFILE;
  try { return mergeProfile(JSON.parse(raw)); } catch { return DEFAULT_PROFILE; }
}

/** cfg: { get(name), source(name), secretStatus(), profile, connectors, features, version, auth, ticketKey?, notifSecret? } */
export function envConfig(auth = { mode: 'env' }) {
  const profile = envProfile();
  return {
    get: (name) => process.env[name],
    source: (name) => (process.env[name] ? 'env' : 'default'),
    secretStatus: () => secretStatus((n) => process.env[n], () => 'env'),
    profile, connectors: [], features: profile.features || {}, version: 0, google: null, cxSecret: () => '',
    auth: { mode: auth.mode, deviceId: auth.deviceId },
  };
}

const last4 = (v) => (typeof v === 'string' && v.length >= 8 ? v.slice(-4) : null);
function secretStatus(get, source) {
  const out = {};
  for (const k of KEYS) if (k.kind === 'secret') { const v = get(k.name); out[k.name] = { set: Boolean(v), source: v ? source(k.name) : 'default', last4: v ? last4(String(v)) : null }; }
  return out;
}

// Settings that moved into the profile (the vault's profile wins over the old env names).
const FROM_PROFILE = {
  GEMINI_LIVE_VOICE: (p) => p.assistant.voice,
  GEMINI_LIVE_INPUT_LANGS: (p) => p.locale.inputLangs.join(','),
  GOOGLE_TIMEZONE: (p) => p.locale.timeZone,
  WEATHER_PLACE: (p) => p.home.city,
};
export const PROFILE_KEYS = Object.keys(FROM_PROFILE);

/** `google` = the decrypted tok:google record (the login made in the app), or null. */
export function vaultConfig(doc, auth, docVer, google = null) {
  const profile = mergeProfile(doc.profile || {});
  const secrets = doc.secrets || {}, settings = doc.settings || {};
  const own = (name) => {
    if (FROM_PROFILE[name]) return FROM_PROFILE[name](profile);
    const info = keyInfo(name);
    if (!info || info.kind === 'infra') return undefined;
    const v = info.kind === 'secret' ? secrets[name] : settings[name];
    return v === undefined || v === null || v === '' ? undefined : v;
  };
  const get = (name) => { const v = own(name); return v !== undefined ? v : process.env[name]; };
  const source = (name) => (own(name) !== undefined ? 'app' : process.env[name] ? 'env' : 'default');
  return {
    get, source, secretStatus: () => secretStatus(get, source),
    profile, connectors: Array.isArray(doc.connectors) ? doc.connectors : [], features: profile.features || {}, version: docVer, google,
    auth: { mode: 'vault', deviceId: auth.deviceId },
    ticketKey: ticketKeyFromDek(auth.dek), connectorKey: connectorKeyFromDek(auth.dek), notifSecret: doc.notifSecret || null,
    cxSecret: (id, what = 'auth') => (secrets[`cx:${id}:${what}`] ? String(secrets[`cx:${id}:${what}`]) : ''),
  };
}

// warm-instance cache of the decrypted doc: sha256(token) -> { docVer, doc, at }. Valid while meta.docVer is unchanged, at most 30 s.
const warm = new Map();
const WARM_MS = 30_000;
async function loadDoc(auth, token) {
  const k = crypto.createHash('sha256').update(token).digest('hex'), now = Date.now();
  const hit = warm.get(k);
  if (hit && hit.docVer === auth.meta.docVer && now - hit.at < WARM_MS) return hit;
  const store = getStore();
  const [{ doc, ver }, tok] = await Promise.all([readDoc(store, auth.dek, auth.meta), loadLogin(store, auth.dek).catch(() => null)]);
  const rec = { docVer: auth.meta.docVer, doc, ver, google: tok || null, at: now };
  warm.set(k, rec);
  if (warm.size > 50) for (const [kk, v] of warm) if (now - v.at > WARM_MS) warm.delete(kk);
  return rec;
}
export const _clearWarmCache = () => warm.clear();

/** Request-level resolution. @returns {{ok:boolean, status:number, error?:string, auth:object, cfg:object, doc?:object}} cfg is always usable (env only when not authenticated) */
export async function getConfig(req) {
  const auth = await authenticate(req);
  if (!auth.ok) return { ok: false, status: auth.status, error: auth.error, auth, cfg: envConfig({ mode: 'none' }) };
  if (auth.mode !== 'vault') return { ok: true, status: 200, auth, cfg: envConfig(auth) };
  try {
    const { doc, docVer, google } = await loadDoc(auth, String(req.headers['x-elvar-token']));
    return { ok: true, status: 200, auth, cfg: vaultConfig(doc, auth, docVer, google), doc };
  } catch (e) {
    console.error('[elvar] vault read failed:', e?.code || e?.message);
    return { ok: false, status: 500, error: 'vault_unavailable', auth, cfg: envConfig({ mode: 'none' }) };
  }
}

export const runWithConfig = (cfg, fn) => als.run(cfg, fn);
export const currentConfig = () => als.getStore() || envConfig();

/** Synchronous accessor: cfg.get(name) -> process.env[name] -> undefined. */
export function env(name) {
  const v = currentConfig().get(name);
  return v === undefined || v === null ? process.env[name] : v;
}

/** An env-shaped object backed by env(); for `fn(env = process.env)` style parameters. */
export const cfgEnv = new Proxy({}, {
  get: (_t, k) => (typeof k === 'string' ? env(k) : undefined),
  has: (_t, k) => typeof k === 'string' && env(k) !== undefined,
});

export const configDefault = (name) => keyInfo(name)?.default;
export { isSecret };
