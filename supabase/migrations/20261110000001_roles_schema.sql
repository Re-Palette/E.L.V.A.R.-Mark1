-- P1 / migration 01: the private schema `app`, the server's database role, and the one helper every user table goes through.
-- docs/ELVAR_MULTIUSER.md sections 3.1 and 3.2.
--
-- * Every user table lives in schema `app`. Supabase's Data API (PostgREST) only exposes `public` and `graphql_public` (supabase/config.toml),
--   so a browser holding the anon key and its own JWT has no way to reach these tables: all access goes through the server.
-- * The server connects as `elvar_app` (login, NOINHERIT, NOBYPASSRLS, owns nothing, no privileges on any table). A request runs inside one
--   transaction that does `set local role authenticated` after setting `request.jwt.claims`; from there Row Level Security applies.
--   If the server forgets either step it fails closed: no switch -> "permission denied", no claims -> auth.uid() is null -> zero rows.
-- * Extensions pgroonga, vector and pg_cron are created by the later migrations that need them (notes 05, memory 08, cron 13), not here.

create schema if not exists app;
revoke all on schema app from public;
revoke all on schema app from anon;
grant usage on schema app to authenticated;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'elvar_app') then
    create role elvar_app login noinherit nobypassrls nosuperuser nocreatedb nocreaterole noreplication;
  end if;
end $$;
-- The password is never in a migration: the operator runs `alter role elvar_app password '...'` once and puts the connection string in ELVAR_DB_URL.
grant authenticated to elvar_app;          -- the only thing elvar_app may do with tables: `set role authenticated`
grant usage on schema app to elvar_app;    -- needed to call the few helper functions it may execute (rate limit, purge, residual check, device lookup)

-- app._secure(table, ops): the single way a user table is locked down, so no table can be added half-configured.
--   * requires a user_id column (the owner of every row)
--   * enables AND forces row level security, removes every grant from public / anon / authenticated
--   * grants exactly `ops` (a subset of select,insert,update,delete) to `authenticated`, each behind the standard own-row policy:
--         using / with check (user_id = (select auth.uid()))        -- the select form lets the planner evaluate it once
--   p_owned = false is only for platform tables that hold no user data (the registry itself, deletion receipts).
--   An empty ops list leaves the table with no policy and no grant: nothing but definer functions and the table owner can touch it.
-- Called by migrations only; nobody else may execute it.
create or replace function app._secure(p_table text, p_ops text default '', p_owned boolean default true)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  op text;
  ops text[] := coalesce(string_to_array(nullif(p_ops, ''), ','), '{}');
  tbl text := format('app.%I', p_table);
begin
  if p_owned and not exists (select 1 from pg_attribute where attrelid = tbl::regclass and attname = 'user_id' and not attisdropped) then
    raise exception 'app._secure: % has no user_id column', tbl;
  end if;
  if not p_owned and cardinality(ops) > 0 then raise exception 'app._secure: a table without user_id cannot get user policies'; end if;
  execute format('alter table %s enable row level security', tbl);
  execute format('alter table %s force row level security', tbl);
  execute format('revoke all on table %s from public, anon, authenticated', tbl);
  foreach op in array ops loop
    if op not in ('select', 'insert', 'update', 'delete') then raise exception 'app._secure: bad op %', op; end if;
    execute format('grant %s on table %s to authenticated', op, tbl);
    if op = 'select' then
      execute format('create policy own_select on %s for select to authenticated using (user_id = (select auth.uid()))', tbl);
    elsif op = 'insert' then
      execute format('create policy own_insert on %s for insert to authenticated with check (user_id = (select auth.uid()))', tbl);
    elsif op = 'update' then
      execute format('create policy own_update on %s for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', tbl);
    else
      execute format('create policy own_delete on %s for delete to authenticated using (user_id = (select auth.uid()))', tbl);
    end if;
  end loop;
end $$;
revoke all on function app._secure(text, text, boolean) from public, anon, authenticated;
