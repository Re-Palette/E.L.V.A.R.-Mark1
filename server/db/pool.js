// The Postgres connection and the per-request identity switch (docs/ELVAR_MULTIUSER.md section 3.2).
//
//   createPgDb(url)  -> { kind:'pg', asUser(verifiedUid, fn), system, ping(), close() }
//
// The server connects as the role `elvar_app` (through Supavisor in transaction mode in production: no prepared statements, few connections).
// elvar_app has no privilege on any table. asUser() runs `fn` inside ONE transaction that first sets request.jwt.claims and does
// `set local role authenticated`, so Row Level Security applies to every statement; both settings are transaction-local, they cannot leak to the
// next request on the same pooled connection. After switching, the identity is read back and compared (fail closed: any mismatch aborts the transaction).
// This is the only module that imports the driver or reads ELVAR_DB_URL (test/service-role-usage.test.mjs).
import postgres from 'postgres';
import { dbError, mapPgError, isDriverError } from './errors.js';
import { requireVerifiedUid } from './verified-uid.js';
import { pgRepos, pgSystem } from './repos/pg.js';

/** The identity read back after the switch must be the authenticated role acting as exactly this user. */
export function assertSwitched(row, uid) {
  if (!row || row.role !== 'authenticated' || row.uid !== uid) throw dbError('identity_not_switched', 500);
}

const STATEMENT_TIMEOUT_MS = 8000, IDLE_TX_TIMEOUT_MS = 15000;

/** Switch the current transaction to `authenticated` acting as `uid`. Must be the first thing a request does in its transaction. */
export async function switchToUser(tx, uid) {
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true),
                  set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true),
                  set_config('idle_in_transaction_session_timeout', ${String(IDLE_TX_TIMEOUT_MS)}, true)`;
  await tx`set local role authenticated`;
  const [row] = await tx`select current_user::text as role, auth.uid()::text as uid`;
  assertSwitched(row, uid);
}

export function createPgDb(url, opts = {}) {
  if (!url || !/^postgres(ql)?:\/\//.test(url)) throw dbError('db_url_invalid', 500);
  const sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20, max_lifetime: 60 * 30, connect_timeout: 10, onnotice: () => {}, ...opts });
  return {
    kind: 'pg',
    async asUser(vuid, fn) {
      const uid = requireVerifiedUid(vuid);
      try {
        return await sql.begin(async (tx) => { await switchToUser(tx, uid); return fn(pgRepos(tx, uid)); });
      } catch (e) { throw isDriverError(e) ? mapPgError(e) : e; }
    },
    system: pgSystem(sql),
    async ping() { try { await sql`select 1`; return true; } catch { return false; } },
    async close() { await sql.end({ timeout: 5 }); },
  };
}
