// HTTP / webhook connector runtime (docs/ELVAR_ARCHITECTURE.md 5.2): turns a validated tool definition + the model's arguments into ONE request through
// safeFetch. Templates are `{{args.<name>}}` only, and only in JSON values, query values, header values and ONE path segment: never in the base URL, host or port.
import { safeFetch } from '../net/safe-fetch.js';
import { ConnectorError, toConnectorError } from './errors.js';
import { cleanText } from './manifest.js';

const ARG_RE = /\{\{\s*args\.([A-Za-z_][A-Za-z0-9_]{0,39})\s*\}\}/g;
const EXACT_RE = /^\{\{\s*args\.([A-Za-z_][A-Za-z0-9_]{0,39})\s*\}\}$/;
const str = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Render a JSON template. A string that is exactly one template keeps the argument's own type; a missing argument omits the key (undefined). */
export function render(v, args) {
  if (typeof v === 'string') {
    const m = EXACT_RE.exec(v);
    if (m) return args[m[1]];
    return v.replace(ARG_RE, (_, n) => str(args[n]));
  }
  if (Array.isArray(v)) return v.map((x) => render(x, args)).filter((x) => x !== undefined);
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) { const r = render(x, args); if (r !== undefined) o[k] = r; } return o; }
  return v;
}

/** The path with each template filled (URL-encoded) inside its own segment. A segment can never become "." / ".." or empty. */
export function renderPath(path, args) {
  return path.split('/').map((seg) => {
    if (!/\{\{/.test(seg)) return seg;
    const out = seg.replace(ARG_RE, (_, n) => encodeURIComponent(str(args[n])));
    if (out === '' || /^\.{1,2}$/.test(out) || /^(%2e){1,2}$/i.test(out)) throw new ConnectorError('bad_args', 'パスに入れる値が正しくありません', 400);
    return out;
  }).join('/');
}

export function authHeaders(c, secret) {
  const a = c.auth || { type: 'none' };
  if (a.type === 'none' || !secret) return {};
  if (a.type === 'bearer') return { authorization: `Bearer ${secret}` };
  if (a.type === 'basic') return { authorization: `Basic ${Buffer.from(String(secret)).toString('base64')}` };
  if (a.type === 'header') return { [a.header]: `${a.prefix || ''}${secret}` };
  return {};
}

const dig = (obj, path) => { let cur = obj; for (const k of path.split('.')) { if (cur === null || cur === undefined) return undefined; cur = Array.isArray(cur) ? cur[/^\d+$/.test(k) ? Number(k) : -1] : typeof cur === 'object' && Object.hasOwn(cur, k) ? cur[k] : undefined; } return cur; };

/** Cap what goes back to the model. @returns {{value:any, truncated:boolean}} */
const STRIP = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;   // control, zero-width and bidi-override characters
export function shapeOutput(value, maxChars) {
  if (typeof value === 'string') { const t = value.replace(STRIP, ' '); return t.length > maxChars ? { value: t.slice(0, maxChars) + '…', truncated: true } : { value: t, truncated: false }; }
  const clean = JSON.parse(JSON.stringify(value ?? null, (k, x) => (typeof x === 'string' ? x.replace(STRIP, ' ') : x)));
  const s = JSON.stringify(clean);
  return s.length > maxChars ? { value: s.slice(0, maxChars) + '…', truncated: true } : { value: clean, truncated: false };
}

/** Build the request for a tool call (pure: tested without a network). */
export function buildRequest(c, tool, args, secret) {
  const rel = renderPath(tool.path, args);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(tool.query || {})) { const r = render(v, args); if (r !== undefined && r !== '') q.append(k, Array.isArray(r) ? r.join(',') : str(r)); }
  const url = c.http.baseUrl + rel + (q.size ? '?' + q.toString() : '');
  if (new URL(url).origin !== new URL(c.http.baseUrl).origin) throw new ConnectorError('bad_args', '接続先が変わってしまうため実行しません', 400);
  const headers = { accept: 'application/json, text/plain;q=0.8', ...authHeaders(c, secret) };
  for (const [k, v] of Object.entries(tool.headers || {})) { const r = render(v, args); if (r !== undefined) { const s = str(r); if (/[\u0000-\u001f\u007f]/.test(s) || s.length > 1000) throw new ConnectorError('bad_args', 'ヘッダーに入れる値が正しくありません', 400); headers[k] = s; } }
  let body;
  if (tool.body !== null && tool.body !== undefined && tool.method !== 'GET') { body = JSON.stringify(render(tool.body, args)); headers['content-type'] = 'application/json'; }
  return { url, method: tool.method, headers, body };
}

/** @returns {Promise<{status:number, value:any, truncated:boolean, note?:string}>} @throws ConnectorError */
export async function runHttpTool(c, tool, args, { secret = '', fetchImpl = safeFetch } = {}) {
  const req = buildRequest(c, tool, args, secret);
  let res;
  try { res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, timeoutMs: c.limits?.timeoutMs, allowPrivate: c.network?.allowPrivate, maxBytes: 1_048_576 }); }
  catch (e) { throw toConnectorError(e); }
  const ct = String(res.headers['content-type'] || '');
  const text = res.text();
  if (res.status < 200 || res.status >= 300) throw new ConnectorError('http_error', `相手のサービスがエラーを返しました（HTTP ${res.status}）${text ? '：' + cleanText(text, 200) : ''}`, 502, { remoteStatus: res.status });
  let data = text, note;
  if (/json/i.test(ct) || /^\s*[[{]/.test(text)) { try { data = JSON.parse(text); } catch { data = text; if (res.truncated) note = '応答が大きすぎて途中で切れています'; } }
  const pick = tool.response?.pick;
  if (pick && data && typeof data === 'object') { const p = dig(data, pick); if (p === undefined) note = `応答に ${pick} がありません`; else data = p; }
  const maxChars = Math.min(tool.response?.maxChars || 4000, c.limits?.maxResultChars || 8000);
  const out = shapeOutput(data, maxChars);
  return { status: res.status, value: out.value, truncated: out.truncated || res.truncated, ...(note ? { note } : {}) };
}

/** Reachability probe for the "test connection" button: one GET to the base URL (any HTTP answer below 500 counts as reachable). */
export async function probeHttp(c, secret, { fetchImpl = safeFetch } = {}) {
  try {
    const r = await fetchImpl(c.http.baseUrl, { method: 'GET', headers: { accept: '*/*', ...authHeaders(c, secret) }, timeoutMs: Math.min(c.limits?.timeoutMs || 15000, 10000), allowPrivate: c.network?.allowPrivate, maxBytes: 4096 });
    return { reachable: r.status < 500, status: r.status };
  } catch (e) { const ce = toConnectorError(e); return { reachable: false, error: ce.message }; }
}
