// The sign-in / sign-up / password-reset screens, in the gold HUD style (docs/ELVAR_MULTIUSER.md 2). Full page, not a dialog: the first thing a new person sees.
//   runAuthScreens({ client, state, notice, initial })   resolves once somebody is signed in (client.session() is set)
//   showNotice / showCancelDeletion                      one-purpose pages (not configured, suspended, "cancel the deletion")
// Sign-up is open to anyone (state.signup): e-mail + password with a confirmation mail, or Google. Cloudflare Turnstile guards sign-up, sign-in and
// reset when the platform has a site key. Nothing here ever shows or stores a password beyond the form field.
import { ensureUiCss, esc } from '../elvar/ui.js';
import { authMessage } from '../elvar/gotrue.js';
import { hostPlatform, redirectFor, markFlow } from '../elvar/auth.js';

const CSS = `
.ea-root{--g:#E8B96A;--gh:#FFD99A;--gd:#8A5A20;--txt:#f6efe2;--sub:#b99b6a;--warn:#ff7a4a;--ok:#9fe3a8;position:fixed;inset:0;z-index:70;overflow:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px 16px;box-sizing:border-box;color:var(--txt,#f6efe2);
  background:radial-gradient(ellipse 70% 55% at 50% 38%,rgba(150,96,36,.28),transparent 72%),radial-gradient(ellipse 100% 70% at 50% 120%,rgba(232,185,106,.10),transparent 70%),#050302;
  font:15px/1.65 'Barlow Semi Condensed','Noto Sans JP','Hiragino Sans','Yu Gothic UI','Meiryo',sans-serif}
.ea-root *{box-sizing:border-box}
.ea-root::before{content:'';position:absolute;inset:0;pointer-events:none;opacity:.5;
  background-image:linear-gradient(rgba(232,185,106,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(232,185,106,.05) 1px,transparent 1px);background-size:44px 44px;
  -webkit-mask-image:radial-gradient(ellipse 60% 55% at 50% 45%,#000,transparent 75%);mask-image:radial-gradient(ellipse 60% 55% at 50% 45%,#000,transparent 75%)}
.ea-brand{position:relative;text-align:center;margin:0 0 18px}
.ea-ring{position:absolute;left:50%;top:50%;width:230px;height:230px;margin:-115px 0 0 -115px;border-radius:50%;pointer-events:none;
  background:conic-gradient(from 0deg,transparent 0 62%,rgba(255,217,154,.55) 75%,transparent 88%);-webkit-mask:radial-gradient(circle,transparent 66%,#000 67% 69%,transparent 70%);mask:radial-gradient(circle,transparent 66%,#000 67% 69%,transparent 70%);animation:ea-spin 9s linear infinite}
.ea-ring.r2{width:290px;height:290px;margin:-145px 0 0 -145px;animation-duration:15s;animation-direction:reverse;opacity:.5}
@keyframes ea-spin{to{transform:rotate(360deg)}}
.ea-mark{position:relative;margin:0;font:400 38px/1.15 'Cinzel','Times New Roman',serif;letter-spacing:12px;padding-left:12px;color:#FFD99A;text-shadow:0 0 18px rgba(255,200,120,.5),0 0 4px rgba(255,200,120,.6)}
.ea-tag{position:relative;margin:4px 0 0;color:#b99b6a;font-size:12.5px;letter-spacing:3px}
.ea-frame{position:relative;--c:20px;width:min(440px,100%);display:flex;padding:1.5px;
  clip-path:polygon(var(--c) 0,calc(100% - var(--c)) 0,100% var(--c),100% calc(100% - var(--c)),calc(100% - var(--c)) 100%,var(--c) 100%,0 calc(100% - var(--c)),0 var(--c));
  background:linear-gradient(135deg,#FFD99A,#8A5A20 28%,#E8B96A 52%,#5a3a14 74%,#FFD99A);filter:drop-shadow(0 0 16px rgba(232,185,106,.30))}
.ea-card{--c:19px;flex:1;min-width:0;padding:24px 28px 26px;
  clip-path:polygon(var(--c) 0,calc(100% - var(--c)) 0,100% var(--c),100% calc(100% - var(--c)),calc(100% - var(--c)) 100%,var(--c) 100%,0 calc(100% - var(--c)),0 var(--c));
  background:radial-gradient(ellipse 80% 40% at 50% 0,rgba(232,185,106,.09),transparent 70%),linear-gradient(180deg,#15100a,#080604 60%,#0b0806)}
.ea-h{display:flex;align-items:center;gap:10px;margin:0 0 4px}.ea-h i{width:8px;height:8px;transform:rotate(45deg);background:#E8B96A;box-shadow:0 0 6px rgba(244,168,58,.8)}
.ea-h h2{margin:0;font:400 19px/1.2 'Cinzel','Times New Roman',serif;letter-spacing:5px;color:#FFD99A}
.ea-sub{margin:0 0 6px;color:#b99b6a;font-size:13px;letter-spacing:1px}
.ea-g{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;margin:14px 0 4px;padding:9px 14px;cursor:pointer;background:#f6efe2;color:#241608;border:1px solid #FFD99A;font:600 14.5px/1.2 'Barlow Semi Condensed','Noto Sans JP',sans-serif;letter-spacing:.8px;
  clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px)}
.ea-g:hover:not(:disabled){background:#fff}.ea-g:disabled{opacity:.5;cursor:default}.ea-g svg{width:18px;height:18px;flex:none}
.ea-or{display:flex;align-items:center;gap:12px;color:#8f7650;font-size:12px;letter-spacing:2px;margin:12px 0 2px}.ea-or::before,.ea-or::after{content:'';flex:1;height:1px;background:rgba(232,185,106,.25)}
.ea-links{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:14px;font-size:13.5px}
.ea-links a,.ea-link{color:#FFD99A;cursor:pointer;background:none;border:0;padding:0;font:inherit;text-decoration:underline;text-underline-offset:3px}
.ea-links a:hover,.ea-link:hover{color:#fff}
.ea-meter{display:flex;gap:4px;margin:6px 0 0}.ea-meter span{flex:1;height:3px;background:rgba(232,185,106,.18)}.ea-meter span.on{background:linear-gradient(90deg,#8A5A20,#FFD99A)}
.ea-hint{margin:4px 0 0;font-size:12.5px;color:#a38a5e}
.ea-note{margin:10px 0 0;padding:9px 12px;border:1px solid rgba(232,185,106,.35);background:rgba(232,185,106,.06);font-size:13.5px;color:#e9dcc4}
.ea-note.warn{border-color:rgba(255,122,74,.55);background:rgba(255,122,74,.08);color:#ffcfb8}
.ea-cap{margin:12px 0 0;min-height:65px;display:flex;align-items:center}
.ea-devcap{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid rgba(232,185,106,.45);background:#0d0a06;cursor:pointer;width:100%}
.ea-foot{position:relative;margin:16px 0 0;font-size:12px;color:#7d6a49;text-align:center;letter-spacing:.6px}.ea-foot a{color:#a38a5e}
.ea-dev{position:relative;margin:0 0 12px;padding:3px 12px;border:1px solid rgba(255,122,74,.55);color:#ffb08a;font-size:12px;letter-spacing:1.5px}
.ea-check{display:flex;gap:10px;align-items:flex-start;margin:12px 0 0;font-size:13.5px;color:#e9dcc4;cursor:pointer}.ea-check input{width:18px;height:18px;margin-top:3px;accent-color:#E8B96A;flex:none}
.ea-check a{color:#FFD99A}
@media (max-width:480px){.ea-card{padding:20px 18px 22px}.ea-mark{font-size:29px;letter-spacing:8px;padding-left:8px}.ea-ring{width:170px;height:170px;margin:-85px 0 0 -85px}.ea-ring.r2{width:215px;height:215px;margin:-107px 0 0 -107px}}
@media (prefers-reduced-motion:reduce){.ea-ring{animation:none}}
`;
let cssDone = false;
function ensureCss() { ensureUiCss(); if (cssDone || typeof document === 'undefined') return; cssDone = true; const s = document.createElement('style'); s.id = 'elvar-auth-css'; s.textContent = CSS; document.head.appendChild(s); }

const G_ICON = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/><path fill="#FBBC05" d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.1 0 24s.9 7.6 2.6 10.8l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>';

const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
/** A captcha widget in `el`; resolves a getter for the current token. site key 'dev-captcha' = the local fake (a checkbox), nothing is loaded. */
function mountCaptcha(el, siteKey) {
  const holder = { token: '', reset: () => {} };
  if (!siteKey) return holder;
  if (siteKey === 'dev-captcha') {
    el.innerHTML = '<label class="ea-devcap"><input type="checkbox" id="ea-devcap"> <span>私はロボットではありません（開発用の偽の確認）</span></label>';
    el.querySelector('#ea-devcap').onchange = (e) => { holder.token = e.target.checked ? 'dev-captcha-ok' : ''; };
    holder.reset = () => { el.querySelector('#ea-devcap').checked = false; holder.token = ''; };
    return holder;
  }
  const render = () => { try { holder.id = window.turnstile.render(el, { sitekey: siteKey, theme: 'dark', callback: (t) => { holder.token = t; }, 'expired-callback': () => { holder.token = ''; }, 'error-callback': () => { holder.token = ''; } }); } catch { /* shown as "not verified" at submit */ } };
  holder.reset = () => { holder.token = ''; try { window.turnstile?.reset(holder.id); } catch { /* ignore */ } };
  if (window.turnstile) render();
  else if (!document.querySelector('script[data-turnstile]')) { const s = document.createElement('script'); s.src = TURNSTILE_SRC; s.async = true; s.dataset.turnstile = '1'; s.onload = render; document.head.appendChild(s); }
  else document.querySelector('script[data-turnstile]').addEventListener('load', render);
  return holder;
}

function strength(pw) {
  let n = 0; if (pw.length >= 10) n++; if (pw.length >= 14) n++; if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) n++; if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) n++;
  return Math.min(4, n);
}
export const passwordProblem = (pw) => (pw.length < 10 ? 'パスワードは10文字以上にしてください' : !/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw) ? '大文字・小文字・数字を、それぞれ1文字以上含めてください' : '');

function shell({ dev = false } = {}) {
  ensureCss();
  const root = document.createElement('div');
  root.className = 'ea-root'; root.setAttribute('role', 'main');
  root.innerHTML = `${dev ? '<div class="ea-dev">DEV LOGIN — 開発用のローカル認証（本番では使えません）</div>' : ''}
    <div class="ea-brand"><div class="ea-ring"></div><div class="ea-ring r2"></div><h1 class="ea-mark">E.L.V.A.R.</h1><p class="ea-tag">あなた専用のAIアシスタント</p></div>
    <div class="ea-frame"><div class="ea-card" data-card></div></div>
    <p class="ea-foot"><a href="/terms/" target="_blank" rel="noopener">利用規約</a>　·　<a href="/privacy/" target="_blank" rel="noopener">プライバシー</a></p>`;
  document.body.appendChild(root);
  return { root, card: root.querySelector('[data-card]'), close: () => root.remove() };
}

/** @returns {Promise<void>} resolves when somebody is signed in */
export function runAuthScreens({ client, state, notice = '', initial = 'signin' }) {
  return new Promise((resolve) => {
    const ui = shell({ dev: Boolean(state?.devAuth) });
    const $ = (id) => ui.card.querySelector('#' + id);
    const signupAllowed = state?.signup !== 'closed';
    let view = initial, cap = { token: '', reset() {} }, pendingEmail = '', note = notice;
    const msg = (t, cls = 'warn') => { const m = $('ea-msg'); if (m) { m.textContent = t; m.className = 'ev-msg ' + cls; } };
    const finish = () => { ui.close(); resolve(); };
    const captchaBox = () => (state?.captchaSiteKey ? '<div class="ea-cap" id="ea-cap"></div>' : '');
    const busy = (on) => ui.card.querySelectorAll('button,input').forEach((b) => { if (b.id !== 'ea-devcap') b.disabled = on; });
    const googleBtn = (label) => `<button class="ea-g" type="button" id="ea-google">${G_ICON}<span>${esc(label)}</span></button><div class="ea-or">または</div>`;
    const noteBox = () => (note ? `<div class="ea-note" role="status">${esc(note)}</div>` : '');

    const views = {
      signin: () => `<div class="ea-h"><i></i><h2>SIGN IN</h2></div><p class="ea-sub">ログイン</p>${noteBox()}
        ${googleBtn('Google でログイン')}
        <form id="ea-form" novalidate>
          <label class="ev-field"><span>メールアドレス</span><input class="ev-input" id="ea-email" type="email" autocomplete="username" inputmode="email" required></label>
          <label class="ev-field"><span>パスワード</span><input class="ev-input" id="ea-pw" type="password" autocomplete="current-password" required></label>
          ${captchaBox()}
          <div class="ev-btns" style="margin-top:14px"><button class="ev-btn pri" id="ea-go" type="submit" style="width:100%">ログイン</button></div>
        </form>
        <div class="ev-msg" id="ea-msg" role="alert"></div>
        <div class="ea-links"><button class="ea-link" type="button" data-go="forgot">パスワードを忘れた</button>${signupAllowed ? '<button class="ea-link" type="button" data-go="signup">アカウントを作る</button>' : '<span class="ea-hint">新規登録は停止中です</span>'}</div>`,
      signup: () => `<div class="ea-h"><i></i><h2>SIGN UP</h2></div><p class="ea-sub">アカウントを作る</p>${noteBox()}
        <p class="ev-p" style="font-size:13.5px;margin:8px 0 0">あなた専用のアシスタントを作ります。名前・口調・記憶・ファイルは、あなただけのものです。</p>
        ${googleBtn('Google で登録')}
        <form id="ea-form" novalidate>
          <label class="ev-field"><span>メールアドレス</span><input class="ev-input" id="ea-email" type="email" autocomplete="username" inputmode="email" required></label>
          <label class="ev-field"><span>パスワード（10文字以上・大文字／小文字／数字）</span><input class="ev-input" id="ea-pw" type="password" autocomplete="new-password" minlength="10" required></label>
          <div class="ea-meter" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
          <label class="ev-field"><span>パスワード（確認）</span><input class="ev-input" id="ea-pw2" type="password" autocomplete="new-password" required></label>
          <label class="ea-check"><input type="checkbox" id="ea-agree"><span><a href="/terms/" target="_blank" rel="noopener">利用規約</a>と<a href="/privacy/" target="_blank" rel="noopener">プライバシーポリシー</a>に同意します（16歳以上）</span></label>
          ${captchaBox()}
          <div class="ev-btns" style="margin-top:14px"><button class="ev-btn pri" id="ea-go" type="submit" style="width:100%">アカウントを作る</button></div>
        </form>
        <div class="ev-msg" id="ea-msg" role="alert"></div>
        <div class="ea-links"><span class="ea-hint">AIのAPIキーは、次の画面で自分のものを入れます</span><button class="ea-link" type="button" data-go="signin">ログインへ</button></div>`,
      forgot: () => `<div class="ea-h"><i></i><h2>RESET</h2></div><p class="ea-sub">パスワードの再設定</p>${noteBox()}
        <p class="ev-p" style="font-size:13.5px">登録したメールアドレスに、再設定用のリンクを送ります。</p>
        <form id="ea-form" novalidate><label class="ev-field"><span>メールアドレス</span><input class="ev-input" id="ea-email" type="email" autocomplete="username" inputmode="email" required></label>
          ${captchaBox()}<div class="ev-btns" style="margin-top:14px"><button class="ev-btn pri" id="ea-go" type="submit" style="width:100%">リンクを送る</button></div></form>
        <div class="ev-msg" id="ea-msg" role="alert"></div><div class="ea-links"><button class="ea-link" type="button" data-go="signin">ログインへ戻る</button></div>`,
      sent: () => `<div class="ea-h"><i></i><h2>CHECK MAIL</h2></div><p class="ea-sub">メールを確認してください</p>
        <div class="ea-note"><b>${esc(pendingEmail)}</b> にメールを送りました。メールのリンクを開くと、手続きが終わります。</div>
        <p class="ea-hint" style="margin-top:12px">届かないときは、迷惑メールのフォルダも見てください。数分たっても届かない場合は、下のボタンでもう一度送れます。</p>
        <div class="ev-btns"><button class="ev-btn" id="ea-resend" type="button">もう一度送る</button></div><div class="ev-msg" id="ea-msg" role="status"></div>
        <div class="ea-links"><button class="ea-link" type="button" data-go="signin">ログインへ</button></div>`,
      reset: () => `<div class="ea-h"><i></i><h2>NEW PASSWORD</h2></div><p class="ea-sub">新しいパスワード</p>${noteBox()}
        <form id="ea-form" novalidate><label class="ev-field"><span>新しいパスワード（10文字以上・大文字／小文字／数字）</span><input class="ev-input" id="ea-pw" type="password" autocomplete="new-password" required></label>
          <div class="ea-meter" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
          <label class="ev-field"><span>新しいパスワード（確認）</span><input class="ev-input" id="ea-pw2" type="password" autocomplete="new-password" required></label>
          <div class="ev-btns" style="margin-top:14px"><button class="ev-btn pri" id="ea-go" type="submit" style="width:100%">変更してログイン</button></div></form><div class="ev-msg" id="ea-msg" role="alert"></div>`,
    };

    async function googleStart() {
      const p = hostPlatform(); busy(true);
      try {
        const url = await client.googleUrl({ redirectTo: redirectFor(p) });
        if (p === 'android') { window.ElvarAndroid.openAuth(url); msg('ブラウザでログインしてください。終わると、このアプリに戻ります', 'ok'); busy(false); return; }
        if (p === 'desktop') { window.elvarDesktop.openAuth(url); msg('ブラウザでログインしてください。終わると、このアプリに戻ります', 'ok'); busy(false); return; }
        location.assign(url);
      } catch (e) { msg(authMessage(e)); busy(false); }
    }

    async function submit() {
      const email = $('ea-email')?.value.trim() || '', pw = $('ea-pw')?.value || '';
      busy(true);
      try {
        if (view === 'signin') {
          if (!email || !pw) return msg('メールアドレスとパスワードを入力してください');
          if (state?.captchaSiteKey && !cap.token) return msg(authMessage({ code: 'captcha_failed' }));
          try { await client.signInWithPassword({ email, password: pw, captchaToken: cap.token }); finish(); }
          catch (e) {
            cap.reset();
            if (e.code === 'email_not_confirmed') { pendingEmail = email; note = ''; go('sent'); return; }
            msg(authMessage(e)); $('ea-pw')?.select();
          }
        } else if (view === 'signup') {
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return msg('メールアドレスの形式が正しくありません');
          const bad = passwordProblem(pw); if (bad) return msg(bad);
          if (pw !== $('ea-pw2').value) return msg('確認のパスワードが一致しません');
          if (!$('ea-agree').checked) return msg('利用規約とプライバシーポリシーへの同意が必要です');
          if (state?.captchaSiteKey && !cap.token) return msg(authMessage({ code: 'captcha_failed' }));
          try {
            const r = await client.signUp({ email, password: pw, captchaToken: cap.token, redirectTo: redirectFor('web') });
            if (r.needsConfirmation) { pendingEmail = email; note = ''; go('sent'); } else finish();
          } catch (e) { cap.reset(); msg(authMessage(e)); }
        } else if (view === 'forgot') {
          if (!email) return msg('メールアドレスを入力してください');
          if (state?.captchaSiteKey && !cap.token) return msg(authMessage({ code: 'captcha_failed' }));
          try { markFlow('recovery'); await client.resetPassword({ email, captchaToken: cap.token, redirectTo: redirectFor('web') }); pendingEmail = email; note = ''; go('sent'); }
          catch (e) { markFlow(''); cap.reset(); msg(authMessage(e)); }
        } else if (view === 'reset') {
          const bad = passwordProblem(pw); if (bad) return msg(bad);
          if (pw !== $('ea-pw2').value) return msg('確認のパスワードが一致しません');
          try { await client.updatePassword(pw); finish(); } catch (e) { msg(authMessage(e)); }
        }
      } finally { if (ui.card.isConnected) busy(false); }
    }

    function go(v) {
      view = v; ui.card.innerHTML = views[v]();
      cap = mountCaptcha($('ea-cap') || document.createElement('div'), state?.captchaSiteKey || '');
      const form = $('ea-form'); if (form) form.onsubmit = (e) => { e.preventDefault(); submit(); };
      const g = $('ea-google'); if (g) g.onclick = googleStart;
      ui.card.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => { note = ''; go(b.dataset.go); }; });
      const pw = $('ea-pw'), meter = ui.card.querySelector('.ea-meter');
      if (pw && meter) pw.oninput = () => { const n = strength(pw.value); meter.querySelectorAll('span').forEach((s, i) => s.classList.toggle('on', i < n)); };
      const rs = $('ea-resend'); if (rs) rs.onclick = async () => { rs.disabled = true; try { await client.resend({ email: pendingEmail, redirectTo: redirectFor('web') }); msg('送りました', 'ok'); } catch (e) { msg(authMessage(e)); } setTimeout(() => { rs.disabled = false; }, 30000); };
      setTimeout(() => (ui.card.querySelector('input:not([type=checkbox])') || ui.card.querySelector('button'))?.focus(), 0);
    }
    go(view);
  });
}

/** A one-purpose page: a title, some lines, buttons. */
export function showNotice({ title, sub = '', lines = [], actions = [] }) {
  const ui = shell();
  ui.card.innerHTML = `<div class="ea-h"><i></i><h2>${esc(title)}</h2></div><p class="ea-sub">${esc(sub)}</p>${lines.map((l) => `<p class="ev-p">${esc(l)}</p>`).join('')}
    <div class="ev-btns">${actions.map((a, i) => `<button class="ev-btn${i === 0 ? ' pri' : ''}" data-i="${i}" type="button">${esc(a.label)}</button>`).join('')}</div>`;
  ui.card.querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => actions[Number(b.dataset.i)].run(ui); });
  return ui;
}

/** Signing in during the 7-day grace period of a deletion: the only screen is "cancel the deletion". */
export function showCancelDeletion({ deletion, api }) {
  return new Promise((resolve) => {
    const when = deletion?.purgeAfter ? new Date(deletion.purgeAfter).toLocaleString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const ui = showNotice({ title: 'ACCOUNT DELETION', sub: '削除が予約されています',
      lines: [when ? `このアカウントは、${when} に完全に削除されます。` : 'このアカウントは、まもなく完全に削除されます。', '削除を取り消して、このまま使い続けることができます。'],
      actions: [
        { label: '削除を取り消す', run: async (u) => { const r = await api('/api/elvar/account/delete/cancel', { method: 'POST', body: {} }); if (r.status === 200) { u.close(); resolve(); } else u.card.querySelector('.ev-msg').textContent = r.body?.message || '取り消せませんでした'; } },
        { label: 'ログアウト', run: async () => { const { logout } = await import('../elvar/auth.js'); await logout({ erase: false }); } },
      ] });
    ui.card.insertAdjacentHTML('beforeend', '<div class="ev-msg warn" role="alert"></div>');
  });
}
