// Input checks shared by the Postgres repos and MemoryDb, so both reject the same values with the same error (the database CHECK constraints are the second line).
import { dbError } from './errors.js';

export const SECRET_NAME_RE = /^[A-Za-z0-9_:.-]{1,80}$/;
export const DEVICE_ID_RE = /^[0-9a-f]{16}$/;
export const DEVICE_SCOPES = Object.freeze(['notif:push', 'notif:pull']);
export const MAX_TTL_SEC = 7 * 86400;

const bad = () => dbError('invalid_value', 400);
export const need = (cond) => { if (!cond) throw bad(); };

export const isBytes = (b, n) => (Buffer.isBuffer(b) || b instanceof Uint8Array) && (n === undefined || b.length === n);
export const toBuf = (b) => Buffer.from(b);
export const secretName = (n) => { need(typeof n === 'string' && SECRET_NAME_RE.test(n)); return n; };
export const jsonObject = (o, maxBytes = 100000) => { need(o !== null && typeof o === 'object' && !Array.isArray(o)); need(JSON.stringify(o).length <= maxBytes); return o; };
export const ttlSec = (t) => { need(Number.isFinite(t) && t > 0 && t <= MAX_TTL_SEC); return Math.ceil(t); };
export function deviceInput(d) {
  need(d && DEVICE_ID_RE.test(d.id) && typeof d.name === 'string' && d.name.length >= 1 && d.name.length <= 40 && isBytes(d.tokenHash, 32));
  need(Array.isArray(d.scopes) && d.scopes.length >= 1 && d.scopes.length <= 8 && d.scopes.every((s) => DEVICE_SCOPES.includes(s)));
  return { id: d.id, name: d.name, tokenHash: toBuf(d.tokenHash), scopes: [...d.scopes] };
}
export function sealedInput(r) {
  need(r && isBytes(r.ct) && r.ct.length >= 17 && r.ct.length <= 16400 && isBytes(r.iv, 12) && Number.isInteger(r.dekVer) && r.dekVer >= 1);
  need(r.last4 === null || r.last4 === undefined || (typeof r.last4 === 'string' && r.last4.length <= 4));
  return { ct: toBuf(r.ct), iv: toBuf(r.iv), dekVer: r.dekVer, last4: r.last4 ?? null };
}
export function keyInput(r) {
  need(r && typeof r.kekId === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(r.kekId) && Number.isInteger(r.dekVer) && r.dekVer >= 1 && isBytes(r.wrapped, 48) && isBytes(r.iv, 12));
  return { kekId: r.kekId, dekVer: r.dekVer, wrapped: toBuf(r.wrapped), iv: toBuf(r.iv) };
}
export const key200 = (k) => { need(typeof k === 'string' && k.length >= 1 && k.length <= 200); return k; };
