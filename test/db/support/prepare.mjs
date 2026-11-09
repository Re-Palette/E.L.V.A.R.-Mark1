// Prepares a disposable Postgres for the database tests: (1) the Supabase emulation, only if the database is not a Supabase one, (2) every migration in
// order, (3) a password for the elvar_app role. The target is DESTROYED first (schema app is dropped). Used by scripts/test-db.mjs.
import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
export const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
export const APP_ROLE_PASSWORD = 'elvar_app_test_password';

export function migrationFiles() { return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(MIGRATIONS_DIR, f)); }

export async function prepareDatabase(adminUrl, log = () => {}) {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {}, connect_timeout: 15 });
  try {
    const run = (file) => sql.unsafe(fs.readFileSync(file, 'utf8')).simple();
    await sql.unsafe('drop schema if exists app cascade').simple();
    const [{ has }] = await sql`select to_regclass('auth.users') is not null as has`;
    if (!has) { log('applying the Supabase emulation'); await run(path.join(ROOT, 'test', 'db', 'support', 'supabase-emulation.sql')); }
    for (const f of migrationFiles()) { log('migration ' + path.basename(f)); await run(f); }
    await sql.unsafe(`alter role elvar_app password '${APP_ROLE_PASSWORD}'`).simple();
  } finally { await sql.end({ timeout: 5 }); }
}

/** The same server and database, connected as elvar_app. */
export function appUrlFrom(adminUrl) { const u = new URL(adminUrl); u.username = 'elvar_app'; u.password = APP_ROLE_PASSWORD; return u.toString(); }
