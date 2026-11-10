-- P6 / migration 18: usage metering by the user's own day, admin hard limits per user, the admin usage view, and the retention of raw usage events
-- (docs/ELVAR_MULTIUSER.md 5.2, 6.1, 6.3, 2.4 / M11). Principle 6: usage is counted per user, limits are set per user (soft: by the user; hard: by an admin).
--
--   record_usage(.., p_day)   the day a count belongs to is the USER'S day (the server passes the date in the user's time zone; the default stays the database date).
--                             Only today and yesterday of the database clock are accepted, so a caller cannot write into an old or a far future day.
--   admin_set_limits          the hard limits of ONE user (numbers only; a key that is not in the catalog is refused; null removes a limit). Recorded in the target's own audit log.
--   admin_user_usage          that user's usage per day, provider and metric (numbers only: no content, no secrets; the per-tool counts are not shown to an admin)
--   admin_users               now also returns the hard limits and the reason of a suspension
--   purge_expired             + raw usage events older than 90 days and daily totals older than 2 years (usage_events -> usage_daily keeps the rollup)

-- ------------------------------------------------------------------------------------------------------ record_usage with the user's own day
drop function app.record_usage(text, text, numeric, text);
create function app.record_usage(p_provider text, p_metric text, p_amount numeric, p_source text default 'server', p_day date default null) returns void
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  d date := coalesce(p_day, current_date);
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_provider is null or length(p_provider) not between 1 and 40 or p_metric is null or length(p_metric) not between 1 and 40
     or p_amount is null or p_amount < 0 or p_amount > 1000000000 or p_source not in ('server', 'client')
     or d < current_date - 1 or d > current_date + 1 then
    raise exception 'record_usage: bad value' using errcode = '22023';
  end if;
  insert into app.accounts (user_id) values (auth.uid()) on conflict (user_id) do nothing;
  insert into app.usage_events (user_id, provider, metric, amount, source) values (auth.uid(), p_provider, p_metric, p_amount, p_source);
  insert into app.usage_daily (user_id, day, provider, metric, amount) values (auth.uid(), d, p_provider, p_metric, p_amount)
    on conflict (user_id, day, provider, metric) do update set amount = app.usage_daily.amount + excluded.amount;
end $$;
revoke all on function app.record_usage(text, text, numeric, text, date) from public, anon;
grant execute on function app.record_usage(text, text, numeric, text, date) to authenticated;

-- ------------------------------------------------------------------------------------------------------ admin: hard limits of one user
-- The catalog of keys (server/usage-limits.js has the same list; test/usage-limits.test.mjs compares them). Values are whole numbers 0 .. 2,000,000,000; maxFileBytes
-- can only lower the 60 MB per-file limit (O1).
create function app.admin_set_limits(p_user uuid, p_limits jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  allowed text[] := array['maxFileBytes', 'requestsPerMinute', 'liveTokensPerHour', 'connectorCallsPerDay', 'exportsPerDay', 'maxConnectors', 'maxNotes',
                          'geminiCallsPerDay', 'groqCallsPerDay', 'exaCallsPerDay', 'newsdataCallsPerDay', 'sarashinaCallsPerDay', 'googleCallsPerDay'];
  cur jsonb; nxt jsonb; k text; v jsonb;
begin
  if not app.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_limits is null or jsonb_typeof(p_limits) <> 'object' or (select count(*) from jsonb_object_keys(p_limits)) > 20 then raise exception 'admin_set_limits: bad value' using errcode = '22023'; end if;
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'not_found' using errcode = 'P0002'; end if;
  insert into app.accounts (user_id) values (p_user) on conflict (user_id) do nothing;
  select hard_limits into cur from app.accounts where user_id = p_user for update;
  nxt := cur;
  for k, v in select * from jsonb_each(p_limits) loop
    if not (k = any (allowed)) then raise exception 'admin_set_limits: unknown limit' using errcode = '22023'; end if;
    if jsonb_typeof(v) = 'null' then nxt := nxt - k;
    elsif jsonb_typeof(v) = 'number' and v::text ~ '^[0-9]{1,10}$' and v::text::bigint <= 2000000000 and (k <> 'maxFileBytes' or v::text::bigint <= 62914560) then nxt := nxt || jsonb_build_object(k, v);
    else raise exception 'admin_set_limits: bad value' using errcode = '22023'; end if;
  end loop;
  update app.accounts set hard_limits = nxt where user_id = p_user;
  insert into app.audit_log (user_id, actor, actor_id, action, meta) values (p_user, 'admin', auth.uid(), 'account.limits_changed', jsonb_build_object('from', cur, 'to', nxt));
  return nxt;
end $$;
revoke all on function app.admin_set_limits(uuid, jsonb) from public, anon;
grant execute on function app.admin_set_limits(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------------------------------------------------ admin: one user's usage numbers
create function app.admin_user_usage(p_user uuid, p_days int default 14) returns table (day date, provider text, metric text, amount numeric)
language plpgsql stable security definer set search_path = pg_catalog, app as $$
begin
  if not app.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_days is null or p_days < 1 or p_days > 60 then raise exception 'admin_user_usage: bad value' using errcode = '22023'; end if;
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'not_found' using errcode = 'P0002'; end if;
  return query select d.day, d.provider, d.metric, d.amount from app.usage_daily d
    where d.user_id = p_user and d.day > current_date - p_days and d.provider <> 'tool' order by d.day, d.provider, d.metric;
end $$;
revoke all on function app.admin_user_usage(uuid, int) from public, anon;
grant execute on function app.admin_user_usage(uuid, int) to authenticated;

-- ------------------------------------------------------------------------------------------------------ admin: the list now carries the hard limits
drop function app.admin_users(int, int);
create function app.admin_users(p_limit int default 100, p_offset int default 0)
returns table (user_id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz, status text, is_admin boolean,
               storage_quota_bytes bigint, storage_used_bytes bigint, calls_today numeric, live_seconds_today numeric, calls_30d numeric,
               hard_limits jsonb, suspended_reason text)
language plpgsql stable security definer set search_path = pg_catalog, app as $$
begin
  if not app.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 or p_offset is null or p_offset < 0 then raise exception 'admin_users: bad paging' using errcode = '22023'; end if;
  return query
    select u.id, u.email::text, u.created_at, u.last_sign_in_at, coalesce(a.status, 'active'),
           exists (select 1 from app.admins ad where ad.user_id = u.id),
           coalesce(a.storage_quota_bytes, 524288000),
           coalesce(s.files_bytes + s.text_bytes + s.notes_bytes + s.messages_bytes, 0)::bigint,
           -- "today": the user's latest day inside the database date +-1 (their own time zone decides which of the three it is)
           coalesce((select sum(d.amount) from app.usage_daily d where d.user_id = u.id and d.metric = 'calls' and d.provider <> 'tool'
                     and d.day = (select max(x.day) from app.usage_daily x where x.user_id = u.id and x.day between current_date - 1 and current_date + 1)), 0),
           coalesce((select sum(d.amount) from app.usage_daily d where d.user_id = u.id and d.metric = 'live_seconds'
                     and d.day = (select max(x.day) from app.usage_daily x where x.user_id = u.id and x.day between current_date - 1 and current_date + 1)), 0),
           coalesce((select sum(d.amount) from app.usage_daily d where d.user_id = u.id and d.day > current_date - 30 and d.metric = 'calls' and d.provider <> 'tool'), 0),
           coalesce(a.hard_limits, '{}'::jsonb), a.suspended_reason
    from auth.users u
    left join app.accounts a on a.user_id = u.id
    left join app.storage_usage s on s.user_id = u.id
    order by u.created_at desc, u.id
    limit p_limit offset p_offset;
end $$;
revoke all on function app.admin_users(int, int) from public, anon;
grant execute on function app.admin_users(int, int) to authenticated;

-- ------------------------------------------------------------------------------------------------------ retention of usage rows
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
  delete from app.usage_events where at <= now() - interval '90 days'; get diagnostics c = row_count; table_name := 'usage_events'; deleted := c; return next;
  delete from app.usage_daily where day <= current_date - 730; get diagnostics c = row_count; table_name := 'usage_daily'; deleted := c; return next;
end $$;
revoke all on function app.purge_expired() from public, anon, authenticated;
grant execute on function app.purge_expired() to elvar_app;
