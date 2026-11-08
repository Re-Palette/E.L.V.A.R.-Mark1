// Google login inside the app (docs/ELVAR_ARCHITECTURE.md 4.2; replaces oauth-web.js). The owner types their OWN OAuth client id / secret in
// Settings, presses 「Googleと連携」, consents in an external browser / Custom Tab, and the refresh token goes straight into the vault.
//   GET  .../connect/google/status      [owner]  state, granted scopes, the redirect URI to register, ...        (?probe=1 also asks Google)
//   POST .../connect/google/start       [owner]  -> { url, state }   PKCE + single-use state, pending flow stored encrypted (server/oauth/flow.js)
//   GET  /api/google/callback           [state]  Google returns here WITHOUT a device token: exchanges the code on the server, parks the tokens
//   POST .../connect/google/claim       [owner]  the app takes the tokens into the vault (or reports what went wrong)
//   POST .../connect/google/disconnect  [owner]  revoke at Google + delete from the vault
// Codes, tokens and secrets are never logged, never put in a page, and the callback never redirects anywhere (no open redirect).
import { getStore } from '../store/index.js';
import { rateLimit, clientIp } from '../config/auth.js';
import { startFlow, handleCallback, claimFlow, discardPending, STATE_RE } from '../oauth/flow.js';
import { googleConfig, googleConfigured, googleState, googleClientConfigured, googleToolAllowed, parseServices, scopesFor, base, AUTH_URL, SERVICES } from './config.js';
import { updateTok, bumpGoogleRev } from './tok.js';
import { TOK_KEY, GSTATE_KEY, loadLogin } from './login-record.js';
import { accessToken } from './http.js';
import { TOOLS } from './tools.js';
import { cfgEnv, env } from '../config/resolve.js';

const audit = (event, extra = {}) => console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event, ...extra }));
const bad = (status, error, message, extra = {}) => ({ status, body: { ok: false, error, message, ...extra } });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const CALLBACK_PATH = '/api/google/callback';
const LOOP_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

/**
 * The redirect URI that is registered at Google and used in the flow. It comes from configuration, never from whatever Host a request claims:
 *  - ELVAR_PUBLIC_ORIGIN (https://..., or a loopback address) when set;
 *  - on Vercel: the request's host only if it is one of THIS deployment's own hosts (VERCEL_PROJECT_PRODUCTION_URL / VERCEL_URL / VERCEL_BRANCH_URL),
 *    otherwise the production URL;
 *  - elsewhere: a loopback Host (localhost / 127.0.0.1) as sent by the local browser.
 * @returns {{ok:true, uri:string, origin:string}|{ok:false, error:string}}
 */
export function redirectUriFor(req, e = process.env) {
  const done = (origin) => ({ ok: true, origin, uri: origin + CALLBACK_PATH });
  const pub = String(e.ELVAR_PUBLIC_ORIGIN || '').trim();
  if (pub) {
    try { const u = new URL(pub); if ((u.protocol === 'https:' || (u.protocol === 'http:' && LOOP_HOST.test(u.host))) && !u.username && !u.password) return done(u.origin); } catch { /* fall through */ }
    return { ok: false, error: 'ELVAR_PUBLIC_ORIGIN の形式が正しくありません（https://example.com のように書いてください）' };
  }
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim().toLowerCase();
  if (e.VERCEL) {
    const own = [e.VERCEL_PROJECT_PRODUCTION_URL, e.VERCEL_URL, e.VERCEL_BRANCH_URL].map((x) => String(x || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')).filter(Boolean);
    if (host && own.includes(host)) return done('https://' + host);
    if (own[0] && e.VERCEL_PROJECT_PRODUCTION_URL) return done('https://' + own[0]);
    return { ok: false, error: 'このアプリのURLを決められません。環境変数 ELVAR_PUBLIC_ORIGIN に https://（このアプリのURL）を設定して、再デプロイしてください' };
  }
  if (LOOP_HOST.test(host)) return done('http://' + host);
  return { ok: false, error: '外部から使うときは、環境変数 ELVAR_PUBLIC_ORIGIN に https://（このアプリのURL）を設定してください（Googleは http のアドレスを受け付けません）' };
}

/** The owner's choice in Settings: which products, and whether read-only. */
export const selectionFrom = (get) => ({ services: parseServices(get('GOOGLE_SERVICES')), readonly: String(get('GOOGLE_READONLY') || '') === '1' });

const writableAuth = (auth) => auth.mode === 'vault';
const notWritable = (auth) => bad(409, 'read_only', auth.mode === 'env' ? '環境変数モードです。Googleの接続は環境変数（GOOGLE_REFRESH_TOKEN など）で設定してください' : '先にセットアップ（オーナーの登録）を済ませてください');

const grantedServices = (scopes) => (scopes ? SERVICES.filter((s) => scopes.has(s.write) || scopes.has(s.read)).map((s) => ({ id: s.id, label: s.label, write: scopes.has(s.write) })) : null);

/** GET status (owner). Reads the login record fresh from the store: the request's cfg may be up to 30 s old on a warm instance. */
export async function connectStatus({ req, cfg, auth, query = {} }) {
  const store = getStore();
  let tok = cfg.google;
  if (writableAuth(auth) && store) { try { tok = await loadLogin(store, auth.dek); } catch { /* keep the cached one */ } }
  let g = googleConfig(cfgEnv, tok);
  const re = redirectUriFor(req);
  const sel = selectionFrom((n) => cfg.get(n));
  const out = {
    ok: true, writable: writableAuth(auth), mode: auth.mode,
    clientId: g.clientId, clientIdSet: Boolean(g.clientId), clientSecretSet: Boolean(g.clientSecret),
    redirectUri: re.ok ? re.uri : '', redirectUriError: re.ok ? '' : re.error,
    selection: sel, requestedScopes: scopesFor(sel),
    configured: googleConfigured(g), source: g.fromVault ? 'app' : g.refreshToken ? 'env' : 'none',
    scopes: g.scopes ? [...g.scopes] : null, services: grantedServices(g.scopes),
    connectedAt: tok?.connectedAt || 0, verifiedAt: tok?.verifiedAt || 0, reauthReason: g.reauthReason || '',
  };
  const tools = TOOLS.filter((t) => googleToolAllowed(t, g.scopes));
  out.tools = tools.length; out.read = tools.filter((t) => t.kind === 'read').length; out.write = tools.filter((t) => t.kind === 'write').length;
  if (g.fromVault && g.scopes) {   // the connection is narrower than the current selection: the owner has to connect again to apply it
    const want = new Set(out.requestedScopes); out.selectionApplied = [...want].every((x) => g.scopes.has(x)) && [...g.scopes].every((x) => want.has(x));
  } else out.selectionApplied = true;
  if (query.probe === '1' && out.configured && !g.reauth) {
    try {
      await accessToken(g); out.authenticated = true;
      if (writableAuth(auth) && store && g.fromVault && Date.now() - (tok?.verifiedAt || 0) > 60_000) {
        await updateTok(store, auth.dek, (t) => (t && t.status === 'connected' ? { ...t, verifiedAt: Date.now() } : t)).then((t) => { out.verifiedAt = t?.verifiedAt || out.verifiedAt; }).catch(() => {});
      }
    } catch (e) { out.authenticated = false; out.error = String(e?.message || e); }
    if (out.authenticated === false) {   // invalid_grant has just been recorded: report the fresh state
      if (writableAuth(auth) && store) { try { g = googleConfig(cfgEnv, await loadLogin(store, auth.dek)); } catch { /* ignore */ } }
    }
  }
  out.state = googleState(g);
  return { status: 200, body: out };
}

/** POST start (owner): the Google consent URL. The page opens it in an external browser / Custom Tab (Google refuses sign-in inside a WebView). */
export async function connectStart({ req, cfg, auth }) {
  if (!writableAuth(auth)) return notWritable(auth);
  const store = getStore(); if (!store) return bad(503, 'storage_required', '保存先がありません');
  const g = googleConfig();
  if (!googleClientConfigured(g)) return bad(400, 'client_missing', 'クライアントIDとクライアントシークレットを、先に保存してください');
  const re = redirectUriFor(req); if (!re.ok) return bad(400, 'origin_unknown', re.error);
  const sel = selectionFrom((n) => cfg.get(n)), scopes = scopesFor(sel);
  const { url, state } = await startFlow({
    store, provider: 'google', authUrl: AUTH_URL, tokenUrl: base('oauth', g), clientId: g.clientId, clientSecret: g.clientSecret, redirectUri: re.uri, scopes, createdBy: auth.deviceId || null,
    params: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' },
  });
  audit('google-connect-started', { by: auth.deviceId, services: sel.services.length, readonly: sel.readonly });
  return { status: 200, body: { ok: true, url, state, redirectUri: re.uri, scopes } };
}

// ---------------------------------------------------------------- callback (no device token: protected by the state alone)
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const page = (title, inner, script = false) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#080604;color:#f6efe2;font:16px/1.8 "Barlow Semi Condensed","Noto Sans JP","Hiragino Sans","Yu Gothic UI","Meiryo",system-ui,sans-serif}main{max-width:560px;margin:0 auto;padding:40px 20px}
h1{font:400 20px/1.4 "Cinzel","Times New Roman",serif;letter-spacing:3px;color:#FFD99A;margin:0 0 14px}p{margin:8px 0;color:#e9dcc4}.ok{color:#9fe3a8}.warn{color:#ff7a4a}.sub{color:#b99b6a;font-size:14px}
a{color:#E8B96A}.box{border:1px solid rgba(232,185,106,.45);padding:16px 18px;background:#100c07}</style></head><body><main><div class="box">${inner}</div></main>${script ? '<script src="/google-setup/claim.js"></script>' : ''}</body></html>`;
const FAIL_TEXT = {
  bad_state: ['このログインは無効です。', 403], unknown_state: ['このログインは無効か、期限（10分）が切れています。', 403], used: ['このログインは、すでに使われています。', 403],
  denied: ['Googleで許可されませんでした。', 400], no_refresh_token: ['Googleから更新用のトークンが返りませんでした。https://myaccount.google.com/permissions でこのアプリを一度削除してから、もう一度お試しください。', 400],
  exchange_failed: ['Googleがトークンの発行を断りました。クライアントの種類が「ウェブ アプリケーション」か、登録した戻り先URLが正確かを確認してください。', 400], network: ['Googleとの通信に失敗しました。少し待って、もう一度お試しください。', 502],
};

/** GET callback. @returns {Promise<{status:number, html:string, headers:object}>} */
export async function connectCallback({ req, query = {} }) {
  const headers = { 'content-security-policy': PAGE_CSP };
  const fail = (text, status) => ({ status, headers, html: page('Googleと連携できませんでした', `<h1>NOT CONNECTED</h1><p class="warn">${esc(text)}</p><p class="sub">アプリの設定の「Google」から、もう一度「Googleと連携」を押してください。</p><p><a href="/">アプリを開く</a></p>`) });
  const store = getStore(); if (!store) return fail('保存先がありません。', 503);
  if (!(await rateLimit(store, 'oauthcb', clientIp(req), 30, 600))) return fail('試行が多すぎます。しばらくしてからもう一度お試しください。', 429);
  const state = String(query.state || '');
  if (!STATE_RE.test(state)) return fail(FAIL_TEXT.bad_state[0], 403);
  const r = await handleCallback({ store, state, code: typeof query.code === 'string' ? query.code : '', error: typeof query.error === 'string' ? query.error : '' });
  audit('google-callback', { ok: r.ok, reason: r.reason, error: r.error });
  if (!r.ok) { const [t, s] = FAIL_TEXT[r.reason] || FAIL_TEXT.exchange_failed; return fail(t + (r.reason === 'denied' && r.error ? `（${r.error}）` : r.reason === 'exchange_failed' && r.error ? `（${r.error}）` : ''), s); }
  return { status: 200, headers, html: page('Googleと連携しました', `<h1>CONNECTED</h1><p class="ok" id="st">Googleの認証を受け取りました。</p><p id="more">E.L.V.A.R. のアプリに戻ってください。アプリが自動で接続を完了します。</p><p class="sub">この画面は閉じて大丈夫です。</p><p><a href="/">アプリを開く</a></p><noscript></noscript>`, true) };
}

// ---------------------------------------------------------------- claim / disconnect
const CLAIM_FAIL = (code, desc) => {
  if (code === 'access_denied') return 'Googleで許可されませんでした。もう一度「Googleと連携」を押して、許可してください。';
  if (code === 'no_refresh_token') return 'Googleから更新用のトークンが返りませんでした。https://myaccount.google.com/permissions でこのアプリを一度削除してから、もう一度お試しください。';
  if (code === 'network') return 'Googleとの通信に失敗しました。もう一度お試しください。';
  return `Googleがトークンの発行を断りました（${code}${desc ? '：' + desc : ''}）。クライアントの種類が「ウェブ アプリケーション」か、登録した戻り先URLが正確か、クライアントシークレットが正しいかを確認してください。`;
};

/** POST claim { state } (owner): move the tokens from the pending flow into the vault. Safe to repeat (the page's own script may have claimed already). */
export async function connectClaim({ body, auth }) {
  if (!writableAuth(auth)) return notWritable(auth);
  const store = getStore(); if (!store) return bad(503, 'storage_required', '保存先がありません');
  const state = String(body?.state || '');
  if (!STATE_RE.test(state)) return bad(400, 'bad_state', 'ログインの情報が正しくありません');
  const c = await claimFlow({ store, state });
  const brief = async () => { const t = await loadLogin(store, auth.dek).catch(() => null); return { state: googleState(googleConfig(cfgEnv, t)) }; };
  if (c.status === 'missing') return { status: 200, body: { ok: true, claimed: false, ...(await brief()) } };
  if (c.status === 'pending') return { status: 200, body: { ok: true, pending: true } };
  if (c.status === 'error') return { status: 200, body: { ok: false, error: c.error, message: CLAIM_FAIL(c.error, c.description) } };
  const scopes = String(c.tokens.scope || '').split(/\s+/).filter(Boolean);
  const now = Date.now();
  await store.del(GSTATE_KEY);
  await updateTok(store, auth.dek, () => ({ refreshToken: c.tokens.refresh_token, scopes: scopes.length ? scopes : c.scopes, clientId: c.clientId, status: 'connected', connectedAt: now, verifiedAt: now }));
  await bumpGoogleRev(store, auth.dek);
  await discardPending(store, state);
  audit('google-connected', { by: auth.deviceId, scopes: scopes.length });
  return { status: 200, body: { ok: true, claimed: true, ...(await brief()) } };
}

/** POST disconnect (owner): revoke the refresh token at Google, then delete it from the vault (deleted even when Google cannot be reached). */
export async function connectDisconnect({ auth }) {
  if (!writableAuth(auth)) return notWritable(auth);
  const store = getStore(); if (!store) return bad(503, 'storage_required', '保存先がありません');
  const cur = await loadLogin(store, auth.dek).catch(() => null);
  if (!cur) return { status: 200, body: { ok: true, revoked: false, disconnected: false, envToken: Boolean(env('GOOGLE_REFRESH_TOKEN')) } };
  let revoked = false;
  try {
    const r = await fetch(base('revoke'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: cur.refreshToken }), signal: AbortSignal.timeout(10_000) });
    revoked = r.ok;
  } catch { /* offline: still removed here */ }
  await store.del(TOK_KEY); await store.del(GSTATE_KEY);
  await bumpGoogleRev(store, auth.dek);
  audit('google-disconnected', { by: auth.deviceId, revoked });
  return { status: 200, body: { ok: true, revoked, disconnected: true } };
}
