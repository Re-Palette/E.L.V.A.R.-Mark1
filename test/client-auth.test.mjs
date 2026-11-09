// Client side of Phase 2: the auth module (no window.prompt), the wizard's pure parts, the profile cache that brand.js reads live,
// greeting / fillers from the profile, the profile form (escaping), and the notification bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// minimal browser globals
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.window = globalThis;

const auth = await import('../web/src/elvar/auth.js');
const brandMod = await import('../web/src/brand.js');
const { startStep } = await import('../web/src/setup/wizard.js');
const { keyStatusText } = await import('../web/src/setup/wizard-text.js');
const { greetingLine } = await import('../web/src/live/clap-standby.js');
const { greetingPrompt, greetingVars } = await import('../web/src/live/greeting-gen.js');
const { phrasesFor, nextFiller } = await import('../web/src/live/fillers.js');
const { renderFields, readFields, mergeInto, errorText } = await import('../web/src/settings/profile-form.js');
const { mergeProfile } = await import('../shared/profile.js');

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('no window.prompt anywhere in the web app; the token header comes from one module', () => {
  const walk = (d) => fs.readdirSync(new URL('../' + d, import.meta.url), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith('.js') ? [`${d}/${e.name}`] : []));
  for (const f of walk('web/src')) assert.ok(!/window\.prompt\s*\(/.test(read(f)), f);
  assert.match(read('web/src/live/gemini-live.js'), /authHeaders\(\) \{ return authHeaders\(\); \}/);
  assert.match(read('web/src/live/gemini-live.js'), /requireLogin\(\)/);
});

test('wizard: where to start / resume, and key status text never shows a key', () => {
  assert.equal(startStep({}, null), 'gemini', 'a new user starts with their own Gemini key');
  assert.equal(startStep({}, 'persona'), 'persona', 'resume');
  assert.equal(startStep({}, 'bogus'), 'gemini'); assert.equal(startStep({}, 'done'), 'gemini'); assert.equal(startStep({}, 'owner'), 'gemini', 'the old owner steps are gone');
  assert.equal(keyStatusText({ set: false }), '未設定');
  assert.equal(keyStatusText({ set: true, last4: 'WXYZ', source: 'app' }), '設定済み・末尾WXYZ');
  assert.equal(keyStatusText({ set: true, last4: null, source: 'env' }), '設定済み（環境変数）');
});

test('greeting line and recording prompt follow the profile (template, honorific, time zone)', () => {
  const p = mergeProfile({ greeting: { template: 'Good {partOfDay}, {honorific}.', honorific: 'boss' }, locale: { timeZone: 'Asia/Tokyo' } });
  assert.equal(greetingLine(new Date('2026-11-02T00:30:00Z'), p), 'Good Morning, boss.', '09:30 in Tokyo');
  assert.equal(greetingLine(new Date('2026-11-02T00:30:00Z'), mergeProfile({ locale: { timeZone: 'America/New_York' } })), 'All systems online. Good Evening, sir.', '19:30 in New York');
  assert.equal(greetingLine(new Date('2026-11-02T00:30:00Z'), mergeProfile({ greeting: { honorific: '' } })), 'All systems online. Good Morning.', 'empty honorific: no dangling comma');
  assert.match(greetingPrompt('Hi.', { honorific: 'boss', ownerAddress: 'テスト様', language: 'en' }), /「boss」は、そのまま読み、「テスト様」/);
  assert.ok(!greetingPrompt('Hi.', { honorific: '', ownerAddress: 'x', language: 'en' }).includes('言い換えない'));
  assert.equal(greetingVars(mergeProfile({})).honorific, 'sir');
});

test('fillers follow language and speaking style; the default is the original Japanese butler set', () => {
  assert.deepEqual(phrasesFor(null).ack, ['かしこまりました。', '承知いたしました。']);
  assert.match(phrasesFor(mergeProfile({ locale: { language: 'en' } })).ack[0], /^[A-Z]/);
  assert.notDeepEqual(phrasesFor(mergeProfile({ assistant: { personaPreset: 'friendly' } })).ack, phrasesFor(null).ack);
  const en = phrasesFor(mergeProfile({ locale: { language: 'en' } }));
  assert.ok(en.ack.includes(nextFiller({ turn: { n: 0 }, now: 0, silentMs: 1500, userText: 'hi', rnd: () => 0, phrases: en })));
});

test('profile form: every value is escaped into the HTML, and read back as a partial profile', () => {
  const p = mergeProfile({ owner: { name: '"><img src=x onerror=alert(1)>', avoidAddresses: ['<a>', 'b'] }, assistant: { customPersona: '</textarea><script>x</script>' } });
  const html = renderFields(['owner.name', 'owner.avoidAddresses', 'assistant.customPersona', 'features.shift', 'locale.timeZone'], p);
  assert.ok(!html.includes('<img') && !html.includes('<script>') && !html.includes('</textarea><script'), 'escaped');
  assert.match(html, /&quot;&gt;&lt;img/);
  // read back from a fake DOM
  const els = [{ dataset: { pf: 'owner.name' }, value: ' X ' }, { dataset: { pf: 'owner.avoidAddresses' }, value: 'a、b,c' }, { dataset: { pf: 'features.shift' }, checked: true }];
  const out = readFields({ querySelectorAll: () => els });
  assert.deepEqual(out, { owner: { name: ' X ', avoidAddresses: ['a', 'b', 'c'] }, features: { shift: true } });
  const merged = mergeInto(mergeProfile({}), out); assert.equal(merged.owner.address, 'ご主人様'); assert.equal(merged.features.finance, true);
  assert.match(errorText([{ path: 'owner.name', message: '入力してください' }]), /お名前：入力してください/);
});

test('settings are split into web/src/settings/* and use the gold palette; the old blue look is gone from them', () => {
  for (const f of ['index.js', 'device.js', 'keys.js', 'account.js', 'profile.js', 'profile-form.js']) assert.ok(fs.existsSync(new URL('../web/src/settings/' + f, import.meta.url)), f);
  const all = ['web/src/settings/index.js', 'web/src/settings/device.js', 'web/src/elvar/ui.js', 'web/src/setup/wizard.js'].map(read).join('\n');
  assert.ok(!/#19d3ff|#8fe3ff|#3ac9ef|25,\s*211,\s*255/i.test(all), 'no cyan left');
  assert.match(read('web/src/elvar/ui.js'), /#E8B96A/); assert.match(read('web/src/elvar/ui.js'), /#FFD99A/); assert.match(read('web/src/elvar/ui.js'), /#8A5A20/); assert.match(read('web/src/elvar/ui.js'), /Cinzel/);
  assert.ok(!/\$\{ownerAddress\(\)\}/.test(read('web/src/settings/device.js')), 'escaped address in the device pane');
  const keys = read('web/src/settings/keys.js'); assert.ok(!/value="\$\{/.test(keys), 'key inputs are never pre-filled');
});

test('Android bridge passes the vault notification secret; the phone derives the key from it (token in env mode)', () => {
  const main = read('android/app/src/main/java/com/elvar/mark1/MainActivity.kt'), sync = read('android/app/src/main/java/com/elvar/mark1/NotifSync.kt'), st = read('android/app/src/main/java/com/elvar/mark1/NotifStore.kt');
  assert.match(main, /setSyncConfig\(baseUrl: String, token: String, enabled: Boolean, notifSecret: String\)/);
  assert.match(st, /syncSecret/); assert.match(sync, /syncSecret\(ctx\)\.ifBlank \{ token \}/);
  assert.match(read('web/src/notifications.js'), /setSyncConfig\?\.\(location\.origin, token\(\), syncOn\(\), key\(\)\)/);
});

test('public pages have no inline scripts (they run under the site CSP)', () => {
  for (const d of ['extension', 'google-setup', 'settings', 'privacy', 'terms']) {
    const h = read(`web/public/${d}/index.html`);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(h), d); assert.ok(!/\son[a-z]+="/.test(h), d + ': no inline handlers');
  }
  assert.ok(!/<script>/.test(read('web/index.html')));
});

test('auth: the Authorization header comes from the Supabase session, the notification key from the session answer, 401 -> not usable; no owner token anywhere', async () => {
  mem.clear(); brandMod.setProfileCache(null);
  assert.deepEqual(auth.authHeaders(), {}, 'signed out: no header');
  assert.equal(auth.notifSecret(), '');
  const prof = mergeProfile({ owner: { address: '<b>テスト様</b>' }, assistant: { displayName: 'ARIA' } });
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ mode: 'user', profile: prof, notifSecret: 'NS-secret', features: prof.features, missing: [] }) });
  try {
    const s = await auth.loadSession();
    assert.equal(s.mode, 'user'); assert.equal(brandMod.brand().name, 'ARIA'); assert.equal(auth.notifSecret(), 'NS-secret');
    globalThis.fetch = async () => ({ status: 403, json: async () => ({ error: 'account_suspended' }) });
    assert.equal(await auth.loadSession(), null); assert.equal(auth.lastSessionError(), 'account_suspended');
  } finally { globalThis.fetch = real; brandMod.setProfileCache(null); mem.clear(); }
  for (const f of ['web/src/elvar/auth.js', 'desktop/main.js', 'desktop/preload.js']) assert.ok(!/x-elvar-token|elv1\./.test(read(f)), f);
});

test('desktop: sign-in with Google goes to the system browser only for Supabase authorize URLs, from our own window, and returns through elvar://', () => {
  const main = read('desktop/main.js'), pre = read('desktop/preload.js');
  assert.match(pre, /openAuth:\s*\(url\)\s*=>\s*ipcRenderer\.send\('elvar:open-auth'/);
  assert.match(main, /AUTH_URL = [^\n]*\/auth\/v1\/authorize[^\n]*provider/);
  assert.match(main, /ipcMain\.on\('elvar:open-auth'[^\n]*e\.sender === win\.webContents[^\n]*OUR_ORIGIN[^\n]*AUTH_URL\(url\)/);
  assert.match(main, /setAsDefaultProtocolClient\('elvar'/); assert.match(main, /\^\[A-Za-z0-9_-\]\{8,200\}\$/);
  assert.ok(!/accessToken/.test(pre), 'no env token reaches the page');
});

test('android: openAuth takes only https Supabase authorize URLs for Google; the callback intent hands the page a plain code', () => {
  const kt = read('android/app/src/main/java/com/elvar/mark1/MainActivity.kt'), man = read('android/app/src/main/AndroidManifest.xml');
  const m = kt.slice(kt.indexOf('fun openAuth'), kt.indexOf('fun saveFile'));
  assert.match(m, /u\.scheme != "https"/); assert.match(m, /\/auth\/v1\/authorize/); assert.match(m, /provider/);
  assert.match(kt, /d\.scheme != "com\.elvar\.mark1" \|\| d\.host != "auth-callback"/); assert.match(kt, /__elvarAuthCode/); assert.match(kt, /\[A-Za-z0-9_-\]\{8,200\}/);
  assert.match(man, /android:scheme="com\.elvar\.mark1" android:host="auth-callback"/);
});
