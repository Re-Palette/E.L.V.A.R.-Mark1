// 「私のデータ」 (docs/ELVAR_MULTIUSER.md 7.2; principle 7): every kind of data the service holds about the signed-in user, with counts and sizes, where to see and change it,
// how to remove it; plus the user's own audit log. Everything runs as the user (Row Level Security): nothing here can reach anybody else's rows.
import { TYPES } from '../rights/mydata-types.js';
import { invalidateUserConfig, INTERNAL_SECRETS } from '../auth/load-user-config.js';
import { DEFAULT_PROFILE } from '../profile/defaults.js';

const bad = (status, error, message) => ({ status, body: { error, ...(message ? { message } : {}) } });
const NOTE_FOLDERS = [['家計', '家計'], ['シフト', 'シフト'], ['履修', '履修'], ['プロジェクト', 'プロジェクト']];

export async function getMyData({ user }) {
  const data = await user.db(async (r) => {
    const counts = await r.rights.counts(), storage = await r.usage.storage(), notes = await r.notes.list({ limit: 20000 });
    return { counts, storage, notePaths: notes.map((n) => n.path), keys: (await r.secrets.list()).filter((s) => !INTERNAL_SECRETS.has(s.name) && !s.name.startsWith('cx:')).length, google: (await r.oauthTokens.list()).find((t) => t.provider === 'google') || null,
      settingsKeys: Object.keys(await r.settings.get()).length, hasProfile: Boolean(await r.profile.get()) };
  });
  const bytes = { notes: data.storage.notesBytes, messages: data.storage.messagesBytes, files: data.storage.filesBytes + data.storage.textBytes };
  const types = TYPES.map((t) => {
    let count = t.tables.reduce((a, n) => a + (data.counts[n] || 0), 0), detail = null;
    if (t.id === 'profile') count = data.hasProfile ? 1 : 0;
    if (t.id === 'settings') count = data.settingsKeys + (data.counts.usage_limits || 0);
    if (t.id === 'keys') count = data.keys;
    if (t.id === 'google') { count = data.google ? 1 : 0; detail = data.google ? (data.google.status === 'ok' ? '接続中' : '再接続が必要') : '未接続'; }
    if (t.id === 'connectors') count = data.counts.connectors;
    if (t.id === 'notes') count = data.counts.notes;
    if (t.id === 'conversations') count = data.counts.messages;
    if (t.id === 'files') count = data.counts.files;
    if (t.id === 'account') count = 1;
    return { id: t.id, label: t.label, note: t.note, count, bytes: t.bytesFrom ? bytes[t.bytesFrom] : null, tables: t.tables, open: t.open, deletable: Boolean(t.del), del: t.del ? { label: t.del.label, ...(t.del.route ? { route: t.del.route } : { type: t.del.type }) } : null, ...(detail ? { detail } : {}) };
  });
  const sub = NOTE_FOLDERS.map(([label, prefix]) => ({ label, count: data.notePaths.filter((p) => p.startsWith(prefix + '/')).length })), usedBytes = data.storage.filesBytes + data.storage.textBytes + data.storage.notesBytes + data.storage.messagesBytes;
  return { status: 200, body: { types, noteFolders: sub, storage: { usedBytes, quotaBytes: user.account.storageQuotaBytes }, tables: data.counts } };
}

/** Removal of the kinds that have no endpoint of their own. Needs the confirmation word; everything is the caller's own. */
export async function deleteType({ user, params, body }) {
  if (body?.confirm !== 'delete') return bad(400, 'confirm_required', '確認のため confirm: "delete" を付けてください');
  const id = params.type;
  if (!(await user.cfg.hit('mydata-delete', 3600, 30))) return bad(429, 'rate_limited', '操作が多すぎます。しばらくしてからにしてください');
  let n = 0;
  if (id === 'profile') n = await user.db(async (r) => ((await r.profile.del()) ? 1 : 0));
  else if (id === 'settings') n = await user.db(async (r) => { const k = Object.keys(await r.settings.get()).length, lims = await r.usageLimits.list(); await r.settings.put({}); for (const l of lims) await r.usageLimits.del(l); return k + lims.length; });
  else if (id === 'keys') n = await user.db(async (r) => { let c = 0; for (const s of await r.secrets.list()) if (!INTERNAL_SECRETS.has(s.name) && !s.name.startsWith('cx:')) { await r.secrets.del(s.name); c++; } return c; });
  else if (id === 'builds') n = await user.db(async (r) => { let c = 0; for (const b of await r.builds.list({ limit: 200 })) if (await r.builds.del(b.id)) c++; return c; });
  else if (id === 'devices') n = await user.db((r) => r.devices.revokeAll());
  else return bad(404, 'not_found');
  invalidateUserConfig(user.uid);
  await user.db((r) => r.audit.append({ action: `mydata.${id}.deleted`, target: id, meta: { n } })).catch(() => {});
  return { status: 200, body: { ok: true, deleted: n, ...(id === 'profile' ? { note: '人格は初期の状態に戻りました', defaultName: DEFAULT_PROFILE.assistant?.displayName ?? null } : {}) } };
}

export async function listAudit({ user, query }) {
  const limit = Math.max(1, Math.min(500, Number.parseInt(query?.limit, 10) || 100));
  return { status: 200, body: { audit: await user.db((r) => r.audit.list({ limit })) } };
}
