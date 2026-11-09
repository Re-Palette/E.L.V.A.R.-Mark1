# supabase/

Database of the multi-user platform (design: `docs/ELVAR_MULTIUSER.md`; principles: `CLAUDE.md`). Phase P1 contains the foundations only; the app
still signs in the old single-owner way until P2.

```
config.toml            Supabase CLI config (the Data API exposes public + graphql_public, never app)
migrations/            applied in file-name order
  ..01_roles_schema    schema app, role elvar_app, the app._secure() helper every user table goes through
  ..02_accounts        accounts, admins, profiles, settings, user_keys, user_secrets, devices, audit_log, data_registry, ensure_account / is_admin / device_lookup
  ..03_ephemeral       kv_ephemeral, rate_limits, ticket_uses, oauth_pending, rl_hit(), purge_expired()
  ..09_usage_quota     usage_events, usage_daily, usage_limits, storage_usage (tables only)
  ..11_jobs_rights     export_jobs, deletion_requests, deletion_receipts, residual_check()
```
(The numbers follow the plan in section 5 of the design; 04-08, 10, 12, 13 arrive with their phases.)

## One-time setup of a project

1. Apply the migrations (`supabase db push`, or paste them in order into the SQL editor).
2. Give the server role a password and build its connection string (Supavisor, transaction mode, port 6543):
   `alter role elvar_app password '<long random>';` then `ELVAR_DB_URL=postgres://elvar_app.<project-ref>:<password>@<pooler-host>:6543/postgres`.
3. Set `ELVAR_KEK` (see `.env.example`), `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `CRON_SECRET`, and `SUPABASE_SECRET_KEY` as Sensitive variables in Vercel.

## The rules every table follows

* Lives in schema `app`, has `user_id uuid not null default auth.uid() references auth.users (id) on delete cascade`, and is locked with
  `select app._secure('<table>', 'select,insert,...')` (RLS enabled and forced, no grants to anon/public, the standard own-row policies).
* Has a row in `app.data_registry` (inserted by the migration that creates the table) **and** the same entry in `server/rights/registry.js`:
  export file, columns that never leave the database, whether the user may edit it, and a fixture INSERT for `{{uid}}`.
* Composite keys and indexes start with `user_id`; a child table references its parent with `(user_id, parent_id)`.

The tests enforce all of it: `npm test` runs `test/migrations-lint.test.mjs` (static) and the in-memory contract; `npm run test:db` migrates a throw-away
Postgres and runs the catalog tests, the generated two-user isolation tests, the deletion check and the same contract against the real layer.

## Running the database tests

`npm run test:db` starts `postgres:16` in Docker (override with `ELVAR_TEST_DB_IMAGE`), applies `test/db/support/supabase-emulation.sql` (roles, `auth.users`,
`auth.uid()`, a minimal `storage`), the migrations, and runs `test/db/*.test.mjs`. To use an existing disposable database instead, set
`ELVAR_TEST_DB_ADMIN_URL` (superuser URL; schema `app` is dropped and recreated; on a real `supabase start` database the emulation is skipped).
