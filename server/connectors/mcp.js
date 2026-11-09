// MCP client over Streamable HTTP (docs/ELVAR_ARCHITECTURE.md 5.4): initialize -> notifications/initialized -> tools/list (paged) / tools/call.
// Replies may be plain JSON or an SSE stream (the matching JSON-RPC message is picked out; a stream that stays open is cut once it has arrived).
// Only TOOLS are supported: resources, prompts, sampling, elicitation and any request the server makes of us are ignored.
// Every request goes through safeFetch. Everything the server says is untrusted data (cleaned and capped by manifest.js before it is kept).
import crypto from 'node:crypto';
import { safeFetch } from '../net/safe-fetch.js';
import { getStore } from '../store/index.js';
import { ConnectorError, toConnectorError } from './errors.js';
import { cleanText, cleanMessage } from './manifest.js';
import { shapeOutput } from './http.js';
import { currentScope } from './data.js';

// The newest revision this client was written against first. NOTE: the MCP spec revisions were not re-checked online while writing this (no network access
// to the spec site from the build environment); the server answers with the version it speaks and we accept any listed here.
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const CLIENT_INFO = { name: 'elvar', version: '0.1' };
const SESSION_TTL = 3600;
const sessKey = (id) => currentScope().sessKey(id);

/** Parse an SSE body into JSON-RPC messages (only `data:` lines; multi-line data joined). */
export function parseSse(text) {
  const out = [];
  for (const ev of String(text).split(/\r?\n\r?\n/)) {
    const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    try { out.push(JSON.parse(data)); } catch { /* an incomplete event at the end of the buffer */ }
  }
  return out;
}
const isResponseFor = (m, id) => m && typeof m === 'object' && m.id === id && (Object.hasOwn(m, 'result') || Object.hasOwn(m, 'error')) && !m.method;

/** Decode a reply body (JSON or SSE) and return the response to request `id`. */
export function pickResponse(res, id) {
  const ct = String(res.headers['content-type'] || '');
  const text = res.text();
  if (/text\/event-stream/i.test(ct)) { const m = parseSse(text).find((x) => isResponseFor(x, id)); return m || null; }
  try { const j = JSON.parse(text); const arr = Array.isArray(j) ? j : [j]; return arr.find((x) => isResponseFor(x, id)) || null; } catch { return null; }
}

/**
 * @param {{url:string, headers?:()=>Promise<object>|object, connectorId?:string, timeoutMs?:number, allowPrivate?:boolean, fetchImpl?:Function, useSessionStore?:boolean}} o
 */
export function createMcpClient({ url, headers = () => ({}), connectorId = null, timeoutMs = 15000, allowPrivate = false, fetchImpl = safeFetch, useSessionStore = true }) {
  let sid = null, proto = null, seq = 0, ready = false;
  const store = () => { try { return useSessionStore && connectorId ? getStore() : null; } catch { return null; } };

  async function post(body, { expectId = null, maxBytes = 2_097_152 } = {}) {
    const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(await headers()) };
    if (proto) h['mcp-protocol-version'] = proto;
    if (sid) h['mcp-session-id'] = sid;
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: h, body: JSON.stringify(body), timeoutMs, allowPrivate, maxBytes,
        stopWhen: expectId === null ? undefined : (buf, hd) => /text\/event-stream/i.test(hd['content-type'] || '') && parseSse(buf.toString('utf8')).some((m) => isResponseFor(m, expectId)) });
    } catch (e) { throw toConnectorError(e); }
    if (res.status === 401) throw new ConnectorError('unauthorized', '認証が必要です（トークンが違うか、期限切れです）', 401, { wwwAuthenticate: res.headers['www-authenticate'] || '' });
    if (res.status === 403) throw new ConnectorError('forbidden', '相手のサービスが、アクセスを許可しませんでした', 403);
    if (res.status === 404 && sid) throw new ConnectorError('session', 'セッションが切れました', 404);
    if (res.status === 202 && expectId === null) return { res, msg: null };
    if (res.status < 200 || res.status >= 300) throw new ConnectorError('http_error', `MCPサーバーがエラーを返しました（HTTP ${res.status}）${res.text() ? '：' + cleanMessage(res.text(), 160) : ''}`, 502);
    if (expectId === null) return { res, msg: null };
    if (res.truncated && !res.stopped) throw new ConnectorError('too_large', '応答が大きすぎます', 502);
    const msg = pickResponse(res, expectId);
    if (!msg) throw new ConnectorError('bad_response', 'MCPサーバーの応答を読み取れませんでした', 502);
    if (msg.error) {
      const code = Number(msg.error.code);
      throw new ConnectorError(/session|initializ/i.test(String(msg.error.message)) ? 'session' : 'rpc_error', `MCPサーバーのエラー：${cleanMessage(msg.error.message || code, 200)}`, 502, { rpcCode: code });
    }
    return { res, msg };
  }
  const rpc = (method, params) => { const id = ++seq; return post({ jsonrpc: '2.0', id, method, params }, { expectId: id }).then((r) => ({ ...r, id })); };

  async function initialize() {
    sid = null; proto = null;
    const { res, msg } = await rpc('initialize', { protocolVersion: PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: CLIENT_INFO });
    const v = msg.result?.protocolVersion;
    if (!PROTOCOL_VERSIONS.includes(v)) throw new ConnectorError('protocol', `このサーバーの MCP バージョン（${cleanText(v, 20) || '不明'}）には対応していません`, 502);
    proto = v;
    const got = res.headers['mcp-session-id'];
    if (got) { if (!/^[\x21-\x7e]{1,256}$/.test(got)) throw new ConnectorError('bad_response', 'セッションIDが正しくありません', 502); sid = got; }
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    ready = true;
    const s = store(); if (s && sid) await s.set(sessKey(connectorId), { sid, proto }, { ttlSec: SESSION_TTL }).catch(() => {});
    const info = msg.result?.serverInfo || {};
    return { serverInfo: { name: cleanText(info.title || info.name, 60), version: cleanText(info.version, 30) }, protocolVersion: v };
  }
  /** Reuse a stored session when there is one ("if we have it"), otherwise initialize. */
  async function ensure() {
    if (ready) return;
    const s = store(); const saved = s ? await s.get(sessKey(connectorId)).catch(() => null) : null;
    if (saved?.sid && PROTOCOL_VERSIONS.includes(saved.proto)) { sid = saved.sid; proto = saved.proto; ready = true; return; }
    await initialize();
  }
  /** Run `fn`; on a lost session, initialize again and retry once. */
  async function withSession(fn) {
    await ensure();
    try { return await fn(); }
    catch (e) {
      if (e.code !== 'session') throw e;
      const s = store(); if (s) await s.del(sessKey(connectorId)).catch(() => {});
      ready = false; await initialize(); return fn();
    }
  }

  async function listTools() {
    return withSession(async () => {
      const tools = []; let cursor;
      for (let page = 0; page < 10; page++) {
        const { msg } = await rpc('tools/list', cursor ? { cursor } : {});
        const list = msg.result?.tools; if (!Array.isArray(list)) throw new ConnectorError('bad_response', '道具の一覧を読み取れませんでした', 502);
        tools.push(...list.filter((t) => t && typeof t === 'object')); if (tools.length > 300) break;
        cursor = typeof msg.result.nextCursor === 'string' && msg.result.nextCursor ? msg.result.nextCursor : null; if (!cursor) break;
      }
      return tools;
    });
  }

  /** @returns {Promise<{value:any, truncated:boolean}>} @throws ConnectorError (a tool-level error is thrown too, with the server's short text) */
  async function callTool(name, args, { maxChars = 8000 } = {}) {
    const { msg } = await withSession(() => rpc('tools/call', { name, arguments: args || {} }));
    const r = msg.result || {};
    const parts = Array.isArray(r.content) ? r.content : [];
    const text = parts.map((p) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : p?.type ? `[${cleanText(p.type, 20)} は省略]` : '')).filter(Boolean).join('\n');
    if (r.isError) throw new ConnectorError('tool_error', `相手のツールがエラーを返しました：${cleanMessage(text || '詳細なし', 240)}`, 502);
    const value = r.structuredContent && !text ? r.structuredContent : text;
    return shapeOutput(value, maxChars);
  }
  const close = async () => { const s = store(); if (s) await s.del(sessKey(connectorId)).catch(() => {}); };
  return { initialize, listTools, callTool, close, get sessionId() { return sid; }, get protocolVersion() { return proto; } };
}

/** Fresh random id for tests / logs. */
export const _rid = () => crypto.randomBytes(4).toString('hex');
