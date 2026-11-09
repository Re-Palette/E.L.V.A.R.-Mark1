-- P1 / migration 03: short-lived tables (docs section 5.1, M9): replaces Redis. Every row carries an expiry; app.purge_expired() removes the
-- expired ones (the schedule arrives with the cron migration, or Vercel Cron calls it through the server). No row outlives its user either:
-- user_id cascades, so even rate-limit rows are gone when the account is.

create table app.kv_ephemeral (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  key text not null check (length(key) between 1 and 200),
  value jsonb not null check (pg_column_size(value) <= 20000),
  expires_at timestamptz not null,
  primary key (user_id, key)
);
create index kv_ephemeral_expires on app.kv_ephemeral (expires_at);
select app._secure('kv_ephemeral', 'select,insert,update,delete');

-- Rate-limit counters in fixed windows. `who` is namespaced by app.rl_hit(): 'u:<user id>' for a signed-in caller (user_id is set too, so the row dies
-- with the account) or 'ip:<hash of the client address>' for a signed-out one. The two namespaces cannot collide, and a uuid-shaped value is never accepted
-- as an address hash, so no row that names a user can be created without user_id. Written only by app.rl_hit(); no user policy.
create table app.rate_limits (
  bucket text not null check (length(bucket) between 1 and 64),
  who text not null check (length(who) between 1 and 128),
  window_start timestamptz not null,
  n int not null default 0,
  user_id uuid references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  primary key (bucket, who, window_start)
);
create index rate_limits_user on app.rate_limits (user_id) where user_id is not null;
create index rate_limits_expires on app.rate_limits (expires_at);
select app._secure('rate_limits', '');

-- Used approval tickets (single use). The unique key makes "mark used" atomic: the second insert of a jti fails.
create table app.ticket_uses (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  jti text not null check (length(jti) between 1 and 100),
  exp timestamptz not null,
  primary key (user_id, jti)
);
create index ticket_uses_exp on app.ticket_uses (exp);
select app._secure('ticket_uses', 'select,insert');

-- OAuth flows in progress. A claim is answered only for the user who started it: the row is invisible to everyone else (RLS).
create table app.oauth_pending (
  state_hash bytea primary key check (octet_length(state_hash) = 32),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  sealed bytea not null check (octet_length(sealed) <= 8192),
  expires_at timestamptz not null
);
create index oauth_pending_user on app.oauth_pending (user_id);
create index oauth_pending_expires on app.oauth_pending (expires_at);
select app._secure('oauth_pending', 'select,insert,update,delete');

-- ------------------------------------------------------------------------------------------------------ functions (elvar_app only)

-- Count one hit in the current fixed window and return the new count; the caller compares it with its limit.
--   p_user given     -> who = 'u:' || p_user (p_who is ignored): the counter belongs to the account and is removed with it
--   p_user is null   -> who = 'ip:' || p_who; p_who must not look like a uuid (a signed-out caller cannot write into a user's counter or leave a row
--                       that names a user but is not tied to the account)
create or replace function app.rl_hit(p_bucket text, p_who text, p_window_secs int, p_user uuid default null) returns int
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  w timestamptz;
  c int;
  k text;
begin
  if p_window_secs is null or p_window_secs < 1 or p_window_secs > 86400 then raise exception 'rl_hit: bad window'; end if;
  if p_user is not null then
    k := 'u:' || p_user::text;
  else
    if p_who is null or length(p_who) < 1 or length(p_who) > 120 then raise exception 'rl_hit: bad who'; end if;
    if p_who ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' then raise exception 'rl_hit: a user id is not an address'; end if;
    k := 'ip:' || p_who;
  end if;
  w := to_timestamp(floor(extract(epoch from now()) / p_window_secs) * p_window_secs);
  insert into app.rate_limits as r (bucket, who, window_start, n, user_id, expires_at)
    values (p_bucket, k, w, 1, p_user, w + make_interval(secs => p_window_secs * 2))
    on conflict (bucket, who, window_start) do update set n = r.n + 1, user_id = coalesce(r.user_id, excluded.user_id)
    returning r.n into c;
  return c;
end $$;
revoke all on function app.rl_hit(text, text, int, uuid) from public, anon, authenticated;
grant execute on function app.rl_hit(text, text, int, uuid) to elvar_app;

-- Delete expired rows of the four short-lived tables. Returns how many per table.
create or replace function app.purge_expired() returns table (table_name text, deleted bigint)
language plpgsql security definer set search_path = pg_catalog, app as $$
declare c bigint;
begin
  delete from app.kv_ephemeral where expires_at <= now(); get diagnostics c = row_count; table_name := 'kv_ephemeral'; deleted := c; return next;
  delete from app.rate_limits where expires_at <= now(); get diagnostics c = row_count; table_name := 'rate_limits'; deleted := c; return next;
  delete from app.ticket_uses where exp <= now(); get diagnostics c = row_count; table_name := 'ticket_uses'; deleted := c; return next;
  delete from app.oauth_pending where expires_at <= now(); get diagnostics c = row_count; table_name := 'oauth_pending'; deleted := c; return next;
end $$;
revoke all on function app.purge_expired() from public, anon, authenticated;
grant execute on function app.purge_expired() to elvar_app;

-- ------------------------------------------------------------------------------------------------------ registry rows
insert into app.data_registry (table_name, export_as, export_exclude, editable, counts_storage, fixture_order, fixture_sql) values
  ('kv_ephemeral', 'none', '{}', false, false, 30, $f$insert into app.kv_ephemeral (user_id, key, value, expires_at) values ({{uid}}, 'fixture', '{"x":1}'::jsonb, now() + interval '1 hour')$f$),
  ('rate_limits',  'none', '{}', false, false, 30, $f$insert into app.rate_limits (bucket, who, window_start, n, user_id, expires_at) values ('fixture', 'u:' || {{uid}}::text, now(), 1, {{uid}}, now() + interval '1 hour')$f$),
  ('ticket_uses',  'none', '{}', false, false, 30, $f$insert into app.ticket_uses (user_id, jti, exp) values ({{uid}}, 'fixture-jti', now() + interval '1 hour')$f$),
  ('oauth_pending', 'none', '{}', false, false, 30, $f$insert into app.oauth_pending (state_hash, user_id, sealed, expires_at) values (sha256(convert_to('fixture-state-' || {{uid}}::text, 'UTF8')), {{uid}}, decode('00', 'hex'), now() + interval '1 hour')$f$);
