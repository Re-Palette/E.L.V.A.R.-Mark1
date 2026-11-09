// A small client for Supabase Auth (GoTrue's REST API): e-mail + password sign-up with e-mail confirmation, sign-in, PKCE code exchange (Google sign-in,
// confirmation and password-reset links), refresh-token rotation, password change, sign-out. No dependency: the same code talks to a real Supabase project
// and to the local development issuer. Only the publishable key is used here, never a service key.
// The session lives in localStorage under elvar_auth_session (device-wide, outside the per-user namespace), refreshed one minute before it expires,
// under a Web Lock (when the browser has one) so that two tabs never spend the same refresh token (Auth revokes a session whose token is reused).
const SESSION_KEY = 'elvar_auth_session', PKCE_KEY = 'elvar_auth_pkce';

export class AuthApiError extends Error {
  constructor(status, code, message) { super(message || code); this.name = 'AuthApiError'; this.status = status; this.code = code || 'unknown'; }
}
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomVerifier = () => b64u(crypto.getRandomValues(new Uint8Array(48)));
export async function challengeOf(verifier) { return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))); }

export function createAuthClient({ url, anonKey, storage = globalThis.localStorage, fetchImpl = (...a) => globalThis.fetch(...a), now = () => Date.now(), locks = globalThis.navigator?.locks } = {}) {
  const base = String(url || '').replace(/\/+$/, '') + '/auth/v1';
  const listeners = new Set();
  const rawGet = (k) => { try { return storage.getItem(k); } catch { return null; } };   // keys start with elvar_auth: web/public/ns.js leaves them un-namespaced (the session is device-wide)
  const rawSet = (k, v) => { try { storage.setItem(k, v); } catch { /* blocked */ } };
  const rawDel = (k) => { try { storage.removeItem(k); } catch { /* blocked */ } };
  let mem = null, timer = 0, inflight = null;

  const read = () => { try { const j = JSON.parse(rawGet(SESSION_KEY) || 'null'); return j && j.access_token && j.refresh_token ? j : null; } catch { return null; } };
  const emit = (event) => { for (const f of listeners) { try { f(event, mem); } catch { /* a listener must not break auth */ } } };
  function schedule() {
    clearTimeout(timer); if (!mem) return;
    const ms = Math.max(5_000, mem.expires_at * 1000 - now() - 60_000);
    timer = setTimeout(() => { refresh().catch(() => {}); }, Math.min(ms, 2 ** 31 - 1)); timer?.unref?.();
  }
  function store(s, event) {
    mem = s ? { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at || Math.floor(now() / 1000) + (s.expires_in || 3600), user: { id: s.user?.id, email: s.user?.email || null, provider: s.user?.app_metadata?.provider || 'email' } } : null;
    if (mem) rawSet(SESSION_KEY, JSON.stringify(mem)); else rawDel(SESSION_KEY);
    schedule(); emit(event);
  }
  mem = read(); schedule();

  async function call(path, { method = 'POST', body, token, query } = {}) {
    const u = base + path + (query ? '?' + new URLSearchParams(query) : '');
    let r;
    try { r = await fetchImpl(u, { method, headers: { apikey: anonKey, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch { throw new AuthApiError(0, 'network', 'network'); }
    if (r.status === 204) return {};
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new AuthApiError(r.status, j.error_code || j.code || j.error || 'unknown', j.msg || j.message || j.error_description || '');
    return j;
  }
  const security = (captchaToken) => (captchaToken ? { gotrue_meta_security: { captcha_token: captchaToken } } : {});

  async function newPkce() { const v = randomVerifier(); rawSet(PKCE_KEY, v); return { challenge: await challengeOf(v), code_challenge_method: 's256' }; }

  async function refresh() {
    const run = async () => {
      const cur = read() || mem; if (!cur) throw new AuthApiError(401, 'no_session');
      if (cur.expires_at * 1000 - now() > 30_000 && cur.access_token !== mem?.access_token) { mem = cur; schedule(); emit('TOKEN_REFRESHED'); return mem; }   // another tab did it
      try { const s = await call('/token', { query: { grant_type: 'refresh_token' }, body: { refresh_token: cur.refresh_token } }); store(s, 'TOKEN_REFRESHED'); return mem; }
      catch (e) { if (e.status === 400 || e.status === 401 || e.status === 403) { store(null, 'SIGNED_OUT'); } throw e; }
    };
    if (!inflight) inflight = (locks ? locks.request('elvar-auth-refresh', run) : run()).finally(() => { inflight = null; });
    return inflight;
  }

  return {
    session: () => mem,
    /** A token that is valid for at least 30 more seconds (refreshes first when needed); null when signed out. */
    async accessToken() {
      mem = read() || mem; if (!mem) return null;
      if (mem.expires_at * 1000 - now() < 30_000) { try { await refresh(); } catch { return mem?.access_token || null; } }
      return mem?.access_token || null;
    },
    token: () => mem?.access_token || null,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    refresh,
    /** @returns {Promise<{needsConfirmation:boolean, session?:object}>} */
    async signUp({ email, password, captchaToken, redirectTo }) {
      const pk = await newPkce();
      const r = await call('/signup', { query: redirectTo ? { redirect_to: redirectTo } : undefined, body: { email, password, code_challenge: pk.challenge, code_challenge_method: pk.code_challenge_method, ...security(captchaToken) } });
      if (r.access_token) { store(r, 'SIGNED_IN'); return { needsConfirmation: false, session: mem }; }
      return { needsConfirmation: true };
    },
    async signInWithPassword({ email, password, captchaToken }) {
      const s = await call('/token', { query: { grant_type: 'password' }, body: { email, password, ...security(captchaToken) } });
      store(s, 'SIGNED_IN'); return mem;
    },
    /** The URL to open for Google sign-in (the caller navigates, or hands it to the system browser on Android / desktop). */
    async googleUrl({ redirectTo }) {
      const pk = await newPkce();
      return `${base}/authorize?` + new URLSearchParams({ provider: 'google', redirect_to: redirectTo, code_challenge: pk.challenge, code_challenge_method: pk.code_challenge_method });
    },
    /** Finish a flow that came back with ?code= (Google, confirmation link, password reset). Needs the verifier this browser made. */
    async exchangeCode(code) {
      const verifier = rawGet(PKCE_KEY); rawDel(PKCE_KEY);
      if (!verifier) throw new AuthApiError(400, 'no_verifier', 'no verifier');
      const s = await call('/token', { query: { grant_type: 'pkce' }, body: { auth_code: code, code_verifier: verifier } });
      store(s, 'SIGNED_IN'); return mem;
    },
    async resetPassword({ email, captchaToken, redirectTo }) {
      const pk = await newPkce();
      await call('/recover', { query: redirectTo ? { redirect_to: redirectTo } : undefined, body: { email, code_challenge: pk.challenge, code_challenge_method: pk.code_challenge_method, ...security(captchaToken) } });
    },
    async resend({ email, redirectTo }) { await call('/resend', { query: redirectTo ? { redirect_to: redirectTo } : undefined, body: { type: 'signup', email } }); },
    async updatePassword(password) { const t = await this.accessToken(); if (!t) throw new AuthApiError(401, 'no_session'); await call('/user', { method: 'PUT', token: t, body: { password } }); },
    /** scope: 'local' (this device) or 'global' (every device). The local session is always dropped, even if the server cannot be reached. */
    async signOut({ scope = 'local' } = {}) {
      const t = mem?.access_token;
      if (t) { try { await call('/logout', { token: t, query: { scope } }); } catch { /* the session is dropped locally regardless */ } }
      store(null, 'SIGNED_OUT');
    },
    /** Parse an address that carries a flow result: ?code=... or ?error=... (also in the fragment). @returns {{code?:string, error?:string, description?:string}|null} */
    parseRedirect(href) {
      try {
        const u = new URL(href), q = new URLSearchParams(u.search), h = new URLSearchParams(u.hash.replace(/^#/, ''));
        const code = q.get('code') || h.get('code'), error = q.get('error') || h.get('error');
        if (code) return { code };
        if (error) return { error, description: q.get('error_description') || h.get('error_description') || '', errorCode: q.get('error_code') || h.get('error_code') || '' };
      } catch { /* not a URL */ }
      return null;
    },
    hasVerifier: () => Boolean(rawGet(PKCE_KEY)),
  };
}

/** Japanese messages for the errors a person can fix. */
export function authMessage(e) {
  const c = e?.code || '';
  if (c === 'network' || e?.status === 0) return 'サーバーに接続できません。通信を確認してください';
  return ({
    invalid_credentials: 'メールアドレスかパスワードが違います',
    email_not_confirmed: 'メールアドレスの確認がまだです。届いたメールのリンクを開いてください',
    user_banned: 'このアカウントは停止されています',
    weak_password: 'パスワードは10文字以上で、大文字・小文字・数字を含めてください',
    captcha_failed: '「ロボットではありません」の確認が済んでいません。もう一度お試しください',
    hook_blocked: e.message || 'このメールアドレスでは登録できません',
    validation_failed: '入力を確認してください',
    over_request_rate_limit: '操作が多すぎます。しばらくしてからお試しください',
    over_email_send_rate_limit: 'メールの送信が多すぎます。しばらくしてからお試しください',
    signup_disabled: '現在、新規登録は停止しています',
    no_verifier: 'このブラウザで始めた手続きではありません。もう一度ログインしてください',
    refresh_token_not_found: 'ログインの有効期限が切れました。もう一度ログインしてください',
    refresh_token_already_used: 'ログインの有効期限が切れました。もう一度ログインしてください',
    same_password: '今のパスワードと同じです。別のものにしてください',
  })[c] || (e?.status === 429 ? '操作が多すぎます。しばらくしてからお試しください' : e?.message && /[ぁ-んァ-ン一-龠]/.test(e.message) ? e.message : '処理できませんでした。しばらくしてからもう一度お試しください');
}

/**
 * Make every call to our own /api/ carry the access token, refresh it first when it is about to expire, and retry once after a 401 that a refresh can fix.
 * An answer that means "this person is no longer signed in" raises elvar:signed-out. Other origins are never touched.
 */
export function installAuthFetch(client, { win = globalThis, onSignedOut = () => {} } = {}) {
  if (win.__elvarAuthFetch) return;
  const native = win.fetch.bind(win); win.__elvarAuthFetch = true;
  const ours = (input) => { try { const u = new URL(typeof input === 'string' ? input : input.url, win.location?.href); return u.origin === win.location?.origin && u.pathname.startsWith('/api/'); } catch { return false; } };
  win.fetch = async (input, init = {}) => {
    if (!ours(input)) return native(input, init);
    const withToken = async () => { const t = await client.accessToken(); const h = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined) || {}); if (t) h.set('authorization', `Bearer ${t}`); return native(input, { ...init, headers: h }); };
    let r = await withToken();
    if (r.status === 401) {
      const e = await r.clone().json().then((j) => j.error).catch(() => '');
      if (e === 'token_expired' || e === 'invalid_token') { try { await client.refresh(); r = await withToken(); } catch { /* signed out below */ } }
      const e2 = r.status === 401 ? await r.clone().json().then((j) => j.error).catch(() => '') : '';
      if (r.status === 401 && ['login_required', 'token_expired', 'invalid_token', 'account_deleted'].includes(e2)) onSignedOut(e2);
    }
    return r;
  };
}
