// Google login inside the app, per user (docs/ELVAR_MULTIUSER.md 8.3, decision O2: no shared platform client). The user types THEIR OWN OAuth client id /
// secret in Settings, presses 「Googleと連携」, consents in an external browser / Custom Tab, and the refresh token is sealed under THEIR data key in THEIR row of
// app.oauth_tokens.
//   GET  .../connect/google/status      [user]  state, granted scopes, the redirect URI to register, ...        (?probe=1 also asks Google)
//   POST .../connect/google/start       [user]  -> { url, state }   PKCE + single-use state, pending flow in the user's row of app.oauth_pending
//   GET  /api/google/callback           [state] Google returns here WITHOUT a token: the platform finds the flow by the state, acts as the user who started
//                                               it, exchanges the code on the server and parks the tokens in that user's pending row
//   POST .../connect/google/claim       [user]  the app takes the tokens (only the user who started the flow can see them)
//   POST .../connect/google/disconnect  [user]  revoke at Google + delete from the database
// Codes, tokens and secrets are never logged, never put in a page, and the callback never redirects anywhere (no open redirect).
import { getDb } from '../db/index.js';
import { rateLimit } from '../auth/rate-limit.js';
import { getKeyring } from '../auth/keyring.js';
import { invalidateUserConfig } from '../auth/load-user-config.js';
import { startFlow, handleCallback, claimFlow, discardPending, STATE_RE } from '../oauth/flow.js';
import { pendingFor, openPendingByState } from '../oauth/pending.js';
import { newBind, bindCookie, nonceFromReq } from '../oauth/browser-bind.js';
import { runWithConfig, cfgEnv } from '../config/resolve.js';
import { googleConfig, googleConfigured, googleState, googleClientConfigured, googleToolAllowed, parseServices, scopesFor, base, AUTH_URL, SERVICES } from './config.js';
import { accessToken } from './http.js';
import { TOOLS } from './tools.js';
import { GOOGLE } from './tok.js';
import { revokeToken } from '../rights/revoke.js';

const audit = (event, extra = {}) => console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event, ...extra }));
const bad = (status, error, message, extra = {}) => ({ status, body: { ok: false, error, message, ...extra } });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const CALLBACK_PATH = '/api/google/callback';
const LOOP_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

/**
 * The redirect URI that is registered at Google and used in the flow: the platform's ONE callback. It comes from configuration, never from whatever Host a
 * request claims:
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

/** The user's choice in Settings: which products, and whether read-only. */
export const selectionFrom = (get) => ({ services: parseServices(get('GOOGLE_SERVICES')), readonly: String(get('GOOGLE_READONLY') || '') === '1' });
const grantedServices = (scopes) => (scopes ? SERVICES.filter((s) => scopes.has(s.write) || scopes.has(s.read)).map((s) => ({ id: s.id, label: s.label, write: scopes.has(s.write) })) : null);

/** Run `fn` inside this user's freshly read configuration (the cached one may be 10 s old, and the status must show what was just changed). */
async function inFresh(user, fn) { const cfg = await user.loadConfig({ fresh: true }); return runWithConfig(cfg, () => fn(cfg)); }

/** GET status (the caller's own connection). */
export async function connectStatus({ req, user, query = {} }) {
  return inFresh(user, async (cfg) => {
    let g = googleConfig(cfgEnv, cfg.google);
    const re = redirectUriFor(req), sel = selectionFrom((n) => cfg.get(n));
    const tok = cfg.google;
    const out = {
      ok: true, writable: true, mode: 'user',
      clientId: g.clientId, clientIdSet: Boolean(g.clientId), clientSecretSet: Boolean(g.clientSecret),
      redirectUri: re.ok ? re.uri : '', redirectUriError: re.ok ? '' : re.error,
      selection: sel, requestedScopes: scopesFor(sel),
      configured: googleConfigured(g), source: g.fromVault ? 'app' : 'none',
      scopes: g.scopes ? [...g.scopes] : null, services: grantedServices(g.scopes),
      connectedAt: tok?.connectedAt || 0, verifiedAt: tok?.verifiedAt || 0, reauthReason: g.reauthReason || '',
    };
    const tools = TOOLS.filter((t) => googleToolAllowed(t, g.scopes));
    out.tools = tools.length; out.read = tools.filter((t) => t.kind === 'read').length; out.write = tools.filter((t) => t.kind === 'write').length;
    if (g.fromVault && g.scopes) {   // the connection is narrower than the current selection: the user has to connect again to apply it
      const want = new Set(out.requestedScopes); out.selectionApplied = [...want].every((x) => g.scopes.has(x)) && [...g.scopes].every((x) => want.has(x));
    } else out.selectionApplied = true;
    if (query.probe === '1' && out.configured && !g.reauth) {
      if (!(await cfg.hit('google-probe', 60, 10))) return bad(429, 'rate_limited', '確認の回数が多すぎます。少し待ってください');
      try {
        await accessToken(g); out.authenticated = true;
        if (g.fromVault && Date.now() - (tok?.verifiedAt || 0) > 60_000) await stamp(user, 'verifiedAt').then((t) => { out.verifiedAt = t || out.verifiedAt; }).catch(() => {});
      } catch (e) { out.authenticated = false; out.error = String(e?.message || e); }
      if (out.authenticated === false) {   // invalid_grant has just been recorded: report the fresh state
        const again = await user.loadConfig({ fresh: true }); g = googleConfig(cfgEnv, again.google);
      }
    }
    out.state = googleState(g);
    return { status: 200, body: out };
  });
}
/** Record that the connection was just verified. @returns {Promise<number|null>} */
async function stamp(user, field) {
  const ring = getKeyring();
  const at = await user.db(async (r) => {
    const t = await ring.getToken(r, GOOGLE); if (!t || t.status !== 'ok') return null;
    const now = Date.now(); await ring.putToken(r, GOOGLE, { ...t.data, [field]: now }, { scopes: t.scopes, status: 'ok', reason: null, revokeUrl: t.revokeUrl }); return now;
  });
  invalidateUserConfig(user.uid);
  return at;
}

/** POST start: the Google consent URL. The page opens it in an external browser / Custom Tab (Google refuses sign-in inside a WebView). */
export async function connectStart({ req, user }) {
  return inFresh(user, async (cfg) => {
    const g = googleConfig(cfgEnv, cfg.google);
    if (!googleClientConfigured(g)) return bad(400, 'client_missing', 'クライアントIDとクライアントシークレットを、先に保存してください');
    const re = redirectUriFor(req); if (!re.ok) return bad(400, 'origin_unknown', re.error);
    if (!(await cfg.hit('google-start', 600, 20))) return bad(429, 'rate_limited', '操作が多すぎます。しばらくしてからもう一度お試しください');
    const sel = selectionFrom((n) => cfg.get(n)), scopes = scopesFor(sel);
    const { nonce, bind } = newBind(user.email);
    const { url, state } = await startFlow({
      bind, pending: pendingFor(user.db), provider: 'google', authUrl: AUTH_URL, tokenUrl: base('oauth', g), clientId: g.clientId, clientSecret: g.clientSecret, redirectUri: re.uri, scopes,
      params: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' },
    });
    audit('google-connect-started', { uid: user.uid.uid, services: sel.services.length, readonly: sel.readonly });
    return { status: 200, headers: { 'set-cookie': bindCookie(state, nonce, { secure: re.uri.startsWith('https:') }) }, body: { ok: true, url, state, redirectUri: re.uri, scopes } };
  });
}

// ---------------------------------------------------------------- callback (no token: protected by the single-use state alone)
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const page = (title, inner) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#080604;color:#f6efe2;font:16px/1.8 "Barlow Semi Condensed","Noto Sans JP","Hiragino Sans","Yu Gothic UI","Meiryo",system-ui,sans-serif}main{max-width:560px;margin:0 auto;padding:40px 20px}
h1{font:400 20px/1.4 "Cinzel","Times New Roman",serif;letter-spacing:3px;color:#FFD99A;margin:0 0 14px}p{margin:8px 0;color:#e9dcc4}.ok{color:#9fe3a8}.warn{color:#ff7a4a}.sub{color:#b99b6a;font-size:14px}
a{color:#E8B96A}.box{border:1px solid rgba(232,185,106,.45);padding:16px 18px;background:#100c07}</style></head><body><main><div class="box">${inner}</div></main></body></html>`;
const FAIL_TEXT = {
  bad_state: ['このログインは無効です。', 403], unknown_state: ['このログインは無効か、期限（10分）が切れています。', 403], used: ['このログインは、すでに使われています。', 403],
  denied: ['Googleで許可されませんでした。', 400], no_refresh_token: ['Googleから更新用のトークンが返りませんでした。https://myaccount.google.com/permissions でこのアプリを一度削除してから、もう一度お試しください。', 400],
  exchange_failed: ['Googleがトークンの発行を断りました。クライアントの種類が「ウェブ アプリケーション」か、登録した戻り先URLが正確かを確認してください。', 400], network: ['Googleとの通信に失敗しました。少し待って、もう一度お試しください。', 502],
};

/** The page for a callback that arrives in a browser other than the one that started the flow (or where cookies cannot be used): nothing is exchanged until the click. */
export const confirmPage = ({ who, what, query }) => {
  const q = new URLSearchParams({ state: String(query.state || ''), ...(typeof query.code === 'string' && query.code ? { code: query.code } : {}), ...(typeof query.error === 'string' && query.error ? { error: query.error } : {}), confirm: '1' });
  return page('確認', `<h1>CONFIRM</h1><p>${esc(what)}を、E.L.V.A.R. の次のアカウントにつなぎます。</p><p class="ok" style="font-size:20px">${esc(who || '（不明）')}</p><p class="warn">これは、あなた自身のアカウントですか？ 見覚えがない、または誰かに「このリンクを開いて許可して」と頼まれたときは、つながずに、このページを閉じてください（許可すると、あなたの${esc(what)}が、そのアカウントの持ち主に渡ります）。</p>
    <p><a href="?${esc(q.toString())}" rel="nofollow" style="display:inline-block;border:1px solid #E8B96A;padding:6px 16px;text-decoration:none">はい、私のアカウントです。つなぐ</a></p><p class="sub">違う場合は、このページを閉じてください。</p>`);
};

/** GET callback. @returns {Promise<{status:number, html:string, headers:object}>} */
export async function connectCallback({ req, query = {} }) {
  const headers = { 'content-security-policy': PAGE_CSP };
  const fail = (text, status) => ({ status, headers, html: page('Googleと連携できませんでした', `<h1>NOT CONNECTED</h1><p class="warn">${esc(text)}</p><p class="sub">アプリの設定の「Google」から、もう一度「Googleと連携」を押してください。</p><p><a href="/">アプリを開く</a></p>`) });
  let db; try { db = await getDb(); } catch { return fail('サービスに接続できません。', 503); }
  if (!(await rateLimit(req, 'oauthcb', 30, 600))) return fail('試行が多すぎます。しばらくしてからもう一度お試しください。', 429);
  const state = String(query.state || '');
  if (!STATE_RE.test(state)) return fail(FAIL_TEXT.bad_state[0], 403);
  let r;
  try { r = await handleCallback({ openPending: openPendingByState(db, 'google'), expectProvider: 'google', cookieNonce: nonceFromReq(req, state), confirmed: query.confirm === '1', tokenUrl: base('oauth', googleConfig(cfgEnv, null)), state, code: typeof query.code === 'string' ? query.code : '', error: typeof query.error === 'string' ? query.error : '' }); }
  catch (e) { console.error('[elvar] google callback:', e?.code || e?.message); return fail('サービスに接続できません。', 503); }
  audit('google-callback', { ok: r.ok, reason: r.reason });   // no user id: the callback knows only the state
  if (!r.ok && r.reason === 'confirm_required') return { status: 200, headers, html: confirmPage({ who: r.who, what: 'Googleのログイン', query }) };
  if (!r.ok) { const [t, s] = FAIL_TEXT[r.reason] || FAIL_TEXT.exchange_failed; return fail(t + ((r.reason === 'denied' || r.reason === 'exchange_failed') && r.error ? `（${esc(r.error)}）` : ''), s); }
  return { status: 200, headers, html: page('Googleと連携しました', '<h1>CONNECTED</h1><p class="ok">Googleの認証を受け取りました。</p><p>E.L.V.A.R. のアプリに戻ってください。アプリが自動で接続を完了します。</p><p class="sub">この画面は閉じて大丈夫です。</p><p><a href="/">アプリを開く</a></p>') };
}

// ---------------------------------------------------------------- claim / disconnect
const CLAIM_FAIL = (code, desc) => {
  if (code === 'access_denied') return 'Googleで許可されませんでした。もう一度「Googleと連携」を押して、許可してください。';
  if (code === 'no_refresh_token') return 'Googleから更新用のトークンが返りませんでした。https://myaccount.google.com/permissions でこのアプリを一度削除してから、もう一度お試しください。';
  if (code === 'network') return 'Googleとの通信に失敗しました。もう一度お試しください。';
  return `Googleがトークンの発行を断りました（${code}${desc ? '：' + desc : ''}）。クライアントの種類が「ウェブ アプリケーション」か、登録した戻り先URLが正確か、クライアントシークレットが正しいかを確認してください。`;
};

/** POST claim { state }: move the tokens from the user's own pending row into their token row. Safe to repeat. */
export async function connectClaim({ body, user }) {
  const state = String(body?.state || '');
  if (!STATE_RE.test(state)) return bad(400, 'bad_state', 'ログインの情報が正しくありません');
  const pending = pendingFor(user.db);
  const c = await claimFlow({ pending, state });
  const brief = async () => { const cfg = await user.loadConfig({ fresh: true }); return { state: runWithConfig(cfg, () => googleState(googleConfig(cfgEnv, cfg.google))) }; };
  if (c.status === 'missing') return { status: 200, body: { ok: true, claimed: false, ...(await brief()) } };
  if (c.status === 'pending') return { status: 200, body: { ok: true, pending: true } };
  if (c.status === 'error') return { status: 200, body: { ok: false, error: c.error, message: CLAIM_FAIL(c.error, c.description) } };
  if (c.provider !== GOOGLE) { await discardPending(pending, state); return { status: 200, body: { ok: true, claimed: false, ...(await brief()) } }; }   // somebody's MCP flow is not a Google login
  const scopes = String(c.tokens.scope || '').split(/\s+/).filter(Boolean), now = Date.now(), ring = getKeyring();
  const revokeUrl = base('revoke');
  await user.db(async (r) => {
    await ring.putToken(r, GOOGLE, { refreshToken: c.tokens.refresh_token, clientId: c.clientId, connectedAt: now, verifiedAt: now }, { scopes: scopes.length ? scopes : c.scopes, status: 'ok', reason: null, revokeUrl });
    await r.audit.append({ action: 'google.connected', target: 'google', meta: { scopes: (scopes.length ? scopes : c.scopes).length } });
  });
  invalidateUserConfig(user.uid);
  await discardPending(pending, state);
  audit('google-connected', { uid: user.uid.uid, scopes: scopes.length });
  return { status: 200, body: { ok: true, claimed: true, ...(await brief()) } };
}

/** POST disconnect: revoke the refresh token at Google, then delete it (deleted even when Google cannot be reached). */
export async function connectDisconnect({ user }) {
  const ring = getKeyring();
  const cur = await user.db((r) => ring.getToken(r, GOOGLE));
  if (!cur) return { status: 200, body: { ok: true, revoked: false, disconnected: false } };
  const revoked = await revokeToken({ provider: 'google', data: cur.data, revokeUrl: cur.revokeUrl }, { googleUrl: base('revoke') });   // offline / refused: still removed here
  await user.db(async (r) => { await r.oauthTokens.del(GOOGLE); await r.audit.append({ action: 'google.disconnected', target: 'google', meta: { revoked } }); });
  invalidateUserConfig(user.uid);
  audit('google-disconnected', { uid: user.uid.uid, revoked });
  return { status: 200, body: { ok: true, revoked, disconnected: true } };
}
