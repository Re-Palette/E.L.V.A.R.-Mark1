// OAuth 2.1 for remote MCP servers (docs/ELVAR_ARCHITECTURE.md 5.7): protected-resource metadata -> authorization-server metadata -> dynamic client
// registration (or a client id typed by the user) -> PKCE S256 + `resource` -> the generic flow in server/oauth/flow.js -> tokens in the user's own row of
// app.oauth_tokens (provider `cx:<id>`), sealed under their data key. Every URL here, including every one found by discovery, is fetched with safeFetch.
// `cfg` is the signed-in user's request configuration: cfg.db(fn) runs fn(repos) as that user (a refresh happens inside a tool call, so it needs no vault key).
import crypto from 'node:crypto';
import { safeFetch, hatchUrlOk } from '../net/safe-fetch.js';
import { startFlow, claimFlow, discardPending, STATE_RE } from '../oauth/flow.js';
import { pendingFor } from '../oauth/pending.js';
import { getKeyring } from '../auth/keyring.js';
import { ConnectorError, toConnectorError } from './errors.js';
import { cleanText } from './manifest.js';
import { providerOf, kvRefreshLockKey } from './data.js';

export const CALLBACK_PATH = '/api/elvar/oauth/callback';
const jget = async (fetchImpl, url, o = {}) => {
  let r; try { r = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, timeoutMs: 10000, maxBytes: 262144, ...o }); } catch (e) { throw toConnectorError(e); }
  if (r.status !== 200) return null;
  try { const j = r.json(); return j && typeof j === 'object' ? j : null; } catch { return null; }
};
const httpsUrl = (u) => { try { const x = new URL(String(u)); return (x.protocol === 'https:' && !x.username && !x.password) || hatchUrlOk(x.toString()) ? x.toString() : null; } catch { return null; } };

/** WWW-Authenticate: Bearer resource_metadata="https://..." */
export const resourceMetadataFrom = (h) => { const m = /resource_metadata="([^"]{1,500})"/i.exec(String(h || '')); return m ? httpsUrl(m[1]) : null; };

/**
 * @returns {Promise<{resource:string, issuer:string, authUrl:string, tokenUrl:string, registrationUrl:string|null, scopes:string[], authMethods:string[]}>}
 * @throws ConnectorError('oauth_unsupported', ...) when the server offers no usable OAuth
 */
export async function discover(mcpUrl, { wwwAuthenticate = '', fetchImpl = safeFetch, allowPrivate = false } = {}) {
  const o = { allowPrivate }; const u = new URL(mcpUrl);
  const pathSuffix = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
  const prmCandidates = [resourceMetadataFrom(wwwAuthenticate), `${u.origin}/.well-known/oauth-protected-resource${pathSuffix}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean);
  let prm = null; for (const c of [...new Set(prmCandidates)]) { prm = await jget(fetchImpl, c, o); if (prm) break; }
  const issuer = httpsUrl(prm?.authorization_servers?.[0]) || u.origin;   // older servers: the MCP server is its own authorization server
  const resource = httpsUrl(prm?.resource) || mcpUrl;
  const iu = new URL(issuer); const ipath = iu.pathname === '/' ? '' : iu.pathname.replace(/\/+$/, '');
  const metaUrls = [`${iu.origin}/.well-known/oauth-authorization-server${ipath}`, `${iu.origin}/.well-known/openid-configuration${ipath}`, `${iu.origin}${ipath}/.well-known/openid-configuration`];
  let meta = null; for (const m of metaUrls) { meta = await jget(fetchImpl, m, o); if (meta?.authorization_endpoint && meta?.token_endpoint) break; meta = null; }
  const authUrl = httpsUrl(meta?.authorization_endpoint), tokenUrl = httpsUrl(meta?.token_endpoint);
  if (!authUrl || !tokenUrl) throw new ConnectorError('oauth_unsupported', 'このサーバーの OAuth の設定を見つけられませんでした', 400);
  const methods = Array.isArray(meta.code_challenge_methods_supported) ? meta.code_challenge_methods_supported : null;
  if (methods && !methods.includes('S256')) throw new ConnectorError('oauth_unsupported', 'このサーバーは PKCE（S256）に対応していません', 400);
  return { resource, issuer, authUrl, tokenUrl, registrationUrl: httpsUrl(meta.registration_endpoint), revocationUrl: httpsUrl(meta.revocation_endpoint), scopes: Array.isArray(meta.scopes_supported) ? meta.scopes_supported.filter((s) => typeof s === 'string').slice(0, 50) : [],
    authMethods: Array.isArray(meta.token_endpoint_auth_methods_supported) ? meta.token_endpoint_auth_methods_supported : ['client_secret_basic'] };
}

/** Dynamic client registration (RFC 7591) as a public client. @returns {{clientId:string, clientSecret?:string}} */
export async function registerClient(meta, redirectUri, { fetchImpl = safeFetch, allowPrivate = false } = {}) {
  if (!meta.registrationUrl) throw new ConnectorError('registration_unavailable', 'このサーバーは、クライアントの自動登録に対応していません。クライアントIDを入力してください', 400);
  let r;
  try {
    r = await fetchImpl(meta.registrationUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, allowPrivate, timeoutMs: 10000, maxBytes: 65536,
      body: JSON.stringify({ client_name: 'E.L.V.A.R.', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  } catch (e) { throw toConnectorError(e); }
  let j = null; try { j = r.json(); } catch { /* below */ }
  if (!(r.status >= 200 && r.status < 300) || typeof j?.client_id !== 'string' || !/^[\x21-\x7e]{1,300}$/.test(j.client_id)) throw new ConnectorError('registration_failed', 'クライアントの自動登録に失敗しました。クライアントIDを入力してください', 400);
  return { clientId: j.client_id, ...(typeof j.client_secret === 'string' && j.client_secret ? { clientSecret: j.client_secret } : {}) };
}

// ---------------------------------------------------------------- the user's tokens (app.oauth_tokens, provider cx:<id>)
const statusCol = (data) => (data?.status === 'reauth_required' ? 'reauth_required' : 'ok');
/** @returns {Promise<{data:object, status:string, revokeUrl:string|null}|null>} the stored token record (opened with the user's key) */
export async function readTok(cfg, id) { return cfg.db((r) => getKeyring().getToken(r, providerOf(id))); }
/** Merge `obj` over the stored record (a refresh keeps the client id and the refresh token). `revokeUrl` is where the server wants tokens revoked. */
export async function writeTok(cfg, id, obj, { revokeUrl = null } = {}) {
  await cfg.db((r) => getKeyring().putToken(r, providerOf(id), obj, { merge: true, scopes: obj.scopes || [], status: statusCol({ status: obj.status }), reason: obj.reason ? String(obj.reason).slice(0, 60) : null, revokeUrl }));
}
export const deleteTok = (cfg, id) => cfg.db((r) => r.oauthTokens.del(providerOf(id)));
/** What the UI may know about the login (never a token). */
export const oauthView = (rec) => (rec ? { connected: Boolean(rec.access_token), state: rec.status || 'connected', registered: Boolean(rec.dynamicClient), connectedAt: rec.obtainedAt || null } : { connected: false, state: null, registered: false });

/**
 * Begin the flow for connector `c`. @param {{cfg:object, c:object, redirectUri:string, clientSecret?:string, fetchImpl?:Function}} o
 * @returns {Promise<{url:string, state:string}>}
 */
export async function startConnectorOAuth({ cfg, c, redirectUri, clientSecret = '', fetchImpl = safeFetch }) {
  const allowPrivate = c.network?.allowPrivate;
  let wwwAuthenticate = '';
  try { const r = await fetchImpl(c.mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}', timeoutMs: 8000, maxBytes: 16384, allowPrivate }); wwwAuthenticate = r.headers['www-authenticate'] || ''; } catch { /* discovery may still work from the well-known paths */ }
  const meta = await discover(c.mcp.url, { wwwAuthenticate, fetchImpl, allowPrivate });
  const cur = await readTok(cfg, c.id).catch(() => null);
  let clientId = c.auth.clientId || '', secret = clientSecret, dynamicClient = false;
  if (!clientId) {
    const saved = cur?.data;
    if (saved?.dynamicClient && saved.redirectUri === redirectUri && saved.authUrl === meta.authUrl && saved.clientId) { clientId = saved.clientId; secret = saved.clientSecret || ''; dynamicClient = true; }
    else { const reg = await registerClient(meta, redirectUri, { fetchImpl, allowPrivate }); clientId = reg.clientId; secret = reg.clientSecret || ''; dynamicClient = true; }
  }
  const scopes = (c.auth.scopes?.length ? c.auth.scopes : []).slice(0, 20);
  const f = await startFlow({ pending: pendingFor(cfg.db), provider: 'mcp', authUrl: meta.authUrl, tokenUrl: meta.tokenUrl, clientId, clientSecret: secret, redirectUri, scopes,
    params: { resource: meta.resource }, tokenParams: { resource: meta.resource }, requireRefresh: false, meta: { connectorId: c.id, resource: meta.resource, authUrl: meta.authUrl, dynamicClient, revocationUrl: meta.revocationUrl || null } });
  // remember the registered client now (the state itself is only in the URL)
  await writeTok(cfg, c.id, { clientId, clientSecret: secret || undefined, dynamicClient, redirectUri, authUrl: meta.authUrl, tokenUrl: meta.tokenUrl, resource: meta.resource, scopes }, { revokeUrl: meta.revocationUrl || null });
  return { url: f.url, state: f.state, issuer: meta.issuer };
}

/** The app takes the finished flow (only the user who started it can see it). @returns {Promise<{status:'missing'|'pending'|'error'|'ok', error?:string}>} */
export async function claimConnectorOAuth({ cfg, c, state }) {
  if (!STATE_RE.test(String(state || ''))) return { status: 'missing' };
  const pending = pendingFor(cfg.db);
  const r = await claimFlow({ pending, state });
  if (r.status !== 'ok') return r.status === 'error' ? { status: 'error', error: r.error, description: r.description } : { status: r.status };
  if (r.provider !== 'mcp' || r.meta?.connectorId !== c.id) { await discardPending(pending, state); return { status: 'missing' }; }   // another connector's (or Google's) flow
  const t = r.tokens, now = Date.now();
  await writeTok(cfg, c.id, { access_token: t.access_token, refresh_token: t.refresh_token || undefined, expiresAt: now + (Number(t.expires_in) || 3600) * 1000, obtainedAt: now, status: 'connected', tokenUrl: r.tokenUrl, clientId: r.clientId, resource: r.meta.resource }, { revokeUrl: r.meta.revocationUrl || null });
  await discardPending(pending, state);
  return { status: 'ok' };
}

/** A usable access token for the connector (refreshing it when it is about to expire; one refresher at a time). @throws ConnectorError('unauthorized') */
export async function accessTokenFor(cfg, c, { fetchImpl = safeFetch, now = Date.now() } = {}) {
  const rec = await readTok(cfg, c.id).catch(() => null);
  const t = rec?.data;
  if (!t?.access_token || t.status === 'reauth_required' || rec?.status === 'reauth_required') throw new ConnectorError('unauthorized', 'この連携アプリは、認証が必要です（設定の「連携アプリ」から認証してください）', 401);
  if (!t.expiresAt || t.expiresAt - now > 60_000) return t.access_token;
  if (!t.refresh_token) throw new ConnectorError('unauthorized', '認証の期限が切れました。設定の「連携アプリ」から、もう一度認証してください', 401);
  const lock = kvRefreshLockKey(c.id);
  if (!(await cfg.db((r) => r.kv.setNx(lock, 1, { ttlSec: 10 })))) {   // another request is refreshing: wait briefly and read what it saved
    for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 400)); const again = (await readTok(cfg, c.id).catch(() => null))?.data; if (again?.access_token && again.expiresAt - Date.now() > 60_000) return again.access_token; }
    throw new ConnectorError('unauthorized', '認証の更新中です。もう一度お試しください', 503);
  }
  try {
    let r;
    try {
      r = await fetchImpl(t.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, allowPrivate: c.network?.allowPrivate, timeoutMs: 10000, maxBytes: 65536,
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId, ...(t.clientSecret ? { client_secret: t.clientSecret } : {}), ...(t.resource ? { resource: t.resource } : {}) }).toString() });
    } catch (e) { throw toConnectorError(e); }
    let j = {}; try { j = r.json(); } catch { /* below */ }
    if (!r.ok || !j.access_token) {
      if (r.status === 400 || r.status === 401) { await writeTok(cfg, c.id, { status: 'reauth_required', reason: cleanText(j.error || 'refresh_failed', 40) }); throw new ConnectorError('unauthorized', '認証が取り消されたか、期限切れです。設定の「連携アプリ」から、もう一度認証してください', 401); }
      throw new ConnectorError('oauth_refresh', '認証の更新に失敗しました', 502);
    }
    await writeTok(cfg, c.id, { access_token: j.access_token, refresh_token: j.refresh_token || t.refresh_token, expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000, status: 'connected' });
    return j.access_token;
  } finally { await cfg.db((r) => r.kv.del(lock)).catch(() => {}); }
}
export const _rand = () => crypto.randomBytes(4).toString('hex');
