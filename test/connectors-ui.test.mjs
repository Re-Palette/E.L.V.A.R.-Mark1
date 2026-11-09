// Pure helpers of the 連携アプリ screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { statusOf, approvalChoices, shownApproval, diffTool, toolPrefsFrom, parseToolsJson, EXAMPLE_TOOLS, firstError } from '../web/src/settings/connectors-logic.js';

test('status labels: connected / needs re-approval / error / needs auth / disabled', () => {
  assert.deepEqual(statusOf({ enabled: true, status: 'connected' }), ['接続中', 'ok']); assert.equal(statusOf({ enabled: true, status: 'needs_reapproval' })[0], '再承認が必要'); assert.equal(statusOf({ enabled: true, status: 'error' })[0], 'エラー');
  assert.equal(statusOf({ enabled: true, status: 'needs_auth' })[0], '認証が必要'); assert.equal(statusOf({ enabled: false, status: 'connected' })[0], '無効'); assert.equal(statusOf({ enabled: true, status: 'weird' })[0], 'エラー');
});
test('approval choices: auto only for a read-only, non-dangerous tool; a dangerous one offers the strong warning', () => {
  assert.deepEqual(approvalChoices({ readOnly: false, danger: 'normal' }), ['ask', 'off']); assert.deepEqual(approvalChoices({ readOnly: true, danger: 'normal' }), ['ask', 'auto', 'off']);
  assert.deepEqual(approvalChoices({ readOnly: true, danger: 'high' }), ['ask', 'ask_high', 'off']); assert.equal(shownApproval({ danger: 'high', approval: 'ask' }), 'ask_high'); assert.equal(shownApproval({ danger: 'normal', approval: 'auto' }), 'auto');
});
test('re-approval diff: what changed in text, parameters and hints', () => {
  const t = { description: 'new', inputSchema: { properties: { a: {}, c: {} } }, annotations: { readOnlyHint: false }, prevDef: { description: 'old', inputSchema: { properties: { a: {}, b: {} } }, annotations: { readOnlyHint: true } } };
  assert.deepEqual(diffTool(t), { description: true, params: ['+c', '-b'], hints: true }); assert.deepEqual(diffTool({ description: 'x' }), { description: false, params: [], hints: false });
});
test('PATCH body: only what changed; a tool waiting for re-approval is enabled with the hash that was shown', () => {
  const tools = [{ name: 'a', enabled: true, approval: 'ask', danger: 'normal', expose: 'pinned', hash: 'h1' }, { name: 'b', enabled: false, approval: 'ask', danger: 'normal', expose: 'pinned', needsReapproval: true, hash: 'h2' }, { name: 'c', enabled: true, approval: 'ask', danger: 'high', expose: 'pinned' }];
  assert.deepEqual(toolPrefsFrom(tools, { a: { enabled: true, approval: 'ask', expose: 'pinned' }, c: { enabled: true, approval: 'ask_high' } }), {}, 'c: the strong-warning level is what it already was (shown as ask_high), so nothing is sent');
  assert.deepEqual(toolPrefsFrom(tools, { a: { enabled: false }, b: { enabled: true, approval: 'ask' } }), { a: { enabled: false }, b: { enabled: true, ackHash: 'h2' } });
  assert.deepEqual(toolPrefsFrom(tools, { b: { enabled: false } }), {});
});
test('tools JSON box and server errors', () => {
  assert.equal(parseToolsJson('').tools.length, 0); assert.equal(parseToolsJson(EXAMPLE_TOOLS).tools.length, 2); assert.equal(parseToolsJson('{}').ok, false); assert.match(parseToolsJson('[oops').message, /JSON/);
  assert.equal(firstError({ errors: [{ message: 'x' }] }), 'x'); assert.equal(firstError({ message: 'm' }), 'm'); assert.equal(firstError({}), '保存できませんでした');
});
