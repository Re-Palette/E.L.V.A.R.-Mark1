// One-time import of an old SINGLE-OWNER install into ONE account of the multi-user platform (docs/ELVAR_MULTIUSER.md 8.5, P4.4). Run by the operator, locally.
//
//   node --env-file=.env scripts/migrate-owner.mjs --user <uuid of the new account> [options]
//
//   --user <uuid>            the platform account that receives the data (required; the person signs up first)
//   --vault <store.json>     the old local data file (${ELVAR_DATA_DIR:-~/.elvar}/store.json) holding the encrypted vault; with --password <owner password>
//                            this brings the profile, settings, API keys and connectors (connector secrets included) into the account, sealed under the account's own key.
//                            Google / MCP login tokens are NOT carried over (they were sealed for the old install): connect Google and re-authorise MCP once.
//   --repo owner/name        the old GitHub second brain; with --token <PAT>  [--branch main] [--dir sub/folder]: every .md becomes a note.
//                            会話/<date>.md logs become conversation messages instead (--keep-log-notes keeps them as notes too).
//   --keep-forever           set the conversation retention to "for ever" (default is 180 days: older imported messages would be swept by the daily cron)
//   --overwrite              replace what the account already has (profile, settings, keys); default: only fill what is empty
//   --dry-run                read everything, count what would change, write NOTHING
//
// Idempotent: run it again and nothing is duplicated (notes are matched by path, messages by time + text, keys / connectors only when missing). Needs ELVAR_DB_URL
// and ELVAR_KEK like the server. It never prints a secret.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getDb } from '../server/db/index.js';
import { mintVerifiedUid } from '../server/db/verified-uid.js';
import { getKeyring } from '../server/auth/keyring.js';
import { hkdf, open } from '../server/crypto/envelope.js';
import { runWithConfig, envConfig } from '../server/config/resolve.js';
import { importFromGithub } from '../server/brain-sync.js';
import { redactSecrets } from '../server/brain.js';
import { KEYS, keyInfo } from '../server/config/keys.js';
import { mergeProfile } from '../server/profile/defaults.js';
import { NOTIF_SECRET } from '../server/auth/load-user-config.js';

const unb64 = (s) => Buffer.from(String(s), 'base64url');
const META_KEY = 'elvar:v1:meta', DOC_KEY = 'elvar:v1:doc';

/** The old vault (scrypt-wrapped data key, AES-GCM records) -> its document { profile, settings, secrets, connectors, notifSecret }. */
export async function readOldVault(file, password) {
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  const get = (k) => { const e = store[k]; if (!e || e.t !== 's') return null; try { return JSON.parse(e.v); } catch { return null; } };
  const meta = get(META_KEY), rec = get(DOC_KEY);
  if (!meta || !rec) throw new Error('この store.json には、旧オーナーの保管庫がありません');
  const kdf = meta.kdf, salt = unb64(kdf.salt);
  const raw = await new Promise((res, rej) => crypto.scrypt(String(password).normalize('NFKC'), salt, 32, { N: Number(kdf.N), r: Number(kdf.r), p: Number(kdf.p), maxmem: 256 * Number(kdf.N) * Number(kdf.r) + 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
  let dek; try { dek = open(hkdf(raw, salt, 'elvar-dek-wrap-pw-v1'), meta.pwWrap, 'wrap:pw'); } catch { throw new Error('オーナーのパスワードが違います'); }
  return JSON.parse(open(dek, rec, `${DOC_KEY}|v${rec.ver}`).toString());
}

/** 会話/<date>.md -> [{ at, role, text }] (what brainAppendConversation wrote: "### HH:MM" then "- **name**：words"). */
export function parseConversationLog(date, text, { userNames, assistantNames, tz = '+09:00' }) {
  const out = []; let hm = '00:00', n = 0;
  for (const line of String(text).split('\n')) {
    const h = /^###\s+(\d{2}:\d{2})\s*$/.exec(line); if (h) { hm = h[1]; n = 0; continue; }
    const m = /^-\s+\*\*([^*]+)\*\*：(.*)$/.exec(line); if (!m) continue;
    const who = m[1].trim(), body = m[2].trim(); if (!body) continue;
    const role = assistantNames.has(who) ? 'assistant' : userNames.has(who) ? 'user' : n % 2 === 0 ? 'user' : 'assistant';
    const at = Date.parse(`${date}T${hm}:00${tz}`) + n; n++;
    if (Number.isFinite(at)) out.push({ at, role, text: body.slice(0, 8000) });
  }
  return out;
}

const LOG_PATH = /^会話\/(\d{4}-\d{2}-\d{2})\.md$/;
const EDITABLE_SETTING = (n) => keyInfo(n)?.kind === 'setting' && !keyInfo(n).platform;
const EDITABLE_SECRET = (n) => keyInfo(n)?.kind === 'secret';

/**
 * @param {{ userId: string, vault?: string, password?: string, repo?: string, token?: string, branch?: string, dir?: string, keepForever?: boolean, overwrite?: boolean,
 *           dryRun?: boolean, keepLogNotes?: boolean, db?: object, fetchImpl?: Function, log?: Function, nowMs?: number }} o
 */
export async function migrateOwner(o) {
  const log = o.log || (() => {}), dry = o.dryRun === true, db = o.db || await getDb(), v = mintVerifiedUid(o.userId, 'migrate'), ring = getKeyring();
  const asUser = (fn) => db.asUser(v, fn);
  const rep = { dryRun: dry, profile: 'skipped', settings: 0, secrets: 0, connectors: 0, notes: { created: 0, updated: 0, same: 0, conflicts: [], skipped: 0, more: 0 }, messages: { added: 0, existing: 0, tooOld: 0 }, retention: null, warnings: [] };
  await asUser((r) => r.accounts.get()).then((a) => { if (!a) return asUser((r) => r.accounts.ensure()); });
  let doc = null;
  if (o.vault) {
    if (!o.password) throw new Error('--vault には --password（旧オーナーのパスワード）も必要です');
    doc = await readOldVault(o.vault, o.password);
    await asUser(async (r) => {
      if (doc.profile) { const has = await r.profile.get(); if (!has || o.overwrite) { rep.profile = has ? 'replaced' : 'imported'; if (!dry) await r.profile.put(JSON.parse(JSON.stringify(mergeProfile(doc.profile)))); } else rep.profile = 'kept (the account already has one)'; }
      const cur = await r.settings.get(), next = { ...cur };
      for (const [k, val] of Object.entries(doc.settings || {})) { if (!EDITABLE_SETTING(k) || typeof val !== 'string' || !val) continue; if (cur[k] === undefined || o.overwrite) { next[k] = val; rep.settings++; } }
      if (rep.settings && !dry) await r.settings.put(next);
      const have = new Set((await r.secrets.list()).map((s) => s.name));
      const secrets = { ...(doc.secrets || {}), ...(doc.notifSecret ? { [NOTIF_SECRET]: doc.notifSecret } : {}) };
      for (const [k, val] of Object.entries(secrets)) {
        const ok = EDITABLE_SECRET(k) && k !== 'GOOGLE_REFRESH_TOKEN' || k === NOTIF_SECRET || /^cx:[A-Za-z0-9_-]{1,40}:(auth|oauthSecret)$/.test(k);
        if (!ok || typeof val !== 'string' || !val) continue;
        if (have.has(k) && !o.overwrite) continue;
        rep.secrets++; if (!dry) await ring.setSecret(r, k, val);
      }
      const haveCx = new Set((await r.connectors.list()).map((c) => c.id));
      for (const c of doc.connectors || []) { if (!c?.id || (haveCx.has(c.id) && !o.overwrite)) continue; rep.connectors++; if (!dry) await r.connectors.put(c); }
    });
    log(`vault: profile ${rep.profile}, ${rep.settings} settings, ${rep.secrets} keys, ${rep.connectors} connectors`);
  }
  if (o.repo) {
    const vals = { BRAIN_REPO: o.repo, BRAIN_GITHUB_TOKEN: o.token, BRAIN_BRANCH: o.branch || 'main', BRAIN_DIR: o.dir || '' };
    const cfg = Object.assign(Object.create(envConfig()), { get: (n) => vals[n] });
    const logs = [];
    // the conversation logs are read in the same pass but become messages, not notes (unless --keep-log-notes)
    rep.notes = await runWithConfig(cfg, () => importFromGithub({ user: { db: asUser }, dryRun: dry, fetchImpl: o.fetchImpl, divert: o.keepLogNotes ? null : (rel, text) => { const m = LOG_PATH.exec(rel); if (m) logs.push([m[1], text]); return Boolean(m); } }));
    const names = (k) => new Set([...(k === 'user' ? [doc?.profile?.owner?.address, doc?.profile?.owner?.name, 'ご主人様'] : [doc?.profile?.assistant?.displayName, 'エルヴァー', 'E.L.V.A.R.'])].filter(Boolean));
    const retention = o.keepForever ? 0 : 180, now = o.nowMs ?? Date.now();
    for (const [date, text] of logs) {
      const turns = parseConversationLog(date, text, { userNames: names('user'), assistantNames: names('assistant') }).map((t) => ({ ...t, text: redactSecrets(t.text) }));
      const fresh = retention === 0 ? turns : turns.filter((t) => t.at >= now - retention * 864e5);
      rep.messages.tooOld += turns.length - fresh.length;
      if (!fresh.length) continue;
      await asUser(async (r) => {
        const lo = Math.min(...fresh.map((t) => t.at)), hi = Math.max(...fresh.map((t) => t.at)) + 1;
        const have = new Set((await r.messages.list({ since: new Date(lo - 1000).toISOString(), until: new Date(hi + 1000).toISOString(), limit: 2000 })).map((m) => `${Date.parse(m.at)}|${m.role}|${m.text}`));
        const add = fresh.filter((t) => !have.has(`${t.at}|${t.role}|${t.text}`));
        rep.messages.existing += fresh.length - add.length; rep.messages.added += add.length;
        if (add.length && !dry) for (let i = 0; i < add.length; i += 100) await r.messages.append({ turns: add.slice(i, i + 100), channel: 'import' });
      });
    }
    log(`github: notes +${rep.notes.created} ~${rep.notes.updated} =${rep.notes.same}, conflicts ${rep.notes.conflicts.length}; messages +${rep.messages.added}`);
  }
  if (o.keepForever) { rep.retention = 'for ever'; if (!dry) await asUser(async (r) => r.settings.put({ ...(await r.settings.get()), MESSAGE_RETENTION_DAYS: '0' })); }
  else if (rep.messages.tooOld) rep.warnings.push(`${rep.messages.tooOld} messages are older than the 180-day retention and were skipped (use --keep-forever to import them and keep them)`);
  if (rep.notes.conflicts.length) rep.warnings.push('notes that were changed in the account since they were last mirrored were kept as they are: ' + rep.notes.conflicts.slice(0, 5).join(', '));
  return rep;
}

function parseArgs(argv) {
  const o = {}, flags = new Set(['dry-run', 'overwrite', 'keep-forever', 'keep-log-notes']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; if (!a.startsWith('--')) throw new Error('unknown argument: ' + a);
    const k = a.slice(2); if (flags.has(k)) { o[k.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = true; continue; }
    const val = argv[++i]; if (val === undefined) throw new Error(a + ' needs a value');
    o[k === 'user' ? 'userId' : k] = val;
  }
  return o;
}
void KEYS;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    const o = parseArgs(process.argv.slice(2));
    if (!o.userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(o.userId)) { console.error('usage: node --env-file=.env scripts/migrate-owner.mjs --user <uuid> [--vault store.json --password ...] [--repo owner/name --token ...] [--dry-run] (see the header of this file)'); process.exit(2); }
    if (!o.vault && !o.repo) { console.error('nothing to import: give --vault and/or --repo'); process.exit(2); }
    const rep = await migrateOwner({ ...o, log: (m) => console.log('[migrate]', m) });
    console.log(JSON.stringify(rep, null, 2));
    process.exit(0);
  })().catch((e) => { console.error('[migrate] failed:', e?.message || e); process.exit(1); });
}
