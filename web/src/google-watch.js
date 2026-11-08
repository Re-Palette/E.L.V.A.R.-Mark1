// Google connect, app side: (1) when the user comes back from the consent screen (it was opened in a Custom Tab / the system browser / another tab),
// claim the result; (2) tell the owner when Google needs to be connected again (notification + a badge in Settings).
import { api } from './elvar/auth.js';
import { readPending, savePending, clearPending, claimOutcome } from './settings/google-logic.js';

const CLAIM = '/api/elvar/connect/google/claim';
const emit = (detail) => { try { window.dispatchEvent(new CustomEvent('elvar:google', { detail })); } catch { /* no DOM */ } };
const ls = () => { try { return localStorage; } catch { return null; } };

let busy = false, retry = 0;
/** Ask the server for the result of the flow this device opened. Safe to call any time (and many times). */
export async function claimNow({ quiet = false } = {}) {
  const store = ls(); if (!store || busy) return 'busy';
  const p = readPending(store); if (!p) return 'idle';
  busy = true;
  try {
    const o = claimOutcome(await api(CLAIM, { method: 'POST', body: { state: p.state } }));
    if (o.kind === 'wait') { clearTimeout(retry); retry = setTimeout(() => claimNow({ quiet: true }), 3000); if (!quiet) emit({ kind: 'waiting' }); return 'wait'; }
    if (o.kind === 'retry') return 'retry';
    clearPending(store);
    if (o.kind === 'connected') emit({ kind: 'connected' });
    else if (o.kind === 'failed') emit({ kind: 'failed', message: o.message });
    return o.kind;
  } catch { return 'error'; }
  finally { busy = false; }
}
/** Called when the consent screen has been opened. */
export function expectReturn(state) { const s = ls(); if (s) savePending(s, state); clearTimeout(retry); retry = setTimeout(() => claimNow({ quiet: true }), 4000); }

const NOTE_KEY = 'elvar_google_reauth_notified', NOTE_EVERY_MS = 12 * 3600e3;
export function initGoogleWatch({ inbox, hudLive, session = () => null } = {}) {
  const back = () => claimNow({ quiet: true });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') back(); });
  addEventListener('focus', back);
  addEventListener('pageshow', back);
  window.__elvarResume = back;   // the Android wrapper calls this when the app returns from the Custom Tab
  addEventListener('elvar:google', (e) => {
    if (e.detail?.kind === 'connected') { inbox?.add({ kind: 'notice', title: 'Googleと連携しました', body: 'カレンダーやメールなどを、声で頼めるようになりました。', key: 'google-connected', quiet: true }); hudLive?.refresh?.(); }
  });
  back();

  function checkReauth() {
    const need = hudLive?.getServer?.()?.googleReauth === true || session()?.google?.state === 'reauth_required';
    emit({ kind: 'state', reauth: need });
    if (!need) return;
    const store = ls(); const last = Number(store?.getItem(NOTE_KEY)) || 0;
    if (Date.now() - last < NOTE_EVERY_MS) return;
    try { store?.setItem(NOTE_KEY, String(Date.now())); } catch { /* ignore */ }
    const body = 'Googleとの接続が切れました。設定の「Google」で、もう一度「Googleと連携」を押してください。';
    inbox?.add({ kind: 'alert', title: 'Googleの再接続が必要です', body, key: 'google-reauth' });
    hudLive?.logActivity?.({ icon: 'gear', title: 'Googleの再接続が必要です', sub: '設定 → Google' });
    try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('E.L.V.A.R.', { body }); } catch { /* not allowed here */ }
  }
  setTimeout(checkReauth, 6000); setInterval(checkReauth, 60_000);
  addEventListener('elvar:google', (e) => { if (e.detail?.kind === 'connected') { try { ls()?.removeItem(NOTE_KEY); } catch { /* ignore */ } } });
  return { claimNow, checkReauth };
}
