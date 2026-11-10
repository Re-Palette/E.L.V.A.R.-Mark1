-- P8 review round 2 / migration 22: a global cap on the number of accounts (platform_config `max_accounts`, checked by the Auth hook next to the daily and per-address caps of
-- migrations 12 and 17). Unset = no ceiling. The operator sets it in the SQL editor: insert into app.platform_config (key, value) values ('max_accounts', '200') on conflict (key) do update set value = excluded.value;
-- The hook is the same function as before with this one extra check.

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
  max_acc int;
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
  -- a ceiling on the number of accounts of the whole platform (P8 abuse control; app.platform_config `max_accounts`, unset = no ceiling)
  begin select value::int into max_acc from app.platform_config where key = 'max_accounts'; exception when others then max_acc := null; end;
  if max_acc is not null and max_acc >= 0 and (select count(*) from auth.users) >= max_acc then
    return jsonb_build_object('error', jsonb_build_object('message', 'Sign-ups are full at the moment. Please try again later.', 'http_code', 403));
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
