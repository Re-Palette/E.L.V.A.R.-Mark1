-- P1 / migration 11 (skeleton): the data-rights tables and the deletion check (docs section 7). The export step and the purge job come later (P7);
-- what exists now is the structure they need and the check that proves a deletion left nothing behind.
-- Decision O3: the user chooses at deletion time, immediately (grace_days = 0) or after a 7-day grace period during which signing in cancels it.

create table app.export_jobs (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'expired')),
  cursor jsonb,
  parts int not null default 0,
  bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  error text check (error is null or length(error) <= 500),
  primary key (user_id, id)
);
select app._secure('export_jobs', 'select,insert');
-- the user can only ask for a job; progress fields are written by the server's export step through definer functions
create policy export_jobs_new_only on app.export_jobs as restrictive for insert to authenticated
  with check (status = 'queued' and parts = 0 and bytes = 0 and cursor is null and error is null);

create table app.deletion_requests (              -- one row while a deletion is pending; the purge job removes the account when purge_after passes
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  requested_at timestamptz not null default now(),
  grace_days smallint not null check (grace_days in (0, 7)),
  purge_after timestamptz not null,
  email_for_receipt text check (email_for_receipt is null or length(email_for_receipt) <= 320),
  check (purge_after >= requested_at)
);
select app._secure('deletion_requests', 'select');

-- What is left after a deletion carries no user id and no email: only that it happened and how many tables were verified clean.
create table app.deletion_receipts (
  id uuid primary key default gen_random_uuid(),
  completed_at timestamptz not null default now(),
  tables_checked int not null check (tables_checked >= 0)
);
select app._secure('deletion_receipts', '', false);

-- Rows still owned by p_user, per registered table (all zero after a deletion). The list of tables comes from app.data_registry, so a table
-- that is registered but cannot be counted raises an error instead of being skipped. elvar_app only.
create or replace function app.residual_check(p_user uuid) returns table (table_name text, n bigint)
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  r record;
  c bigint;
begin
  for r in select dr.table_name as t, dr.owner_column as o from app.data_registry dr order by dr.table_name loop
    if r.t = 'rate_limits' then
      -- a counter belongs to the user by its user_id AND by its key: a row that names the user in `who` but lost its user_id still counts as residue
      select count(*) into c from app.rate_limits where user_id = p_user or who in ('u:' || p_user::text, p_user::text);
    else
      execute format('select count(*) from app.%I where %I = $1', r.t, r.o) into c using p_user;
    end if;
    table_name := r.t; n := c; return next;
  end loop;
end $$;
revoke all on function app.residual_check(uuid) from public, anon, authenticated;
grant execute on function app.residual_check(uuid) to elvar_app;

insert into app.data_registry (table_name, export_as, export_exclude, editable, counts_storage, fixture_order, fixture_sql) values
  ('export_jobs', 'none', '{}', false, false, 30, $f$insert into app.export_jobs (user_id) values ({{uid}})$f$),
  ('deletion_requests', 'account.json', '{}', false, false, 30, $f$insert into app.deletion_requests (user_id, grace_days, purge_after) values ({{uid}}, 7, now() + interval '7 days')$f$);
