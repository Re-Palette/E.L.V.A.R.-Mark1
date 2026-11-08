// In-browser Google login (no Node/PowerShell on the owner's PC). Uses a *Web application* OAuth client:
//   POST /api/google/connect   (needs the access token)  -> { url }  the Google consent URL, with a signed single-use `state`
//   GET  /api/google/callback  (state-verified)          -> exchanges the code on the SERVER (client secret never leaves it)
//                                                           and shows the refresh token ONCE so it can be pasted into Vercel.
import { googleConfig, googleClientConfigured, base, SCOPES } from './config.js';
import { signState, verifyState } from './ticket.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function originOf(req) {
  const h = req.headers;
  const proto = String(h['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http')).split(',')[0].trim();
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}
export const redirectUriFor = (req) => `${originOf(req)}/api/google/callback`;

export function buildConnect(req) {
  if (!googleClientConfigured()) return { status: 503, body: { ok: false, error: 'GOOGLE_CLIENT_ID と GOOGLE_CLIENT_SECRET が、サーバー（Vercelの環境変数）に登録されていません。登録して再デプロイしてください。' } };
  const redirectUri = redirectUriFor(req);
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: googleConfig().clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state: signState(redirectUri),
  });
  return { status: 200, body: { ok: true, url, redirectUri } };
}

const page = (title, inner) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#000c1d;color:#d9eef9;font:16px/1.8 "Yu Gothic UI","Meiryo",system-ui,sans-serif}main{max-width:760px;margin:0 auto;padding:32px 18px}h1{font-size:22px;color:#19d3ff}
code,textarea{background:#001a33;border:1px solid rgba(30,166,216,.5);border-radius:4px;color:#d9eef9;font:14px/1.5 Consolas,monospace}textarea{width:100%;height:7em;padding:8px;box-sizing:border-box;word-break:break-all}
button{background:#19d3ff;color:#001428;border:0;border-radius:6px;padding:9px 18px;font:inherit;font-weight:700;cursor:pointer}.w{color:#ffb347}a{color:#19d3ff}</style></head><body><main>${inner}</main></body></html>`;

/** @returns {Promise<{status:number, html:string}>} */
export async function handleCallback(req) {
  const q = new URL(req.url, 'http://x').searchParams;
  const fail = (msg, status = 400) => ({ status, html: page('ログインできませんでした', `<h1>ログインできませんでした</h1><p>${esc(msg)}</p><p><a href="/google-setup/">案内ページに戻る</a></p>`) });
  if (q.get('error')) return fail(`許可されませんでした（${q.get('error')}）。もう一度、案内ページのボタンから試してください。`);
  if (!googleClientConfigured()) return fail('サーバーに GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が登録されていません。', 503);
  const st = verifyState(q.get('state'));
  if (!st.ok) return fail(st.reason, 403);
  if (st.redirectUri !== redirectUriFor(req)) return fail('戻り先のアドレスが一致しません。', 403);
  const cfg = googleConfig();
  let j = {};
  try {
    const r = await fetch(base('oauth', cfg), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: q.get('code') || '', client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: st.redirectUri, grant_type: 'authorization_code' }), signal: AbortSignal.timeout(15_000) });
    j = await r.json().catch(() => ({}));
    if (!r.ok) return fail(`Googleがトークンの発行を断りました（${j.error || r.status}${j.error_description ? '：' + j.error_description : ''}）。クライアントの種類が「ウェブ アプリケーション」か、登録した戻り先のアドレスが正確かを確認してください。`);
  } catch (e) { return fail('Googleとの通信に失敗しました：' + (e?.message || e), 502); }
  if (!j.refresh_token) return fail('更新トークンが返りませんでした。https://myaccount.google.com/permissions で E.L.V.A.R. を一度削除してから、もう一度ボタンを押してください。');
  console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event: 'google-login-completed', scopes: String(j.scope || '').split(' ').length }));
  return { status: 200, html: page('Googleにログインできました', `<h1>Googleにログインできました ✓</h1>
<p>次の値を<b>コピー</b>して、Vercel の <b>Environment Variables</b> に、名前 <code>GOOGLE_REFRESH_TOKEN</code> で登録し、<b>再デプロイ</b>してください。</p>
<textarea id="t" readonly>${esc(j.refresh_token)}</textarea>
<p><button id="c" type="button">コピー</button> <span id="m"></span></p>
<p class="w">この値は、あなたのGoogleに入るための鍵です。<b>この画面は、一度閉じると二度と表示できません</b>（必要なら、ボタンからやり直せます）。他の人には見せないでください。</p>
<script>document.getElementById('c').onclick=async()=>{const t=document.getElementById('t');t.select();try{await navigator.clipboard.writeText(t.value);document.getElementById('m').textContent='コピーしました'}catch{document.getElementById('m').textContent='選択されています。Ctrl+C でコピーしてください'}}</script>`) };
}
