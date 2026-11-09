-- P1 / migration 09 (tables only): usage metering and storage accounting (docs sections 5.1, 6). The server is the source of truth; users read their
-- own numbers. Writes to events / daily / storage_usage come from definer functions added with the metering work (P6); the user may edit only
-- their own soft limits. Quota default (O1): accounts.storage_quota_bytes = 500 MB, set in migration 02.

create table app.usage_events (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id bigint generated always as identity,
  at timestamptz not null default now(),
  provider text not null check (length(provider) between 1 and 40),
  metric text not null check (length(metric) between 1 and 40),
  amount numeric not null check (amount >= 0),
  source text not null check (source in ('server', 'client')),
  meta jsonb check (meta is null or pg_column_size(meta) <= 4000),
  primary key (user_id, id)
);
create index usage_events_user_at on app.usage_events (user_id, at desc);
select app._secure('usage_events', 'select');

create table app.usage_daily (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day date not null,
  provider text not null check (length(provider) between 1 and 40),
  metric text not null check (length(metric) between 1 and 40),
  amount numeric not null default 0 check (amount >= 0),
  primary key (user_id, day, provider, metric)
);
select app._secure('usage_daily', 'select');

create table app.usage_limits (                   -- the user's own soft limits (warn or block); the user edits them
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  provider text not null check (length(provider) between 1 and 40),
  metric text not null check (length(metric) between 1 and 40),
  period text not null check (period in ('day', 'month')),
  soft numeric not null check (soft >= 0),
  soft_action text not null default 'warn' check (soft_action in ('warn', 'block')),
  primary key (user_id, provider, metric, period)
);
select app._secure('usage_limits', 'select,insert,update,delete');

create table app.storage_usage (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  files_bytes bigint not null default 0 check (files_bytes >= 0),
  text_bytes bigint not null default 0 check (text_bytes >= 0),
  notes_bytes bigint not null default 0 check (notes_bytes >= 0),
  messages_bytes bigint not null default 0 check (messages_bytes >= 0),
  reserved_bytes bigint not null default 0 check (reserved_bytes >= 0)
);
select app._secure('storage_usage', 'select');

-- storage_usage's fixture runs first (order 5): the triggers of migration 07 keep adding to the row as the other fixtures (notes, files ...) are inserted.
insert into app.data_registry (table_name, export_as, export_exclude, editable, counts_storage, fixture_order, fixture_sql) values
  ('usage_events', 'usage.json', '{}', false, false, 30, $f$insert into app.usage_events (user_id, provider, metric, amount, source) values ({{uid}}, 'gemini', 'calls', 1, 'server')$f$),
  ('usage_daily',  'usage.json', '{}', false, false, 30, $f$insert into app.usage_daily (user_id, day, provider, metric, amount) values ({{uid}}, current_date, 'gemini', 'calls', 1)$f$),
  ('usage_limits', 'usage.json', '{}', true,  false, 30, $f$insert into app.usage_limits (user_id, provider, metric, period, soft) values ({{uid}}, 'gemini', 'live_seconds', 'day', 3600)$f$),
  ('storage_usage', 'usage.json', '{}', false, false, 5, $f$insert into app.storage_usage (user_id, files_bytes) values ({{uid}}, 1)$f$);
