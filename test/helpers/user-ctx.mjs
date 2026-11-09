// A signed-in user for the tests that run tools directly (approval tickets need the user's key and the user's own database): an in-memory database, a
// user in it, and a request configuration shaped like the real one (server/auth/load-user-config.js) but NOT strict, so the tests that point the
// code at mock servers through process.env keep working. Not for tests about the strict configuration itself (test/user-config.test.mjs).
import crypto from 'node:crypto';
import { createMemoryDb } from '../../server/db/memory.js';
import { mintVerifiedUid } from '../../server/db/verified-uid.js';
import { envConfig, _enterConfigForTests, runWithConfig } from '../../server/config/resolve.js';

export function makeTestUser({ db = createMemoryDb(), ticketKey = crypto.randomBytes(32), extra = {} } = {}) {
  const uid = db.testing.newUser(), v = mintVerifiedUid(uid, 'test');
  const base = envConfig({ mode: 'user' });   // profile / features stay live getters (tests set ELVAR_PROFILE)
  const cfg = Object.assign(Object.create(base), {
    auth: { mode: 'user', userId: uid }, uid, ticketKey,
    db: (fn) => db.asUser(v, fn),
    hit: async (bucket, windowSec, limit) => (await db.system.rlHit({ bucket, who: uid, windowSec, userId: v })) <= limit,
    record: (provider, metric, amount = 1, source = 'server') => db.asUser(v, (r) => r.usage.record({ provider, metric, amount, source })),
    ...extra,
  });
  return { db, uid, v, cfg, run: (fn) => runWithConfig(cfg, fn) };
}
/** Make a test user the configuration of the rest of this test file. */
export function enterTestUser(opts) { const u = makeTestUser(opts); _enterConfigForTests(u.cfg); return u; }
