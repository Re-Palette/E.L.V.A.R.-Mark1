// One-time Google login for E.L.V.A.R. — prints a REFRESH TOKEN to put in your environment (never commit it).
//
//   node google-auth.mjs        (needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the environment or in a .env next to it)
//   options:  --readonly   ask only for read access   --write-env   store GOOGLE_REFRESH_TOKEN in ./.env   --no-open   do not open a browser
//
// Uses the "Desktop app" OAuth client + loopback redirect + PKCE. See docs/GOOGLE_INTEGRATION.md.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

// Self-contained on purpose: the app serves this single file at /google-auth.mjs so it runs without the repository.
// KEEP IN SYNC with SCOPES in server/google/config.js (test/google-auth.test.mjs checks it).
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/contacts.readonly',
];
const TOKEN_URL = process.env.GOOGLE_API_MOCK_ORIGIN ? `${process.env.GOOGLE_API_MOCK_ORIGIN}/oauth` : 'https://oauth2.googleapis.com/token';   // mock only for tests

const argv = new Set(process.argv.slice(2));
// tiny .env reader so no extra flags are needed (an already-set environment variable wins)
try { for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('GOOGLE_CLIENT_ID と GOOGLE_CLIENT_SECRET が未設定です。環境変数で渡すか、このファイルと同じ場所の .env に書いてください（アプリの /google-setup/ の手順4）。');
  process.exit(1);
}
const scopes = argv.has('--readonly')
  ? ['calendar.readonly', 'gmail.readonly', 'drive.readonly', 'documents.readonly', 'spreadsheets.readonly', 'tasks.readonly', 'contacts.readonly'].map((s) => `https://www.googleapis.com/auth/${s}`)
  : SCOPES;

const verifier = crypto.randomBytes(48).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(16).toString('base64url');

let done;
const finished = new Promise((r) => (done = r));
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
  const page = (msg) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<meta charset="utf-8"><body style="font:16px system-ui;background:#000c1d;color:#d9eef9;padding:40px"><h2>E.L.V.A.R.</h2><p>${msg}</p>`); };
  if (url.searchParams.get('state') !== state) { page('state が一致しません。もう一度やり直してください。'); return done({ error: 'state mismatch' }); }
  if (url.searchParams.get('error')) { page('許可されませんでした：' + url.searchParams.get('error')); return done({ error: url.searchParams.get('error') }); }
  try {
    const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: url.searchParams.get('code'), client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }) });
    const j = await r.json();
    if (!r.ok || !j.refresh_token) { page('トークンを取得できませんでした。ターミナルの表示を確認してください。'); return done({ error: j.error_description || j.error || '更新トークンが返りませんでした（以前に許可済みの場合は、https://myaccount.google.com/permissions で E.L.V.A.R. の許可を取り消してから、やり直してください）' }); }
    page('完了しました。このタブは閉じて構いません。ターミナルに戻ってください。');
    done({ refreshToken: j.refresh_token, scope: j.scope });
  } catch (e) { page('通信エラー'); done({ error: String(e) }); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '),
  access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
});
console.log('\n次のアドレスをブラウザで開き、Googleアカウントでログインして許可してください：\n\n' + authUrl + '\n');
console.log('許可を求める権限：\n' + scopes.map((s) => '  - ' + s.replace('https://www.googleapis.com/auth/', '')).join('\n') + '\n');
if (!argv.has('--no-open')) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', authUrl]] : process.platform === 'darwin' ? ['open', [authUrl]] : ['xdg-open', [authUrl]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
}
console.log(`（待機中: ${redirectUri} — 5分で終了します）`);
const timeout = setTimeout(() => done({ error: '時間切れ' }), 5 * 60_000);
const result = await finished;
clearTimeout(timeout); server.close();
if (result.error) { console.error('\n失敗：' + result.error); process.exit(1); }

console.log('\n成功しました。次の1行を、.env（ローカル）と Vercel の Environment Variables に追加してください。他人に見せないでください：\n');
console.log(`GOOGLE_REFRESH_TOKEN=${result.refreshToken}\n`);
if (argv.has('--write-env')) {
  let env = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
  env = /^GOOGLE_REFRESH_TOKEN=.*$/m.test(env) ? env.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, `GOOGLE_REFRESH_TOKEN=${result.refreshToken}`) : env.replace(/\n*$/, '\n') + `GOOGLE_REFRESH_TOKEN=${result.refreshToken}\n`;
  fs.writeFileSync('.env', env); console.log('.env に書き込みました。');
}
