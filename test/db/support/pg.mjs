// Connections and helpers for the database tests. Run through `npm run test:db`, which sets the two URLs:
//   ELVAR_TEST_DB_ADMIN_URL  superuser: creates users, fixtures, inspects the catalog (tests only)
//   ELVAR_TEST_DB_APP_URL    the elvar_app role: what the server uses
import crypto from 'node:crypto';
import postgres from 'postgres';

process.env.ELVAR_TEST_MODE = '1';
export const adminUrl = process.env.ELVAR_TEST_DB_ADMIN_URL, appUrl = process.env.ELVAR_TEST_DB_APP_URL;
if (!adminUrl || !appUrl) throw new Error('These tests need a database: run `npm run test:db` (it starts Postgres in Docker).');

const open = (url, max) => postgres(url, { max, prepare: false, onnotice: () => {}, idle_timeout: 5, connect_timeout: 15 });
export const admin = open(adminUrl, 4);
/** A separate elvar_app connection for the raw-role experiments (the production layer is in server/db/pool.js). */
export const rawApp = (max = 1) => open(appUrl, max);

export async function newUser(sql = admin) {
  const id = crypto.randomUUID();
  await sql`insert into auth.users (id, email) values (${id}, ${id + '@example.test'})`;
  return id;
}
export const deleteUser = (uid, sql = admin) => sql`delete from auth.users where id = ${uid}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run fn(tx) as `authenticated` acting as uid, the way asUser does (raw: for the generated isolation tests). claims === undefined -> no claims at all. */
export async function asRole(sql, { uid, claims = uid ? { sub: uid, role: 'authenticated' } : undefined, role = 'authenticated' }, fn) {
  return sql.begin(async (tx) => {
    if (claims !== undefined) await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    if (role) await tx.unsafe(`set local role ${role}`);
    return fn(tx);
  });
}

/** Tables of schema app with their owner column, from the catalog. */
export async function appTables() {
  return admin`select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced, c.relkind as kind
               from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind in ('r', 'p') order by 1`;
}
