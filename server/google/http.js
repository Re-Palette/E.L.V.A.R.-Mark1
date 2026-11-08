// Tiny Google REST client: access-token cache (from the refresh token) + fetch wrapper with timeouts and clean errors.
import crypto from 'node:crypto';
import { googleConfig, base } from './config.js';
import { markReauth } from './tok.js';

export class GoogleError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

// Access tokens live in memory only, one per login: keyed by sha256(client id + refresh token), so a reconnect, a second owner login or a
// changed client never reuses another login's token (and a revoked one is dropped).
const cache = new Map();
const cacheKey = (cfg) => crypto.createHash('sha256').update(`${cfg.clientId}\n${cfg.refreshToken}`).digest('hex');

export const REAUTH_MESSAGE = 'Googleとの接続が切れました（取り消し・期限切れ。「テスト中」のアプリは7日で切れます）。設定の「Google」で、もう一度「Googleと連携」を押してください。';

export async function accessToken(cfg = googleConfig()) {
  const key = cacheKey(cfg), hit = cache.get(key);
  if (hit && Date.now() < hit.exp - 60_000) return hit.token;
  if (cfg.reauth) throw new GoogleError(401, REAUTH_MESSAGE, 'reauth_required');     // already known to be refused: do not ask Google again
  const r = await fetch(base('oauth', cfg), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    cache.delete(key);
    if (j.error === 'invalid_grant') {
      if (cfg.fromVault) await markReauth(cfg.refreshToken, 'invalid_grant');
      throw new GoogleError(401, REAUTH_MESSAGE, 'invalid_grant');
    }
    const why = j.error === 'invalid_client' || j.error === 'unauthorized_client'
      ? 'GoogleのクライアントIDかシークレットが正しくありません。設定の「Google」で入れ直してください。'
      : `Googleの認証に失敗しました（${j.error || r.status}）`;
    throw new GoogleError(401, why, j.error);
  }
  cache.set(key, { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
  if (cache.size > 20) for (const [k, v] of cache) if (v.exp < Date.now()) cache.delete(k);
  return j.access_token;
}
export const resetTokenCache = () => cache.clear();

/**
 * @param {string} service  key in config.base()
 * @param {string} path     e.g. '/calendars/primary/events'
 * @param {{method?:string, query?:Record<string,any>, json?:any, body?:any, headers?:Record<string,string>, text?:boolean}} [o]
 */
export async function gfetch(service, path, o = {}) {
  const cfg = googleConfig();
  const url = new URL(base(service, cfg) + path);
  for (const [k, v] of Object.entries(o.query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers = { authorization: `Bearer ${await accessToken(cfg)}`, ...(o.headers || {}) };
  let body = o.body;
  if (o.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.json); }
  let r = await fetch(url, { method: o.method || 'GET', headers, body, signal: AbortSignal.timeout(20_000) });
  if (r.status === 401) {   // the cached access token was revoked early: get a fresh one once (a refused refresh token ends in the reconnect message)
    cache.delete(cacheKey(cfg));
    headers.authorization = `Bearer ${await accessToken(cfg)}`;
    r = await fetch(url, { method: o.method || 'GET', headers, body, signal: AbortSignal.timeout(20_000) });
  }
  if (r.status === 204) return null;
  const raw = await r.text();
  if (!r.ok) {
    let msg = raw.slice(0, 300), code;
    try { const e = JSON.parse(raw).error; msg = e?.message || msg; code = e?.status; } catch {}
    const hint = r.status === 403 ? '（権限不足、またはAPIが有効化されていません）' : r.status === 404 ? '（見つかりません）' : '';
    throw new GoogleError(r.status, `Google API エラー ${r.status}${hint}: ${msg}`, code);
  }
  if (o.text) return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}
