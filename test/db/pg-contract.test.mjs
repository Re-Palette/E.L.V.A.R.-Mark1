// The database contract (test/contracts/db.contract.mjs) against the real Postgres layer: asUser() through the elvar_app role, RLS, the definer functions.
import { createPgDb } from '../../server/db/pool.js';
import { runDbContract } from '../contracts/db.contract.mjs';
import { appUrl, admin, newUser, deleteUser, sleep } from './support/pg.mjs';
import test from 'node:test';

const db = createPgDb(appUrl);
test.after(async () => { await db.close(); await admin.end({ timeout: 5 }); });

runDbContract('postgres', async () => ({
  db,
  newUser: () => newUser(),
  deleteUser: (uid) => deleteUser(uid),
  makeAdmin: async (uid) => { await admin`insert into app.admins (user_id) values (${uid}) on conflict do nothing`; },
  passTime: (ms) => sleep(ms),
}));
