// A fake Supabase Auth (GoTrue) for LOCAL DEVELOPMENT ONLY, so the whole sign-up -> wizard -> HUD -> settings flow can be tried and tested with
// ELVAR_DB=memory and no Supabase project. It speaks the subset of GoTrue's REST API the app uses (docs/ELVAR_MULTIUSER.md 2): e-mail + password sign-up with
// a confirmation mail, sign-in, refresh-token rotation, PKCE code exchange, password recovery, a fake "Google" account chooser, /user, /logout, and the admin
// calls the server makes with the service key (ban, app_metadata, delete). Access tokens are real ES256 JWTs verified by the server like Supabase's.
//
// IMPOSSIBLE TO ENABLE IN PRODUCTION: this module refuses to load on Vercel or with NODE_ENV=production, needs ELVAR_DEV_AUTH=1 AND ELVAR_DB=memory
// (server/dev/dev-auth-guard.js), and only server/index.js (the local server) imports it; api/*.js (the Vercel functions) never do
// (test/dev-auth.test.mjs checks both). "E-mails" are not sent: they are kept in a mailbox you read at /dev-supabase/dev/mailbox and printed to the console.
import crypto from 'node:crypto';
import * as jose from 'jose';
import { assertDevAuthAllowed } from './dev-auth-guard.js';

if (process.env.VERCEL || process.env.NODE_ENV === 'production') throw new Error('server/dev/fake-auth.js must never run in production');

export const DEV_PUBLISHABLE_KEY = 'dev-publishable-key';
export const DEV_SERVICE_KEY = 'dev-service-key';
export const DEV_CAPTCHA_OK = 'dev-captcha-ok';
const DISPOSABLE = ['mailinator.com', 'guerrillamail.com', 'yopmail.com', '10minutemail.com', 'tempmail.com', 'trashmail.com'];
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256b64u = (s) => crypto.createHash('sha256').update(s).digest('base64url');
const rand = (n = 24) => crypto.randomBytes(n).toString('base64url');

export async function createFakeAuth({ db, issuerBase, base = '/dev-supabase', env = process.env, log = console.log } = {}) {
  assertDevAuthAllowed(env);
  const issuer = `${issuerBase}${base}/auth/v1`;
  const { publicKey, privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
  const kid = 'dev-' + rand(6), jwk = { ...(await jose.exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const users = new Map(), byEmail = new Map(), codes = new Map(), refresh = new Map(), links = new Map(), mailbox = [];
  const captchaRequired = env.ELVAR_DEV_CAPTCHA === '1';
  const signupMode = String(env.ELVAR_SIGNUP || 'open');
  const publicUser = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.confirmed ? u.confirmedAt : null, phone: '', app_metadata: { provider: u.provider, providers: [u.provider], ...(u.appMetadata || {}) }, user_metadata: u.meta || {}, identities: [{ provider: u.provider }], created_at: u.createdAt, updated_at: u.createdAt });

  const send = (u, type, redirectTo, challenge) => {
    const token = rand(18);
    links.set(token, { userId: u.id, type, challenge: challenge || null, redirectTo: redirectTo || '', exp: Date.now() + 3600_000 });
    const link = `${issuer}/verify?token=${token}&type=${type}${redirectTo ? `&redirect_to=${encodeURIComponent(redirectTo)}` : ''}`;
    const subject = type === 'signup' ? '【E.L.V.A.R.】メールアドレスの確認' : '【E.L.V.A.R.】パスワードの再設定';
    mailbox.push({ to: u.email, subject, link, type, at: new Date().toISOString() });
    log(`[dev-auth] mail to ${u.email}: ${subject}\n[dev-auth]   ${link}`);
  };

  async function session(u, sid = rand(8)) {
    const now = Math.floor(Date.now() / 1000), exp = now + 3600;
    const access = await new jose.SignJWT({ role: 'authenticated', email: u.email, session_id: sid, aal: 'aal1', is_anonymous: false,
      app_metadata: { provider: u.provider, providers: [u.provider], ...(u.appMetadata || {}) }, user_metadata: u.meta || {} })
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' }).setIssuer(issuer).setAudience('authenticated').setSubject(u.id).setIssuedAt(now).setExpirationTime(exp).sign(privateKey);
    const rt = rand(16); refresh.set(rt, { userId: u.id, sid, used: false });
    db.testing.touchSignIn?.(u.id);
    return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: rt, user: publicUser(u) };
  }
  const err = (res, status, code, msg) => json(res, status, { code: status, error_code: code, msg });
  const json = (res, status, body, headers = {}) => { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store'); for (const [k, v] of Object.entries(headers)) res.setHeader(k, v); res.end(status === 204 ? '' : JSON.stringify(body)); };
  const redirect = (res, to) => { res.statusCode = 302; res.setHeader('location', to); res.setHeader('cache-control', 'no-store'); res.end(); };

  const hook = (email) => {   // the same rules as app.before_user_created (supabase/migrations/..._admin_signup.sql)
    const dom = String(email).split('@')[1] || '';
    if (signupMode === 'closed') return 'サインアップは停止しています';
    if (DISPOSABLE.some((d) => dom === d || dom.endsWith('.' + d))) return '使い捨てのメールアドレスは使えません';
    return '';
  };
  const captchaOk = (body) => !captchaRequired || body?.gotrue_meta_security?.captcha_token === DEV_CAPTCHA_OK;
  const strong = (pw) => typeof pw === 'string' && pw.length >= 10 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw);
  const apiKeyOk = (req) => req.headers.apikey === DEV_PUBLISHABLE_KEY || req.headers.apikey === DEV_SERVICE_KEY;
  const bearerUser = async (req) => {
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || '')); if (!m) return null;
    try { const { payload } = await jose.jwtVerify(m[1], publicKey, { issuer, audience: 'authenticated' }); return { u: users.get(payload.sub), sid: payload.session_id }; } catch { return null; }
  };
  const isService = (req) => req.headers.apikey === DEV_SERVICE_KEY && req.headers.authorization === `Bearer ${DEV_SERVICE_KEY}`;
  const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 100000) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); req.on('error', () => resolve({})); });
  const readForm = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(b)))); req.on('error', () => resolve({})); });

  function createUser({ email, password, provider = 'email', confirmed = false, meta }) {
    const id = crypto.randomUUID(), createdAt = new Date().toISOString();
    const u = { id, email, password: password ? crypto.createHash('sha256').update('dev|' + password).digest('hex') : null, provider, confirmed, confirmedAt: confirmed ? createdAt : null, createdAt, meta, banned: false, appMetadata: {} };
    users.set(id, u); byEmail.set(email, id); db.testing.newUser(id, email, { confirmed });
    return u;
  }
  const pwOk = (u, pw) => u.password && u.password === crypto.createHash('sha256').update('dev|' + pw).digest('hex');

  const googlePage = (q) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google（開発用の偽物）</title>
<body style="margin:0;font:16px/1.6 sans-serif;background:#f1f3f4;color:#202124;display:flex;min-height:100vh;align-items:center;justify-content:center">
<form method="post" action="${base}/auth/v1/dev/google-continue" style="background:#fff;padding:32px;border-radius:8px;width:min(380px,92vw);box-shadow:0 1px 4px rgba(0,0,0,.3)">
<h1 style="font-size:20px;margin:0 0 4px">Google でログイン</h1><p style="margin:0 0 16px;color:#5f6368">開発用の偽のアカウント選択です（本物の Google ではありません）</p>
<input type="hidden" name="redirect_to" value="${esc(q.redirect_to || '')}"><input type="hidden" name="challenge" value="${esc(q.code_challenge || '')}">
<label>メールアドレス<br><input name="email" type="email" required autofocus value="google.user@example.test" style="width:100%;padding:8px;box-sizing:border-box;margin-top:4px"></label>
<p><button style="padding:8px 20px;background:#1a73e8;color:#fff;border:0;border-radius:4px;font-size:15px;cursor:pointer">続行</button></p></form>`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** @returns {Promise<boolean>} true when the request belonged to the fake issuer (and was answered) */
  async function handle(req, res, pathname, query) {
    if (!pathname.startsWith(base + '/')) return false;
    const p = pathname.slice(base.length), method = req.method;
    if (p === '/dev/mailbox') { if (method === 'DELETE') { mailbox.length = 0; return json(res, 200, {}), true; } return json(res, 200, { mailbox }), true; }
    if (p === '/auth/v1/.well-known/jwks.json') return json(res, 200, { keys: [jwk] }), true;
    if (p === '/auth/v1/dev/google-continue' && method === 'POST') {
      const f = await readForm(req), email = String(f.email || '').trim().toLowerCase();
      const why = hook(email); if (why) return redirect(res, `${f.redirect_to || '/'}?error=access_denied&error_description=${encodeURIComponent(why)}`), true;
      let u = users.get(byEmail.get(email)); if (!u) u = createUser({ email, provider: 'google', confirmed: true, meta: { full_name: email.split('@')[0] } });
      if (u.banned) return redirect(res, `${f.redirect_to || '/'}?error=access_denied&error_description=${encodeURIComponent('このアカウントは停止されています')}`), true;
      const code = rand(16); codes.set(code, { userId: u.id, challenge: f.challenge || null, exp: Date.now() + 300_000 });
      return redirect(res, `${f.redirect_to || '/'}${(f.redirect_to || '').includes('?') ? '&' : '?'}code=${code}`), true;
    }
    if (!p.startsWith('/auth/v1/')) return json(res, 404, { msg: 'not found' }), true;
    const route = p.slice('/auth/v1'.length);

    if (route === '/authorize' && method === 'GET') {
      if (query.provider !== 'google') return err(res, 400, 'validation_failed', 'unsupported provider'), true;
      res.statusCode = 200; res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.end(googlePage(query)); return true;
    }
    if (route === '/verify' && method === 'GET') {
      const l = links.get(query.token); links.delete(query.token);
      if (!l || l.exp < Date.now() || l.type !== query.type) return redirect(res, `${query.redirect_to || '/'}?error=access_denied&error_code=otp_expired&error_description=${encodeURIComponent('リンクの有効期限が切れています')}`), true;
      const u = users.get(l.userId); if (l.type === 'signup') { u.confirmed = true; u.confirmedAt = new Date().toISOString(); db.testing.setConfirmed?.(u.id, true); }
      const code = rand(16); codes.set(code, { userId: u.id, challenge: l.challenge, exp: Date.now() + 300_000 });
      return redirect(res, `${l.redirectTo || '/'}${(l.redirectTo || '').includes('?') ? '&' : '?'}code=${code}`), true;
    }
    if (!apiKeyOk(req) && !route.startsWith('/admin/')) return err(res, 401, 'no_authorization', 'No API key found in request'), true;

    if (route === '/signup' && method === 'POST') {
      const b = await readBody(req);
      if (!captchaOk(b)) return err(res, 400, 'captcha_failed', 'captcha verification process failed'), true;
      const email = String(b.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(res, 422, 'validation_failed', 'Unable to validate email address: invalid format'), true;
      if (!strong(b.password)) return err(res, 422, 'weak_password', 'Password should be at least 10 characters and contain upper and lower case letters and digits.'), true;
      const why = hook(email); if (why) return err(res, 400, 'hook_blocked', why), true;
      const existing = users.get(byEmail.get(email));
      if (existing) return json(res, 200, { ...publicUser(existing), identities: [] }), true;   // GoTrue does not reveal that the address is registered
      const u = createUser({ email, password: b.password, meta: b.data });
      send(u, 'signup', query.redirect_to, b.code_challenge);
      return json(res, 200, publicUser(u)), true;
    }
    if (route === '/resend' && method === 'POST') { const b = await readBody(req), u = users.get(byEmail.get(String(b.email || '').toLowerCase())); if (u && !u.confirmed) send(u, 'signup', query.redirect_to, null); return json(res, 200, {}), true; }
    if (route === '/recover' && method === 'POST') {
      const b = await readBody(req);
      if (!captchaOk(b)) return err(res, 400, 'captcha_failed', 'captcha verification process failed'), true;
      const u = users.get(byEmail.get(String(b.email || '').toLowerCase())); if (u && u.confirmed && !u.banned) send(u, 'recovery', query.redirect_to, b.code_challenge);
      return json(res, 200, {}), true;
    }
    if (route === '/token' && method === 'POST') {
      const b = await readBody(req), g = query.grant_type;
      if (g === 'password') {
        if (!captchaOk(b)) return err(res, 400, 'captcha_failed', 'captcha verification process failed'), true;
        const u = users.get(byEmail.get(String(b.email || '').trim().toLowerCase()));
        if (!u || !pwOk(u, b.password)) return err(res, 400, 'invalid_credentials', 'Invalid login credentials'), true;
        if (!u.confirmed) return err(res, 400, 'email_not_confirmed', 'Email not confirmed'), true;
        if (u.banned) return err(res, 403, 'user_banned', 'User is banned'), true;
        return json(res, 200, await session(u)), true;
      }
      if (g === 'refresh_token') {
        const r = refresh.get(b.refresh_token); if (!r) return err(res, 400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found'), true;
        const u = users.get(r.userId); if (!u || u.banned) return err(res, 400, 'refresh_token_not_found', 'Invalid Refresh Token'), true;
        if (r.used) { for (const [k, v] of refresh) if (v.sid === r.sid) refresh.delete(k); return err(res, 400, 'refresh_token_already_used', 'Invalid Refresh Token: Already Used'), true; }
        r.used = true; return json(res, 200, await session(u, r.sid)), true;
      }
      if (g === 'pkce') {
        const c = codes.get(b.auth_code); codes.delete(b.auth_code);
        if (!c || c.exp < Date.now() || (c.challenge && sha256b64u(String(b.code_verifier || '')) !== c.challenge)) return err(res, 400, 'validation_failed', 'invalid flow state, no valid flow state found'), true;
        const u = users.get(c.userId); if (u.banned) return err(res, 403, 'user_banned', 'User is banned'), true;
        return json(res, 200, await session(u)), true;
      }
      return err(res, 400, 'validation_failed', 'unsupported grant_type'), true;
    }
    if (route === '/user') {
      const a = await bearerUser(req); if (!a?.u) return err(res, 401, 'bad_jwt', 'invalid JWT'), true;
      if (method === 'GET') return json(res, 200, publicUser(a.u)), true;
      if (method === 'PUT') { const b = await readBody(req); if (!strong(b.password)) return err(res, 422, 'weak_password', 'Password should be at least 10 characters and contain upper and lower case letters and digits.'), true; a.u.password = crypto.createHash('sha256').update('dev|' + b.password).digest('hex'); return json(res, 200, publicUser(a.u)), true; }
    }
    if (route === '/logout' && method === 'POST') {
      const a = await bearerUser(req); if (!a?.u) return json(res, 204, null), true;
      for (const [k, v] of refresh) if (v.userId === a.u.id && (query.scope === 'global' || v.sid === a.sid)) refresh.delete(k);
      return json(res, 204, null), true;
    }
    const adm = /^\/admin\/users\/([0-9a-f-]{36})$/.exec(route);
    if (adm) {
      if (!isService(req)) return err(res, 401, 'not_admin', 'This endpoint requires a Bearer token from a service role'), true;
      const u = users.get(adm[1]); if (!u) return err(res, 404, 'user_not_found', 'User not found'), true;
      if (method === 'DELETE') { users.delete(u.id); byEmail.delete(u.email); for (const [k, v] of refresh) if (v.userId === u.id) refresh.delete(k); db.testing.deleteUser(u.id); return json(res, 200, {}), true; }
      if (method === 'PUT') {
        const b = await readBody(req);
        if (b.ban_duration !== undefined) { u.banned = b.ban_duration !== 'none'; if (u.banned) for (const [k, v] of refresh) if (v.userId === u.id) refresh.delete(k); }
        if (b.app_metadata) u.appMetadata = { ...u.appMetadata, ...b.app_metadata };
        return json(res, 200, publicUser(u)), true;
      }
    }
    return err(res, 404, 'not_found', 'not found'), true;
  }

  return { handle, mailbox, issuer, users, kid };
}
