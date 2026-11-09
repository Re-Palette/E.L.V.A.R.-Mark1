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
  setQuota: async (uid, bytes) => { await admin`insert into app.accounts (user_id) values (${uid}) on conflict do nothing`; await admin`update app.accounts set storage_quota_bytes = ${bytes} where user_id = ${uid}`; },
  setHardLimits: async (uid, o) => { await admin`insert into app.accounts (user_id) values (${uid}) on conflict do nothing`; await admin`update app.accounts set hard_limits = ${admin.json(o)} where user_id = ${uid}`; },
  expireReservations: async (uid) => { await admin`update app.files set reserved_until = now() - interval '10 minutes' where user_id = ${uid} and status = 'pending'`; },
}));
