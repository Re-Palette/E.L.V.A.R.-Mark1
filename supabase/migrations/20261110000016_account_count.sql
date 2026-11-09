-- Review fix: "allow my private network" for connectors is only for a SINGLE-user install (ELVAR_ALLOW_PRIVATE_CONNECTORS=1). The server refuses it as soon as
-- a second account exists, so it can never be left on by accident on a shared platform. This returns how many accounts exist (a number, nothing else).
create function app.account_count() returns bigint
language sql stable security definer set search_path = pg_catalog, app as $$ select count(*) from app.accounts $$;
revoke all on function app.account_count() from public, anon, authenticated;
grant execute on function app.account_count() to elvar_app;
