// Client side of the Google connect: pending state, the external-browser rule, claim outcomes, the setup page, and the desktop / Android wrappers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PENDING_KEY, PENDING_TTL_MS, savePending, readPending, clearPending, isGoogleAuthUrl, externalMode, claimOutcome, servicesToSetting, settingToServices, stateChipClass } from '../web/src/settings/google-logic.js';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
const STATE = 'A'.repeat(43);

test('pending flow: remembered for 10 minutes, then forgotten; garbage is ignored; storage that throws does not break the page', () => {
  const s = mem(), t0 = 1_000_000;
  assert.equal(readPending(s, t0), null);
  savePending(s, STATE, t0);
  assert.deepEqual(readPending(s, t0 + 5 * 60e3), { state: STATE, at: t0 });
  assert.equal(readPending(s, t0 + PENDING_TTL_MS + 1), null); assert.equal(s.getItem(PENDING_KEY), null, 'expired: removed');
  savePending(s, 'short', t0); assert.equal(readPending(s, t0), null, 'not a valid state');
  s.setItem(PENDING_KEY, '{not json'); assert.equal(readPending(s, t0), null);
  savePending(s, STATE, t0); clearPending(s); assert.equal(readPending(s, t0), null);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.doesNotThrow(() => { savePending(broken, STATE); readPending(broken); clearPending(broken); });
});

test('only Google\'s own consent screen is ever opened outside the app', () => {
  assert.equal(isGoogleAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=x'), true);
  for (const bad of ['http://accounts.google.com/o/oauth2/v2/auth?x', 'https://accounts.google.com.evil.example/o/oauth2/v2/auth?x', 'https://evil.example/?https://accounts.google.com/o/oauth2/v2/auth?', 'javascript:alert(1)', 'https://accounts.google.com/signin', '', null, undefined]) assert.equal(isGoogleAuthUrl(bad), false, String(bad));
});

test('the consent screen opens in a Custom Tab on Android, the system browser on desktop, a new tab on the web (never inside the app\'s WebView)', () => {
  assert.equal(externalMode({ ElvarAndroid: { openExternal() {} } }), 'android');
  assert.equal(externalMode({ elvarDesktop: { openExternal() {} } }), 'desktop');
  assert.equal(externalMode({ ElvarAndroid: {} }), 'browser', 'an old APK without the bridge falls back to a tab');
  assert.equal(externalMode({}), 'browser'); assert.equal(externalMode(undefined), 'browser');
});

test('claim answers: waiting, failed (with the reason), connected (claimed here or already finished by the callback page), 401 retries later', () => {
  assert.deepEqual(claimOutcome({ status: 200, body: { ok: true, pending: true } }), { kind: 'wait' });
  assert.deepEqual(claimOutcome({ status: 200, body: { ok: true, claimed: true, state: 'connected' } }), { kind: 'connected' });
  assert.deepEqual(claimOutcome({ status: 200, body: { ok: true, claimed: false, state: 'connected' } }), { kind: 'connected' });
  assert.deepEqual(claimOutcome({ status: 200, body: { ok: true, claimed: false, state: 'client_only' } }), { kind: 'drop' });
  assert.deepEqual(claimOutcome({ status: 200, body: { ok: false, message: 'ダメでした' } }), { kind: 'failed', message: 'ダメでした' });
  assert.deepEqual(claimOutcome({ status: 401, body: {} }), { kind: 'retry' });
  assert.deepEqual(claimOutcome({ status: 400, body: {} }), { kind: 'drop' }); assert.deepEqual(claimOutcome(null), { kind: 'drop' });
});

test('product checkboxes <-> setting: all products = nothing stored; order and unknown ids are normalised', () => {
  const ALL = ['calendar', 'gmail', 'drive', 'docs', 'sheets', 'tasks', 'contacts'];
  assert.equal(servicesToSetting(ALL, ALL), null); assert.equal(servicesToSetting(['tasks', 'calendar'], ALL), 'calendar,tasks');
  assert.deepEqual(settingToServices('', ALL), ALL); assert.deepEqual(settingToServices('tasks,evil,calendar', ALL), ['calendar', 'tasks']);
  assert.equal(stateChipClass('connected'), 'ok'); assert.equal(stateChipClass('reauth_required'), 'warn'); assert.equal(stateChipClass('client_only'), 'off');
});

test('the callback page: strict CSP (no inline script), claim script from our own origin, nothing else', () => {
  const claim = read('web/public/google-setup/claim.js');
  assert.match(claim, /\/api\/elvar\/connect\/google\/claim/); assert.match(claim, /history\.replaceState/, 'the state leaves the address bar');
  assert.doesNotMatch(claim, /eval\(|innerHTML|document\.write|location\.(href|assign|replace)\s*=/, 'no way to redirect anywhere (no open redirect)');
  const html = read('web/public/google-setup/index.html'); assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'no inline script on the guide');
  for (const must of ['ウェブ アプリケーション', 'リダイレクト', 'テストユーザー', '7日', '本番', 'copy-redirect', 'id="u-redirect"']) assert.ok(html.includes(must), must);
  assert.doesNotMatch(html, /GOOGLE_REFRESH_TOKEN[^]{0,80}(Vercel|貼り付け|登録)/, 'no "paste the refresh token into Vercel" step any more');
});

test('desktop: the page can only hand Google\'s authorize URL to the system browser, from our own window', () => {
  const main = read('desktop/main.js'), pre = read('desktop/preload.js');
  assert.match(pre, /openExternal:\s*\(url\)\s*=>\s*ipcRenderer\.send\('elvar:open-external'/);
  const h = main.slice(main.indexOf("ipcMain.on('elvar:open-external'")); const body = h.slice(0, h.indexOf('});') + 3);
  assert.match(body, /e\.sender === win\.webContents/); assert.match(body, /OUR_ORIGIN/); assert.match(body, /GOOGLE_AUTH_URL\.test/); assert.match(body, /shell\.openExternal/);
  assert.match(main, /GOOGLE_AUTH_URL = \/\^https:\\\/\\\/accounts\\\.google\\\.com\\\/o\\\/oauth2/);
  assert.equal((main.match(/shell\.openExternal/g) || []).length, 2, 'two places only: Google consent (open-external) and Supabase sign-in (open-auth, own test)');
});

test('android: openExternal takes only Google\'s URL, uses a Custom Tab, and the page is told when the app is back', () => {
  const kt = read('android/app/src/main/java/com/elvar/mark1/MainActivity.kt');
  const m = kt.slice(kt.indexOf('fun openExternal'), kt.indexOf('fun saveFile'));
  assert.match(m, /startsWith\("https:\/\/accounts\.google\.com\/o\/oauth2\/"\)\) return/); assert.match(m, /android\.support\.customtabs\.extra\.SESSION/); assert.match(m, /runOnUiThread/);
  assert.match(kt, /override fun onResume\(\)[^}]*__elvarResume/);
  assert.match(read('android/gradle.properties'), /android\.useAndroidX=false/, 'no AndroidX dependency was added');
});
