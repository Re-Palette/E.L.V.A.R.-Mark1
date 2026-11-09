// Connector manifests (docs/ELVAR_ARCHITECTURE.md 5.1): validation, normalisation, hashing and the owner-facing view. Pure functions, no I/O.
// A manifest lives in the user's own rows (app.connectors / app.connector_tools, server/connectors/data.js); its secrets live in the user's encrypted secrets
// (`cx:<id>:auth`, write-only: no view ever contains them).
// Everything that comes from a REMOTE server (tool names, descriptions, schemas) is untrusted data: it is cleaned and capped here, once, on the way in.
import crypto from 'node:crypto';
import { isForbiddenHeader, classifyIp, privateAllowed, hatchUrlOk } from '../net/safe-fetch.js';
import net from 'node:net';
import { getSecret } from './data.js';

export const MAX_CONNECTORS = 10, MAX_TOOLS = 100, MAX_HTTP_TOOLS = 40, MAX_PINNED = 24;
export const DESC_MAX = 300, PROP_DESC_MAX = 200, SCHEMA_MAX_CHARS = 6000, PINNED_SCHEMA_MAX = 1500, PINNED_DECL_BUDGET = 20_000;
export const SLUG_RE = /^[a-z0-9]{2,16}$/;
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const APPROVALS = ['ask', 'ask_high', 'auto', 'off'];
export const MCP_AUTH = ['none', 'bearer', 'oauth'], HTTP_AUTH = ['none', 'bearer', 'header', 'basic'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const ARG_RE = /\{\{\s*args\.([A-Za-z_][A-Za-z0-9_]{0,39})\s*\}\}/g;
const ANY_BRACES = /\{\{|\}\}/;

// ------------------------------------------------------------------ text
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
/** One line, no control / zero-width / bidi characters, no template braces, at most `max` characters. */
export function cleanText(s, max = DESC_MAX) {
  const t = String(s ?? '').replace(INVISIBLE, ' ').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  const cp = [...t];
  return cp.length > max ? cp.slice(0, max - 1).join('') + '…' : t;
}
/** Multi-line allowed (error text); still no control characters. */
export const cleanMessage = (s, max = 300) => cleanText(s, max);

export const randomId = () => 'cx_' + crypto.randomBytes(3).toString('hex');
export const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}

// ------------------------------------------------------------------ JSON Schema (what a model may be shown)
const PROP_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
function cleanProp(s, depth, st) {
  if (st.n++ > 120) throw new Error('schema_too_big');
  const src = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  let type = Array.isArray(src.type) ? src.type.find((t) => t !== 'null') : src.type;
  if (!['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(type)) type = 'string';
  const out = { type };
  if (src.description) out.description = cleanText(src.description, PROP_DESC_MAX);
  if (Array.isArray(src.enum) && src.enum.length && src.enum.length <= 50 && src.enum.every((v) => ['string', 'number', 'boolean'].includes(typeof v))) out.enum = src.enum.map((v) => (typeof v === 'string' ? cleanText(v, 80) : v));
  for (const k of ['minimum', 'maximum']) if (typeof src[k] === 'number' && Number.isFinite(src[k]) && (type === 'number' || type === 'integer')) out[k] = src[k];
  for (const k of ['minLength', 'maxLength']) if (Number.isInteger(src[k]) && src[k] >= 0 && src[k] <= 100_000 && type === 'string') out[k] = src[k];
  for (const k of ['minItems', 'maxItems']) if (Number.isInteger(src[k]) && src[k] >= 0 && src[k] <= 1000 && type === 'array') out[k] = src[k];
  if (['string', 'number', 'integer', 'boolean'].includes(typeof src.default)) out.default = typeof src.default === 'string' ? cleanText(src.default, 100) : src.default;
  if (type === 'array') out.items = depth >= 3 ? { type: 'string' } : cleanProp(src.items, depth + 1, st);
  if (type === 'object') {
    if (depth >= 3) return { type: 'object', ...(out.description ? { description: out.description } : {}) };
    const props = {}; let n = 0;
    for (const [k, v] of Object.entries(src.properties && typeof src.properties === 'object' ? src.properties : {})) { if (!PROP_NAME.test(k)) continue; if (++n > 30) break; props[k] = cleanProp(v, depth + 1, st); }
    out.properties = props;
    const req = Array.isArray(src.required) ? src.required.filter((k) => typeof k === 'string' && Object.hasOwn(props, k)) : [];
    if (req.length) out.required = req;
  }
  return out;
}
/** @returns {object|null} an object schema safe to show a model and to validate with, or null when it cannot be used (too big / a required name we cannot send) */
export function cleanSchema(schema) {
  try {
    const src = schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : { type: 'object', properties: {} };
    if (src.type && src.type !== 'object') return null;
    const out = cleanProp({ ...src, type: 'object' }, 0, { n: 0 });
    for (const k of Array.isArray(src.required) ? src.required : []) if (typeof k === 'string' && !Object.hasOwn(out.properties, k)) return null;   // a required name that cannot be sent: unusable
    if (JSON.stringify(out).length > SCHEMA_MAX_CHARS) return null;
    return out;
  } catch { return null; }
}

const ANN_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
export function cleanAnnotations(a) {
  const out = {}; if (a && typeof a === 'object') for (const k of ANN_KEYS) if (typeof a[k] === 'boolean') out[k] = a[k];
  return out;
}
/** The pin: any change to what the tool says it does (text, parameters, hints) changes the hash. */
export const toolHash = ({ description, inputSchema, annotations }) => 'sha256:' + sha(canonical({ d: cleanText(description, 2000), s: inputSchema, a: annotations || {} }));

// ------------------------------------------------------------------ names
export const slugFromName = (name) => { const s = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16); return s.length >= 2 ? s : 'app' + crypto.randomBytes(2).toString('hex'); };
export const localToolName = (remote) => {
  const n = String(remote || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return /^[a-z]/.test(n) ? n : ('t_' + n).slice(0, 40);
};
/** The name the model sees: cx_<slug>_<tool>, [A-Za-z0-9_] only, at most 64 characters. */
export const toolFullName = (c, t) => `cx_${c.slug}_${t.name}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64);
export const GATEWAY_TOOLS = ['connector_tools', 'connector_call'];

// ------------------------------------------------------------------ urls
/** Syntax-level check of an owner-typed URL (the real network check is safeFetch at call time). @returns {{ok:true, url:string, host:string}|{ok:false, message:string}} */
export function checkUrl(raw, { allowPrivate = false } = {}) {
  let u; try { u = new URL(String(raw || '').trim()); } catch { return { ok: false, message: 'URLの形式が正しくありません' }; }
  if (hatchUrlOk(u.toString())) { u.hash = ''; return { ok: true, url: u.toString(), host: u.host }; }   // test-only loopback hatch (never on Vercel / in production)
  if (u.protocol !== 'https:') return { ok: false, message: 'https:// で始まるアドレスだけ使えます' };
  if (u.username || u.password) return { ok: false, message: 'URLにユーザー名・パスワードは入れられません（認証は別の欄に入れます）' };
  if (u.search && /[?&](access_token|token|key|api_key|apikey|secret|password)=/i.test(u.search)) return { ok: false, message: 'キーをURLに入れないでください（認証の欄に入れます）' };
  const host = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
  const port = u.port ? Number(u.port) : 443;
  const pa = privateAllowed(allowPrivate);
  if (![443, 8443].includes(port) && !pa) return { ok: false, message: 'ポートは 443 か 8443 だけ使えます' };
  if (net.isIP(host)) {
    const k = classifyIp(host);
    if (k !== 'public' && !(pa && ['private', 'cgnat', 'loopback'].includes(k))) return { ok: false, message: 'このアドレス（社内・ループバックなど）は使えません' };
  } else if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(host) || host.length > 253) return { ok: false, message: 'ホスト名が正しくありません' };
  if (!net.isIP(host) && !pa && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local'))) return { ok: false, message: 'このアドレス（社内・ループバックなど）は使えません' };
  u.hash = '';
  return { ok: true, url: u.toString(), host: u.host };
}
export const hostOf = (c) => { try { return new URL(c.type === 'mcp' ? c.mcp.url : c.http.baseUrl).host; } catch { return ''; } };

// ------------------------------------------------------------------ HTTP tool templates
function templateArgs(v, out = new Set()) {
  if (typeof v === 'string') { for (const m of v.matchAll(ARG_RE)) out.add(m[1]); }
  else if (Array.isArray(v)) v.forEach((x) => templateArgs(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => templateArgs(x, out));
  return out;
}
const strayBraces = (v) => (typeof v === 'string' ? ANY_BRACES.test(v.replace(ARG_RE, '')) : Array.isArray(v) ? v.some(strayBraces) : v && typeof v === 'object' ? Object.values(v).some(strayBraces) : false);
const jsonSize = (v) => { try { return JSON.stringify(v).length; } catch { return Infinity; } };

function validateHttpTool(t, i, errs, seen) {
  const at = `tools[${i}]`; const e = (m) => errs.push({ path: at, message: m });
  if (!t || typeof t !== 'object' || Array.isArray(t)) { e('道具の形式が正しくありません'); return null; }
  const name = String(t.name || '');
  if (!TOOL_NAME_RE.test(name)) e('道具の名前は、英小文字・数字・_ で、英字から始め40字までにしてください');
  if (seen.has(name)) e(`道具の名前が重複しています: ${name}`); seen.add(name);
  const method = String(t.method || 'GET').toUpperCase();
  if (!METHODS.includes(method)) e('method は GET / POST / PUT / PATCH / DELETE のどれかです');
  const path = String(t.path ?? '');
  if (!/^\/[^?#\\\s]*$/.test(path) || path.length > 300 || /(^|\/)\.{1,2}(\/|$)/.test(path.replace(ARG_RE, 'x')) || /\/\//.test(path)) e('path は / で始まり、?・#・空白・.. を含めない形にしてください');
  if (strayBraces(path)) e('テンプレートは {{args.名前}} だけ使えます');
  for (const seg of path.split('/')) if ((seg.match(ARG_RE) || []).length > 1) { e('path の1区間に使える {{args.名前}} は1つまでです'); break; }
  const query = t.query && typeof t.query === 'object' && !Array.isArray(t.query) ? t.query : {};
  if (Object.keys(query).length > 20) e('query の項目は20個までです');
  for (const [k, v] of Object.entries(query)) { if (!/^[A-Za-z0-9_.\-[\]]{1,40}$/.test(k)) e(`query の名前が正しくありません: ${k}`); if (!['string', 'number', 'boolean'].includes(typeof v)) e(`query の値は文字・数・真偽だけです: ${k}`); }
  const headers = t.headers && typeof t.headers === 'object' && !Array.isArray(t.headers) ? t.headers : {};
  if (Object.keys(headers).length > 10) e('headers は10個までです');
  for (const [k, v] of Object.entries(headers)) { if (!HEADER_NAME.test(k) || isForbiddenHeader(k)) e(`この名前のヘッダーは設定できません: ${String(k).slice(0, 40)}`); if (typeof v !== 'string' || /[\u0000-\u001f\u007f]/.test(v) || v.length > 300) e(`ヘッダーの値が正しくありません: ${k}`); }
  if (t.body !== undefined && t.body !== null && (method === 'GET')) e('GET に body は付けられません');
  if (jsonSize(t.body ?? null) > 4000) e('body のテンプレートが大きすぎます（4000字まで）');
  for (const v of [path, query, headers, t.body ?? null]) if (strayBraces(v)) { e('テンプレートは {{args.名前}} だけ使えます'); break; }
  const inputSchema = cleanSchema(t.inputSchema ?? { type: 'object', properties: {} });
  if (!inputSchema) e('inputSchema が正しくないか、大きすぎます');
  const used = templateArgs([path, query, headers, t.body ?? null]);
  if (inputSchema) for (const a of used) if (!Object.hasOwn(inputSchema.properties, a)) e(`テンプレートの args.${a} が inputSchema にありません`);
  const resp = t.response && typeof t.response === 'object' ? t.response : {};
  const pick = resp.pick === undefined || resp.pick === null || resp.pick === '' ? '' : String(resp.pick);
  if (pick && !/^[A-Za-z0-9_-]{1,40}(\.[A-Za-z0-9_-]{1,40}){0,7}$/.test(pick)) e('response.pick は a.b.c の形（8段まで）にしてください');
  const maxChars = resp.maxChars === undefined ? 4000 : Number(resp.maxChars);
  if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > 20000) e('response.maxChars は100〜20000の整数です');
  const approval = t.approval === undefined ? 'ask' : String(t.approval);
  if (!APPROVALS.includes(approval)) e('approval は ask / ask_high / auto / off のどれかです');
  const readOnly = t.readOnly === true;
  if (approval === 'auto' && !readOnly) e('approval:auto は、readOnly:true の道具だけ選べます');
  const danger = method === 'DELETE' || t.danger === 'high' || approval === 'ask_high' ? 'high' : 'normal';
  if (approval === 'auto' && danger === 'high') e('DELETE や危険度「高」の道具は、自動承認にできません');
  const expose = t.expose === 'gateway' ? 'gateway' : 'pinned';
  return { name, enabled: t.enabled !== false, expose, approval, danger, description: cleanText(t.description || name, DESC_MAX), method, path, query, headers, body: t.body ?? null,
    inputSchema, readOnly, response: { pick, maxChars } };
}

// ------------------------------------------------------------------ the whole manifest
/**
 * Validate an owner-supplied draft (create) or a full replacement. Tools of an MCP connector are NOT taken from the input (they come from the server on sync);
 * the HTTP connector's tools are defined by the owner and validated here.
 * @returns {{ok:true, manifest:object}|{ok:false, errors:{path:string, message:string}[]}}
 */
export function validateManifest(input, { existing = [], id = null } = {}) {
  const errs = [], e = (path, message) => errs.push({ path, message });
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const type = src.type === 'http' ? 'http' : src.type === 'mcp' ? 'mcp' : null;
  if (!type) e('type', '種類は mcp か http です');
  const name = cleanText(src.name, 40); if (!name) e('name', '名前を入れてください');
  const others = existing.filter((c) => c.id !== id);
  let slug = typeof src.slug === 'string' && src.slug ? src.slug : slugFromName(name);
  if (!SLUG_RE.test(slug)) e('slug', '識別名は英小文字と数字の2〜16字です');
  else if (!src.slug) { let n = 2; const base = slug.slice(0, 14); while (others.some((c) => c.slug === slug)) slug = base + n++; }
  if (others.some((c) => c.slug === slug)) e('slug', 'この識別名は、すでに使われています');
  if (!id && others.length >= MAX_CONNECTORS) e('name', `連携アプリは${MAX_CONNECTORS}個までです`);
  const allowPrivate = Boolean(src.network?.allowPrivate);
  if (allowPrivate && !privateAllowed(true)) e('network.allowPrivate', 'このサービスでは、社内・自宅のネットワークのアドレスにはつなげません');
  const out = { id: id || randomId(), slug, name, type, enabled: src.enabled !== false, mcp: null, http: null, auth: { type: 'none' }, network: { allowPrivate: allowPrivate && privateAllowed(true) },
    description: cleanText(src.description, 80), grantAgents: [], limits: { perMinute: 30, timeoutMs: 15000, maxResultChars: 8000 }, tools: [], syncedAt: null };
  const lim = src.limits && typeof src.limits === 'object' ? src.limits : {};
  for (const [k, lo, hi] of [['perMinute', 1, 120], ['timeoutMs', 2000, 30000], ['maxResultChars', 500, 20000]]) {
    if (lim[k] !== undefined) { const n = Number(lim[k]); if (!Number.isInteger(n) || n < lo || n > hi) e(`limits.${k}`, `${k} は${lo}〜${hi}の整数です`); else out.limits[k] = n; }
  }
  // url
  const rawUrl = type === 'mcp' ? src.mcp?.url : src.http?.baseUrl;
  const u = checkUrl(rawUrl, { allowPrivate: out.network.allowPrivate });
  if (!u.ok) e(type === 'mcp' ? 'mcp.url' : 'http.baseUrl', u.message);
  else if (type === 'mcp') out.mcp = { url: u.url }; else out.http = { baseUrl: u.url.replace(/\/+$/, '') };
  // auth (the secret value itself is handled by the caller; the manifest keeps only the shape)
  const a = src.auth && typeof src.auth === 'object' ? src.auth : { type: 'none' };
  const allowed = type === 'mcp' ? MCP_AUTH : HTTP_AUTH;
  if (!allowed.includes(a.type || 'none')) e('auth.type', `この種類で使える認証: ${allowed.join(' / ')}`);
  else {
    out.auth = { type: a.type || 'none' };
    if (a.type === 'header') {
      const h = String(a.header || '');
      if (!HEADER_NAME.test(h) || (isForbiddenHeader(h))) e('auth.header', 'このヘッダー名は使えません'); else out.auth.header = h;
      const pre = String(a.prefix ?? ''); if (pre.length > 20 || /[\u0000-\u001f\u007f]/.test(pre)) e('auth.prefix', '頭に付ける文字が正しくありません'); else out.auth.prefix = pre;
    }
    if (a.type === 'oauth') {
      out.auth.scopes = Array.isArray(a.scopes) ? a.scopes.filter((s) => typeof s === 'string' && /^[\x21-\x7e]{1,80}$/.test(s)).slice(0, 20) : [];
      if (a.clientId !== undefined && a.clientId !== '') { const cid = String(a.clientId); if (!/^[\x21-\x7e]{1,300}$/.test(cid)) e('auth.clientId', 'クライアントIDが正しくありません'); else out.auth.clientId = cid; }
    }
  }
  if (Array.isArray(src.grantAgents)) out.grantAgents = [...new Set(src.grantAgents.filter((x) => typeof x === 'string' && /^[a-z_]{1,24}$/.test(x)))].slice(0, 30);
  if (type === 'http') {
    const tools = Array.isArray(src.tools) ? src.tools : [];
    if (tools.length > MAX_HTTP_TOOLS) e('tools', `道具は${MAX_HTTP_TOOLS}個までです`);
    const seen = new Set();
    out.tools = tools.slice(0, MAX_HTTP_TOOLS).map((t, i) => validateHttpTool(t, i, errs, seen)).filter(Boolean);
  } else if (Array.isArray(src.tools) && src.tools.length) e('tools', 'MCP の道具は、サーバーから取り込みます（手で入れることはできません）');
  if (errs.length) return { ok: false, errors: errs };
  return { ok: true, manifest: out };
}

// ------------------------------------------------------------------ MCP tools from a server (untrusted) -> manifest entries
/**
 * Merge a freshly listed set of remote tools into the stored ones. Owner choices (enabled / approval / expose) survive only for a tool whose pin (hash) is
 * unchanged. A tool whose text, parameters or hints changed is DISABLED, its approval is reset to "ask", and it waits for the owner to look at the difference
 * and approve it again. New tools arrive disabled when `first` is false (the owner reviews them), and with safe defaults when it is the first sync.
 * @returns {{tools:object[], added:string[], changed:string[], removed:string[], skipped:{name:string, reason:string}[]}}
 */
export function mergeRemoteTools(stored, remote, { first = false } = {}) {
  const byRemote = new Map(stored.map((t) => [t.remoteName, t]));
  const usedNames = new Set(); const tools = []; const added = [], changed = [], skipped = [];
  const seenRemote = new Set();
  for (const r of remote.slice(0, MAX_TOOLS)) {
    const remoteName = String(r?.name || '').slice(0, 128);
    if (!remoteName || seenRemote.has(remoteName)) { skipped.push({ name: remoteName || '?', reason: '名前が空か重複しています' }); continue; }
    seenRemote.add(remoteName);
    const inputSchema = cleanSchema(r.inputSchema);
    if (!inputSchema) { skipped.push({ name: remoteName, reason: '引数の定義が大きすぎるか、使えない形です' }); continue; }
    const annotations = cleanAnnotations(r.annotations);
    const description = cleanText(r.description || r.title || remoteName, DESC_MAX);
    const hash = toolHash({ description: r.description || r.title || remoteName, inputSchema, annotations });
    const prev = byRemote.get(remoteName);
    let name = prev?.name || localToolName(remoteName); if (!prev) { let n = 2; const base = name.slice(0, 36); while (usedNames.has(name) || stored.some((t) => t.name === name)) name = base + '_' + n++; }
    usedNames.add(name);
    const destructive = annotations.destructiveHint === true;
    const base = { name, remoteName, description, inputSchema, annotations, hash };
    if (!prev) {
      added.push(name);
      tools.push({ ...base, enabled: first && !destructive, expose: 'pinned', approval: destructive ? 'ask_high' : 'ask', danger: destructive ? 'high' : 'normal', ...(first ? {} : { isNew: true }) });
    } else if (prev.hash === hash) {
      const { needsReapproval, prevDef, ...keep } = prev;   // unchanged since the owner last decided (a pending re-approval stays pending)
      tools.push({ ...keep, ...base, ...(needsReapproval ? { needsReapproval, prevDef } : {}) });
    } else {
      changed.push(name);
      tools.push({ ...prev, ...base, enabled: false, approval: destructive ? 'ask_high' : 'ask', danger: destructive || prev.danger === 'high' ? 'high' : 'normal', needsReapproval: true,
        prevDef: prev.needsReapproval && prev.prevDef ? prev.prevDef : { description: prev.description, inputSchema: prev.inputSchema, annotations: prev.annotations || {}, hash: prev.hash } });
    }
  }
  const removed = stored.filter((t) => !seenRemote.has(t.remoteName)).map((t) => t.name);
  return { tools, added, changed, removed, skipped };
}

/** MCP tool prefs from the owner (PATCH): only these three fields, only valid values. Re-approval needs the hash the owner saw. */
export function applyToolPrefs(tools, prefs, { isMcp }) {
  const errs = []; const out = tools.map((t) => ({ ...t }));
  for (const [name, p] of Object.entries(prefs && typeof prefs === 'object' ? prefs : {})) {
    const t = out.find((x) => x.name === name); if (!t) { errs.push({ path: `tools.${name}`, message: '道具が見つかりません' }); continue; }
    if (p.approval !== undefined) {
      if (!APPROVALS.includes(p.approval)) { errs.push({ path: `tools.${name}.approval`, message: '承認の設定が正しくありません' }); continue; }
      t.approval = p.approval;
    }
    if (p.expose !== undefined) { if (!['pinned', 'gateway'].includes(p.expose)) { errs.push({ path: `tools.${name}.expose`, message: 'expose が正しくありません' }); continue; } t.expose = p.expose; }
    if (p.enabled !== undefined) {
      t.enabled = p.enabled === true;
      if (t.enabled && t.needsReapproval) {
        if (p.ackHash !== t.hash) { errs.push({ path: `tools.${name}`, message: '内容が変わった道具です。差分を確認して、もう一度承認してください' }); t.enabled = false; continue; }
        delete t.needsReapproval; delete t.prevDef;
      }
      if (t.enabled) delete t.isNew;
    }
    const danger = t.danger === 'high' || t.approval === 'ask_high' || t.annotations?.destructiveHint === true || t.method === 'DELETE';
    t.danger = danger ? 'high' : 'normal';
    if (danger && t.approval === 'ask') t.approval = 'ask_high';
    if (t.approval === 'auto') {
      const ro = isMcp ? t.annotations?.readOnlyHint === true : t.readOnly === true;
      if (!ro) { errs.push({ path: `tools.${name}.approval`, message: '「読み取り専用」と示されていない道具は、自動承認にできません' }); t.approval = 'ask'; }
      else if (danger) { errs.push({ path: `tools.${name}.approval`, message: '危険度が高い道具は、自動承認にできません' }); t.approval = 'ask_high'; }
    }
  }
  return { tools: out, errors: errs };
}

/** Which tools are really pinned in a Live session: at most 24 in all, small schemas only, within the byte budget; the rest go through the gateway. */
export function allocateExposure(connectors) {
  let pinned = 0, bytes = 0; const out = new Map();
  for (const c of connectors) {
    if (!c.enabled) continue;
    for (const t of c.tools || []) {
      if (!t.enabled || t.needsReapproval || t.approval === 'off') continue;
      let mode = t.expose === 'gateway' ? 'gateway' : 'pinned';
      if (mode === 'pinned') {
        const size = JSON.stringify(t.inputSchema || {}).length + (t.description || '').length + 80;
        if (pinned >= MAX_PINNED || JSON.stringify(t.inputSchema || {}).length > PINNED_SCHEMA_MAX || bytes + size > PINNED_DECL_BUDGET) mode = 'gateway'; else { pinned++; bytes += size; }
      }
      out.set(`${c.id}:${t.name}`, mode);
    }
  }
  return out;
}

// ------------------------------------------------------------------ owner-facing views (never a secret)
const last4 = (v) => (typeof v === 'string' && v.length >= 8 ? v.slice(-4) : null);
export function connectorStatus(c, { oauth } = {}) {
  if (c.lastError) return 'error';
  if (c.auth?.type === 'oauth' && !(oauth?.connected)) return 'needs_auth';
  if (c.auth?.type === 'oauth' && oauth?.state === 'reauth_required') return 'needs_auth';
  if ((c.tools || []).some((t) => t.needsReapproval)) return 'needs_reapproval';
  return 'connected';
}
export function publicConnector(c, { secrets = {}, oauth = null } = {}) {
  const sec = getSecret(secrets, c.id);
  const alloc = allocateExposure([c]);
  return {
    id: c.id, slug: c.slug, name: c.name, type: c.type, enabled: c.enabled, description: c.description || '', host: hostOf(c), url: c.type === 'mcp' ? c.mcp.url : c.http.baseUrl,
    auth: { ...c.auth, set: Boolean(sec), last4: last4(sec) || null, ...(c.auth.type === 'oauth' ? { connected: Boolean(oauth?.connected), oauthState: oauth?.state || null, clientIdSet: Boolean(c.auth.clientId || oauth?.registered), clientSecretSet: Boolean(getSecret(secrets, c.id, 'oauthSecret')) } : {}) },
    network: c.network, grantAgents: c.grantAgents || [], limits: c.limits, syncedAt: c.syncedAt || null, lastError: c.lastError || null, status: connectorStatus(c, { oauth }),
    serverInfo: c.serverInfo || null,
    tools: (c.tools || []).map((t) => ({
      name: t.name, fullName: toolFullName(c, t), remoteName: t.remoteName || null, enabled: t.enabled, expose: t.expose, effectiveExpose: alloc.get(`${c.id}:${t.name}`) || null, approval: t.approval, danger: t.danger,
      description: t.description, inputSchema: t.inputSchema, annotations: t.annotations || {}, readOnly: c.type === 'mcp' ? t.annotations?.readOnlyHint === true : t.readOnly === true,
      hash: t.hash || null, needsReapproval: Boolean(t.needsReapproval), isNew: Boolean(t.isNew), prevDef: t.prevDef || null,
      ...(c.type === 'http' ? { method: t.method, path: t.path, query: t.query, headers: t.headers, body: t.body, response: t.response } : {}),
    })),
  };
}
