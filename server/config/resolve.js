// Configuration access. Phase 1: the only input is process.env (and ELVAR_PROFILE); the shape is final so that
// the vault can be merged in later. Priority (later phases): vault > env > default.
import { AsyncLocalStorage } from 'node:async_hooks';
import { DEFAULT_PROFILE, mergeProfile } from '../profile/defaults.js';
import { keyInfo } from './keys.js';

const als = new AsyncLocalStorage();

function envProfile() {
  const raw = process.env.ELVAR_PROFILE;
  if (!raw) return DEFAULT_PROFILE;
  try { return mergeProfile(JSON.parse(raw)); } catch { return DEFAULT_PROFILE; }
}

/** cfg: { get(name), source(name), profile, connectors, features, version } */
export function envConfig() {
  const profile = envProfile();
  return {
    get: (name) => process.env[name],
    source: (name) => (process.env[name] ? 'env' : 'default'),
    secretStatus: () => ({}),
    profile, connectors: [], features: profile.features || {}, version: 0,
  };
}

/** Request-level resolution. Phase 1: no vault yet, so everything comes from env. */
export async function getConfig(req) {
  void req;
  return { ok: true, status: 200, auth: { mode: 'env' }, cfg: envConfig() };
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
