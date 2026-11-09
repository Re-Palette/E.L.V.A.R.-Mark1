// Moved out of index.html so the page works under the site CSP (no inline scripts).
const $ = (id) => document.getElementById(id);
const guess = location.origin + '/api/google/callback';
let redirect = guess;

function showRedirect(uri, exact) {
  redirect = uri; $('u-redirect').textContent = uri;
  $('u-note').textContent = exact ? 'このアプリが実際に使うアドレスです。そのまま登録してください。' : 'いま開いているアドレスから作った値です。アプリの設定の「Google」タブに出る値が正確です（違うときは、そちらを使います）。';
}
showRedirect(guess, false);

// Each user connects their OWN Google client (docs/DECISIONS.md O2): the state of THEIR connection is shown in the app's settings (Google tab), not on this guide.
$('status').innerHTML = '手順を終えたら、アプリの設定の「Google」タブで、クライアントIDとシークレットを入れて「Googleと連携」を押します。あなた専用の接続です。';
$('copy-redirect').onclick = async () => { try { await navigator.clipboard.writeText(redirect); $('copy-redirect').textContent = 'コピーしました'; } catch { $('copy-redirect').textContent = '手動でコピーしてください'; } setTimeout(() => { $('copy-redirect').textContent = 'コピー'; }, 2500); };
const o = location.origin; $('u-home').textContent = o + '/'; $('u-priv').textContent = o + '/privacy/'; $('u-terms').textContent = o + '/terms/';
