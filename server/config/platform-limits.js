// The platform-wide per-file limit (P8, docs/ELVAR_MULTIUSER.md 19). The source of truth is the database (app.platform_config `max_file_bytes`: reserve_file enforces it and a
// trigger keeps the Storage bucket's file_size_limit equal to it). The operator may set it there (SQL editor) or with the environment variable ELVAR_MAX_FILE_BYTES, which the
// daily cron (and the local dev stack at start) writes into the database. Default 60 MB (owner decision O1). On the Supabase Free plan the project-wide upload limit is 50 MB
// and a bucket limit cannot exceed it: migration 20 therefore starts the database at 52428800 (50 MB); raise it with ELVAR_MAX_FILE_BYTES on a paid plan.
export const DEFAULT_MAX_FILE_BYTES = 62914560, MIN_MAX_FILE_BYTES = 1048576, MAX_MAX_FILE_BYTES = 62914560;   // the ceiling is O1's 60 MB: app.files.size_bytes (migration 07) is checked at 60 MB, so a bigger limit could never be used

/** The value of ELVAR_MAX_FILE_BYTES clamped to the 60 MB ceiling, or null when it is unset, not an integer, or below 1 MB. */
export function envMaxFileBytes(env = process.env) {
  const s = String(env.ELVAR_MAX_FILE_BYTES ?? '').trim();
  if (!/^[0-9]{1,12}$/.test(s)) return null;
  const n = Number(s);
  return n >= MIN_MAX_FILE_BYTES ? Math.min(n, MAX_MAX_FILE_BYTES) : null;
}
