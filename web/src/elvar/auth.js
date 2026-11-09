// Client side of authentication on the multi-user platform. One place for the Supabase Auth session (web/src/elvar/gotrue.js), the Authorization header,
// the sign-in / sign-up screens (web/src/auth/screens.js), per-user local data (web/src/elvar/local.js) and the start-up decision:
//   not configured -> a notice            not signed in -> sign in / sign up            account pending deletion -> offer to cancel
//   suspended -> a notice                  no Gemini key yet -> the setup wizard          otherwise -> the HUD
// Every call to our own /api/ gets `Authorization: Bearer <access token>` (the fetch wrapper in gotrue.js also refreshes it and retries once).
import { setProfileCache } from '../brand.js';
import { createAuthClient, installAuthFetch } from './gotrue.js';
import { adoptUser, clearUserLocal, leaveUser, activeNs } from './local.js';

const SECRET_KEY = 'elvar_notif_secret', FLOW_KEY = 'elvar_auth_flow';
const ls = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

let client = null, session = null, platform = null, lastError = '';
export const authClient = () => client;
export const platformState = () => platform;
export const getAccessToken = () => client?.token() || '';
/** Headers that authorise calls to our own /api. */
export function authHeaders() { const t = getAccessToken(); return t ? { authorization: `Bearer ${t}` } : {}; }
/** Key material for the phone-notification encryption: made once per user on the server, returned with the session. */
export const notifSecret = () => ls.get(SECRET_KEY);
export const lastSessionError = () => lastError;

/** JSON call to our API. @returns {Promise<{status:number, body:any}>} */
export async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, { method, cache: 'no-store', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...authHeaders() }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

export const getState = () => fetch('/api/elvar/state', { cache: 'no-store' }).then((r) => (r.status === 200 ? r.json() : null)).catch(() => null);
export const currentSession = () => session;

/** GET /api/elvar/session: caches the profile (for brand / time zone / greetings) and the notification key. null = not usable; lastSessionError() says why. */
export async function loadSession() {
  lastError = '';
  const r = await api('/api/elvar/session').catch(() => null);
  if (!r) { lastError = 'offline'; return null; }
  if (r.status !== 200) { lastError = r.body?.error || 'error'; return null; }
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

/** Which shell hosts the page: the Android WebView and the Electron desktop shell must send Google sign-in to the system browser. */
export function hostPlatform() {
  if (typeof window === 'undefined') return 'web';
  if (window.ElvarAndroid?.openAuth) return 'android';
  if (window.elvarDesktop?.openAuth) return 'desktop';
  return 'web';
}
export const redirectFor = (p = hostPlatform()) => (p === 'android' ? 'com.elvar.mark1://auth-callback' : p === 'desktop' ? 'elvar://auth-callback' : `${location.origin}/auth/callback/`);

const SETUP_STEP_KEY = 'elvar_setup_step';
export const setupStep = () => ls.get(SETUP_STEP_KEY);
export const setSetupStep = (s) => (s ? ls.set(SETUP_STEP_KEY, s) : ls.del(SETUP_STEP_KEY));
export const markFlow = (f) => (f ? ls.set(FLOW_KEY, f) : ls.del(FLOW_KEY));

const absolute = (u) => { try { return new URL(u, location.href).toString().replace(/\/+$/, ''); } catch { return u; } };
let loginPromise = null;
/**
 * Show the sign-in screen (once, even if several calls hit 401 at the same time) and resolve when somebody is signed in.
 * A different person than before gets a fresh namespace (the page reloads so every module starts in it).
 */
export function requireLogin({ notice = '', initial = 'signin' } = {}) {
  if (loginPromise) return loginPromise;
  loginPromise = (async () => {
    const st = platform || await getState();
    const { runAuthScreens } = await import('../auth/screens.js');
    await runAuthScreens({ client, state: st, notice, initial });
    if (await adoptUser(client.session().user.id)) { location.reload(); await new Promise(() => {}); }
  })().finally(() => { loginPromise = null; });
  return loginPromise;
}

/** A code handed over by the Android / desktop shell after Google sign-in in the system browser (the PKCE verifier is in this page's storage). */
async function handleHandoff(code) {
  try { await client.exchangeCode(String(code)); } catch { return; }
  location.reload();
}

/** Start-up: decide what to show before the HUD starts. Offline / server down: returns null and the HUD starts anyway (it shows what fails). */
export async function bootAuth() {
  platform = await getState();
  if (!platform) return null;
  const screens = () => import('../auth/screens.js');
  if (!platform.configured) { (await screens()).showNotice({ title: 'SETUP REQUIRED', sub: 'サーバーの設定が未完了です', lines: ['このサーバーには、ログインの設定（Supabase）がまだありません。', '運営者向け: docs/ELVAR_MULTIUSER.md の「ローカル開発とテスト」を確認してください。'] }); await new Promise(() => {}); }
  client = createAuthClient({ url: absolute(platform.supabaseUrl), anonKey: platform.publishableKey });
  installAuthFetch(client, { onSignedOut: (why) => { if (!client.session()) requireLogin({ notice: why === 'account_deleted' ? 'このアカウントは削除されました' : '' }); } });
  window.__elvarAuthCode = handleHandoff;

  // a flow that came back to this page (Google, the confirmation link, the password-reset link)
  let notice = '', initial = 'signin';
  const flow = client.parseRedirect(location.href);
  if (flow) {
    try { const u = new URL(location.href); for (const k of ['code', 'error', 'error_code', 'error_description']) u.searchParams.delete(k); u.hash = ''; history.replaceState(null, '', u.pathname + (u.search || '')); } catch { /* keep the address */ }
    const recovery = ls.get(FLOW_KEY) === 'recovery';
    if (flow.code) {
      try { await client.exchangeCode(flow.code); if (recovery) initial = 'reset'; markFlow(''); }
      catch (e) { markFlow(''); notice = e.code === 'no_verifier' ? 'メールの確認が終わりました。ログインしてください' : '手続きを完了できませんでした。もう一度お試しください'; }
    } else { markFlow(''); notice = flow.description || '手続きを完了できませんでした。もう一度お試しください'; }
  }
  if (!client.session() || initial === 'reset') await requireLogin({ notice, initial });

  for (let attempt = 0; attempt < 3; attempt++) {
    const s = await loadSession();
    if (s) {
      const needWizard = Boolean(s.missing?.includes('GEMINI_API_KEY')) || Boolean(setupStep());   // the Gemini key is required: everyone brings their own
      if (needWizard) {
        const { runWizard } = await import('../setup/wizard.js');
        await runWizard({ state: platform, session: s });
        return await loadSession() || s;
      }
      return s;
    }
    if (lastError === 'offline') return null;
    if (lastError === 'account_pending_deletion') { const r = await api('/api/elvar/account/deletion'); await (await screens()).showCancelDeletion({ deletion: r.body?.deletion, api }); continue; }
    if (lastError === 'account_suspended') { (await screens()).showNotice({ title: 'SUSPENDED', sub: 'アカウントが停止されています', lines: ['このアカウントは、運営者によって停止されています。心当たりがない場合は、運営者にお問い合わせください。'], actions: [{ label: 'ログアウト', run: () => logout() }] }); await new Promise(() => {}); }
    if (lastError === 'platform_unconfigured' || lastError === 'db_unavailable') { (await screens()).showNotice({ title: 'UNAVAILABLE', sub: 'サービスを利用できません', lines: ['サーバーの設定またはデータベースに問題があります。しばらくしてからもう一度お試しください。'], actions: [{ label: '再読み込み', run: () => location.reload() }] }); await new Promise(() => {}); }
    // account_deleted, login_required, invalid_token ...: this session is no good
    await client.signOut();
    await requireLogin({ notice: lastError === 'account_deleted' ? 'このアカウントは削除されました' : 'もう一度ログインしてください' });
  }
  return null;
}

/** Sign out. everywhere = every device; the data this browser holds for the user is erased (shared computers keep nothing). */
export async function logout({ everywhere = false, erase = true } = {}) {
  const ns = activeNs();
  try { await client?.signOut({ scope: everywhere ? 'global' : 'local' }); } catch { /* dropped locally anyway */ }
  ls.del(SECRET_KEY); setProfileCache(null);
  if (erase) await clearUserLocal(ns);
  leaveUser();
  location.reload();
  await new Promise(() => {});
}
