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

// ---- P3: connections
export const PROVIDER_RE = /^(google|cx:[A-Za-z0-9_-]{1,40})$/;
export const CONNECTOR_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const OAUTH_STATUSES = Object.freeze(['ok', 'reauth_required']);
export function oauthTokenInput(provider, r) {
  need(typeof provider === 'string' && PROVIDER_RE.test(provider));
  need(r && isBytes(r.ct) && r.ct.length >= 17 && r.ct.length <= 16400 && isBytes(r.iv, 12) && Number.isInteger(r.dekVer) && r.dekVer >= 1);
  const scopes = r.scopes === undefined ? [] : r.scopes, status = r.status === undefined ? 'ok' : r.status, reason = r.reason ?? null, revokeUrl = r.revokeUrl ?? null;
  need(Array.isArray(scopes) && scopes.length <= 40 && scopes.every((x) => typeof x === 'string' && x.length >= 1 && x.length <= 300));
  need(OAUTH_STATUSES.includes(status) && (reason === null || (typeof reason === 'string' && reason.length <= 60)));
  need(revokeUrl === null || (typeof revokeUrl === 'string' && revokeUrl.length <= 500 && /^https?:\/\//.test(revokeUrl)));
  return { ct: toBuf(r.ct), iv: toBuf(r.iv), dekVer: r.dekVer, scopes: [...scopes], status, reason, revokeUrl };
}
const jsonLen = (o) => { try { return JSON.stringify(o).length; } catch { return Infinity; } };
/** A connector manifest with its tools (server/connectors/manifest.js shape). The tools are stored as rows of their own. */
export function connectorInput(c) {
  need(c && typeof c === 'object' && !Array.isArray(c) && typeof c.id === 'string' && CONNECTOR_ID_RE.test(c.id));
  const { tools = [], ...manifest } = c;
  need(Array.isArray(tools) && tools.length <= 100 && jsonLen(manifest) <= 20000);
  const seen = new Set();
  const rows = tools.map((t, i) => {
    need(t && typeof t === 'object' && typeof t.name === 'string' && t.name.length >= 1 && t.name.length <= 100 && !seen.has(t.name) && jsonLen(t) <= 40000);
    need(t.hash === undefined || (typeof t.hash === 'string' && t.hash.length <= 100));
    seen.add(t.name);
    return { name: t.name, def: t, hash: t.hash || '', enabled: t.enabled === true, approval: ['ask', 'ask_high', 'auto', 'off'].includes(t.approval) ? t.approval : null, expose: ['pinned', 'gateway'].includes(t.expose) ? t.expose : null, pos: i };
  });
  const syncedAt = Number.isFinite(c.syncedAt) && c.syncedAt > 0 ? c.syncedAt : null;
  return { id: c.id, manifest, enabled: c.enabled !== false, syncedAt, tools: rows };
}
export const BUILD_STATES = Object.freeze(['queued', 'working', 'review', 'done', 'failed']);
export function buildInput(b) {
  need(b && typeof b.repo === 'string' && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(b.repo) && Number.isInteger(b.issueNumber) && b.issueNumber >= 1);
  const target = b.target === undefined ? 'builds' : b.target, state = b.state === undefined ? 'queued' : b.state;
  need(['builds', 'self'].includes(target) && BUILD_STATES.includes(state) && typeof b.title === 'string' && b.title.length >= 1 && b.title.length <= 200);
  return { repo: b.repo, target, issueNumber: b.issueNumber, state, title: b.title };
}
