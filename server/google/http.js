// Tiny Google REST client: access-token cache (from the refresh token) + fetch wrapper with timeouts and clean errors.
import { googleConfig, base } from './config.js';

export class GoogleError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

let cached = { token: '', exp: 0 };

export async function accessToken(cfg = googleConfig()) {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const r = await fetch(base('oauth', cfg), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const why = j.error === 'invalid_grant'
      ? 'Googleのログインが無効になっています（期限切れ・取り消し）。アプリの /google-setup/ の「Googleにログイン」ボタンからやり直し、GOOGLE_REFRESH_TOKEN を更新してください。'
      : `Googleの認証に失敗しました（${j.error || r.status}）`;
    throw new GoogleError(401, why, j.error);
  }
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.token;
}
export const resetTokenCache = () => { cached = { token: '', exp: 0 }; };

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
  const r = await fetch(url, { method: o.method || 'GET', headers, body, signal: AbortSignal.timeout(20_000) });
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
