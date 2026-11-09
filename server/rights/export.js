// The export of a user's data (docs/ELVAR_MULTIUSER.md 7.3, principle 7). One entry per registry `exportAs` file; test/export.test.mjs requires every
// registered table that is exported to be covered here, so a new table cannot be added without deciding what leaves with the user.
// Ciphertext, wrapped keys and token hashes never leave (the registry's exportExclude): secrets are listed by NAME and last four characters only.
import { REGISTRY } from './registry.js';
import { exportConnectors } from '../connectors/data.js';

const dayStr = (d) => d.toISOString().slice(0, 10);

/** exportAs file -> async (repos) => json. Keys must be exactly the files named by the registry (except 'none'). */
export const EXPORTERS = {
  'account.json': async (r) => ({ account: await r.accounts.get(), deletion: await r.accounts.deletion() }),
  'profile.json': async (r) => ({ profile: await r.profile.get() }),
  'settings.json': async (r) => ({ settings: await r.settings.get() }),
  'secrets.json': async (r) => ({ secrets: (await r.secrets.list()).map((s) => ({ name: s.name, last4: s.last4, updatedAt: s.updatedAt })), note: 'キーの値は、安全のため書き出しません（名前と末尾4桁だけ）' }),
  'devices.json': async (r) => ({ devices: await r.devices.list() }),
  'audit.json': async (r) => ({ audit: await r.audit.list({ limit: 1000 }) }),
  // P3: what the user connected (Google, MCP logins: provider, granted scopes, state; never a token), their connectors (secrets only as "is set"), their build requests
  'connections.json': async (r) => ({ connections: (await r.oauthTokens.list()).map((t) => ({ provider: t.provider, scopes: t.scopes, status: t.status, reason: t.reason, updatedAt: t.updatedAt })), note: 'ログインの値（トークン）は、安全のため書き出しません（連携の状態とスコープだけ）' }),
  'connectors.json': async (r) => exportConnectors(await r.connectors.list(), Object.fromEntries((await r.secrets.list()).filter((s) => s.name.startsWith('cx:')).map((s) => [s.name, 'set'])), r.uid),
  'builds.json': async (r) => ({ builds: await r.builds.list({ limit: 200 }) }),
  // P4: the notes (current text, trash flag, kept revisions), the conversation log, the notification box, the relay's ciphertext (ids and times only)
  'notes.json': async (r) => {
    const all = [...await r.notes.list({ limit: 20000 }), ...await r.notes.list({ trash: true, limit: 20000 })], notes = [];
    for (const m of all) { const n = await r.notes.getById(m.id); notes.push({ path: n.path, content: n.content, tags: n.tags, rev: n.rev, createdAt: n.createdAt, updatedAt: n.updatedAt, trashed: n.deletedAt !== null, revisions: await Promise.all((await r.notes.revisions(m.id)).map(async (v) => ({ ...v, content: (await r.notes.revision(m.id, v.rev))?.content }))) }); }
    return { notes, note: 'ノートは Markdown のまま（content）。Obsidian などでそのまま開けます' };
  },
  'conversations.json': async (r) => {
    const list = await r.messages.conversations({ limit: 200 }), conversations = [];
    for (const c of list) conversations.push(await r.messages.conversation(c.id, { limit: 5000 }));
    return { conversations, note: '会話の記録です（秘密情報は保存の前に伏せてあります）' };
  },
  'inbox.json': async (r) => ({ inbox: await r.inbox.list({ limit: 100 }) }),
  'notifications.json': async (r) => ({ stored: await r.notif.count(), note: 'スマホの通知の中継は、暗号化されたまま3日だけ保管される一時的な写しです（中身は書き出しません。元の通知はスマホにあります）' }),
  // P5: the file vault. The metadata and the extracted text are in the JSON; the ORIGINALS are listed in `originals` (the plan for the zip of docs 7.3: files/<id>-<name>)
  // and each one can be downloaded now through its own signed link (GET downloadPath)
  'files.json': async (r) => {
    const list = await r.files.list({ limit: 20000 }), files = [];
    for (const f of list) {
      const { objectPath, ...meta } = f;
      files.push({ ...meta, text: await r.files.text(f.id) });
    }
    return { files, originals: originalsPlan(list), note: '取り込んだファイルの原本は、ここに載っている「ダウンロード」の道筋（downloadPath）から、1件ずつ取り出せます。タグ・メモ・読み取った文字もここに入っています' };
  },
  'usage.json': async (r) => {
    const to = new Date(), from = new Date(to.getTime() - 400 * 86400_000);
    return { daily: await r.usage.daily({ from: dayStr(from), to: dayStr(to) }), limits: await r.usageLimits.list(), storage: await r.usage.storage() };
  },
};

const safePart = (n) => String(n).replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').slice(0, 100);
/** Where each original goes in the export zip, and how to get it now. The Storage path itself is never part of the export. */
export const originalsPlan = (files) => files.map((f) => ({ id: f.id, name: f.name, size: f.size, sha256: f.sha256, exportPath: `files/${f.id}-${safePart(f.name)}`, downloadPath: `/api/elvar/files/${f.id}/download` }));

export const exportedFiles = () => [...new Set(REGISTRY.map((e) => e.exportAs).filter((f) => f !== 'none'))].sort();

/** @param {object} r repos of the user (inside asUser) @returns {Promise<{format:string, exportedAt:string, files:object}>} */
export async function buildExport(r, { user } = {}) {
  const files = {};
  for (const f of exportedFiles()) {
    if (!EXPORTERS[f]) throw Object.assign(new Error('export_incomplete'), { code: 'export_incomplete', status: 500 });
    files[f] = await EXPORTERS[f](r);
  }
  return { format: 'elvar-export-v1', exportedAt: new Date().toISOString(), user: user ? { id: user.id, email: user.email ?? null } : undefined, files };
}
