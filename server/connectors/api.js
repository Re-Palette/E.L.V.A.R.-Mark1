// /api/elvar/connectors* handlers (docs/ELVAR_ARCHITECTURE.md 5): list / add / change / delete / sync / OAuth. Every handler returns { status, body }.
// Secrets are write-only (bearer tokens, header values, OAuth client secrets: stored in the vault doc, never returned). Anything a remote MCP server says is
// cleaned and capped (manifest.js) before it is stored. Network work happens BEFORE the vault write (the write may retry on a version conflict).
import { getStore } from '../store/index.js';
import * as V from '../config/vault.js';
import { rateLimit, clientIp } from '../config/auth.js';
import { handleCallback } from '../oauth/flow.js';
import { safeFetchAsFetch } from '../net/safe-fetch.js';
import { AGENTS } from '../agents/registry.js';
import { redirectUriFor } from '../google/connect.js';
import { validateManifest, applyToolPrefs, mergeRemoteTools, publicConnector, randomId, cleanMessage, cleanText, MAX_CONNECTORS, MAX_PINNED, allocateExposure } from './manifest.js';
import { probeHttp } from './http.js';
import { clientFor } from './index.js';
import { toConnectorError, ConnectorError } from './errors.js';
import { startConnectorOAuth, claimConnectorOAuth, readTok, oauthView, deleteTok, CALLBACK_PATH } from './mcp-oauth.js';
import { STATE_RE } from '../oauth/flow.js';
import { currentScope, exportConnectors, deleteAllConnectors } from './data.js';

const audit = (event, extra = {}) => console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event, ...extra }));
const bad = (status, error, message, extra = {}) => ({ status, body: { ok: false, error, ...(message ? { message } : {}), ...extra } });
const writable = (a) => a.mode === 'vault';
const notWritable = (a) => bad(409, 'read_only', a.mode === 'env' ? '環境変数モードでは、連携アプリは使えません。アプリの中でセットアップ（オーナーパスワード）をしてください' : 'まだセットアップされていません');
const AGENT_IDS = new Set(Object.keys(AGENTS));
const secretOk = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(v);
const known = (list) => (Array.isArray(list) ? list.filter((x) => AGENT_IDS.has(x)) : undefined);

async function oauthFor(cfg, c) {
  if (c.auth?.type !== 'oauth') return null;
  try { const store = getStore(); return oauthView(store && cfg.connectorKey ? (await readTok(store, cfg.connectorKey, c.id))?.data : null); } catch { return oauthView(null); }
}
async function viewOf(cfg, c, secrets) {
  const sec = secrets || currentScope().secretsMap(cfg.connectors || [], cfg.cxSecret);
  return publicConnector(c, { secrets: sec, oauth: await oauthFor(cfg, c) });
}
const meta = (cfg) => {
  const alloc = allocateExposure(cfg.connectors || []);
  return { agents: Object.entries(AGENTS).filter(([, d]) => d.label).map(([id, d]) => ({ id, label: d.label })), maxConnectors: MAX_CONNECTORS, maxPinned: MAX_PINNED, pinned: [...alloc.values()].filter((m) => m === 'pinned').length, vercel: Boolean(process.env.VERCEL) };
};
const find = (cfg, id) => (cfg.connectors || []).find((c) => c.id === id);

export async function listConnectors({ cfg, auth }) {
  const views = []; for (const c of cfg.connectors || []) views.push(await viewOf(cfg, c));
  return { status: 200, body: { ok: true, writable: writable(auth), connectors: views, ...meta(cfg) } };
}
/** GET export [owner]: every connector as JSON, without secrets or tokens (the owner's copy of their own data). */
export async function exportAll({ auth }) {
  if (!writable(auth)) return notWritable(auth);
  const store = getStore(); if (!store) return bad(503, 'storage_required', '保存先がありません');
  const { doc } = await V.updateDoc(store, auth.dek, (d) => d);   // a fresh read of the vault doc
  audit('connectors-exported', { by: auth.deviceId, count: currentScope().connectorsOf(doc).length });
  return { status: 200, body: exportConnectors(doc) };
}
/** POST delete-all { confirm:'delete' } [owner]: removes every connector, its secrets, OAuth tokens and sessions. */
export async function deleteAll({ body, auth }) {
  if (!writable(auth)) return notWritable(auth);
  const store = getStore(); if (!store) return bad(503, 'storage_required', '保存先がありません');
  if (body?.confirm !== 'delete') return bad(400, 'confirm_required', '確認のため、confirm: "delete" を送ってください');
  const r = await deleteAllConnectors(store, auth.dek);
  audit('connectors-deleted-all', { by: auth.deviceId, count: r.connectors });
  return { status: 200, body: { ok: true, ...r } };
}
export async function getConnector({ cfg, params }) {
  const c = find(cfg, params.id); if (!c) return bad(404, 'not_found', '連携アプリが見つかりません');
  return { status: 200, body: { ok: true, connector: await viewOf(cfg, c) } };
}

/** The write-only secrets of a request body -> { auth?: string|null, oauthSecret?: string|null } (undefined = leave as it is). */
function secretsFrom(body) {
  const a = body?.auth && typeof body.auth === 'object' ? body.auth : {}, out = {};
  if (a.secret === null) out.auth = null; else if (a.secret !== undefined) { if (!secretOk(String(a.secret).trim())) return { error: '認証の値が正しくありません（空白・改行は入れられません）' }; out.auth = String(a.secret).trim(); }
  if (a.clientSecret === null) out.oauthSecret = null; else if (a.clientSecret !== undefined && a.clientSecret !== '') { if (!secretOk(String(a.clientSecret).trim())) return { error: 'クライアントシークレットが正しくありません' }; out.oauthSecret = String(a.clientSecret).trim(); }
  return out;
}
const needsSecret = (m) => ['bearer', 'header', 'basic'].includes(m.auth.type);
const applySecrets = (d, id, s, m) => {
  const S = currentScope();
  if (s.auth === null || !needsSecret(m)) S.setSecret(d, id, 'auth', null); else if (s.auth) S.setSecret(d, id, 'auth', s.auth);
  if (s.oauthSecret === null || m.auth.type !== 'oauth') S.setSecret(d, id, 'oauthSecret', null); else if (s.oauthSecret) S.setSecret(d, id, 'oauthSecret', s.oauthSecret);
};

export async function createConnector({ body, auth, cfg }) {
  if (!writable(auth)) return notWritable(auth);
  const store = getStore(); if (!store) return bad(503, 'storage_required', '保存先がありません');
  const sec = secretsFrom(body); if (sec.error) return bad(422, 'invalid', sec.error);
  const id = randomId(); let result = null;
  const draft = { ...body, tools: body?.type === 'http' ? body.tools : undefined, enabled: body?.type === 'mcp' ? false : body?.enabled };   // an MCP connector starts disabled: it is switched on after its tools were reviewed
  const first = validateManifest(draft, { existing: cfg.connectors || [], id }); if (!first.ok) return bad(422, 'invalid', '入力を確認してください', { errors: first.errors });
  if ((cfg.connectors || []).length >= MAX_CONNECTORS) return bad(422, 'invalid', `連携アプリは${MAX_CONNECTORS}個までです`);
  if (needsSecret(first.manifest) && !sec.auth) return bad(422, 'invalid', '認証の値（トークンなど）を入れてください', { errors: [{ path: 'auth.secret', message: '認証の値を入れてください' }] });
  const { doc } = await V.updateDoc(store, auth.dek, (d) => {
    d.connectors = Array.isArray(d.connectors) ? d.connectors : [];
    const v = validateManifest(draft, { existing: d.connectors, id });
    if (!v.ok || d.connectors.length >= MAX_CONNECTORS) { result = v.ok ? { ok: false, errors: [{ path: 'name', message: `連携アプリは${MAX_CONNECTORS}個までです` }] } : v; return d; }
    d.connectors.push(v.manifest); applySecrets(d, id, sec, v.manifest); result = v; return d;
  });
  if (!result.ok) return bad(422, 'invalid', '入力を確認してください', { errors: result.errors });
  audit('connector-created', { id, type: result.manifest.type, host: new URL(result.manifest.type === 'mcp' ? result.manifest.mcp.url : result.manifest.http.baseUrl).host, by: auth.deviceId });
  const c = doc.connectors.find((x) => x.id === id);
  return { status: 200, body: { ok: true, connector: publicConnector(c, { secrets: doc.secrets, oauth: null }) } };
}

export async function patchConnector({ body, auth, cfg, params }) {
  if (!writable(auth)) return notWritable(auth);
  const store = getStore(); if (!store) return bad(503, 'storage_required', '保存先がありません');
  const cur = find(cfg, params.id); if (!cur) return bad(404, 'not_found', '連携アプリが見つかりません');
  const sec = secretsFrom(body); if (sec.error) return bad(422, 'invalid', sec.error);
  let result = null, urlChanged = false, errors = [];
  const { doc } = await V.updateDoc(store, auth.dek, (d) => {
    const list = Array.isArray(d.connectors) ? d.connectors : []; const i = list.findIndex((c) => c.id === params.id);
    if (i < 0) { result = { ok: false, notFound: true }; return d; }
    const c = list[i], b = body && typeof body === 'object' ? body : {};
    const merged = { type: c.type, slug: c.slug, name: b.name ?? c.name, description: b.description ?? c.description, enabled: b.enabled ?? c.enabled,
      mcp: c.type === 'mcp' ? { url: b.mcp?.url ?? c.mcp.url } : null, http: c.type === 'http' ? { baseUrl: b.http?.baseUrl ?? c.http.baseUrl } : null,
      auth: { ...c.auth, ...(b.auth && typeof b.auth === 'object' ? Object.fromEntries(Object.entries(b.auth).filter(([k]) => !['secret', 'clientSecret'].includes(k))) : {}) },
      network: { ...c.network, ...(b.network || {}) }, limits: { ...c.limits, ...(b.limits || {}) }, grantAgents: known(b.grantAgents) ?? c.grantAgents,
      tools: c.type === 'http' ? (Array.isArray(b.tools) ? b.tools : c.tools) : undefined };
    const v = validateManifest(merged, { existing: list, id: c.id });
    if (!v.ok) { result = v; return d; }
    const m = v.manifest; m.syncedAt = c.syncedAt; m.lastError = c.lastError; m.serverInfo = c.serverInfo;
    if (c.type === 'mcp') m.tools = c.tools;
    urlChanged = (c.type === 'mcp' ? c.mcp.url !== m.mcp.url : c.http.baseUrl !== m.http.baseUrl);
    if (urlChanged && c.type === 'mcp') { m.tools = []; m.syncedAt = null; m.serverInfo = null; m.lastError = null; m.enabled = false; }
    if (b.toolPrefs && typeof b.toolPrefs === 'object') { const r = applyToolPrefs(m.tools, b.toolPrefs, { isMcp: c.type === 'mcp' }); m.tools = r.tools; errors = r.errors; }
    list[i] = m; d.connectors = list; applySecrets(d, c.id, sec, m); result = v; return d;
  });
  if (result?.notFound) return bad(404, 'not_found', '連携アプリが見つかりません');
  if (!result?.ok) return bad(422, 'invalid', '入力を確認してください', { errors: result?.errors || [] });
  if (urlChanged || sec.auth !== undefined) { try { await clientFor(cfg, cur, { useSessionStore: true }).close(); } catch { /* ignore */ } }
  if (urlChanged) await deleteTok(store, params.id).catch(() => {});
  audit('connector-updated', { id: params.id, by: auth.deviceId, fields: Object.keys(body || {}).filter((k) => k !== 'auth'), secret: sec.auth === undefined ? undefined : sec.auth === null ? 'removed' : 'replaced', toolPrefs: Object.keys(body?.toolPrefs || {}).length || undefined });
  const c = doc.connectors.find((x) => x.id === params.id);
  const fresh = { ...cfg, connectors: doc.connectors, cxSecret: (id, what = 'auth') => currentScope().getSecret(doc.secrets, id, what) };
  return { status: 200, body: { ok: true, connector: await viewOf(fresh, c, doc.secrets), ...(errors.length ? { warnings: errors } : {}) } };
}

export async function deleteConnector({ auth, cfg, params }) {
  if (!writable(auth)) return notWritable(auth);
  const store = getStore(); if (!store) return bad(503, 'storage_required', '保存先がありません');
  const cur = find(cfg, params.id); if (!cur) return bad(404, 'not_found', '連携アプリが見つかりません');
  await V.updateDoc(store, auth.dek, (d) => { d.connectors = (d.connectors || []).filter((c) => c.id !== params.id); currentScope().purgeSecrets(d, params.id); return d; });
  await deleteTok(store, params.id).catch(() => {}); try { await clientFor(cfg, cur).close(); } catch { /* ignore */ }
  audit('connector-deleted', { id: params.id, by: auth.deviceId });
  return { status: 200, body: { ok: true } };
}

/** "Test connection" and "sync": MCP -> initialize + tools/list, merged with the pins; HTTP -> reachability of the base URL. */
export async function syncConnector({ auth, cfg, params }) {
  if (!writable(auth)) return notWritable(auth);
  const store = getStore(); if (!store) return bad(503, 'storage_required', '保存先がありません');
  const c = find(cfg, params.id); if (!c) return bad(404, 'not_found', '連携アプリが見つかりません');
  const setError = async (msg) => { await V.updateDoc(store, auth.dek, (d) => { const x = (d.connectors || []).find((y) => y.id === c.id); if (x) { if (msg) x.lastError = msg; else delete x.lastError; } return d; }).catch(() => {}); };
  if (c.type === 'http') {
    const probe = await probeHttp(c, cfg.cxSecret(c.id));
    await V.updateDoc(store, auth.dek, (d) => { const x = (d.connectors || []).find((y) => y.id === c.id); if (x) { x.syncedAt = Date.now(); if (probe.reachable) delete x.lastError; else x.lastError = probe.error || `接続できませんでした（HTTP ${probe.status}）`; } return d; });
    const { doc } = await V.updateDoc(store, auth.dek, (d) => d);
    const nc = doc.connectors.find((x) => x.id === c.id);
    audit('connector-synced', { id: c.id, reachable: probe.reachable, by: auth.deviceId });
    return { status: 200, body: { ok: probe.reachable, probe, message: probe.reachable ? undefined : (probe.error || `相手が HTTP ${probe.status} を返しました`), connector: publicConnector(nc, { secrets: doc.secrets, oauth: null }) } };
  }
  let info, remote;
  try { const cl = clientFor(cfg, c); info = await cl.initialize(); remote = await cl.listTools(); }
  catch (e) {
    const ce = toConnectorError(e); await setError(ce.message);
    audit('connector-sync-failed', { id: c.id, code: ce.code, by: auth.deviceId });
    return { status: 200, body: { ok: false, error: ce.code, message: ce.message, needsAuth: ce.code === 'unauthorized', oauthPossible: ce.code === 'unauthorized' && c.auth.type === 'none' } };
  }
  let diff = null;
  const { doc } = await V.updateDoc(store, auth.dek, (d) => {
    const x = (d.connectors || []).find((y) => y.id === c.id); if (!x) return d;
    const m = mergeRemoteTools(x.tools || [], remote, { first: !x.syncedAt });
    x.tools = m.tools; x.syncedAt = Date.now(); delete x.lastError; x.serverInfo = info.serverInfo; diff = { added: m.added, changed: m.changed, removed: m.removed, skipped: m.skipped };
    return d;
  });
  const nc = doc.connectors.find((x) => x.id === c.id);
  audit('connector-synced', { id: c.id, tools: nc.tools.length, added: diff.added.length, changed: diff.changed, removed: diff.removed.length, by: auth.deviceId });
  const fresh = { ...cfg, connectors: doc.connectors };
  return { status: 200, body: { ok: true, diff, connector: publicConnector(nc, { secrets: doc.secrets, oauth: await oauthFor(fresh, nc) }) } };
}

// ---------------------------------------------------------------- OAuth
export async function oauthStart({ req, auth, cfg, params }) {
  if (!writable(auth)) return notWritable(auth);
  const store = getStore(); if (!store) return bad(503, 'storage_required', '保存先がありません');
  const c = find(cfg, params.id); if (!c) return bad(404, 'not_found', '連携アプリが見つかりません');
  if (c.type !== 'mcp' || c.auth.type !== 'oauth') return bad(400, 'not_oauth', 'この連携アプリは OAuth を使いません');
  const re = redirectUriFor(req); if (!re.ok) return bad(400, 'origin_unknown', re.error);
  const redirectUri = re.origin + CALLBACK_PATH;
  try {
    const f = await startConnectorOAuth({ store, key: cfg.connectorKey, c, redirectUri, clientSecret: cfg.cxSecret(c.id, 'oauthSecret'), deviceId: auth.deviceId || null });
    audit('connector-oauth-started', { id: c.id, by: auth.deviceId });
    return { status: 200, body: { ok: true, url: f.url, state: f.state, redirectUri } };
  } catch (e) { const ce = toConnectorError(e); return bad(ce.status >= 400 && ce.status < 500 ? ce.status : 502, ce.code, ce.message); }
}
export async function oauthClaim({ body, auth, cfg, params }) {
  if (!writable(auth)) return notWritable(auth);
  const store = getStore(); if (!store) return bad(503, 'storage_required', '保存先がありません');
  const c = find(cfg, params.id); if (!c) return bad(404, 'not_found', '連携アプリが見つかりません');
  const state = String(body?.state || ''); if (!STATE_RE.test(state)) return bad(400, 'bad_state', 'ログインの情報が正しくありません');
  const r = await claimConnectorOAuth({ store, key: cfg.connectorKey, c, state });
  if (r.status === 'pending') return { status: 200, body: { ok: true, pending: true } };
  if (r.status === 'missing') return { status: 200, body: { ok: true, claimed: false } };
  if (r.status === 'error') return { status: 200, body: { ok: false, error: r.error, message: `認証できませんでした（${cleanText(r.error, 40)}${r.description ? '：' + cleanText(r.description, 120) : ''}）` } };
  await V.updateDoc(store, auth.dek, (d) => { const x = (d.connectors || []).find((y) => y.id === c.id); if (x) delete x.lastError; return d; }).catch(() => {});
  audit('connector-oauth-connected', { id: c.id, by: auth.deviceId });
  return { status: 200, body: { ok: true, claimed: true } };
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, inner) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#080604;color:#f6efe2;font:16px/1.8 "Barlow Semi Condensed","Noto Sans JP",system-ui,sans-serif}main{max-width:560px;margin:0 auto;padding:40px 20px}h1{font:400 20px/1.4 "Cinzel",serif;letter-spacing:3px;color:#FFD99A;margin:0 0 14px}p{margin:8px 0;color:#e9dcc4}.ok{color:#9fe3a8}.warn{color:#ff7a4a}.box{border:1px solid rgba(232,185,106,.45);padding:16px 18px;background:#100c07}a{color:#E8B96A}</style></head><body><main><div class="box">${inner}</div></main></body></html>`;
const FAIL = { bad_state: '無効なリクエストです。', unknown_state: '無効か、期限（10分）が切れています。', used: 'すでに使われています。', denied: '相手のサービスで許可されませんでした。', no_refresh_token: '更新用のトークンが返りませんでした。', exchange_failed: 'トークンの発行を断られました。', network: '通信に失敗しました。' };

/** GET /api/elvar/oauth/callback [state]: the browser returns from the MCP server's login. The code is exchanged here (through safeFetch); the app claims the result. */
export async function oauthCallback({ req, query = {} }) {
  const headers = { 'content-security-policy': PAGE_CSP };
  const fail = (text, status) => ({ status, headers, html: page('連携できませんでした', `<h1>NOT CONNECTED</h1><p class="warn">${esc(text)}</p><p>アプリの設定の「連携アプリ」から、もう一度お試しください。</p><p><a href="/">アプリを開く</a></p>`) });
  const store = getStore(); if (!store) return fail('保存先がありません。', 503);
  if (!(await rateLimit(store, 'cxoauthcb', clientIp(req), 30, 600))) return fail('試行が多すぎます。しばらくしてからもう一度お試しください。', 429);
  const state = String(query.state || ''); if (!STATE_RE.test(state)) return fail(FAIL.bad_state, 403);
  const r = await handleCallback({ store, state, code: typeof query.code === 'string' ? query.code : '', error: typeof query.error === 'string' ? query.error : '', fetchImpl: safeFetchAsFetch() });
  audit('connector-oauth-callback', { ok: r.ok, reason: r.reason });
  if (!r.ok) return fail((FAIL[r.reason] || FAIL.exchange_failed) + (r.error ? `（${cleanText(r.error, 40)}）` : ''), r.reason === 'network' ? 502 : 400);
  return { status: 200, headers, html: page('連携しました', '<h1>CONNECTED</h1><p class="ok">認証を受け取りました。</p><p>E.L.V.A.R. のアプリに戻ってください。アプリが自動で接続を完了します。</p><p><a href="/">アプリを開く</a></p>') };
}
export { ConnectorError };
