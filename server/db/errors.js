// Errors of the database layer. `status` and `code` follow the convention of the router: < 500 is shown to the client as { error: code },
// anything else becomes "internal_error" (and 502/503 "store_unavailable"). Messages never contain row data.
export class DbError extends Error {
  constructor(code, status = 500, cause) { super(code); this.name = 'DbError'; this.code = code; this.status = status; if (cause) this.cause = cause; }
}
export const dbError = (code, status = 500, cause) => new DbError(code, status, cause);

/** Postgres / driver error -> DbError. Errors that already are DbErrors pass through. */
export function mapPgError(e) {
  if (e instanceof DbError) return e;
  const c = String(e?.code || '');
  if (c === '23505') return dbError('conflict', 409, e);                            // unique_violation
  if (c === '23514' || c === '22P02' || c === '22023' || c === '22001' || c === '22003' || c === '22007' || c === '22008') return dbError('invalid_value', 400, e); // check_violation, bad text / range / datetime
  if (c === '23502') return dbError('invalid_value', 400, e);                         // not_null_violation
  if (c === '23503') return dbError('invalid_reference', 409, e);                     // foreign_key_violation
  if (c === '42501') return dbError('forbidden', 403, e);                             // insufficient_privilege, also "violates row-level security policy"
  if (c === '57014') return dbError('db_timeout', 503, e);                            // statement_timeout
  if (c.startsWith('08') || c === '53300' || c === '57P01' || c === '57P03' || /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)/.test(c) || /^(CONNECT|CONNECTION)_/.test(c)) return dbError('db_unavailable', 503, e);
  return dbError('db_error', 500, e);
}

/** Is this an error that came from the Postgres driver (a server error, or a connection problem)? Errors thrown by our own code pass through asUser untouched. */
export const isDriverError = (e) => e?.name === 'PostgresError' || /^(CONNECTION_|CONNECT_|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UNDEFINED_VALUE|MAX_PARAMETERS)/.test(String(e?.code || ''));
