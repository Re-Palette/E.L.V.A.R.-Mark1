// Moved out of index.html so the page works under the site CSP (no inline scripts).
const $ = (id) => document.getElementById(id);
  async function check() {
    const el = $('status'); el.textContent = '現在の状態を確認中…';
    let token = ''; try { token = localStorage.getItem('elvar_device_token') || localStorage.getItem('elvar_access_token') || ''; } catch {}
    try {
      const r = await fetch('/api/google/status?probe=1', { headers: token ? { 'x-elvar-token': token } : {} });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) el.innerHTML = '<b class="no">アクセストークンが未入力、または違います。</b>先にアプリ本体を開いて、マイクボタンを押し、アクセストークンを入力してください。';
      else if (!j.configured) el.innerHTML = '状態：<b class="no">未設定</b>（下の手順の途中です）';
      else if (j.authenticated === false) el.innerHTML = '状態：<b class="no">ログイン切れ</b>（' + (j.error || '').replace(/[<>&]/g, '') + '）→ 手順6のボタンからやり直してください。';
      else el.innerHTML = '状態：<b class="ok">接続済み ✓</b>　読み取り ' + j.read + ' ／ 書き込み ' + j.write + '（書き込みは毎回、承認が必要）';
    } catch { el.innerHTML = '状態：<b class="no">サーバーに接続できません</b>'; }
  }
  $('recheck').onclick = check; check();
  const redirect = location.origin + '/api/google/callback';
  $('u-redirect').textContent = redirect;
  $('copy-redirect').onclick = async () => { try { await navigator.clipboard.writeText(redirect); $('copy-redirect').textContent = 'コピーしました'; } catch { $('copy-redirect').textContent = '手動でコピーしてください'; } };
  $('login').onclick = async () => {
    const msg = $('login-msg'); msg.textContent = '準備中…';
    let token = ''; try { token = localStorage.getItem('elvar_device_token') || localStorage.getItem('elvar_access_token') || ''; } catch {}
    if (!token) { msg.textContent = '先に E.L.V.A.R. のアプリ（このサイトのトップ）でログインしてから、もう一度押してください'; return; }
    try {
      const r = await fetch('/api/google/connect', { method: 'POST', headers: { 'x-elvar-token': token } });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { try { localStorage.removeItem('elvar_device_token'); } catch {} msg.textContent = 'アクセストークンが違います。もう一度ボタンを押して、入力し直してください。'; return; }
      if (!j.ok) { msg.textContent = j.error || 'ログインを開始できませんでした'; return; }
      location.href = j.url;
    } catch { msg.textContent = 'サーバーに接続できません'; }
  };
  const o = location.origin; $('u-home').textContent = o + '/'; $('u-priv').textContent = o + '/privacy/'; $('u-terms').textContent = o + '/terms/';
