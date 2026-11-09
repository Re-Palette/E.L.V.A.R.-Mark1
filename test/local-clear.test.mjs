// Review fix (BLOCKER 3): signing out erases the user's namespaced keys. The real web/public/ns.js is loaded (it patches Storage), then clearUserLocal runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('clearUserLocal removes the signed-out user\'s keys (conversation queue, notification secret) through the real ns.js, and leaves another user\'s', async () => {
  const data = new Map();
  class Storage {}
  Storage.prototype.getItem = function (k) { return data.has(k) ? data.get(k) : null; }; Storage.prototype.setItem = function (k, v) { data.set(k, String(v)); }; Storage.prototype.removeItem = function (k) { data.delete(k); };
  const ls = Object.assign(new Storage(), { key: (i) => [...data.keys()][i] }); Object.defineProperty(ls, 'length', { get: () => data.size });
  const win = { Storage, localStorage: ls }; win.window = win;
  data.set('elvar_ns', 'aaaaaaaaaaaaaaaa');
  vm.runInNewContext(fs.readFileSync(new URL('../web/public/ns.js', import.meta.url), 'utf8'), { ...win, Storage, localStorage: ls, window: win });
  Object.assign(globalThis, { window: win, localStorage: ls, indexedDB: { databases: async () => [] } });
  ls.setItem('elvar_conv_queue', '[1]'); ls.setItem('elvar_notif_secret', 'S');   // stored as u.aaaaaaaaaaaaaaaa.<key>
  data.set('u.bbbbbbbbbbbbbbbb.elvar_conv_queue', 'other user'); data.set('elvar_auth_session', 'device-wide');
  assert.ok(data.has('u.aaaaaaaaaaaaaaaa.elvar_conv_queue'));
  const { clearUserLocal } = await import('../web/src/elvar/local.js');
  await clearUserLocal('aaaaaaaaaaaaaaaa');
  assert.deepEqual([...data.keys()].sort(), ['elvar_auth_session', 'elvar_ns', 'u.bbbbbbbbbbbbbbbb.elvar_conv_queue'], 'only the signed-out user\'s keys are gone');
});
