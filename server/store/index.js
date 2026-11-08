// Store selection. ELVAR_STORE=memory (tests) > Upstash (UPSTASH_* / KV_REST_API_*) > file (local node) > none (Vercel without Redis).
// Interface (all async): get(key) set(key, value, {ttlSec, nx}) del(key) incr(key, ttlSec) cas(key, expectedVer, value) cmd([[REDIS, ...]]) ; `kind`.
import { MemoryStore } from './memory.js';
import { FileStore } from './file.js';
import { UpstashStore } from './upstash.js';

let cached = null, cachedSig = '';

export function storeKind(e = process.env) {
  if (e.ELVAR_STORE === 'memory') return 'memory';
  if ((e.UPSTASH_REDIS_REST_URL || e.KV_REST_API_URL) && (e.UPSTASH_REDIS_REST_TOKEN || e.KV_REST_API_TOKEN)) return 'upstash';
  if (!e.VERCEL) return 'file';
  return 'none';
}

/** @returns {import('./local.js').LocalStore|UpstashStore|null} null when this deployment has no storage */
export function getStore(e = process.env) {
  const kind = storeKind(e);
  const url = e.UPSTASH_REDIS_REST_URL || e.KV_REST_API_URL || '', tok = e.UPSTASH_REDIS_REST_TOKEN || e.KV_REST_API_TOKEN || '';
  const sig = [kind, kind === 'upstash' ? url + tok : '', kind === 'file' ? e.ELVAR_DATA_DIR || '' : ''].join('|');
  if (sig === cachedSig && cached !== undefined) return cached;
  cachedSig = sig;
  cached = kind === 'memory' ? new MemoryStore() : kind === 'upstash' ? new UpstashStore(url, tok) : kind === 'file' ? new FileStore() : null;
  return cached;
}

/** Tests: drop the cached store (a fresh MemoryStore on the next call). */
export function resetStore() { cached = null; cachedSig = ''; }
