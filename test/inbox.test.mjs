import test from 'node:test';
import assert from 'node:assert/strict';
import { pushItem, ago, KINDS } from '../web/src/inbox.js';
import { noteForBuild } from '../web/src/builds.js';

test('inbox: newest first, same key replaces (an updated build is one item), capped at 40, empty titles ignored, unknown kinds become お知らせ', () => {
  let l = [];
  l = pushItem(l, { kind: 'build', key: 'build:7', title: '製作：A（作業中）' }, 1000);
  l = pushItem(l, { kind: 'report', title: '報告1' }, 2000);
  l = pushItem(l, { kind: 'deliverable', key: 'build:7', title: '製作：A（完成）' }, 3000);
  assert.deepEqual(l.map((x) => x.title), ['製作：A（完成）', '報告1']); assert.equal(l[0].kind, 'deliverable'); assert.equal(l[0].read, false);
  assert.equal(pushItem(l, { title: '' }), l); assert.equal(pushItem([], { kind: 'zzz', title: 'x' })[0].kind, 'notice');
  for (let i = 0; i < 60; i++) l = pushItem(l, { title: 'n' + i }, 4000 + i); assert.equal(l.length, 40); assert.equal(l[0].title, 'n59');
  assert.ok(Object.keys(KINDS).includes('alert'));
});
test('inbox: relative times and a self-modification build note that says the PR must be merged first', () => {
  assert.equal(ago(0, 30 * 1000), 'いま'); assert.equal(ago(0, 5 * 60000), '5分前'); assert.equal(ago(0, 3 * 3600e3), '3時間前');
  const n = noteForBuild({ title: 'シフト', stateLabel: 'PRができました', self: true, pr: { number: 2, merged: false, draft: false }, summary: '' });
  assert.match(n, /E\.L\.V\.A\.R\.自身/); assert.match(n, /マージ/);
});
