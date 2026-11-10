// Handlers of the signed-in user's own endpoints under /api/elvar/*: session, configuration (their own keys and settings), profile, devices, usage and
// the account itself (export, delete). Each returns { status, body } and gets the router's context { user, body, query, params, cfg }.
// Secrets are write-only: no handler ever returns a secret value, only { set, source, last4 }.
// Everything here reads and writes ONLY the caller's rows: through user.db(fn), i.e. asUser(uid) with Row Level Security.
import { KEYS, keyInfo, isSecret } from '../config/keys.js';
import { PROFILE_KEYS, cfgEnv } from '../config/resolve.js';
import { validateProfile } from '../../shared/profile.js';
import { testKey } from '../api-status.js';
import { SERVICE_IDS, googleConfig, googleState } from '../google/config.js';
import { VERSION } from '../version.js';
import { getDb } from '../db/index.js';
import { getKeyring } from '../auth/keyring.js';
import { invalidateUserConfig, NOTIF_SECRET, randomNotifSecret } from '../auth/load-user-config.js';
import { invalidateAccount, requireFresh, signOutEverywhere } from '../auth/with-user.js';
import { newDeviceToken } from '../auth/device-token.js';
import { DEVICE_SCOPES } from '../db/validate.js';
import { purgeAccount } from '../rights/purge.js';
import { buildExport } from '../rights/export.js';

const bad = (status, error, message, extra = {}) => ({ status, body: { error, ...(message ? { message } : {}), ...extra } });
const audit = (event, extra) => console.log('[audit] ' + JSON.stringify({ at: new Date().toISOString(), event, ...extra }));

// What the user can edit here. The Google client id / secret are the user's OWN OAuth client (decision O2); the refresh token is never typed: it comes from the
// consent flow (server/google/connect.js) and lives in app.oauth_tokens.
const NOT_TYPED = new Set(['NOTIF_SECRET', 'GOOGLE_REFRESH_TOKEN']);
const SECRET_EDITABLE = (name) => isSecret(name) && !NOT_TYPED.has(name);
const SETTING_EDITABLE = (name) => { const k = keyInfo(name); return k?.kind === 'setting' && !PROFILE_KEYS.includes(name); };

/** The settings screen's view of the configuration: secrets as { set, source, last4 }, settings with their values. */
export function configView(cfg) {
  const st = cfg.secretStatus(), secrets = {}, settings = {};
  for (const k of KEYS) {
    if (k.kind === 'secret' && SECRET_EDITABLE(k.name)) secrets[k.name] = { ...st[k.name], label: k.label, group: k.group, testable: Boolean(k.test) };
    else if (k.kind === 'setting' && SETTING_EDITABLE(k.name)) settings[k.name] = { value: String(cfg.get(k.name) ?? k.default ?? ''), source: cfg.source(k.name), default: k.default ?? '', label: k.label, group: k.group };
  }
  return { mode: 'user', writable: true, secrets, settings, missing: ['GEMINI_API_KEY'].filter((n) => !st[n]?.set) };
}

// Settings that end up inside a URL (repository names, model ids) get a strict format; anything that would be a host / URL is env-only (keys.js infra).
const SHAPES = [
  [/^GOOGLE_SERVICES$/, new RegExp(`^(${SERVICE_IDS.join('|')})(,(${SERVICE_IDS.join('|')}))*$`), '選べないサービスが入っています'],
  [/^GOOGLE_READONLY$/, /^1$/, '1 か空にしてください'],
  [/^GOOGLE_CLIENT_ID$/, /^[A-Za-z0-9][A-Za-z0-9._-]{4,199}$/, 'クライアントIDの形式が正しくありません'],
  [/^MESSAGE_RETENTION_DAYS$/, /^(0|[7-9]|[1-9][0-9]{1,4})$/, '7〜99999 日、または 0（ずっと残す）で入力してください'],
  [/^BRAIN_MIRROR$/, /^1$/, '1 か空にしてください'],
  [/_REPO$/, /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, 'owner/name の形で入力してください'],
  [/MODEL/, /^[A-Za-z0-9][A-Za-z0-9_.:-]*(\/[A-Za-z0-9][A-Za-z0-9_.:-]*)?$/, 'モデル名の形式が正しくありません'],
  [/_(URL|ORIGIN|HOST|ENDPOINT)$/, /^$/, 'このアドレスはアプリからは変更できません'],
];
function shapeError(name, v) {
  for (const [re, ok, msg] of SHAPES) if (re.test(name) && (!ok.test(v) || v.includes('..'))) return msg;
  return '';
}
const okValue = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

export async function getConfigRoute({ cfg }) { return { status: 200, body: configView(cfg) }; }

export async function patchConfig({ user, body, cfg }) {
  const sec = body?.secrets && typeof body.secrets === 'object' && !Array.isArray(body.secrets) ? body.secrets : {};
  const set = body?.settings && typeof body.settings === 'object' && !Array.isArray(body.settings) ? body.settings : {};
  if (Object.keys(sec).length + Object.keys(set).length > 40) return bad(400, 'too_many', '一度に変えられる項目が多すぎます');
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
  const ring = getKeyring();
  await user.db(async (r) => {
    for (const [k, v] of Object.entries(secretUpdates)) { if (v === null) await ring.deleteSecret(r, k); else await ring.setSecret(r, k, v); }
    if (Object.keys(settingUpdates).length) {
      const next = { ...(await r.settings.get()) };
      for (const [k, v] of Object.entries(settingUpdates)) { if (v === null) delete next[k]; else next[k] = v; }
      await r.settings.put(next);
    }
  });
  invalidateUserConfig(user.uid);
  audit('config-updated', { uid: user.uid.uid, secrets: Object.keys(secretUpdates), settings: Object.keys(settingUpdates) });
  const fresh = await user.loadConfig({ fresh: true });
  void cfg;
  return { status: 200, body: configView(fresh) };
}

/** Check one saved key against its service. The key is read on the server (the caller's own key) and never returned. */
export async function postConfigTest({ user, body }) {
  const name = String(body?.name || '');
  if (!SECRET_EDITABLE(name) || !keyInfo(name)?.test) return bad(400, 'unknown_key', 'このキーは確認できません');
  if (!(await user.cfg.hit('config-test', 60, 12))) return bad(429, 'rate_limited', '確認の回数が多すぎます。少し待ってください');
  return { status: 200, body: await testKey(name) };
}

export async function getProfile({ cfg }) { return { status: 200, body: { profile: cfg.profile, writable: true } }; }

export async function putProfile({ user, body, cfg }) {
  const v = validateProfile(body?.profile ?? body, cfg.profile);
  if (!v.ok) return bad(422, 'invalid_profile', '入力を確認してください', { errors: v.errors });
  await user.db((r) => r.profile.put(v.profile));
  invalidateUserConfig(user.uid);
  audit('profile-updated', { uid: user.uid.uid });
  return { status: 200, body: { profile: v.profile } };
}

/** Called once at start-up by the client: the view the UI needs (who, profile, features, the notification key). */
export async function getSession({ user, cfg }) {
  const ring = getKeyring();
  let notifSecret = cfg.notifSecret;
  if (!notifSecret) {   // the key material for the phone-notification encryption: made once, only ever returned to the user's own devices
    notifSecret = await user.db(async (r) => { const cur = await ring.getSecret(r, NOTIF_SECRET); if (cur) return cur; const n = randomNotifSecret(); await ring.setSecret(r, NOTIF_SECRET, n); return n; });
    invalidateUserConfig(user.uid);
  }
  const p = cfg.profile, st = cfg.secretStatus();
  return { status: 200, body: {
    mode: 'user', user: { id: user.uid.uid, email: user.email }, role: user.role, account: { status: user.account.status, storageQuotaBytes: user.account.storageQuotaBytes },
    profile: p, features: cfg.features,
    brand: { name: p.assistant.displayName, spokenName: p.assistant.spokenName, ownerAddress: p.owner.address },
    notifSecret,
    google: { state: googleState(googleConfig(cfgEnv, cfg.google)) },
    missing: ['GEMINI_API_KEY'].filter((n) => !st[n]?.set),
    comingSoon: ['files-sync'],
    version: VERSION,
  } };
}

// ---- devices (the Android notification sync's tokens)
export async function listDevices({ user }) { return { status: 200, body: { devices: await user.db((r) => r.devices.list()) } }; }
export async function createDevice({ user, body }) {
  const name = typeof body?.name === 'string' ? body.name.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40) : '';
  const scopes = Array.isArray(body?.scopes) ? [...new Set(body.scopes)] : [...DEVICE_SCOPES];
  if (!name) return bad(400, 'bad_name', '端末の名前を入力してください');
  if (!scopes.length || !scopes.every((s) => DEVICE_SCOPES.includes(s))) return bad(400, 'bad_scopes', '許可の種類が正しくありません');
  if (!(await user.cfg.hit('device-create', 3600, 20))) return bad(429, 'rate_limited', '端末の登録が多すぎます。しばらくしてからにしてください');
  const t = newDeviceToken();
  await user.db(async (r) => { if ((await r.devices.list()).length >= 10) throw Object.assign(new Error('too_many_devices'), { status: 409, code: 'too_many_devices' }); await r.devices.create({ id: t.deviceId, name, tokenHash: t.hash, scopes }); });
  return { status: 200, body: { id: t.deviceId, name, scopes, token: t.token, note: 'このトークンは今回しか表示されません' } };   // shown once; only its hash is stored
}
export async function removeDevice({ user, params }) {
  if (!/^[0-9a-f]{16}$/.test(params.id)) return bad(404, 'not_found');
  return (await user.db((r) => r.devices.revoke(params.id))) ? { status: 200, body: { ok: true } } : bad(404, 'not_found');
}

// ---- the account: export and delete (principle 7)
export async function getDeletion({ user }) { return { status: 200, body: { status: user.account.status, deletion: await user.db((r) => r.accounts.deletion()) } }; }

export async function exportData({ user }) {
  await requireFresh(user);
  if (!(await user.system.rlHit({ bucket: 'export', who: user.uid.uid, windowSec: 86400, userId: user.uid }) <= 3)) return bad(429, 'rate_limited', '書き出しは1日3回までです');
  const data = await user.db((r) => buildExport(r, { user: { id: user.uid.uid, email: user.email } }));
  audit('account-exported', { uid: user.uid.uid });
  return { status: 200, headers: { 'content-disposition': 'attachment; filename="elvar-export.json"' }, body: data };
}

/**
 * O3: the user chooses, at deletion time, immediate deletion or a 7-day grace period during which signing in offers to cancel.
 * Needs a recent sign-in (requireFresh): the client asks for the password or a new Google sign-in first.
 */
export async function deleteAccount({ user, body }) {
  const graceDays = body?.graceDays;
  if (graceDays !== 0 && graceDays !== 7) return bad(422, 'bad_grace', '削除の方法を選んでください（すぐに削除 / 7日後に削除）');
  await requireFresh(user);
  if (!(await user.cfg.hit('account-delete', 3600, 5))) return bad(429, 'rate_limited', '操作が多すぎます。しばらくしてからにしてください');
  const due = await user.db((r) => r.accounts.requestDeletion(graceDays, user.email));
  invalidateAccount(user.uid); invalidateUserConfig(user.uid);
  await user.db((r) => r.devices.revokeAll());
  await signOutEverywhere(user);
  audit('account-delete-requested', { uid: user.uid.uid, graceDays });
  if (graceDays === 0) {
    const res = await purgeAccount(await getDb(), user.uid.uid);
    audit('account-deleted', { tablesChecked: res.tablesChecked });
    return { status: 200, body: { deleted: true } };
  }
  return { status: 200, body: { pending: true, graceDays, purgeAfter: due } };
}

export async function cancelDeletion({ user }) {
  await requireFresh(user);   // a stolen, older session must not be able to undo the owner's deletion request
  const ok = await user.db((r) => r.accounts.cancelDeletion());
  invalidateAccount(user.uid); invalidateUserConfig(user.uid);
  if (!ok) return bad(409, 'not_cancellable', 'この削除は取り消せません');
  audit('account-delete-cancelled', { uid: user.uid.uid });
  return { status: 200, body: { cancelled: true } };
}

