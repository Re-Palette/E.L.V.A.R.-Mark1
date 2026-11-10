// P8: the public privacy policy and terms are templates for a MULTI-USER platform (docs/ELVAR_MULTIUSER.md 19.3): operator placeholders, the user's data rights, the data
// categories, per-user encryption and what the operator can read, retention, APPI as the baseline with GDPR-compatible requests, BYOK. No personal data. Plus the load-test script's guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const page = (n) => fs.readFileSync(new URL(`../web/public/${n}/index.html`, import.meta.url), 'utf8');
const text = (h) => h.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '');

test('privacy policy: a multi-user template with operator placeholders, the data rights, categories, encryption, retention, APPI / GDPR and BYOK', () => {
  const h = page('privacy'), t = text(h);
  assert.ok((h.match(/class="ph">【/g) || []).length >= 8, 'operator placeholders to fill in');
  for (const must of ['運営者の名称', '連絡先メールアドレス', '閲覧', '修正', '書き出し', '完全削除', '個人情報保護法', 'GDPR', '持ち込みの鍵', '利用者ごとの鍵', '運営者は、技術的にはこれらの内容を読める', 'バックアップ', 'ファイル保管庫', '会話の記録', '利用量', '操作記録', '7日の猶予', '最低年齢']) assert.ok(t.includes(must), `missing: ${must}`);
  assert.ok(!/オーナー1人|自分自身のためだけ|会員登録もありません/.test(t), 'no single-owner wording is left');
  assert.ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(t.replace(/example\.[a-z]+/g, '')) , 'no e-mail address or personal contact is written into the template');
});

test('terms: a multi-user template with accounts, data ownership, BYOK responsibility, limits, prohibited use, termination and liability', () => {
  const h = page('terms'), t = text(h);
  assert.ok((h.match(/class="ph">【/g) || []).length >= 8);
  for (const must of ['運営者', 'アカウント', 'データは利用者のもの', '持ち込みの鍵', '利用者の責任', '禁止事項', '利用の上限', '承認', '停止', '免責', '準拠法', 'プライバシーポリシー', '見る・直す・書き出す・完全に削除']) assert.ok(t.includes(must), `missing: ${must}`);
  assert.ok(!/個人用ソフトウェア|運営者以外の方の利用を想定していません/.test(t), 'no single-owner wording is left');
  assert.match(h, /href="\/privacy\/"/);
});

test('both pages are linked from the sign-up and sign-in screens', () => {
  const s = fs.readFileSync(new URL('../web/src/auth/screens.js', import.meta.url), 'utf8');
  assert.match(s, /href="\/terms\/"/); assert.match(s, /href="\/privacy\/"/);
});

test('the load test refuses anything but a local dev stack', () => {
  const r = spawnSync(process.execPath, ['scripts/load-test.mjs', '--base', 'https://example.com'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /local dev stack/);
});
