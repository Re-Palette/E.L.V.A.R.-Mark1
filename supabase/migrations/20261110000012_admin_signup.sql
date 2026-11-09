-- P2 / migration 12: sign-up controls (the Auth hook), the minimal admin functions, usage recording, and the account-deletion steps.
-- docs/ELVAR_MULTIUSER.md sections 2.1, 2.4, 6.1, 7.4 and decisions M11 (admins see metadata only), O3 (immediate or 7-day grace).
--
-- * Three platform tables (no user data): platform_config (sign-up policy and limits), blocked_email_domains, signup_invites. No policy, no grant: only
--   the definer functions below read them. The operator edits them in the Supabase SQL editor.
-- * app.before_user_created(event): the Supabase Auth hook "Before User Created". It runs for e-mail sign-ups AND for Google sign-ups. Executable by
--   supabase_auth_admin only. Configure it in supabase/config.toml ([auth.hook.before_user_created]) or the dashboard.
-- * Admin functions never return anything that is content or a secret: e-mail, dates, status, quota and numbers (M11). They check app.is_admin() themselves.

create table app.platform_config (
  key text primary key check (key ~ '^[a-z_]{1,40}$'),
  value text not null check (length(value) <= 500),
  updated_at timestamptz not null default now()
);
select app._secure('platform_config', '', false);
insert into app.platform_config (key, value) values ('signup_mode', 'open'), ('daily_signup_limit', '500');   -- signup_mode: open | invite | closed

create table app.blocked_email_domains (
  domain text primary key check (domain = lower(domain) and length(domain) between 3 and 100)
);
select app._secure('blocked_email_domains', '', false);
insert into app.blocked_email_domains (domain) values
  ('mailinator.com'), ('guerrillamail.com'), ('guerrillamail.net'), ('guerrillamail.org'), ('sharklasers.com'), ('10minutemail.com'), ('10minutemail.net'),
  ('tempmail.com'), ('temp-mail.org'), ('temp-mail.io'), ('throwawaymail.com'), ('yopmail.com'), ('yopmail.net'), ('trashmail.com'), ('trashmail.net'),
  ('getnada.com'), ('nada.email'), ('maildrop.cc'), ('dispostable.com'), ('fakeinbox.com'), ('mintemail.com'), ('mohmal.com'), ('emailondeck.com'),
  ('spamgourmet.com'), ('tempinbox.com'), ('burnermail.io'), ('discard.email'), ('mailnesia.com'), ('moakt.com'), ('tmpmail.org'), ('tmpmail.net'),
  ('mail.tm'), ('1secmail.com'), ('1secmail.net'), ('1secmail.org'), ('anonbox.net'), ('spambox.us'), ('tempr.email'), ('byom.de');

create table app.signup_invites (                -- used when signup_mode = 'invite'
  email text primary key check (email = lower(email) and length(email) <= 320),
  created_at timestamptz not null default now()
);
select app._secure('signup_invites', '', false);

-- ------------------------------------------------------------------------------------------------------ the Auth hook
create or replace function app.before_user_created(event jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  em text := lower(btrim(coalesce(event -> 'user' ->> 'email', '')));
  dom text;
  mode text;
  lim int;
  deny jsonb;
begin
  if em = '' or position('@' in em) < 2 then
    return jsonb_build_object('error', jsonb_build_object('message', 'An e-mail address is required to sign up.', 'http_code', 400));
  end if;
  dom := split_part(em, '@', 2);
  select value into mode from app.platform_config where key = 'signup_mode';
  mode := coalesce(mode, 'open');
  if mode = 'closed' then
    return jsonb_build_object('error', jsonb_build_object('message', 'Sign-up is closed.', 'http_code', 403));
  end if;
  if mode = 'invite' and not exists (select 1 from app.signup_invites where email = em) then
    return jsonb_build_object('error', jsonb_build_object('message', 'Sign-up is by invitation only.', 'http_code', 403));
  end if;
  if exists (select 1 from app.blocked_email_domains b where dom = b.domain or dom like '%.' || b.domain) then
    return jsonb_build_object('error', jsonb_build_object('message', 'Disposable e-mail addresses cannot be used.', 'http_code', 400));
  end if;
  begin select value::int into lim from app.platform_config where key = 'daily_signup_limit'; exception when others then lim := null; end;
  if lim is not null and lim >= 0 and (select count(*) from auth.users u where u.created_at > now() - interval '1 day') >= lim then
    return jsonb_build_object('error', jsonb_build_object('message', 'Too many sign-ups today. Please try again tomorrow.', 'http_code', 429));
  end if;
  return '{}'::jsonb;
end $$;
revoke all on function app.before_user_created(jsonb) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema app to supabase_auth_admin;
    grant execute on function app.before_user_created(jsonb) to supabase_auth_admin;
  end if;
end $$;

-- ------------------------------------------------------------------------------------------------------ usage recording (docs 6.1)
-- The signed-in user's own numbers, written only through here. Bounded (one call cannot record a huge amount).
create or replace function app.record_usage(p_provider text, p_metric text, p_amount numeric, p_source text default 'server') returns void
language plpgsql security definer set search_path = pg_catalog, app as $$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_provider is null or length(p_provider) not between 1 and 40 or p_metric is null or length(p_metric) not between 1 and 40
     or p_amount is null or p_amount < 0 or p_amount > 1000000000 or p_source not in ('server', 'client') then
    raise exception 'record_usage: bad value' using errcode = '22023';
  end if;
  insert into app.accounts (user_id) values (auth.uid()) on conflict (user_id) do nothing;
  insert into app.usage_events (user_id, provider, metric, amount, source) values (auth.uid(), p_provider, p_metric, p_amount, p_source);
  insert into app.usage_daily (user_id, day, provider, metric, amount) values (auth.uid(), current_date, p_provider, p_metric, p_amount)
    on conflict (user_id, day, provider, metric) do update set amount = app.usage_daily.amount + excluded.amount;
end $$;
revoke all on function app.record_usage(text, text, numeric, text) from public, anon;
grant execute on function app.record_usage(text, text, numeric, text) to authenticated;

-- ------------------------------------------------------------------------------------------------------ account deletion (docs 7.4, O3)
-- Step 1, for the caller only: the account becomes pending_deletion and the request is recorded. p_grace 0 = purge now, 7 = a week during which signing in
-- offers to cancel. The server then signs the user out everywhere, revokes the devices, and (grace 0) runs the purge job.
create or replace function app.request_deletion(p_grace smallint, p_email text default null) returns timestamptz
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  due timestamptz;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_grace is null or p_grace not in (0, 7) then raise exception 'request_deletion: grace must be 0 or 7' using errcode = '22023'; end if;
  insert into app.accounts (user_id) values (auth.uid()) on conflict (user_id) do nothing;
  select purge_after into due from app.deletion_requests where user_id = auth.uid();
  if due is not null then return due; end if;                 -- already requested: keep the first decision
  due := now() + make_interval(days => p_grace);
  insert into app.deletion_requests (user_id, grace_days, purge_after, email_for_receipt, requested_at) values (auth.uid(), p_grace, due, nullif(left(p_email, 320), ''), now());
  update app.accounts set status = 'pending_deletion' where user_id = auth.uid();
  insert into app.audit_log (user_id, actor, actor_id, action, meta) values (auth.uid(), 'user', auth.uid(), 'account.delete_requested', jsonb_build_object('grace_days', p_grace));
  return due;
end $$;
revoke all on function app.request_deletion(smallint, text) from public, anon;
grant execute on function app.request_deletion(smallint, text) to authenticated;

-- Cancel during the grace period. Only for the caller, only while the request has a grace period (an immediate deletion cannot be undone).
create or replace function app.cancel_deletion() returns boolean
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  n int;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  delete from app.deletion_requests where user_id = auth.uid() and grace_days > 0 and purge_after > now();
  get diagnostics n = row_count;
  if n = 0 then return false; end if;
  update app.accounts set status = 'active' where user_id = auth.uid() and status = 'pending_deletion';
  insert into app.audit_log (user_id, actor, actor_id, action) values (auth.uid(), 'user', auth.uid(), 'account.delete_cancelled');
  return true;
end $$;
revoke all on function app.cancel_deletion() from public, anon;
grant execute on function app.cancel_deletion() to authenticated;

-- ------------------------------------------------------------------------------------------------------ admin (M11): metadata only
create or replace function app.admin_users(p_limit int default 100, p_offset int default 0)
returns table (user_id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz, status text, is_admin boolean,
               storage_quota_bytes bigint, storage_used_bytes bigint, calls_today numeric, live_seconds_today numeric, calls_30d numeric)
language plpgsql stable security definer set search_path = pg_catalog, app as $$
begin
  if not app.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 or p_offset is null or p_offset < 0 then raise exception 'admin_users: bad paging' using errcode = '22023'; end if;
  return query
    select u.id, u.email::text, u.created_at, u.last_sign_in_at, coalesce(a.status, 'active'),
           exists (select 1 from app.admins ad where ad.user_id = u.id),
           coalesce(a.storage_quota_bytes, 524288000),
           coalesce(s.files_bytes + s.text_bytes + s.notes_bytes + s.messages_bytes, 0)::bigint,
           coalesce((select sum(d.amount) from app.usage_daily d where d.user_id = u.id and d.day = current_date and d.metric = 'calls'), 0),
           coalesce((select sum(d.amount) from app.usage_daily d where d.user_id = u.id and d.day = current_date and d.metric = 'live_seconds'), 0),
           coalesce((select sum(d.amount) from app.usage_daily d where d.user_id = u.id and d.day > current_date - 30 and d.metric = 'calls'), 0)
    from auth.users u
    left join app.accounts a on a.user_id = u.id
    left join app.storage_usage s on s.user_id = u.id
    order by u.created_at desc, u.id
    limit p_limit offset p_offset;
end $$;
revoke all on function app.admin_users(int, int) from public, anon;
grant execute on function app.admin_users(int, int) to authenticated;

-- Suspend / lift. Not for admins (including oneself), not for an account that is being deleted. The action is recorded in the target's audit log
-- (actor 'admin', actor_id = the admin): the user can see that and who.
create or replace function app.admin_set_status(p_user uuid, p_status text, p_reason text default null) returns text
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  cur text;
begin
  if not app.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('active', 'suspended') then raise exception 'admin_set_status: bad status' using errcode = '22023'; end if;
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'not_found' using errcode = 'P0002'; end if;
  if exists (select 1 from app.admins where user_id = p_user) then raise exception 'cannot_change_admin' using errcode = '42501'; end if;
  insert into app.accounts (user_id) values (p_user) on conflict (user_id) do nothing;
  select status into cur from app.accounts where user_id = p_user for update;
  if cur = 'pending_deletion' then raise exception 'pending_deletion' using errcode = '55000'; end if;
  update app.accounts set status = p_status, suspended_reason = case when p_status = 'suspended' then nullif(left(p_reason, 500), '') else null end where user_id = p_user;
  insert into app.audit_log (user_id, actor, actor_id, action, meta)
    values (p_user, 'admin', auth.uid(), case when p_status = 'suspended' then 'account.suspended' else 'account.unsuspended' end, jsonb_build_object('reason', nullif(left(p_reason, 200), '')));
  return p_status;
end $$;
revoke all on function app.admin_set_status(uuid, text, text) from public, anon;
grant execute on function app.admin_set_status(uuid, text, text) to authenticated;

-- ------------------------------------------------------------------------------------------------------ cron / purge helpers (elvar_app only)
create or replace function app.due_deletions(p_limit int default 20) returns table (user_id uuid, grace_days smallint)
language sql stable security definer set search_path = pg_catalog, app as $$
  select d.user_id, d.grace_days from app.deletion_requests d where d.purge_after <= now() order by d.purge_after limit greatest(1, least(coalesce(p_limit, 20), 200));
$$;
revoke all on function app.due_deletions(int) from public, anon, authenticated;
grant execute on function app.due_deletions(int) to elvar_app;

create or replace function app.record_deletion_receipt(p_tables int) returns void
language sql security definer set search_path = pg_catalog, app as $$
  insert into app.deletion_receipts (tables_checked) values (greatest(0, p_tables));
$$;
revoke all on function app.record_deletion_receipt(int) from public, anon, authenticated;
grant execute on function app.record_deletion_receipt(int) to elvar_app;

-- The first admin: the confirmed account whose e-mail equals ELVAR_BOOTSTRAP_ADMIN_EMAIL. Returns its id (the server then sets the signed claim
-- app_metadata.elvar_role = 'admin' through the Auth admin API), or null if there is no such confirmed account.
create or replace function app.bootstrap_admin(p_email text) returns uuid
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  uid uuid;
begin
  select u.id into uid from auth.users u where lower(u.email) = lower(btrim(p_email)) and u.email_confirmed_at is not null limit 1;
  if uid is null then return null; end if;
  insert into app.accounts (user_id) values (uid) on conflict (user_id) do nothing;
  insert into app.admins (user_id, granted_by) values (uid, null) on conflict (user_id) do nothing;
  return uid;
end $$;
revoke all on function app.bootstrap_admin(text) from public, anon, authenticated;
grant execute on function app.bootstrap_admin(text) to elvar_app;
