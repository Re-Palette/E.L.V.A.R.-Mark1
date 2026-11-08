// Approval tickets: single use holds through the store (SET NX), i.e. across serverless instances, and fails closed when the store is down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetStore, getStore } from '../server/store/index.js';
import { signTicket, verifyTicket } from '../server/google/ticket.js';

const args = { to: 'a@example.com', subject: 's' };

test('a ticket is single use: the first verify wins a store SET NX, a replay (another instance) loses; parallel verifies yield exactly one winner', async () => {
  resetStore();
  const t = signTicket('gmail_send', args);
  const jti = JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString()).j;
  assert.equal(await getStore().get(`elvar:v1:ticket:${jti}`), null);
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => verifyTicket(t, 'gmail_send', args)));
  assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one of five concurrent verifies may execute');
  assert.ok(results.filter((r) => !r.ok).every((r) => /使用済み/.test(r.reason)));
  assert.equal(await getStore().get(`elvar:v1:ticket:${jti}`), 1, 'the mark lives in the store, not in this process');
  assert.equal((await verifyTicket(t, 'gmail_send', args)).ok, false, 'replay refused');
});

test('another instance (a fresh in-process state, the same store) cannot replay a used ticket', async () => {
  resetStore();
  const t = signTicket('gmail_send', args);
  assert.equal((await verifyTicket(t, 'gmail_send', args)).ok, true);
  // a second module instance = a second serverless instance: its own in-process memory, the shared store
  const other = await import('../server/google/ticket.js?instance=2');
  assert.equal((await other.verifyTicket(t, 'gmail_send', args)).ok, false);
});

test('a wrong tool / args / forged signature / expired ticket never consumes the store mark', async () => {
  resetStore();
  const t = signTicket('gmail_send', args);
  assert.equal((await verifyTicket(t, 'gmail_create_draft', args)).ok, false);
  assert.equal((await verifyTicket(t, 'gmail_send', { ...args, to: 'evil@example.com' })).ok, false);
  assert.equal((await verifyTicket(t.slice(0, -3) + 'AAA', 'gmail_send', args)).ok, false);
  assert.equal((await verifyTicket(signTicket('gmail_send', args, Date.now() - 200_000), 'gmail_send', args)).ok, false);
  assert.equal((await verifyTicket('', 'gmail_send', args)).ok, false);
  assert.equal((await verifyTicket(t, 'gmail_send', args)).ok, true, 'the genuine one still works once');
});

test('the mark expires with the ticket (TTL = remaining life + a minute)', async () => {
  resetStore();
  const store = getStore(); const calls = []; const real = store.set.bind(store);
  store.set = (k, v, o) => { calls.push({ k, o }); return real(k, v, o); };
  assert.equal((await verifyTicket(signTicket('gmail_send', args), 'gmail_send', args)).ok, true);
  const c = calls.find((x) => x.k.startsWith('elvar:v1:ticket:'));
  assert.equal(c.o.nx, true); assert.ok(c.o.ttlSec >= 60 + 100 && c.o.ttlSec <= 60 + 121, `ttl ${c.o.ttlSec}`);
});

test('a configured store that fails closes the door: the ticket is refused (no replay window during an outage)', async () => {
  resetStore();
  const store = getStore(); store.set = async () => { throw new Error('redis down'); };
  const r = await verifyTicket(signTicket('gmail_send', args), 'gmail_send', args);
  assert.equal(r.ok, false); assert.match(r.reason, /確認できません/);
});
