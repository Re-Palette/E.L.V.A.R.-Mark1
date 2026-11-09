// /api/elvar/connectors* handlers (docs/ELVAR_ARCHITECTURE.md 5, docs/ELVAR_MULTIUSER.md 8.1): list / add / change / delete / sync / OAuth, for the signed-in user's
// OWN connectors. Every handler returns { status, body } and gets the router's context { user, body, params, req }.
// Secrets are write-only (bearer tokens, header values, OAuth client secrets: encrypted under the user's key, never returned). Anything a remote MCP server says is
// cleaned and capped (manifest.js) before it is stored. Network work happens BEFORE the database write. Everything reads and writes only the caller's rows
// (user.db(fn) = asUser, Row Level Security); another user's connector id is simply "not found".
import { getDb } from '../db/index.js';
import { getKeyring } from '../auth/keyring.js';
import { rateLimit } from '../auth/rate-limit.js';
import { invalidateUserConfig } from '../auth/load-user-config.js';
import { handleCallback, STATE_RE } from '../oauth/flow.js';
import { openPendingByState } from '../oauth/pending.js';
import { safeFetchAsFetch, privateAllowed } from '../net/safe-fetch.js';
import { AGENTS } from '../agents/registry.js';
import { redirectUriFor } from '../google/connect.js';
import { validateManifest, applyToolPrefs, mergeRemoteTools, publicConnector, randomId, cleanText, MAX_CONNECTORS, MAX_PINNED, allocateExposure } from './manifest.js';
import { probeHttp } from './http.js';
import { clientFor } from './index.js';
import { toConnectorError } from './errors.js';
import { startConnectorOAuth, claimConnectorOAuth, oauthView, CALLBACK_PATH } from './mcp-oauth.js';
import { secretName, secretsMap, exportConnectors, purgeConnectorData, deleteAllConnectors, providerOf } from './data.js';
import { revokeToken } from '../rights/revoke.js';

const audit = (event, extra = {}) => console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event, ...extra }));
const bad = (status, error, message, extra = {}) => ({ status, body: { ok: false, error, ...(message ? { message } : {}), ...extra } });
const NOT_FOUND = () => bad(404, 'not_found', '連携アプリが見つかりません');
const AGENT_IDS = new Set(Object.keys(AGENTS));
const secretOk = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(v);
const known = (list) => (Array.isArray(list) ? list.filter((x) => AGENT_IDS.has(x)) : undefined);
const idOk = (id) => /^[A-Za-z0-9_-]{1,40}$/.test(String(id));

/** The user's configuration, read fresh (the cached one may be 10 s old and the screens show what was just changed). */
const fresh = (user) => user.loadConfig({ fresh: true });
const secretsOf = (cfg) => secretsMap(cfg.connectors || [], cfg.cxSecret);
async function oauthViews(cfg) {
  if (!(cfg.connectors || []).some((c) => c.auth?.type === 'oauth')) return {};
  const toks = await cfg.db((r) => getKeyring().allTokens(r));
  return Object.fromEntries(toks.filter((t) => t.provider.startsWith('cx:')).map((t) => [t.provider.slice(3), oauthView(t.data)]));
}
const viewOf = (cfg, c, oauth) => publicConnector(c, { secrets: secretsOf(cfg), oauth: c.auth?.type === 'oauth' ? (oauth[c.id] || oauthView(null)) : null });
const meta = (cfg) => {
  const alloc = allocateExposure(cfg.connectors || []);
  // `vercel` tells the screen to hide "allow my home / office network": on the platform that is never possible (privateAllowed is false unless a single-user install opted in)
  return { agents: Object.entries(AGENTS).filter(([, d]) => d.label).map(([id, d]) => ({ id, label: d.label })), maxConnectors: MAX_CONNECTORS, maxPinned: MAX_PINNED, pinned: [...alloc.values()].filter((m) => m === 'pinned').length, vercel: !privateAllowed(true) };
};
const find = (cfg, id) => (cfg.connectors || []).find((c) => c.id === id);

export async function listConnectors({ user }) {
  const cfg = await fresh(user), oauth = await oauthViews(cfg);
  return { status: 200, body: { ok: true, writable: true, connectors: (cfg.connectors || []).map((c) => viewOf(cfg, c, oauth)), ...meta(cfg) } };
}
/** GET export: every connector as JSON, without secrets or tokens (the user's copy of their own data). */
export async function exportAll({ user }) {
  const cfg = await fresh(user);
  audit('connectors-exported', { uid: user.uid.uid, count: (cfg.connectors || []).length });
  return { status: 200, body: exportConnectors(cfg.connectors, secretsOf(cfg), user.uid.uid) };
}
/** POST delete-all { confirm:'delete' }: removes every connector, its secrets, OAuth tokens (revoked at the server when it allows it) and sessions. */
export async function deleteAll({ user, body }) {
  if (body?.confirm !== 'delete') return bad(400, 'confirm_required', '確認のため、confirm: "delete" を送ってください');
  const ring = getKeyring();
  const toks = (await user.db((r) => ring.allTokens(r))).filter((t) => t.provider.startsWith('cx:'));
  for (const t of toks) await revokeToken(t);   // best effort, before the tokens are deleted
  const res = await user.db((r) => deleteAllConnectors(r, ring));
  invalidateUserConfig(user.uid);
  audit('connectors-deleted-all', { uid: user.uid.uid, count: res.connectors });
  return { status: 200, body: { ok: true, ...res } };
}
export async function getConnector({ user, params }) {
  if (!idOk(params.id)) return NOT_FOUND();
  const cfg = await fresh(user), c = find(cfg, params.id); if (!c) return NOT_FOUND();
  return { status: 200, body: { ok: true, connector: viewOf(cfg, c, await oauthViews(cfg)) } };
}

/** The write-only secrets of a request body -> { auth?: string|null, oauthSecret?: string|null } (undefined = leave as it is). */
function secretsFrom(body) {
  const a = body?.auth && typeof body.auth === 'object' ? body.auth : {}, out = {};
  if (a.secret === null) out.auth = null; else if (a.secret !== undefined) { if (!secretOk(String(a.secret).trim())) return { error: '認証の値が正しくありません（空白・改行は入れられません）' }; out.auth = String(a.secret).trim(); }
  if (a.clientSecret === null) out.oauthSecret = null; else if (a.clientSecret !== undefined && a.clientSecret !== '') { if (!secretOk(String(a.clientSecret).trim())) return { error: 'クライアントシークレットが正しくありません' }; out.oauthSecret = String(a.clientSecret).trim(); }
  return out;
}
const needsSecret = (m) => ['bearer', 'header', 'basic'].includes(m.auth.type);
/** Inside the user's transaction: write or remove the connector's secrets (encrypted under their key). */
async function applySecrets(r, ring, id, s, m) {
  const put = async (what, v) => (v === null || v === undefined || v === '' ? ring.deleteSecret(r, secretName(id, what)) : ring.setSecret(r, secretName(id, what), v));
  if (s.auth === null || !needsSecret(m)) await put('auth', null); else if (s.auth) await put('auth', s.auth);
  if (s.oauthSecret === null || m.auth.type !== 'oauth') await put('oauthSecret', null); else if (s.oauthSecret) await put('oauthSecret', s.oauthSecret);
}

export async function createConnector({ user, body }) {
  const cfg = await fresh(user), existing = cfg.connectors || [], ring = getKeyring();
  const sec = secretsFrom(body); if (sec.error) return bad(422, 'invalid', sec.error);
  if (!(await cfg.hit('cx-write', 60, 30))) return bad(429, 'rate_limited', '操作が多すぎます。少し待ってください');
  const id = randomId();
  const draft = { ...body, tools: body?.type === 'http' ? body.tools : undefined, enabled: body?.type === 'mcp' ? false : body?.enabled };   // an MCP connector starts disabled: it is switched on after its tools were reviewed
  const v = validateManifest(draft, { existing, id }); if (!v.ok) return bad(422, 'invalid', '入力を確認してください', { errors: v.errors });
  if (existing.length >= MAX_CONNECTORS) return bad(422, 'invalid', `連携アプリは${MAX_CONNECTORS}個までです`);
  if (needsSecret(v.manifest) && !sec.auth) return bad(422, 'invalid', '認証の値（トークンなど）を入れてください', { errors: [{ path: 'auth.secret', message: '認証の値を入れてください' }] });
  await user.db(async (r) => {
    if ((await r.connectors.list()).length >= MAX_CONNECTORS) throw Object.assign(new Error('too_many_connectors'), { status: 422, code: 'too_many_connectors' });
    await r.connectors.put(v.manifest); await applySecrets(r, ring, id, sec, v.manifest);
    await r.audit.append({ action: 'connector.created', target: id, meta: { type: v.manifest.type } });
  });
  invalidateUserConfig(user.uid);
  audit('connector-created', { uid: user.uid.uid, id, type: v.manifest.type, host: new URL(v.manifest.type === 'mcp' ? v.manifest.mcp.url : v.manifest.http.baseUrl).host });
  const f = await fresh(user);
  return { status: 200, body: { ok: true, connector: viewOf(f, find(f, id), {}) } };
}

export async function patchConnector({ user, body, params }) {
  if (!idOk(params.id)) return NOT_FOUND();
  const cfg = await fresh(user), cur = find(cfg, params.id); if (!cur) return NOT_FOUND();
  const ring = getKeyring(), sec = secretsFrom(body); if (sec.error) return bad(422, 'invalid', sec.error);
  if (!(await cfg.hit('cx-write', 60, 30))) return bad(429, 'rate_limited', '操作が多すぎます。少し待ってください');
  const c = cur, b = body && typeof body === 'object' ? body : {};
  const merged = { type: c.type, slug: c.slug, name: b.name ?? c.name, description: b.description ?? c.description, enabled: b.enabled ?? c.enabled,
    mcp: c.type === 'mcp' ? { url: b.mcp?.url ?? c.mcp.url } : null, http: c.type === 'http' ? { baseUrl: b.http?.baseUrl ?? c.http.baseUrl } : null,
    auth: { ...c.auth, ...(b.auth && typeof b.auth === 'object' ? Object.fromEntries(Object.entries(b.auth).filter(([k]) => !['secret', 'clientSecret'].includes(k))) : {}) },
    network: { ...c.network, ...(b.network || {}) }, limits: { ...c.limits, ...(b.limits || {}) }, grantAgents: known(b.grantAgents) ?? c.grantAgents,
    tools: c.type === 'http' ? (Array.isArray(b.tools) ? b.tools : c.tools) : undefined };
  const v = validateManifest(merged, { existing: cfg.connectors, id: c.id });
  if (!v.ok) return bad(422, 'invalid', '入力を確認してください', { errors: v.errors });
  const m = v.manifest; m.syncedAt = c.syncedAt; m.lastError = c.lastError; m.serverInfo = c.serverInfo;
  if (c.type === 'mcp') m.tools = c.tools;
  const urlChanged = c.type === 'mcp' ? c.mcp.url !== m.mcp.url : c.http.baseUrl !== m.http.baseUrl;
  if (urlChanged && c.type === 'mcp') { m.tools = []; m.syncedAt = null; m.serverInfo = null; m.lastError = null; m.enabled = false; }
  let errors = [];
  if (b.toolPrefs && typeof b.toolPrefs === 'object') { const r = applyToolPrefs(m.tools, b.toolPrefs, { isMcp: c.type === 'mcp' }); m.tools = r.tools; errors = r.errors; }
  if (urlChanged && sec.auth === undefined && c.type === 'mcp') { /* the old login belonged to the old address */ }
  await user.db(async (r) => {
    await r.connectors.put(m); await applySecrets(r, ring, c.id, sec, m);
    if (urlChanged) await r.oauthTokens.del(providerOf(c.id));
    await r.audit.append({ action: 'connector.updated', target: c.id, meta: { fields: Object.keys(b).filter((k) => k !== 'auth').slice(0, 12), toolPrefs: Object.keys(b.toolPrefs || {}).length || undefined } });
  });
  invalidateUserConfig(user.uid);
  if (urlChanged || sec.auth !== undefined) { try { await clientFor(cfg, cur, { useSessionStore: true }).close(); } catch { /* ignore */ } }
  audit('connector-updated', { uid: user.uid.uid, id: c.id, fields: Object.keys(b).filter((k) => k !== 'auth'), secret: sec.auth === undefined ? undefined : sec.auth === null ? 'removed' : 'replaced', toolPrefs: Object.keys(b.toolPrefs || {}).length || undefined });
  const f = await fresh(user);
  return { status: 200, body: { ok: true, connector: viewOf(f, find(f, c.id), await oauthViews(f)), ...(errors.length ? { warnings: errors } : {}) } };
}

export async function deleteConnector({ user, params }) {
  if (!idOk(params.id)) return NOT_FOUND();
  const cfg = await fresh(user), cur = find(cfg, params.id); if (!cur) return NOT_FOUND();
  const ring = getKeyring();
  const tok = await user.db((r) => ring.getToken(r, providerOf(cur.id)));
  if (tok?.data) await revokeToken({ provider: providerOf(cur.id), data: tok.data, revokeUrl: tok.revokeUrl });   // best effort, before the token is deleted
  await user.db(async (r) => { await purgeConnectorData(r, ring, cur.id); await r.audit.append({ action: 'connector.deleted', target: cur.id }); });
  invalidateUserConfig(user.uid);
  try { await clientFor(cfg, cur).close(); } catch { /* ignore */ }
  audit('connector-deleted', { uid: user.uid.uid, id: cur.id });
  return { status: 200, body: { ok: true } };
}

/** "Test connection" and "sync": MCP -> initialize + tools/list, merged with the pins; HTTP -> reachability of the base URL. */
export async function syncConnector({ user, params }) {
  if (!idOk(params.id)) return NOT_FOUND();
  const cfg = await fresh(user), c = find(cfg, params.id); if (!c) return NOT_FOUND();
  if (!(await cfg.hit('cx-sync', 60, 20))) return bad(429, 'rate_limited', '試行が多すぎます。少し待ってください');
  const save = (fn) => user.db(async (r) => { const x = await r.connectors.get(c.id); if (!x) return null; const y = fn(x) || x; await r.connectors.put(y); return y; });
  // the network call runs in the user's own request context (their secrets, their token)
  const setError = (msg) => save((x) => { if (msg) x.lastError = msg; else delete x.lastError; return x; }).catch(() => {});
  if (c.type === 'http') {
    const probe = await probeHttp(c, cfg.cxSecret(c.id));
    const nc = await save((x) => { x.syncedAt = Date.now(); if (probe.reachable) delete x.lastError; else x.lastError = probe.error || `接続できませんでした（HTTP ${probe.status}）`; return x; });
    invalidateUserConfig(user.uid);
    audit('connector-synced', { uid: user.uid.uid, id: c.id, reachable: probe.reachable });
    const f = await fresh(user);
    return { status: 200, body: { ok: probe.reachable, probe, message: probe.reachable ? undefined : (probe.error || `相手が HTTP ${probe.status} を返しました`), connector: viewOf(f, find(f, c.id) || nc, {}) } };
  }
  let info, remote;
  try { const cl = clientFor(cfg, c); info = await cl.initialize(); remote = await cl.listTools(); }
  catch (e) {
    const ce = toConnectorError(e); await setError(ce.message); invalidateUserConfig(user.uid);
    audit('connector-sync-failed', { uid: user.uid.uid, id: c.id, code: ce.code });
    return { status: 200, body: { ok: false, error: ce.code, message: ce.message, needsAuth: ce.code === 'unauthorized', oauthPossible: ce.code === 'unauthorized' && c.auth.type === 'none' } };
  }
  let diff = null;
  await save((x) => {
    const m = mergeRemoteTools(x.tools || [], remote, { first: !x.syncedAt });
    x.tools = m.tools; x.syncedAt = Date.now(); delete x.lastError; x.serverInfo = info.serverInfo; diff = { added: m.added, changed: m.changed, removed: m.removed, skipped: m.skipped };
    return x;
  });
  invalidateUserConfig(user.uid);
  const f = await fresh(user), nc = find(f, c.id);
  audit('connector-synced', { uid: user.uid.uid, id: c.id, tools: nc.tools.length, added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length });
  return { status: 200, body: { ok: true, diff, connector: viewOf(f, nc, await oauthViews(f)) } };
}

// ---------------------------------------------------------------- OAuth
export async function oauthStart({ req, user, params }) {
  if (!idOk(params.id)) return NOT_FOUND();
  const cfg = await fresh(user), c = find(cfg, params.id); if (!c) return NOT_FOUND();
  if (c.type !== 'mcp' || c.auth.type !== 'oauth') return bad(400, 'not_oauth', 'この連携アプリは OAuth を使いません');
  const re = redirectUriFor(req); if (!re.ok) return bad(400, 'origin_unknown', re.error);
  if (!(await cfg.hit('cx-oauth', 600, 20))) return bad(429, 'rate_limited', '試行が多すぎます。少し待ってください');
  const redirectUri = re.origin + CALLBACK_PATH;
  try {
    const f = await startConnectorOAuth({ cfg, c, redirectUri, clientSecret: cfg.cxSecret(c.id, 'oauthSecret') });
    audit('connector-oauth-started', { uid: user.uid.uid, id: c.id });
    return { status: 200, body: { ok: true, url: f.url, state: f.state, redirectUri } };
  } catch (e) { const ce = toConnectorError(e); return bad(ce.status >= 400 && ce.status < 500 ? ce.status : 502, ce.code, ce.message); }
}
export async function oauthClaim({ user, body, params }) {
  if (!idOk(params.id)) return NOT_FOUND();
  const cfg = await fresh(user), c = find(cfg, params.id); if (!c) return NOT_FOUND();
  const state = String(body?.state || ''); if (!STATE_RE.test(state)) return bad(400, 'bad_state', 'ログインの情報が正しくありません');
  const r = await claimConnectorOAuth({ cfg, c, state });
  if (r.status === 'pending') return { status: 200, body: { ok: true, pending: true } };
  if (r.status === 'missing') return { status: 200, body: { ok: true, claimed: false } };
  if (r.status === 'error') return { status: 200, body: { ok: false, error: r.error, message: `認証できませんでした（${cleanText(r.error, 40)}${r.description ? '：' + cleanText(r.description, 120) : ''}）` } };
  await user.db(async (tx) => { const x = await tx.connectors.get(c.id); if (x?.lastError) { delete x.lastError; await tx.connectors.put(x); } await tx.audit.append({ action: 'connector.oauth_connected', target: c.id }); }).catch(() => {});
  invalidateUserConfig(user.uid);
  audit('connector-oauth-connected', { uid: user.uid.uid, id: c.id });
  return { status: 200, body: { ok: true, claimed: true } };
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, inner) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#080604;color:#f6efe2;font:16px/1.8 "Barlow Semi Condensed","Noto Sans JP",system-ui,sans-serif}main{max-width:560px;margin:0 auto;padding:40px 20px}h1{font:400 20px/1.4 "Cinzel",serif;letter-spacing:3px;color:#FFD99A;margin:0 0 14px}p{margin:8px 0;color:#e9dcc4}.ok{color:#9fe3a8}.warn{color:#ff7a4a}.box{border:1px solid rgba(232,185,106,.45);padding:16px 18px;background:#100c07}a{color:#E8B96A}</style></head><body><main><div class="box">${inner}</div></main></body></html>`;
const FAIL = { bad_state: '無効なリクエストです。', unknown_state: '無効か、期限（10分）が切れています。', used: 'すでに使われています。', denied: '相手のサービスで許可されませんでした。', no_refresh_token: '更新用のトークンが返りませんでした。', exchange_failed: 'トークンの発行を断られました。', network: '通信に失敗しました。' };

/** GET /api/elvar/oauth/callback [state]: the browser returns from the MCP server's login. The platform finds the user's flow by the state; the code is exchanged here (through safeFetch); that user's app claims the result. */
export async function oauthCallback({ req, query = {} }) {
  const headers = { 'content-security-policy': PAGE_CSP };
  const fail = (text, status) => ({ status, headers, html: page('連携できませんでした', `<h1>NOT CONNECTED</h1><p class="warn">${esc(text)}</p><p>アプリの設定の「連携アプリ」から、もう一度お試しください。</p><p><a href="/">アプリを開く</a></p>`) });
  let db; try { db = await getDb(); } catch { return fail('サービスに接続できません。', 503); }
  if (!(await rateLimit(req, 'cxoauthcb', 30, 600))) return fail('試行が多すぎます。しばらくしてからもう一度お試しください。', 429);
  const state = String(query.state || ''); if (!STATE_RE.test(state)) return fail(FAIL.bad_state, 403);
  let r;
  try { r = await handleCallback({ openPending: openPendingByState(db, 'mcp'), expectProvider: 'mcp', state, code: typeof query.code === 'string' ? query.code : '', error: typeof query.error === 'string' ? query.error : '', fetchImpl: safeFetchAsFetch() }); }
  catch (e) { console.error('[elvar] connector oauth callback:', e?.code || e?.message); return fail('サービスに接続できません。', 503); }
  audit('connector-oauth-callback', { ok: r.ok, reason: r.reason });
  if (!r.ok) return fail((FAIL[r.reason] || FAIL.exchange_failed) + (r.error ? `（${cleanText(r.error, 40)}）` : ''), r.reason === 'network' ? 502 : 400);
  return { status: 200, headers, html: page('連携しました', '<h1>CONNECTED</h1><p class="ok">認証を受け取りました。</p><p>E.L.V.A.R. のアプリに戻ってください。アプリが自動で接続を完了します。</p><p><a href="/">アプリを開く</a></p>') };
}
