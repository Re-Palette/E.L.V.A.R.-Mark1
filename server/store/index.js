// The key/value store used by the modules that have not moved to the database yet (connector sessions, OAuth flows: P3). It exists ONLY as the in-memory
// store for tests and local experiments (ELVAR_STORE=memory); Upstash, the local file store and the shared owner vault are gone (docs/ELVAR_MULTIUSER.md M1).
// Everything a user owns lives in Postgres behind Row Level Security (server/db/). Without ELVAR_STORE=memory there is no store and getStore() is null.
import { MemoryStore } from './memory.js';

let cached = null;
export const storeKind = (e = process.env) => (e.ELVAR_STORE === 'memory' ? 'memory' : 'none');

/** @returns {MemoryStore|null} */
export function getStore(e = process.env) {
  if (storeKind(e) !== 'memory') { cached = null; return null; }
  return (cached ||= new MemoryStore());
}

/** Tests: drop the cached store (a fresh MemoryStore on the next call). */
export function resetStore() { cached = null; }
