-- Review fix (P2 follow-up): the sign-up policy has ONE source (app.platform_config, which the Auth hook enforces and /api/elvar/state now reads), and the daily
-- cap has a per-address part: at most `ip_daily_signup_limit` (default 5) sign-ups per network per day, counted from a salted hash of the address the Auth hook
-- is given (event.metadata.ip_address); the hashes are kept two days. Needs the hook to be enabled: supabase/config.toml [auth.hook.before_user_created]
-- (local) or Authentication > Hooks > Before User Created > Postgres function app.before_user_created (a hosted project: dashboard step, supabase/README.md).

create table app.signup_attempts (
  ip_hash text not null check (length(ip_hash) = 64),
  at timestamptz not null default now()
);
create index signup_attempts_ip on app.signup_attempts (ip_hash, at);
select app._secure('signup_attempts', '', false);
insert into app.platform_config (key, value) values ('ip_daily_signup_limit', '5') on conflict (key) do nothing;

create or replace function app.before_user_created(event jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  em text := lower(btrim(coalesce(event -> 'user' ->> 'email', '')));
  dom text;
  mode text;
  lim int;
  deny jsonb;
  ip text := nullif(btrim(coalesce(event -> 'metadata' ->> 'ip_address', '')), '');
  ip_lim int;
  v_ip_hash text;
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
  -- per address: the daily cap is not only a global number (one script could use it all up). The address is kept as a hash, for two days.
  if ip is not null then
    v_ip_hash := encode(sha256(convert_to('elvar-signup-ip|' || ip, 'UTF8')), 'hex');
    begin select value::int into ip_lim from app.platform_config where key = 'ip_daily_signup_limit'; exception when others then ip_lim := null; end;
    if ip_lim is not null and ip_lim >= 0 and (select count(*) from app.signup_attempts s where s.ip_hash = v_ip_hash and s.at > now() - interval '1 day') >= ip_lim then
      return jsonb_build_object('error', jsonb_build_object('message', 'Too many sign-ups from this network today. Please try again tomorrow.', 'http_code', 429));
    end if;
    insert into app.signup_attempts (ip_hash) values (v_ip_hash);
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

-- What /api/elvar/state tells the sign-in screens: the same value the hook enforces.
create function app.platform_signup_mode() returns text
language sql stable security definer set search_path = pg_catalog, app as $$ select coalesce((select value from app.platform_config where key = 'signup_mode'), 'open') $$;
revoke all on function app.platform_signup_mode() from public, anon, authenticated;
grant execute on function app.platform_signup_mode() to elvar_app;

create or replace function app.purge_expired() returns table (table_name text, deleted bigint)
language plpgsql security definer set search_path = pg_catalog, app as $$
declare c bigint;
begin
  delete from app.kv_ephemeral where expires_at <= now(); get diagnostics c = row_count; table_name := 'kv_ephemeral'; deleted := c; return next;
  delete from app.rate_limits where expires_at <= now(); get diagnostics c = row_count; table_name := 'rate_limits'; deleted := c; return next;
  delete from app.ticket_uses where exp <= now(); get diagnostics c = row_count; table_name := 'ticket_uses'; deleted := c; return next;
  delete from app.oauth_pending where expires_at <= now(); get diagnostics c = row_count; table_name := 'oauth_pending'; deleted := c; return next;
  delete from app.notif_items where at <= now() - interval '3 days'; get diagnostics c = row_count; table_name := 'notif_items'; deleted := c; return next;
  delete from app.note_revisions where at <= now() - interval '90 days'; get diagnostics c = row_count; table_name := 'note_revisions'; deleted := c; return next;
  delete from app.notes where deleted_at is not null and deleted_at <= now() - interval '30 days'; get diagnostics c = row_count; table_name := 'notes'; deleted := c; return next;
  delete from app.messages m using (
      select u.user_id, case when s.settings->>'MESSAGE_RETENTION_DAYS' ~ '^[0-9]{1,5}$' then (s.settings->>'MESSAGE_RETENTION_DAYS')::int else 180 end as days
      from (select distinct x.user_id from app.messages x) u left join app.settings s on s.user_id = u.user_id) r
    where r.user_id = m.user_id and r.days > 0 and m.at < now() - make_interval(days => r.days);
  get diagnostics c = row_count; table_name := 'messages'; deleted := c; return next;
  delete from app.signup_attempts where at < now() - interval '2 days';
  delete from app.conversations v where v.last_at < now() - interval '1 day'
    and not exists (select 1 from app.messages m where m.user_id = v.user_id and m.conversation_id = v.id);
  get diagnostics c = row_count; table_name := 'conversations'; deleted := c; return next;
end $$;
revoke all on function app.purge_expired() from public, anon, authenticated;
grant execute on function app.purge_expired() to elvar_app;
