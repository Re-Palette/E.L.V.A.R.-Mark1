// The database contract against MemoryDb (what npm test uses). The same file of tests runs against Postgres in test/db/pg-contract.test.mjs.
import { createMemoryDb } from '../server/db/memory.js';
import { runDbContract } from './contracts/db.contract.mjs';

runDbContract('memory', async () => {
  const db = createMemoryDb();
  return {
    db,
    newUser: async () => db.testing.newUser(),
    deleteUser: async (uid) => db.testing.deleteUser(uid),
    makeAdmin: async (uid) => db.testing.makeAdmin(uid),
    passTime: async (ms) => db.testing.advance(ms),
    setQuota: async (uid, bytes) => db.testing.setQuota(uid, bytes),
    setHardLimits: async (uid, o) => db.testing.setHardLimits(uid, o),
    expireReservations: async () => db.testing.advance(40 * 60_000),
    now: () => db.testing.now(),   // the fake clock (earlier tests moved it)
  };
});
