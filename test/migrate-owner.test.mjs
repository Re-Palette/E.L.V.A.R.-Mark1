// scripts/migrate-owner.mjs: an old single-owner install (the encrypted vault file + the GitHub second brain) into one account. Dry run writes nothing; a second run
// duplicates nothing; the keys end up sealed under the account's own key; other accounts are untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryDb } from '../server/db/memory.js';
import { mintVerifiedUid } from '../server/db/verified-uid.js';
import { _setKeyringForTests } from '../server/auth/keyring.js';
import { createKeyring, envKekProvider, hkdf, seal } from '../server/crypto/envelope.js';
import { migrateOwner, readOldVault, parseConversationLog } from '../scripts/migrate-owner.mjs';
import { DEFAULT_PROFILE } from '../server/profile/defaults.js';

process.env.ELVAR_TEST_MODE = '1';
const b64 = (b) => Buffer.from(b).toString('base64url');
const PASSWORD = 'owner-password-1234';

/** An old vault file exactly as the single-owner build wrote it (scrypt-wrapped data key, AES-GCM document). */
async function oldVaultFile(doc) {
  const dek = crypto.randomBytes(32), kdf = { alg: 'scrypt', N: 2 ** 10, r: 8, p: 1, salt: b64(crypto.randomBytes(16)) }, salt = Buffer.from(kdf.salt, 'base64url');
  const raw = await new Promise((res, rej) => crypto.scrypt(PASSWORD, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
  const meta = { ver: 1, v: 1, kdf, pwWrap: seal(hkdf(raw, salt, 'elvar-dek-wrap-pw-v1'), dek, 'wrap:pw'), docVer: 1, devices: {} };
  const rec = { ver: 1, ...seal(dek, JSON.stringify(doc), 'elvar:v1:doc|v1') };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elvar-old-')), 'store.json');
  fs.writeFileSync(file, JSON.stringify({ 'elvar:v1:meta': { t: 's', v: JSON.stringify(meta), x: null }, 'elvar:v1:doc': { t: 's', v: JSON.stringify(rec), x: null } }));
  return file;
}
const github = (files) => async (url, o = {}) => {
  const u = decodeURIComponent(String(url)), J = (b, status = 200) => ({ ok: status < 300, status, json: async () => b });
  if (u.includes('/git/trees/')) return J({ tree: Object.entries(files).map(([p, t]) => ({ path: p, type: 'blob', size: t.length })) });
  const p = u.match(/\/contents\/([^?]+)/)?.[1]; return p in files ? J({ type: 'file', sha: 's', content: Buffer.from(files[p]).toString('base64') }) : J({}, 404);
};

test('the conversation log format of the old build is parsed back into messages with the right roles and times', () => {
  const t = '# 会話ログ 2026-11-04\n\n### 21:05\n- **ご主人様**：明日の予定は？\n- **エルヴァー**：10時に打ち合わせです。\n\n### 21:07\n- **ご主人様**：ありがとう\n';
  const m = parseConversationLog('2026-11-04', t, { userNames: new Set(['ご主人様']), assistantNames: new Set(['エルヴァー']) });
  assert.deepEqual(m.map((x) => [x.role, x.text]), [['user', '明日の予定は？'], ['assistant', '10時に打ち合わせです。'], ['user', 'ありがとう']]);
  assert.equal(m[0].at, Date.parse('2026-11-04T21:05:00+09:00'));
});

test('migrate-owner: dry run writes nothing; the real run brings profile, keys, connectors, notes and conversation; a second run duplicates nothing; another account is untouched', async () => {
  const db = createMemoryDb(), me = db.testing.newUser(), other = db.testing.newUser(), V = mintVerifiedUid(me, 'test'), O = mintVerifiedUid(other, 'test');
  const ring = createKeyring({ kek: envKekProvider({ ELVAR_KEK: 'ck1:' + crypto.randomBytes(32).toString('base64') }) }); _setKeyringForTests(ring);
  const profile = structuredClone(DEFAULT_PROFILE); profile.owner.name = 'テスト太郎'; profile.assistant.displayName = 'エルヴァー';
  const doc = { profile, settings: { WEATHER_PLACE: '東京', GROQ_MODEL: 'platform-model-ignored' }, secrets: { GEMINI_API_KEY: 'AIzaOLD-OWNER-KEY-0000', BOGUS_KEY: 'x', GOOGLE_REFRESH_TOKEN: 'never' }, notifSecret: 'old-notif-secret-0123456789abcdef', connectors: [{ id: 'cx_old', name: '旧コネクタ', type: 'http', http: { baseUrl: 'https://api.example.com' }, tools: [] }] };
  const vault = await oldVaultFile(doc);
  assert.deepEqual((await readOldVault(vault, PASSWORD)).secrets.GEMINI_API_KEY, 'AIzaOLD-OWNER-KEY-0000');
  await assert.rejects(readOldVault(vault, 'wrong-password-999'), /パスワードが違います/);
  const now = Date.parse('2026-11-10T00:00:00+09:00');
  const files = { '人物/田中さん.md': '# 田中さん\n定例は火曜', '好み/コーヒー.md': 'ブラック', '会話/2026-11-04.md': '### 21:05\n- **テスト太郎**：明日の予定は？ パスワードは abc12345 です\n- **エルヴァー**：10時です。\n', '会話/2025-01-01.md': '### 09:00\n- **テスト太郎**：とても古い話\n' };
  const base = { userId: me, vault, password: PASSWORD, repo: 'me/old-brain', token: 'ghp_OLD', db, fetchImpl: github(files), nowMs: now };

  const dry = await migrateOwner({ ...base, dryRun: true });
  assert.deepEqual([dry.profile, dry.settings, dry.secrets, dry.connectors], ['imported', 1, 2, 1]); assert.deepEqual([dry.notes.created, dry.messages.added, dry.messages.tooOld], [2, 2, 1]);
  assert.equal(await db.asUser(V, (r) => r.notes.count()), 0); assert.equal(await db.asUser(V, (r) => r.messages.count()), 0); assert.equal(await db.asUser(V, (r) => r.profile.get()), null); assert.deepEqual(await db.asUser(V, (r) => r.secrets.list()), []);

  const run1 = await migrateOwner(base);
  assert.deepEqual([run1.notes.created, run1.messages.added], [2, 2]); assert.equal(run1.warnings.length, 1, 'the very old log is reported, not silently dropped');
  assert.equal((await db.asUser(V, (r) => r.profile.get())).owner.name, 'テスト太郎');
  assert.deepEqual(await db.asUser(V, (r) => r.settings.get()), { WEATHER_PLACE: '東京' }, 'only the user-level settings; the platform-owned key is not copied');
  assert.deepEqual((await db.asUser(V, (r) => r.secrets.list())).map((s) => s.name).sort(), ['GEMINI_API_KEY', 'NOTIF_SECRET'], 'known keys only; the Google refresh token and unknown names are not carried over');
  assert.equal(await db.asUser(V, (r) => ring.getSecret(r, 'GEMINI_API_KEY')), 'AIzaOLD-OWNER-KEY-0000', 'sealed under the account\'s own key');
  assert.deepEqual((await db.asUser(V, (r) => r.connectors.list())).map((c) => c.id), ['cx_old']);
  assert.deepEqual((await db.asUser(V, (r) => r.notes.list())).map((n) => n.path), ['人物/田中さん.md', '好み/コーヒー.md'], 'the conversation logs are messages, not notes');
  const msgs = await db.asUser(V, (r) => r.messages.list({})); assert.equal(msgs.length, 2); assert.ok(!msgs.some((m) => /abc12345/.test(m.text)), 'secrets are masked on the way in');
  assert.deepEqual(msgs.map((m) => m.role).sort(), ['assistant', 'user']);

  const run2 = await migrateOwner(base);
  assert.deepEqual([run2.notes.created, run2.notes.same, run2.messages.added, run2.messages.existing, run2.secrets, run2.connectors], [0, 2, 0, 2, 0, 0], 'idempotent');
  // an edit made in the account is not overwritten by the next import
  await db.asUser(V, async (r) => { await r.notes.put({ path: '好み/コーヒー.md', content: 'ミルク' }); });
  files['好み/コーヒー.md'] = 'リポジトリで変更'; const run3 = await migrateOwner(base); assert.deepEqual(run3.notes.conflicts, ['好み/コーヒー.md']); assert.equal((await db.asUser(V, (r) => r.notes.get('好み/コーヒー.md'))).content, 'ミルク');
  // --keep-forever imports the old log too and turns the retention off
  const run4 = await migrateOwner({ ...base, keepForever: true }); assert.equal(run4.messages.added, 1); assert.equal((await db.asUser(V, (r) => r.settings.get())).MESSAGE_RETENTION_DAYS, '0');
  assert.deepEqual(await db.asUser(O, (r) => r.notes.list()), [], 'the other account got nothing'); assert.equal(await db.asUser(O, (r) => r.messages.count()), 0);
  _setKeyringForTests(null);
});
