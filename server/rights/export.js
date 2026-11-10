// The export of a user's data (docs/ELVAR_MULTIUSER.md 7.3, principle 7). One entry per registry `exportAs` file; test/export.test.mjs requires every
// registered table that is exported to be covered here, so a new table cannot be added without deciding what leaves with the user.
// Ciphertext, wrapped keys and token hashes never leave (the registry's exportExclude): secrets are listed by NAME and last four characters only.
import { REGISTRY } from './registry.js';
import { PAGED_ORDER } from './export-pages.js';
import { exportConnectors } from '../connectors/data.js';

const dayStr = (d) => d.toISOString().slice(0, 10);

/** exportAs file -> async (repos) => json. Keys must be exactly the files named by the registry (except 'none'). */
export const EXPORTERS = {
  'account.json': async (r) => ({ account: await r.accounts.get(), deletion: await r.accounts.deletion() }),
  'profile.json': async (r) => ({ profile: await r.profile.get() }),
  'settings.json': async (r) => ({ settings: await r.settings.get() }),
  'secrets.json': async (r) => ({ secrets: (await r.secrets.list()).map((s) => ({ name: s.name, last4: s.last4, updatedAt: s.updatedAt })), note: 'キーの値は、安全のため書き出しません（名前と末尾4桁だけ）' }),
  'devices.json': async (r) => ({ devices: await r.devices.list() }),
  // P3: what the user connected (Google, MCP logins: provider, granted scopes, state; never a token), their connectors (secrets only as "is set")
  'connections.json': async (r) => ({ connections: (await r.oauthTokens.list()).map((t) => ({ provider: t.provider, scopes: t.scopes, status: t.status, reason: t.reason, updatedAt: t.updatedAt })), note: 'ログインの値（トークン）は、安全のため書き出しません（連携の状態とスコープだけ）' }),
  'connectors.json': async (r) => exportConnectors(await r.connectors.list(), Object.fromEntries((await r.secrets.list()).filter((s) => s.name.startsWith('cx:')).map((s) => [s.name, 'set'])), r.uid),
  'notifications.json': async (r) => ({ stored: await r.notif.count(), note: 'スマホの通知の中継は、暗号化されたまま3日だけ保管される一時的な写しです（中身は書き出しません。元の通知はスマホにあります）' }),
  // The files below carry ROWS of tables that can be any size: the rows themselves go into rows/<table>-part<n>.jsonl, walked page by page (export-pages.js), so nothing is cut at a
  // fixed number. What is here is the part that is not rows (a note on how to read them).
  'builds.json': async () => ({ note: '製作依頼の記録は rows/build_requests-part*.jsonl にあります' }),
  'notes.json': async () => ({ note: 'ノートは notes/ の Markdown（Obsidian などでそのまま開けます）。メタ情報と過去の版は rows/notes-part*.jsonl と rows/note_revisions-part*.jsonl にあります' }),
  'conversations.json': async () => ({ note: '会話の記録です（秘密情報は保存の前に伏せてあります）。1日ごとの読みやすい形は conversations/、すべての行は rows/conversations-part*.jsonl と rows/messages-part*.jsonl にあります' }),
  'inbox.json': async () => ({ note: '通知ボックスの中身は rows/inbox_items-part*.jsonl にあります' }),
  'audit.json': async () => ({ note: 'あなたのアカウントの操作記録（すべて）は rows/audit_log-part*.jsonl にあります' }),
  'files.json': async () => ({ note: '取り込んだファイルのメタ情報・タグ・メモは rows/files-part*.jsonl、読み取った文字は rows/file_texts-part*.jsonl、原本は files/ にあります（files/index-part*.json が対応表です）' }),
  'usage.json': async (r) => ({ limits: await r.usageLimits.list(), storage: await r.usage.storage(), note: '利用量の1日ごとの合計は rows/usage_daily-part*.jsonl、1回ごとの記録（直近90日）は rows/usage_events-part*.jsonl にあります' }),
};

const safePart = (n) => String(n).replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').slice(0, 100);
export const exportedFiles = () => [...new Set(REGISTRY.map((e) => e.exportAs).filter((f) => f !== 'none'))].sort();
/** The rows of a paged table, named as they are in the zip. */
export const rowsFileOf = (table, part) => `rows/${table}-part${part}.jsonl`;
/** Where one original goes in the zip: files/<id>-<name> (the name is made safe again by the zip writer). */
export const originalPath = (f) => `files/${f.id}-${safePart(f.name)}`;
/** The Storage path of a file's original (always built from the owner, the id and the hash: the database builds the same one when it reserves the upload). */
export const objectPathOf = (uid, f) => `users/${uid}/files/${f.id}/${f.sha256}`;

/**
 * The whole export in one piece, for tests and small accounts: every whole file, and every paged table walked to its end. (The export JOB does the same in steps.)
 * @param {object} r repos of the user (inside asUser) @returns {Promise<{format:string, exportedAt:string, files:object, rows:Record<string, object[]>}>}
 */
export async function buildExport(r, { user } = {}) {
  const files = {}, rows = {};
  for (const f of exportedFiles()) {
    if (!EXPORTERS[f]) throw Object.assign(new Error('export_incomplete'), { code: 'export_incomplete', status: 500 });
    files[f] = await EXPORTERS[f](r);
  }
  for (const t of PAGED_ORDER) { rows[t] = []; for (let after = null; ;) { const p = await r.rights.exportPage(t, { after }); rows[t].push(...p.rows); if (!p.next) break; after = p.next; } }
  return { format: 'elvar-export-v2', exportedAt: new Date().toISOString(), user: user ? { id: user.id, email: user.email ?? null } : undefined, files, rows };
}
