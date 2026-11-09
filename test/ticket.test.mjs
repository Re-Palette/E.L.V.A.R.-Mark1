// Approval tickets (server/google/ticket.js): signed with a key derived from the USER's own data key, carrying the user id, and single use per user in the
// user's own database (app.ticket_uses). A ticket of one user is worthless for another; nothing is signed or verified without a user; the database being
// down fails closed (no replay window during an outage).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithConfig, envConfig } from '../server/config/resolve.js';
import { signTicket, verifyTicket } from '../server/google/ticket.js';
import { createMemoryDb } from '../server/db/memory.js';
import { makeTestUser } from './helpers/user-ctx.mjs';
import { createKeyring, envKekProvider } from '../server/crypto/envelope.js';
import crypto from 'node:crypto';

const args = { to: 'a@example.com', subject: 's' };
const jtiOf = (t) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString()).j;
const payloadOf = (t) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString());

test('a ticket is single use: the first verify wins, a replay (another instance) loses; parallel verifies yield exactly one winner', async () => {
  const u = makeTestUser();
  await u.run(async () => {
    const t = signTicket('gmail_send', args);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => verifyTicket(t, 'gmail_send', args)));
    assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one of five concurrent verifies may execute');
    assert.ok(results.filter((r) => !r.ok).every((r) => /使用済み/.test(r.reason)));
    assert.equal((await verifyTicket(t, 'gmail_send', args)).ok, false, 'replay refused');
  });
});

test('another instance (a fresh module instance, the same database) cannot replay a used ticket', async () => {
  const u = makeTestUser();
  await u.run(async () => {
    const t = signTicket('gmail_send', args);
    assert.equal((await verifyTicket(t, 'gmail_send', args)).ok, true);
    const other = await import('../server/google/ticket.js?instance=2');
    assert.equal((await other.verifyTicket(t, 'gmail_send', args)).ok, false);
  });
});

test('a wrong tool / args / forged signature / expired ticket never consumes the mark', async () => {
  const u = makeTestUser();
  await u.run(async () => {
    const t = signTicket('gmail_send', args);
    assert.equal((await verifyTicket(t, 'gmail_create_draft', args)).ok, false);
    assert.equal((await verifyTicket(t, 'gmail_send', { ...args, to: 'evil@example.com' })).ok, false);
    assert.equal((await verifyTicket(t.slice(0, -3) + 'AAA', 'gmail_send', args)).ok, false);
    assert.equal((await verifyTicket(signTicket('gmail_send', args, Date.now() - 200_000), 'gmail_send', args)).ok, false);
    assert.equal((await verifyTicket('', 'gmail_send', args)).ok, false);
    assert.equal((await verifyTicket(t, 'gmail_send', args)).ok, true, 'the genuine one still works once');
  });
});

test('the mark expires with the ticket (TTL = remaining life + a minute)', async () => {
  const seen = [];
  const u = makeTestUser({ extra: {} });
  const inner = u.cfg.db;
  u.cfg.db = (fn) => inner((r) => fn({ ...r, tickets: { markUsed: (j, ttl) => { seen.push(ttl); return r.tickets.markUsed(j, ttl); } } }));
  await u.run(async () => assert.equal((await verifyTicket(signTicket('gmail_send', args), 'gmail_send', args)).ok, true));
  assert.ok(seen[0] >= 60 + 100 && seen[0] <= 60 + 121, `ttl ${seen[0]}`);
});

test('the database being down closes the door: the ticket is refused', async () => {
  const u = makeTestUser(); u.cfg.db = async () => { throw new Error('db down'); };
  await u.run(async () => { const r = await verifyTicket(signTicket('gmail_send', args), 'gmail_send', args); assert.equal(r.ok, false); assert.match(r.reason, /確認できません/); });
});

test('a ticket of user A is refused for user B (different key, different id), even when both share the same database', async () => {
  const db = createMemoryDb(), a = makeTestUser({ db }), b = makeTestUser({ db });
  const t = await a.run(() => signTicket('gmail_send', args));
  assert.equal(payloadOf(t).u, a.uid);
  await b.run(async () => assert.equal((await verifyTicket(t, 'gmail_send', args)).ok, false, 'B cannot use A\'s ticket'));
  // even if B somehow had A's key, the user id inside the ticket would still not match
  const sameKey = makeTestUser({ db, ticketKey: a.cfg.ticketKey });
  await sameKey.run(async () => assert.equal((await verifyTicket(t, 'gmail_send', args)).ok, false, 'a second lock: the ticket names its user'));
  await a.run(async () => assert.equal((await verifyTicket(t, 'gmail_send', args)).ok, true, 'A still can'));
});

test('without a user there is nothing to sign or verify (no platform key, no per-process fallback)', async () => {
  await runWithConfig(envConfig(), async () => {
    assert.throws(() => signTicket('gmail_send', args), /ログイン/);
    assert.equal((await verifyTicket('a.b', 'gmail_send', args)).ok, false);
  });
  const u = makeTestUser(); const t = await u.run(() => signTicket('gmail_send', args));
  await runWithConfig(envConfig(), async () => assert.equal((await verifyTicket(t, 'gmail_send', args)).ok, false));
});

test('rotating the user\'s DEK invalidates pending tickets (the signing key is derived from it)', async () => {
  const db = createMemoryDb(), ring = createKeyring({ kek: envKekProvider({ ELVAR_KEK: 'k:' + crypto.randomBytes(32).toString('base64') }) });
  const u = makeTestUser({ db });
  const key1 = await u.cfg.db((r) => ring.ticketKey(r)); u.cfg.ticketKey = key1;
  const t = await u.run(() => signTicket('gmail_send', args));
  await u.cfg.db((r) => ring.rotateDek(r));
  u.cfg.ticketKey = await u.cfg.db((r) => ring.ticketKey(r));
  await u.run(async () => assert.equal((await verifyTicket(t, 'gmail_send', args)).ok, false));
  assert.notEqual(jtiOf(t), undefined);
});
