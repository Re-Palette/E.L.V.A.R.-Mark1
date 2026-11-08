// Handlers of the /api/elvar/* endpoints (owner setup, devices, config, profile, session). Each returns { status, body }.
// Secrets are write-only: no handler ever returns a secret value, only { set, source, last4 }.
import { getStore } from './store/index.js';
import * as auth from './config/auth.js';
import { KEYS, keyInfo, isSecret } from './config/keys.js';
import { PROFILE_KEYS } from './config/resolve.js';
import * as V from './config/vault.js';
import { validateProfile } from '../shared/profile.js';
import { testKey } from './api-status.js';
import { SERVICE_IDS, googleState, googleConfig } from './google/config.js';

const bad = (status, error, message, extra = {}) => ({ status, body: { error, ...(message ? { message } : {}), ...extra } });
const audit = (event, extra) => console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event, ...extra }));
// The Google client id / secret are typed in Settings (the Google tab); the refresh token is never typed: the in-app login puts it in the vault.
// Profile-backed names are edited in the profile.
const SECRET_EDITABLE = (name) => isSecret(name) && name !== 'GOOGLE_REFRESH_TOKEN';
const SETTING_EDITABLE = (name) => keyInfo(name)?.kind === 'setting' && !PROFILE_KEYS.includes(name);
const writable = (a) => a.mode === 'vault';
const readOnly = (a) => bad(409, 'read_only', a.mode === 'env' ? '環境変数モードです。設定は環境変数で変更してください' : 'まだセットアップされていません');

/** The settings screen's view of the configuration: secrets as { set, source, last4 }, settings with their values. */
export function configView(cfg, a) {
  const st = cfg.secretStatus(), secrets = {}, settings = {};
  for (const k of KEYS) {
    if (k.kind === 'secret' && SECRET_EDITABLE(k.name)) secrets[k.name] = { ...st[k.name], label: k.label, group: k.group, testable: Boolean(k.test) };
    else if (k.kind === 'setting' && SETTING_EDITABLE(k.name)) settings[k.name] = { value: String(cfg.get(k.name) ?? k.default ?? ''), source: cfg.source(k.name), default: k.default ?? '', label: k.label, group: k.group };
  }
  return { mode: a.mode, writable: writable(a), secrets, settings, missing: ['GEMINI_API_KEY'].filter((n) => !st[n]?.set) };
}

// Settings that end up inside a URL (repository names, model ids) get a strict format; anything that would be a host / URL is env-only (keys.js infra).
const SHAPES = [
  [/^GOOGLE_CLIENT_ID$/, /^[0-9A-Za-z._-]{6,120}\.apps\.googleusercontent\.com$/, 'クライアントIDの形式が正しくありません（…apps.googleusercontent.com で終わる文字列です）'],
  [/^GOOGLE_SERVICES$/, new RegExp(`^(${SERVICE_IDS.join('|')})(,(${SERVICE_IDS.join('|')}))*$`), '選べないサービスが入っています'],
  [/^GOOGLE_READONLY$/, /^1$/, '1 か空にしてください'],
  [/_REPO$/, /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, 'owner/name の形で入力してください'],
  [/MODEL/, /^[A-Za-z0-9][A-Za-z0-9_.:-]*(\/[A-Za-z0-9][A-Za-z0-9_.:-]*)?$/, 'モデル名の形式が正しくありません'],
  [/_(URL|ORIGIN|HOST|ENDPOINT)$/, /^$/, 'このアドレスはアプリからは変更できません'],
];
function shapeError(name, v) {
  for (const [re, ok, msg] of SHAPES) if (re.test(name) && (!ok.test(v) || v.includes('..'))) return msg;
  return '';
}
const okValue = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

export async function getConfigRoute({ cfg, auth: a }) { return { status: 200, body: configView(cfg, a) }; }

export async function patchConfig({ body, auth: a, cfg }) {
  if (!writable(a)) return readOnly(a);
  const sec = body?.secrets && typeof body.secrets === 'object' && !Array.isArray(body.secrets) ? body.secrets : {};
  const set = body?.settings && typeof body.settings === 'object' && !Array.isArray(body.settings) ? body.settings : {};
  const secretUpdates = {}, settingUpdates = {};
  for (const [name, v] of Object.entries(sec)) {
    if (!SECRET_EDITABLE(name)) return bad(400, 'unknown_key', `${name} は設定できません`);
    if (v === null) { secretUpdates[name] = null; continue; }
    const t = typeof v === 'string' ? v.trim().replace(/^["']|["']$/g, '') : '';
    if (!t || !okValue(t, 512) || /\s/.test(t)) return bad(400, 'bad_value', 'キーの形式が正しくありません（空白や改行は入れられません）', { key: name });
    secretUpdates[name] = t;
  }
  for (const [name, v] of Object.entries(set)) {
    if (!SETTING_EDITABLE(name)) return bad(400, 'unknown_key', `${name} は設定できません`);
    if (v === null || v === '') { settingUpdates[name] = null; continue; }
    if (!okValue(v, 200)) return bad(400, 'bad_value', '値が正しくありません', { key: name });
    const se = shapeError(name, v.trim()); if (se) return bad(400, 'bad_value', se, { key: name });
    settingUpdates[name] = v.trim();
  }
  const store = getStore();
  const { doc, ver } = await V.updateDoc(store, a.dek, (d) => {
    d.secrets = d.secrets || {}; d.settings = d.settings || {};
    for (const [k, v] of Object.entries(secretUpdates)) { if (v === null) delete d.secrets[k]; else d.secrets[k] = v; }
    for (const [k, v] of Object.entries(settingUpdates)) { if (v === null) delete d.settings[k]; else d.settings[k] = v; }
    return d;
  });
  audit('config-updated', { secrets: Object.keys(secretUpdates), settings: Object.keys(settingUpdates), by: a.deviceId });
  // answer from the new doc (the request's cfg still holds the old one)
  const { vaultConfig } = await import('./config/resolve.js');
  return { status: 200, body: configView(vaultConfig(doc, a, ver), a) };
}

export async function postConfigTest({ body, auth: a }) {
  const name = String(body?.name || '');
  if (!SECRET_EDITABLE(name) || !keyInfo(name)?.test) return bad(400, 'unknown_key', 'このキーは確認できません');
  void a;
  const r = await testKey(name);
  return { status: 200, body: r };
}

export async function getProfile({ cfg, auth: a }) { return { status: 200, body: { profile: cfg.profile, writable: writable(a) } }; }

export async function putProfile({ body, cfg, auth: a }) {
  if (!writable(a)) return readOnly(a);
  const v = validateProfile(body?.profile ?? body, cfg.profile);
  if (!v.ok) return bad(422, 'invalid_profile', '入力を確認してください', { errors: v.errors });
  await V.updateDoc(getStore(), a.dek, (d) => { d.profile = v.profile; return d; });
  audit('profile-updated', { by: a.deviceId });
  return { status: 200, body: { profile: v.profile } };
}

/** Called once at start-up by the client: the public view the UI needs (profile, features, the notification key). */
export async function getSession({ cfg, auth: a }) {
  const p = cfg.profile;
  return { status: 200, body: {
    mode: a.mode, profile: p, features: cfg.features,
    brand: { name: p.assistant.displayName, spokenName: p.assistant.spokenName, ownerAddress: p.owner.address },
    notifSecret: cfg.notifSecret || null,
    google: { state: googleState(googleConfig()) },     // 'reauth_required' = the reconnect prompt (notification + badge in Settings)
    missing: ['GEMINI_API_KEY'].filter((n) => !cfg.get(n)),
  } };
}

export { auth };
