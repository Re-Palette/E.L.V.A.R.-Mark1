// Pure helpers of the Google connect UI (no DOM; tested in test/google-client.test.mjs).

export const PENDING_KEY = 'elvar_google_pending';
export const PENDING_TTL_MS = 10 * 60 * 1000;   // the same 10 minutes as the server's pending flow

const lsOf = (storage) => ({
  get: (k) => { try { return storage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { storage.setItem(k, v); } catch { /* private mode */ } },
  del: (k) => { try { storage.removeItem(k); } catch { /* ignore */ } },
});

/** Remember the state of the flow that was just opened in another browser, so the app can claim the result when it comes back. */
export function savePending(storage, state, now = Date.now()) { lsOf(storage).set(PENDING_KEY, JSON.stringify({ state, at: now })); }
export function readPending(storage, now = Date.now()) {
  const ls = lsOf(storage);
  try {
    const p = JSON.parse(ls.get(PENDING_KEY) || 'null');
    if (p && /^[A-Za-z0-9_-]{43}$/.test(String(p.state)) && now - p.at < PENDING_TTL_MS && now >= p.at - 60_000) return { state: p.state, at: p.at };
  } catch { /* corrupt */ }
  ls.del(PENDING_KEY); return null;
}
export const clearPending = (storage) => lsOf(storage).del(PENDING_KEY);

/** Only Google's own consent screen is ever handed to the OS / an external browser. */
export const isGoogleAuthUrl = (u) => /^https:\/\/accounts\.google\.com\/o\/oauth2\/(v2\/)?auth\?/.test(String(u));

/** How the consent screen is opened: Android WebView and Electron have a bridge (Google refuses sign-in inside a WebView); a browser opens a tab. */
export function externalMode(w) {
  if (w?.ElvarAndroid && typeof w.ElvarAndroid.openExternal === 'function') return 'android';
  if (w?.elvarDesktop && typeof w.elvarDesktop.openExternal === 'function') return 'desktop';
  return 'browser';
}

export const STATE_LABEL = { unconfigured: '未設定', client_only: '未連携', connected: '連携済み', reauth_required: '再接続が必要' };
export const stateChipClass = (s) => (s === 'connected' ? 'ok' : s === 'reauth_required' ? 'warn' : 'off');

/** The checkboxes' value for settings: all products (default) is stored as "nothing". */
export function servicesToSetting(ids, all) { const set = new Set(ids); return all.every((x) => set.has(x)) ? null : all.filter((x) => set.has(x)).join(','); }
export const settingToServices = (v, all) => { const w = new Set(String(v || '').split(',').filter(Boolean)); return w.size ? all.filter((x) => w.has(x)) : [...all]; };

/** What a claim answer means for the screen. */
export function claimOutcome(r) {
  if (!r || r.status !== 200 || !r.body) return { kind: r?.status === 401 ? 'retry' : 'drop' };
  const b = r.body;
  if (b.pending) return { kind: 'wait' };
  if (b.ok === false) return { kind: 'failed', message: b.message || 'Googleとの連携に失敗しました' };
  if (b.ok && b.claimed) return { kind: 'connected' };
  if (b.ok && b.state === 'connected') return { kind: 'connected' };   // the page's own script (or another device) already finished it
  return { kind: 'drop' };
}

/** 2026-11-08 12:00 style, in the viewer's locale. */
export const when = (ts) => (ts ? new Date(ts).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }) : '');
