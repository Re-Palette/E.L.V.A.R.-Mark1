// In-app settings (gear icon / Ctrl+, / ?settings=1). Tabs: アカウント, APIキー, Google, プロフィール, 機能, この端末.
// Server-side values (keys, profile, devices) go through /api/elvar/*; "この端末" is stored on this device only.
import { ensureUiCss, esc } from '../elvar/ui.js';
import { api, currentSession, loadSession } from '../elvar/auth.js';
import { mountDevice } from './device.js';
import { mountKeys } from './keys.js';
import { mountGoogle } from './google.js';
import { mountAccount } from './account.js';
import { mountProfile } from './profile.js';

// The device pane keeps its original markup (vs-* classes); restyled here in the gold palette.
const DEVICE_CSS = `
.vs-gear{cursor:pointer}
.ev-settings .vs-sec{margin-top:16px;padding-top:12px;border-top:1px solid rgba(232,185,106,.18)}
.ev-settings .vs-sec:first-child{border-top:0;margin-top:6px;padding-top:0}
.ev-settings .vs-sec>h3{margin:0 0 8px;font:600 12.5px/1.4 'Barlow Semi Condensed','Noto Sans JP',sans-serif;letter-spacing:2.4px;color:#E8B96A}
.ev-settings .vs-row{display:flex;align-items:center;gap:12px;margin:7px 0}
.ev-settings .vs-row>span.l{flex:0 0 11em;color:#e9dcc4;font-size:14px}
.ev-settings .vs-row output{flex:0 0 3.8em;text-align:right;color:#FFD99A;font-variant-numeric:tabular-nums}
.ev-settings .vs-row input[type=range]{flex:1;min-width:0;accent-color:#E8B96A}
.ev-settings .vs-row input[type=checkbox]{width:18px;height:18px;accent-color:#E8B96A;flex:none}
.ev-settings .vs-row input[type=number]{background:#0d0a06;color:#f6efe2;border:1px solid rgba(232,185,106,.38);padding:4px 8px;font:inherit}
.ev-settings .vs-btn{display:inline-block;background:transparent;color:#E8B96A;border:1px solid rgba(232,185,106,.7);padding:5px 14px;cursor:pointer;font:inherit;font-size:14px;margin:3px 8px 3px 0;
  clip-path:polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px)}
.ev-settings .vs-btn:hover:not(:disabled){background:rgba(232,185,106,.14);color:#FFD99A}
.ev-settings .vs-btn.pri{background:linear-gradient(180deg,#FFD99A,#E8B96A 45%,#b07a32);color:#1a1006;border-color:#FFD99A}
.ev-settings .vs-btn:disabled{opacity:.35;cursor:default}
.ev-settings .vs-info{color:#e9dcc4;font-size:14px;word-break:break-all}.ev-settings .vs-info b{color:#FFD99A}
.ev-settings .vs-msg{font-size:13px;color:#b99b6a;min-height:1.3em}.ev-settings .vs-msg.warn{color:#ff7a4a}.ev-settings .vs-msg.ok{color:#9fe3a8}
.ev-settings .vs-note{font-size:12.5px;color:#b99b6a;margin:6px 0 0}
.ev-settings .vs-file{display:none}
.ev-settings .vs-sel{background:#0d0a06;color:#f6efe2;border:1px solid rgba(232,185,106,.45);padding:4px 8px;font:inherit}
@media (max-width:560px){.ev-settings .vs-row{flex-wrap:wrap}.ev-settings .vs-row>span.l{flex:1 0 100%}}
`;

const TABS = [['account', 'アカウント'], ['keys', 'APIキー'], ['google', 'Google'], ['profile', 'プロフィール'], ['features', '機能'], ['device', 'この端末']];

export function initSettingsPanel(app) {
  ensureUiCss();
  const style = document.createElement('style'); style.textContent = DEVICE_CSS; document.head.appendChild(style);
  const back = document.createElement('div');
  back.className = 'ev-back ev-settings'; back.hidden = true;
  back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true'); back.setAttribute('aria-label', '設定');
  back.innerHTML = `<div class="ev-frame wide"><div class="ev-panel">
    <div class="ev-head"><i></i><div><h2 class="ev-title">SETTINGS</h2><p class="ev-sub">設定</p></div><button class="ev-x" type="button" data-x>閉じる</button></div>
    <div class="ev-tabs" role="tablist">${TABS.map(([id, l]) => `<button class="ev-tab" role="tab" type="button" data-tab="${id}">${esc(l)}</button>`).join('')}</div>
    ${TABS.map(([id]) => `<div class="ev-pane" data-pane="${id}" hidden></div>`).join('')}
  </div></div>`;
  document.body.appendChild(back);
  const pane = (id) => back.querySelector(`[data-pane="${id}"]`);
  const isOpen = () => !back.hidden;
  const close = () => { back.hidden = true; device.stop(); };
  const mode = () => currentSession()?.mode || 'local';

  const device = mountDevice(pane('device'), app, { close });
  const parts = {
    account: mountAccount(pane('account'), { mode }),
    keys: mountKeys(pane('keys')),
    google: mountGoogle(pane('google'), { onChange: () => checkBadge() }),
    profile: mountProfile(pane('profile'), 'profile', { onSaved: () => loadSession() }),
    features: mountProfile(pane('features'), 'features', { onSaved: () => loadSession() }),
    device,
  };
  // A dot on the Google tab when Google must be connected again (the watcher in google-watch.js raises the event; the status endpoint is the source of truth).
  const tabBtn = () => back.querySelector('[data-tab="google"]');
  const setBadge = (on) => { const b = tabBtn(); if (b) { b.classList.toggle('alert', on); b.title = on ? 'Googleの再接続が必要です' : ''; } };
  async function checkBadge() { try { const r = await api('/api/elvar/connect/google/status'); if (r.status === 200) setBadge(r.body.state === 'reauth_required'); } catch { /* offline */ } }
  addEventListener('elvar:google', (e) => { if (e.detail?.kind === 'state') setBadge(Boolean(e.detail.reauth)); else if (e.detail?.kind === 'connected') setBadge(false); });
  let current = 'keys';
  function show(id) {
    current = id;
    for (const [t] of TABS) { pane(t).hidden = t !== id; back.querySelector(`[data-tab="${t}"]`).classList.toggle('on', t === id); back.querySelector(`[data-tab="${t}"]`).setAttribute('aria-selected', String(t === id)); }
    parts[id].refresh();
  }
  function open(tab) { back.hidden = false; show(tab || current); checkBadge(); setTimeout(() => back.querySelector('[data-x]')?.focus(), 0); }
  back.addEventListener('click', (e) => {
    if (e.target === back || e.target.closest('[data-x]')) return close();
    const t = e.target.closest('[data-tab]'); if (t) show(t.dataset.tab);
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) { e.stopImmediatePropagation(); e.preventDefault(); close(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); isOpen() ? close() : open(); }
  }, true);
  // The gear icon belongs to the HUD artwork; listen from outside.
  document.addEventListener('click', (e) => { const g = e.target.closest?.('.vh-set, [data-vh-settings]'); if (g) { e.preventDefault(); open(); } }, true);
  const markGear = () => document.querySelectorAll('.vh-set,[data-vh-settings]').forEach((el) => el.classList.add('vs-gear'));
  markGear(); new MutationObserver(markGear).observe(document.body, { childList: true, subtree: true });

  const q = app.qs?.get('settings');
  if (q) open(TABS.some(([t]) => t === q) ? q : undefined);
  return { open, close };
}
