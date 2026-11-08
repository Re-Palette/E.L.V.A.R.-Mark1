// Client side of owner authentication. One place for the device token, the x-elvar-token header, the sign-in screen and 401 handling.
// The token is a per-device credential (elv1.<deviceId>.<secret>) issued by the server at setup / sign-in; the desktop app may pass one at launch.
import { overlay, esc } from './ui.js';
import { setProfileCache } from '../brand.js';

const TOKEN_KEY = 'elvar_device_token', LEGACY_KEY = 'elvar_access_token', SECRET_KEY = 'elvar_notif_secret';
const ls = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

export const getToken = () => ls.get(TOKEN_KEY) || ls.get(LEGACY_KEY) || (typeof window !== 'undefined' && window.elvarDesktop?.accessToken) || '';
export function setToken(t) { ls.set(TOKEN_KEY, String(t || '')); ls.del(LEGACY_KEY); }
export function clearToken() { ls.del(TOKEN_KEY); ls.del(LEGACY_KEY); ls.del(SECRET_KEY); }
/** Headers that authorise calls to our own /api. */
export function authHeaders() { const t = getToken(); return t ? { 'x-elvar-token': t } : {}; }
/** Key material for the phone-notification encryption: the vault's notifSecret, or the access token in env mode. */
export const notifSecret = () => ls.get(SECRET_KEY) || getToken();

/** JSON call to our API. @returns {Promise<{status:number, body:any}>} */
export async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, { method, cache: 'no-store', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...authHeaders() }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

export const getState = () => api('/api/elvar/state').then((r) => (r.status === 200 ? r.body : null)).catch(() => null);

let session = null;
export const currentSession = () => session;
/** GET /api/elvar/session: caches the profile (for brand / time zone / greetings) and the notification key. null = not signed in. */
export async function loadSession() {
  const r = await api('/api/elvar/session').catch(() => null);
  if (!r) return null;
  if (r.status === 401) return null;
  if (r.status !== 200) return null;
  session = r.body;
  setProfileCache(session.profile);
  if (session.notifSecret) ls.set(SECRET_KEY, session.notifSecret); else ls.del(SECRET_KEY);
  return session;
}

const defaultDeviceName = () => {
  if (typeof navigator === 'undefined') return 'この端末';
  const ua = navigator.userAgent || '';
  const kind = window.elvarDesktop ? 'デスクトップ' : /Android|iPhone|iPad/i.test(ua) ? 'スマホ' : 'PC';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return `${kind}${br ? `（${br}）` : ''}`;
};
export { defaultDeviceName };

let loginPromise = null;
/**
 * Show the sign-in screen (once, even if several calls hit 401 at the same time) and resolve when this device has a working token.
 * Env mode asks for the shared access token instead of the password.
 */
export function requireLogin({ envMode } = {}) {
  if (loginPromise) return loginPromise;
  loginPromise = (async () => {
    const st = envMode === undefined ? await getState() : { envMode };
    await new Promise((resolve) => showLogin(Boolean(st?.envMode), resolve));
    await loadSession();
  })().finally(() => { loginPromise = null; });
  return loginPromise;
}

function showLogin(envMode, done) {
  const o = overlay({ title: 'SIGN IN', sub: envMode ? 'アクセストークンで接続' : 'オーナーのパスワードでログイン' });
  o.panel.innerHTML = envMode ? `
    <p class="ev-p">このサーバーは環境変数のアクセストークンで保護されています。</p>
    <label class="ev-field"><span>アクセストークン</span><input class="ev-input" id="ev-l-tok" type="password" autocomplete="off" spellcheck="false"></label>
    <div class="ev-btns"><button class="ev-btn pri" id="ev-l-go" type="button">接続する</button></div><div class="ev-msg" id="ev-l-msg"></div>` : `
    <p class="ev-p">この端末はまだログインしていません。セットアップで決めたパスワードを入力してください。</p>
    <label class="ev-field"><span>パスワード</span><input class="ev-input" id="ev-l-pw" type="password" autocomplete="current-password"></label>
    <label class="ev-field"><span>この端末の名前</span><input class="ev-input" id="ev-l-name" type="text" maxlength="40" value="${esc(defaultDeviceName())}"></label>
    <div class="ev-btns"><button class="ev-btn pri" id="ev-l-go" type="button">ログイン</button></div><div class="ev-msg" id="ev-l-msg"></div>
    <p class="ev-note">パスワードを忘れたときは、ログイン済みの別の端末の設定から変更できます。</p>`;
  const $ = (id) => o.panel.querySelector('#' + id), msg = (t, c = '') => { $('ev-l-msg').textContent = t; $('ev-l-msg').className = 'ev-msg ' + c; };
  const go = async () => {
    $('ev-l-go').disabled = true; msg('確認しています…');
    try {
      if (envMode) {
        const t = $('ev-l-tok').value.trim(); if (!t) { msg('入力してください', 'warn'); return; }
        setToken(t);
        const r = await api('/api/elvar/session');
        if (r.status !== 200) { clearToken(); msg('トークンが違います', 'warn'); return; }
      } else {
        const r = await api('/api/elvar/auth/login', { method: 'POST', body: { password: $('ev-l-pw').value, deviceName: $('ev-l-name').value } });
        if (r.status !== 200) { msg(r.body?.message || 'ログインできませんでした', 'warn'); $('ev-l-pw').select(); return; }
        setToken(r.body.token);
      }
      o.close(); done();
    } catch { msg('サーバーに接続できません', 'warn'); }
    finally { if ($('ev-l-go')) $('ev-l-go').disabled = false; }
  };
  $('ev-l-go').onclick = go;
  o.panel.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  setTimeout(() => o.panel.querySelector('input')?.focus(), 0);
}

const SETUP_STEP_KEY = 'elvar_setup_step';
export const setupStep = () => ls.get(SETUP_STEP_KEY);
export const setSetupStep = (s) => (s ? ls.set(SETUP_STEP_KEY, s) : ls.del(SETUP_STEP_KEY));

/**
 * Start-up: make sure this device can talk to the server before the HUD starts.
 *   - not set up yet -> the setup wizard (lazy loaded)
 *   - set up, wizard not finished on this device -> the wizard continues where it stopped
 *   - set up, no valid token -> the sign-in screen
 * Offline / server down: returns null and the HUD starts anyway (it shows what fails).
 */
export async function bootAuth() {
  const st = await getState();
  if (!st) return null;
  const needWizard = (!st.initialized && !st.envMode) || (st.initialized && setupStep() && getToken());
  if (needWizard) {
    const { runWizard } = await import('../setup/wizard.js');
    await runWizard({ state: st });
  }
  let s = await loadSession();
  if (!s) { await requireLogin({ envMode: st.envMode }); s = currentSession(); }
  return s;
}

/** Sign out this device (revokes its token on the server). */
export async function logout() {
  await api('/api/elvar/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  clearToken(); setProfileCache(null);
}
