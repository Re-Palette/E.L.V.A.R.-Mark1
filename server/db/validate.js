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
/** The kinds of OAuth flow (and of callback): the Google login of the user's own client, and a connector's MCP login. */
export const OAUTH_FLOW_KINDS = Object.freeze(['google', 'mcp']);
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
  need(b && typeof b.repo === 'string' && REPO_RE.test(b.repo) && Number.isInteger(b.issueNumber) && b.issueNumber >= 1);
  const target = b.target === undefined ? 'builds' : b.target, state = b.state === undefined ? 'queued' : b.state;
  need(['builds', 'self'].includes(target) && BUILD_STATES.includes(state) && typeof b.title === 'string' && b.title.length >= 1 && b.title.length <= 200);
  return { repo: b.repo, target, issueNumber: b.issueNumber, state, title: b.title };
}

// ---- P4: notes, conversations, inbox, notification relay
export const NOTE_MAX_BYTES = 400000;
export const NOTE_REVISIONS_KEPT = 30;
/** A vault-relative note path: ends in .md, no empty / dot-leading segments (no .., no hidden files), no control characters, at most 300 characters. */
export function notePath(p) {
  need(typeof p === 'string' && p.length >= 4 && p.length <= 300 && /\.md$/.test(p) && !/[\u0000-\u001f\u007f]/.test(p) && !p.startsWith('/'));
  need(p.split('/').every((s) => s.length > 0 && !s.startsWith('.')));
  return p;
}
export const noteContent = (c) => { need(typeof c === 'string' && Buffer.byteLength(c, 'utf8') <= NOTE_MAX_BYTES); return c; };
export function noteTags(t) { if (t === undefined || t === null) return null; need(Array.isArray(t) && t.length <= 30 && t.every((x) => typeof x === 'string' && x.length >= 1 && x.length <= 60)); return [...t]; }
export const MESSAGE_ROLES = Object.freeze(['user', 'assistant', 'tool']);
export const CHANNELS = Object.freeze(['voice', 'text', 'agent', 'import']);
export const MESSAGE_MAX = 8000;
/** [{ role, text, at(ms) }] -> the same, validated (1..120 messages per call). */
/** owner/name of a GitHub repository: no `.` or `..` segment (the name goes into an API path). */
export const REPO_RE = /^(?!\.)[A-Za-z0-9_.-]{1,100}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
export function messageTurns(turns) {
  need(Array.isArray(turns) && turns.length >= 1 && turns.length <= 120);
  return turns.map((t) => {
    need(t && MESSAGE_ROLES.includes(t.role) && typeof t.text === 'string' && t.text.length >= 1 && t.text.length <= MESSAGE_MAX && Number.isFinite(t.at) && t.at > 0 && t.at < 4e12);
    return { role: t.role, text: t.text, at: Math.floor(t.at) };
  });
}
export const INBOX_KINDS = Object.freeze(['report', 'deliverable', 'build', 'alert', 'notice']);
export function inboxInput(x) {
  need(x && typeof x === 'object');
  const kind = x.kind === undefined ? 'notice' : x.kind, body = x.body ?? '', url = x.url || null, notePath = x.notePath || null, key = x.key || null;
  need(INBOX_KINDS.includes(kind) && typeof x.title === 'string' && x.title.length >= 1 && x.title.length <= 120 && typeof body === 'string' && body.length <= 2000);
  need(url === null || (typeof url === 'string' && url.length <= 500 && /^https?:\/\//.test(url)));
  need(notePath === null || (typeof notePath === 'string' && notePath.length <= 300));
  need(key === null || (typeof key === 'string' && key.length >= 1 && key.length <= 100));
  return { kind, title: x.title, body, url, notePath, key };
}
export const NOTIF_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const B64 = /^[A-Za-z0-9+/_=-]+$/;
export function notifItem(x) {
  need(x && typeof x.id === 'string' && NOTIF_ID_RE.test(x.id) && Number.isFinite(x.at) && x.at > 0
    && typeof x.iv === 'string' && x.iv.length >= 12 && x.iv.length <= 32 && B64.test(x.iv) && typeof x.ct === 'string' && x.ct.length >= 16 && x.ct.length <= 6000 && B64.test(x.ct));
  return { id: x.id, at: Math.floor(x.at), iv: x.iv, ct: x.ct };
}
export const NOTIF_KEEP_MS = 3 * 864e5, NOTIF_MAX_ITEMS = 200, INBOX_MAX_ITEMS = 100;
/** `%`-escape one search term for ILIKE (the escape character is a backslash). */
export const likePattern = (t) => '%' + String(t).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
export function searchTerms(terms, max = 40) {
  need(Array.isArray(terms) && terms.length >= 1);
  const t = [...new Set(terms.map((x) => String(x)).filter((x) => x.length >= 1 && x.length <= 100))].slice(0, max); need(t.length >= 1); return t;
}
/** Turns sorted by time and cut into runs: a gap longer than gapMs starts a new conversation. */
export function splitRuns(turns, gapMs) {
  const t = [...turns].sort((a, b) => a.at - b.at), runs = [];
  for (const x of t) { const r = runs[runs.length - 1]; if (r && x.at - r[r.length - 1].at <= gapMs) r.push(x); else runs.push([x]); }
  return runs;
}

// ---- P5: the file vault
export const FILE_KINDS = Object.freeze(['pdf', 'image', 'text', 'office', 'other']);
export const HARD_LIMIT_KEYS = Object.freeze(['maxFileBytes', 'requestsPerMinute', 'liveTokensPerHour', 'connectorCallsPerDay', 'exportsPerDay', 'maxConnectors', 'maxNotes', 'geminiCallsPerDay', 'groqCallsPerDay', 'exaCallsPerDay', 'newsdataCallsPerDay', 'sarashinaCallsPerDay', 'googleCallsPerDay']);   // the catalog of app.admin_set_limits (migration 18)
export const FILE_MAX_BYTES = 62914560;          // O1: 60 MB per file (accounts.hard_limits.maxFileBytes can only lower it)
export const FILE_TEXT_MAX_BYTES = 4000000;      // the extracted text of one file
export const FILE_RESERVE_MINUTES = 15;   // migration 20: an unverified object may sit in the bucket for at most this long
export const FILE_ANALYSIS_MAX = 90000;          // characters of the JSON "memory" (the column check is 100000 bytes)
const SHA_RE = /^[0-9a-f]{64}$/;
export const isSha256 = (s) => typeof s === 'string' && SHA_RE.test(s);
const plainText = (s, max, min = 0) => typeof s === 'string' && s.length >= min && s.length <= max && !/[\u0000-\u001f\u007f]/.test(s);
export const fileName = (n) => { need(plainText(n, 200, 1) && !/[\\/]/.test(n)); return n; };
/** { name, mime, kind, size, sha256, textBytes?, source?, allowDuplicate? } -> the validated reservation request. */
export function fileReserveInput(x) {
  need(x && typeof x === 'object');
  fileName(x.name);
  need(typeof x.mime === 'string' && x.mime.length >= 3 && x.mime.length <= 100 && /^[A-Za-z0-9.+\-/;= ]+$/.test(x.mime));
  need(FILE_KINDS.includes(x.kind) && Number.isInteger(x.size) && x.size >= 1 && x.size <= FILE_MAX_BYTES && isSha256(x.sha256));
  const textBytes = x.textBytes === undefined ? 0 : x.textBytes, source = x.source === undefined ? 'picker' : x.source;
  need(Number.isInteger(textBytes) && textBytes >= 0 && textBytes <= FILE_TEXT_MAX_BYTES && typeof source === 'string' && /^[a-z0-9-]{1,40}$/.test(source));
  return { name: x.name, mime: x.mime, kind: x.kind, size: x.size, sha256: x.sha256, textBytes, source, allowDuplicate: x.allowDuplicate === true };
}
const tagList = (t, max, each) => { need(Array.isArray(t) && t.length <= max && t.every((x) => plainText(x, each, 1))); return [...t]; };
const relatedMark = (r) => { if (r === null) return null; need(r && typeof r === 'object' && !Array.isArray(r) && jsonLen(r) <= 1500); return r; };
const analysisObj = (a) => { need(a && typeof a === 'object' && !Array.isArray(a) && jsonLen(a) <= FILE_ANALYSIS_MAX); return a; };
/** The memory the browser worker built (finalize) or an owner's edit / a re-read (patch): only these keys, each checked. */
export function filePatchInput(p, { allowName = true } = {}) {
  need(p && typeof p === 'object' && !Array.isArray(p));
  const out = {};
  if (p.name !== undefined) { need(allowName); out.name = fileName(p.name); }
  if (p.tags !== undefined) out.tags = tagList(p.tags, 30, 30);
  if (p.memo !== undefined) { need(typeof p.memo === 'string' && p.memo.length <= 1000); out.memo = p.memo; }
  if (p.kindLabel !== undefined) { need(p.kindLabel === null || plainText(p.kindLabel, 40)); out.kindLabel = p.kindLabel ?? ''; }
  if (p.title !== undefined) { need(p.title === null || plainText(p.title, 200)); out.title = p.title; }
  if (p.docKind !== undefined) { need(p.docKind === null || plainText(p.docKind, 40)); out.docKind = p.docKind; }
  if (p.keywords !== undefined) out.keywords = tagList(p.keywords, 30, 60);
  if (p.snippet !== undefined) { need(typeof p.snippet === 'string' && p.snippet.length <= 300); out.snippet = p.snippet; }
  if (p.related !== undefined) out.related = relatedMark(p.related);
  if (p.analysis !== undefined) out.analysis = analysisObj(p.analysis);
  return out;
}
export function fileText(t) { need(typeof t === 'string' && Buffer.byteLength(t, 'utf8') <= FILE_TEXT_MAX_BYTES); return t; }
export const FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function fileFinalizeInput(x) {
  need(x && typeof x === 'object');
  const base = filePatchInput({ title: x.title ?? null, docKind: x.docKind ?? null, keywords: x.keywords ?? [], snippet: x.snippet ?? '', related: x.related ?? null, analysis: x.analysis ?? {} }, { allowName: false });
  const text = x.text === undefined || x.text === null ? '' : fileText(x.text);
  return { ...base, text };
}
