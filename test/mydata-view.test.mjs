import test from 'node:test';
import assert from 'node:assert/strict';
import { auditText, progressText } from '../web/src/settings/mydata.js';

test('auditText: Japanese sentences, admin and automatic actions are marked, an unknown action is shown as it is', () => {
  assert.equal(auditText({ action: 'export.requested', actor: 'user' }), 'データの書き出しを依頼');
  assert.equal(auditText({ action: 'account.limits_changed', actor: 'admin' }), '管理者が上限を変更（管理者）'); assert.equal(auditText({ action: 'export.completed', actor: 'system' }), 'データの書き出しが完了（自動）');
  assert.equal(auditText({ action: 'mydata.keys.deleted', actor: 'user' }), '「私のデータ」から keys を削除'); assert.equal(auditText({ action: 'something.else', actor: 'user' }), 'something.else');
});
test('progressText: running shows how many originals are in, done and failed say so', () => {
  assert.match(progressText({ status: 'running', parts: 2, progress: { originals: 5 } }), /原本 5 件.*2 個目/); assert.equal(progressText({ status: 'done' }), '完成しました'); assert.match(progressText({ status: 'failed' }), /失敗/);
});
