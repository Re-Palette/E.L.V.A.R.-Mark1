// Sealed key/value records for the modules that still keep state in a key/value store (connector OAuth tokens until P3 moves them to app.oauth_tokens):
// AES-256-GCM(JSON) under a key the caller passes, AAD = "<record key>|v<version>" so a swapped or rolled-back record fails to open. The per-user
// envelope (server/crypto/envelope.js) is where user keys come from; the old single-owner vault is gone (docs/ELVAR_MULTIUSER.md section 1).
import { seal, open } from './envelope.js';

export const tokKey = (name) => `elvar:v1:tok:${name}`;
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
const recAad = (key, ver) => `${key}|v${ver}`;

/** Encrypt an object into a store record: { ver, iv, ct }. */
export function sealRecord(dek, key, ver, obj) { return { ver, ...seal(dek, JSON.stringify(obj), recAad(key, ver)) }; }
export function openRecord(dek, key, rec) { return JSON.parse(open(dek, rec, recAad(key, rec.ver)).toString()); }

export async function readRecord(store, dek, key) {
  const rec = await store.get(key); if (!rec) return null;
  try { return { data: openRecord(dek, key, rec), ver: rec.ver }; } catch { throw fail('record_corrupt', 500); }
}
/** Write with compare-and-set. Returns false on a version conflict. */
export async function writeRecord(store, dek, key, obj, expectedVer) {
  return store.cas(key, expectedVer, sealRecord(dek, key, expectedVer + 1, obj));
}
