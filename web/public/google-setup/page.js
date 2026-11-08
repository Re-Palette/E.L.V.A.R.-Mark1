// Moved out of index.html so the page works under the site CSP (no inline scripts).
const $ = (id) => document.getElementById(id);
const token = () => { try { return localStorage.getItem('elvar_device_token') || localStorage.getItem('elvar_access_token') || ''; } catch { return ''; } };
const guess = location.origin + '/api/google/callback';
let redirect = guess;

function showRedirect(uri, exact) {
  redirect = uri; $('u-redirect').textContent = uri;
  $('u-note').textContent = exact ? 'このアプリが実際に使うアドレスです。そのまま登録してください。' : 'いま開いているアドレスから作った値です。アプリの設定の「Google」タブに出る値が正確です（違うときは、そちらを使います）。';
}
showRedirect(guess, false);

async function check() {
  const el = $('status'); el.textContent = '現在の状態を確認中…';
  const t = token();
  if (!t) { el.innerHTML = '状態：<b class="no">ログインしていません</b>（アプリ本体を開いてログインすると、ここに状態が出ます）'; return; }
  try {
    const r = await fetch('/api/elvar/connect/google/status?probe=1', { headers: { 'x-elvar-token': t } });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { el.innerHTML = '状態：<b class="no">ログインが必要です</b>（アプリ本体を開いて、ログインしてください）'; return; }
    if (j.redirectUri) showRedirect(j.redirectUri, true);
    if (j.state === 'connected') el.innerHTML = '状態：<b class="ok">連携済み ✓</b>　読み取り ' + j.read + ' ／ 書き込み ' + j.write + '（書き込みは毎回、承認が必要）';
    else if (j.state === 'reauth_required') el.innerHTML = '状態：<b class="no">再接続が必要です</b>→ アプリの設定「Google」で「再接続」を押してください。';
    else if (j.state === 'client_only') el.innerHTML = '状態：<b class="no">未連携</b>（クライアントIDとシークレットは入っています。設定の「Google」で「Googleと連携」を押してください）';
    else el.innerHTML = '状態：<b class="no">未設定</b>（下の手順の途中です）';
  } catch { el.innerHTML = '状態：<b class="no">サーバーに接続できません</b>'; }
}
$('recheck').onclick = check; check();
$('copy-redirect').onclick = async () => { try { await navigator.clipboard.writeText(redirect); $('copy-redirect').textContent = 'コピーしました'; } catch { $('copy-redirect').textContent = '手動でコピーしてください'; } setTimeout(() => { $('copy-redirect').textContent = 'コピー'; }, 2500); };
const o = location.origin; $('u-home').textContent = o + '/'; $('u-priv').textContent = o + '/privacy/'; $('u-terms').textContent = o + '/terms/';
