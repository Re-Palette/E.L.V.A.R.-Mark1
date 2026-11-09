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
  // Google connection is being moved to the multi-user platform (each user connects their own Google client): not available yet.
  $('status').innerHTML = '状態：<b class="no">準備中です</b>（Googleとの連携は、まもなく使えるようになります。このページの手順は、そのとき必要になります）';
}
$('recheck').onclick = check; check();
$('copy-redirect').onclick = async () => { try { await navigator.clipboard.writeText(redirect); $('copy-redirect').textContent = 'コピーしました'; } catch { $('copy-redirect').textContent = '手動でコピーしてください'; } setTimeout(() => { $('copy-redirect').textContent = 'コピー'; }, 2500); };
const o = location.origin; $('u-home').textContent = o + '/'; $('u-priv').textContent = o + '/privacy/'; $('u-terms').textContent = o + '/terms/';
