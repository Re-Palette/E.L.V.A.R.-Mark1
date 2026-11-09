// Settings > Google: connect YOUR OWN Google account with YOUR OWN OAuth client (decision O2: there is no shared platform client) (calendar, Gmail, Drive, Docs, Sheets, Tasks, Contacts) with no environment variables.
//   1. register the redirect URI shown here in your own Google OAuth client   2. type its client id / secret (secret: write-only)
//   3. choose the products   4. 「Googleと連携」: consent opens in the system browser / a Custom Tab; coming back, the app claims the result.
import { esc } from '../elvar/ui.js';
import { api } from '../elvar/auth.js';
import { claimNow, expectReturn } from '../google-watch.js';
import { externalMode, isGoogleAuthUrl, readPending, servicesToSetting, settingToServices, STATE_LABEL, stateChipClass, when } from './google-logic.js';

const G = '/api/elvar/connect/google';
const PRODUCTS = [['calendar', 'カレンダー'], ['gmail', 'Gmail'], ['drive', 'ドライブ'], ['docs', 'ドキュメント'], ['sheets', 'スプレッドシート'], ['tasks', 'タスク'], ['contacts', '連絡先']];
const ALL = PRODUCTS.map((p) => p[0]);
const CSS = `
.ev-g-url{display:flex;gap:8px;align-items:stretch}.ev-g-url input{flex:1;min-width:0;font:13px/1.4 'Barlow Semi Condensed',monospace}
.ev-g-prod{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:0 12px}
.ev-g-warn{border:1px solid rgba(255,122,74,.55);background:rgba(255,122,74,.07);padding:10px 14px;margin:10px 0;color:#ffcfb8;font-size:14px}
.ev-g-info{border:1px solid rgba(232,185,106,.35);background:rgba(232,185,106,.05);padding:10px 14px;margin:10px 0;font-size:13.5px;color:#e9dcc4}
.ev-chip.warn{border-color:rgba(255,122,74,.7);color:#ff9a6a}
.ev-g-svc{display:inline-block;margin:2px 6px 2px 0;padding:0 8px;font-size:12.5px;border:1px solid rgba(159,227,168,.45);color:#9fe3a8}
.ev-g-svc.ro{border-color:rgba(232,185,106,.45);color:#E8B96A}
.ev-g-step{display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;margin-right:8px;background:linear-gradient(180deg,#FFD99A,#b07a32);color:#1a1006;font:700 12px/20px 'Barlow Semi Condensed',sans-serif;transform:rotate(45deg) scale(.85)}
.ev-g-step>b{display:inline-block;transform:rotate(-45deg)}
`;
let cssDone = false;

/** @param {HTMLElement} root @param {{compact?:boolean, onChange?:()=>void}} [opts] compact = inside the setup wizard (no heading text) */
export function mountGoogle(root, { compact = false, onChange = () => {} } = {}) {
  if (!cssDone) { cssDone = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
  let cfg = null, st = null, waiting = false, note = { t: '', c: '' };
  const $ = (sel) => root.querySelector(sel);
  const say = (t, c = '') => { note = { t, c }; const m = $('#eg-msg'); if (m) { m.textContent = t; m.className = 'ev-msg ' + c; } };

  function services() { return st?.services ? st.services : []; }
  function draw() {
    if (!st || !cfg) { root.innerHTML = '<p class="ev-msg warn">読み込めませんでした</p>'; return; }
    const writable = st.writable, state = st.state, secret = cfg.secrets?.GOOGLE_CLIENT_SECRET || {}, id = cfg.settings?.GOOGLE_CLIENT_ID?.value || '';
    const picked = settingToServices(cfg.settings?.GOOGLE_SERVICES?.value, ALL), ro = cfg.settings?.GOOGLE_READONLY?.value === '1';
    const connected = state === 'connected' || state === 'reauth_required';
    const ready = Boolean(st.clientIdSet && st.clientSecretSet);
    root.innerHTML = `
      ${compact ? '' : '<p class="ev-note" style="margin-top:0">自分のGoogleアカウントのカレンダーやメールなどを、声で頼めるようにします。Google側の準備（約10分）の手順は <a href="/google-setup/" target="_blank" rel="noopener" style="color:#FFD99A">こちらの案内</a> です。</p>'}
      <div class="ev-row"><span class="l">状態</span><span class="ev-chip ${stateChipClass(state)}" id="eg-chip">${esc(STATE_LABEL[state] || state)}</span>
        ${connected && st.source === 'app' && st.connectedAt ? `<span class="ev-note" style="margin:0">連携 ${esc(when(st.connectedAt))}${st.verifiedAt ? `／最終確認 ${esc(when(st.verifiedAt))}` : ''}</span>` : ''}
        ${st.source === 'env' ? '<span class="ev-note" style="margin:0">環境変数のトークンで接続中</span>' : ''}</div>
      ${state === 'reauth_required' ? `<div class="ev-g-warn"><b>再接続が必要です。</b>${st.reauthReason === 'client_changed' ? 'クライアントIDを変えたため、' : 'Googleとの接続が切れました（取り消し・期限切れ。公開ステータスが「テスト中」だと7日で切れます）。'}下の「再接続」を押してください。</div>` : ''}
      ${connected && st.services ? `<div style="margin:4px 0 8px">${services().map((s) => `<span class="ev-g-svc ${s.write ? '' : 'ro'}">${esc(s.label)}${s.write ? '' : '（読み取りのみ）'}</span>`).join('') || '<span class="ev-note">許可されたサービスがありません</span>'}</div>` : ''}
      ${connected && st.source === 'app' && st.selectionApplied === false ? '<div class="ev-g-info">下で選んだサービスは、まだ反映されていません。「再接続」を押すと反映されます。</div>' : ''}
      ${!writable ? `<p class="ev-note">${st.mode === 'env' ? '環境変数モードです。Googleは環境変数（GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET・GOOGLE_REFRESH_TOKEN）で設定してください。ここでは状態だけ表示します。' : 'セットアップが済むと、ここでGoogleと連携できます。'}</p>` : `
      <div class="ev-sec"><h3><span class="ev-g-step"><b>1</b></span>リダイレクトURIを登録</h3>
        <p class="ev-p" style="font-size:14px">Google Cloud のOAuthクライアント（種類：ウェブ アプリケーション）の「承認済みのリダイレクト URI」に、<b>この値をそのまま</b>登録します。</p>
        ${st.redirectUri ? `<div class="ev-g-url"><input class="ev-input" id="eg-uri" type="text" readonly value="${esc(st.redirectUri)}" aria-label="リダイレクトURI"><button class="ev-btn sm" id="eg-copy" type="button">コピー</button></div>` : `<div class="ev-g-warn">${esc(st.redirectUriError || 'アドレスを決められません')}</div>`}
      </div>
      <div class="ev-sec"><h3><span class="ev-g-step"><b>2</b></span>クライアントID と シークレット</h3>
        <label class="ev-field"><span>クライアントID</span><input class="ev-input" id="eg-id" type="text" autocomplete="off" spellcheck="false" placeholder="123456789-abc….apps.googleusercontent.com" value="${esc(id)}"></label>
        <label class="ev-field"><span>クライアントシークレット <span class="ev-chip ${secret.set ? 'ok' : 'off'}">${secret.set ? `設定済み${secret.last4 ? '・末尾' + esc(secret.last4) : ''}` : '未設定'}</span></span>
          <input class="ev-input" id="eg-secret" type="password" autocomplete="off" spellcheck="false" placeholder="${secret.set ? '入れ直すときだけ入力' : 'GOCSPX-…'}"></label>
        <p class="ev-note">シークレットは暗号化して保存し、画面には二度と表示しません。</p>
      </div>
      <div class="ev-sec"><h3><span class="ev-g-step"><b>3</b></span>使うサービス</h3>
        <div class="ev-g-prod">${PRODUCTS.map(([k, l]) => `<label class="ev-check"><input type="checkbox" data-svc="${k}" ${picked.includes(k) ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div>
        <label class="ev-check"><input type="checkbox" id="eg-ro" ${ro ? 'checked' : ''}><span>読み取りのみ（予定の追加・メール送信などはしない）</span></label>
        <p class="ev-note">許可されたサービスの道具だけが使えます。変更したら、もう一度「Googleと連携」を押します。</p>
      </div>
      <div class="ev-sec"><h3><span class="ev-g-step"><b>4</b></span>連携</h3>
        ${waiting ? '<div class="ev-g-info">Googleの画面で許可してください。終わると、自動でここに反映されます。</div>' : ''}
        <div class="ev-btns" style="margin-top:6px">
          <button class="ev-btn pri" id="eg-connect" type="button" ${st.redirectUri ? '' : 'disabled'}>${connected ? '再接続' : 'Googleと連携'}</button>
          <button class="ev-btn" id="eg-save" type="button">保存だけ</button>
          ${waiting ? '<button class="ev-btn" id="eg-claim" type="button">連携を完了する</button>' : ''}
          ${connected ? '<button class="ev-btn" id="eg-probe" type="button">接続を確認</button>' : ''}
          ${connected && st.source === 'app' ? '<button class="ev-btn danger" id="eg-disc" type="button">切断</button>' : ''}
        </div>
        <p class="ev-note">Googleの画面は、${externalMode(window) === 'android' ? 'Chromeのタブ（Custom Tab）' : externalMode(window) === 'desktop' ? '外部のブラウザ' : '新しいタブ'}で開きます。${ready ? '' : 'クライアントIDとシークレットを入れてから押してください。'}</p>
      </div>
      <div class="ev-g-warn" style="margin-top:14px"><b>公開ステータスに注意：</b>Google Cloud のOAuth同意画面が「テスト」のままだと、連携が<b>7日で切れます</b>。自分専用なら「本番」に切り替えてください（手順は<a href="/google-setup/" target="_blank" rel="noopener" style="color:#FFD99A">案内ページ</a>）。</div>`}
      <div class="ev-msg" id="eg-msg" role="status">${esc(note.t)}</div>`;
    if (note.c) { const m = $('#eg-msg'); m.className = 'ev-msg ' + note.c; }
  }

  async function refresh() {
    const [c, s] = await Promise.all([api('/api/elvar/config'), api(G + '/status')]);
    if (c.status === 200 && s.status === 200) { cfg = c.body; st = s.body; } else { cfg = st = null; }
    try { waiting = Boolean(readPending(localStorage)); } catch { waiting = false; }
    draw();
  }

  const selected = () => [...root.querySelectorAll('[data-svc]')].filter((x) => x.checked).map((x) => x.dataset.svc);
  /** Save what is typed. Returns true when the server accepted it (or there was nothing to change). */
  async function save() {
    const id = $('#eg-id').value.trim(), secret = $('#eg-secret').value.trim(), svc = selected();
    if (!svc.length) { say('サービスを1つ以上選んでください', 'warn'); return false; }
    const body = { settings: { GOOGLE_SERVICES: servicesToSetting(svc, ALL), GOOGLE_READONLY: $('#eg-ro').checked ? '1' : null }, secrets: {} };
    if (id) body.settings.GOOGLE_CLIENT_ID = id; else if (cfg.settings?.GOOGLE_CLIENT_ID?.value) body.settings.GOOGLE_CLIENT_ID = null;
    if (secret) body.secrets.GOOGLE_CLIENT_SECRET = secret;
    const r = await api('/api/elvar/config', { method: 'PATCH', body });
    $('#eg-secret').value = '';
    if (r.status !== 200) { say(r.body?.message || '保存できませんでした', 'warn'); return false; }
    cfg = r.body; return true;
  }
  async function reload(msg, cls = 'ok') { const keep = note; note = { t: msg || keep.t, c: msg ? cls : keep.c }; await refresh(); onChange(); }

  async function connect() {
    if (!await save()) return;
    const s0 = await api(G + '/status'); st = s0.body;
    if (!st.clientIdSet || !st.clientSecretSet) { draw(); say('クライアントIDとシークレットを入れてください', 'warn'); return; }
    const mode = externalMode(window);
    // A browser blocks a tab that is opened after an await: open a blank one now, inside the click, and point it at Google when the URL arrives.
    const tab = mode === 'browser' ? window.open('', '_blank') : null;
    say('Googleの画面を準備しています…');
    const r = await api(G + '/start', { method: 'POST', body: {} });
    if (r.status !== 200 || !r.body?.url || !isGoogleAuthUrl(r.body.url)) { try { tab?.close(); } catch { /* ignore */ } await refresh(); say(r.body?.message || '開始できませんでした', 'warn'); return; }
    expectReturn(r.body.state); waiting = true;
    if (mode === 'android') window.ElvarAndroid.openExternal(r.body.url);
    else if (mode === 'desktop') window.elvarDesktop.openExternal(r.body.url);
    else if (tab) { try { tab.opener = null; } catch { /* ignore */ } tab.location.href = r.body.url; }
    else { draw(); say(''); $('#eg-msg').innerHTML = `開かないときは <a href="${esc(r.body.url)}" target="_blank" rel="noopener" style="color:#FFD99A">こちらを押してください</a>`; return; }
    draw(); say('Googleの画面で許可してください');
  }

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const run = async (fn) => { b.disabled = true; try { await fn(); } catch { say('サーバーに接続できません', 'warn'); } finally { b.disabled = false; } };
    if (b.id === 'eg-copy') { const v = $('#eg-uri').value; try { await navigator.clipboard.writeText(v); b.textContent = 'コピーしました'; } catch { $('#eg-uri').select(); b.textContent = 'Ctrl+C でコピー'; } setTimeout(() => { b.textContent = 'コピー'; }, 2500); }
    else if (b.id === 'eg-save') run(async () => { if (await save()) await reload('保存しました'); });
    else if (b.id === 'eg-connect') run(connect);
    else if (b.id === 'eg-claim') run(async () => { const r = await claimNow(); say(r === 'wait' ? 'まだ完了していません。Googleの画面で許可してください' : r === 'idle' ? '連携の途中ではありません。もう一度「Googleと連携」を押してください' : '', r === 'wait' || r === 'idle' ? 'warn' : ''); });
    else if (b.id === 'eg-probe') run(async () => { say('確認しています…'); const r = await api(G + '/status?probe=1'); if (r.status === 200) { st = r.body; draw(); say(st.authenticated ? '接続できています' : st.error || '確認できませんでした', st.authenticated ? 'ok' : 'warn'); onChange(); } });
    else if (b.id === 'eg-disc') run(async () => {
      if (!confirm('Googleとの連携を切断します。Google側でも許可を取り消し、このアプリに保存した接続を削除します。よろしいですか？')) return;
      const r = await api(G + '/disconnect', { method: 'POST', body: {} });
      if (r.status !== 200 || !r.body?.ok) return say(r.body?.message || '切断できませんでした', 'warn');
      waiting = false; await reload(r.body.revoked ? '切断しました（Google側の許可も取り消しました）' : '切断しました（Google側の取り消しは、Googleのアカウント設定で行えます）');
    });
  });

  addEventListener('elvar:google', async (e) => {
    const k = e.detail?.kind; if (!root.isConnected) return;
    if (k === 'connected') { waiting = false; await reload('Googleと連携しました', 'ok'); }
    else if (k === 'failed') { waiting = false; await reload(e.detail.message, 'warn'); }
    else if (k === 'waiting') { waiting = true; }
  });
  return { refresh };
}
