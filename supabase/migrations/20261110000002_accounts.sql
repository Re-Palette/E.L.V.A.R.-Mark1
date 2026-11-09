-- P1 / migration 02: accounts, profiles, settings, keys, secrets, devices, audit log, and the data registry.
-- docs/ELVAR_MULTIUSER.md sections 3.1, 4.2, 5.1, 7.1.  Decisions: O1 (500 MB default quota, 60 MB per file).
--
-- Every table: user_id uuid not null default auth.uid() references auth.users(id) on delete cascade, then app._secure().
-- Deleting the auth user therefore removes every row (principle 7). Every table also has a row in app.data_registry (bottom of this file):
-- that registry drives the export, the deletion check and the generated isolation tests.

create table app.accounts (                      -- read-only for the user; written by definer functions (and, later, admin functions)
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'suspended', 'pending_deletion')),
  storage_quota_bytes bigint not null default 524288000 check (storage_quota_bytes >= 0),   -- O1: 500 MB; an admin can change it per user
  hard_limits jsonb not null default '{}'::jsonb check (jsonb_typeof(hard_limits) = 'object'),   -- admin-set limits (docs section 6.3); per-file max is 62914560 (60 MB)
  suspended_reason text check (suspended_reason is null or length(suspended_reason) <= 500),
  created_at timestamptz not null default now()
);
select app._secure('accounts', 'select');

create table app.admins (                         -- who may use the admin functions. No policy: only definer functions read it (app.is_admin)
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz not null default now()
);
select app._secure('admins', '');

create table app.profiles (                       -- principle 2: persona, how to be addressed, tone, greeting, voice
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  profile jsonb not null check (jsonb_typeof(profile) = 'object' and pg_column_size(profile) <= 100000),
  updated_at timestamptz not null default now()
);
select app._secure('profiles', 'select,insert,update,delete');

create table app.settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) <= 100000),
  updated_at timestamptz not null default now()
);
select app._secure('settings', 'select,insert,update,delete');

create table app.user_keys (                      -- the user's DEK, wrapped by the platform KEK (docs section 4.2). wrapped = 32 bytes + 16 tag
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  kek_id text not null check (kek_id ~ '^[A-Za-z0-9_.-]{1,32}$'),
  dek_ver int not null default 1 check (dek_ver >= 1),
  wrapped bytea not null check (octet_length(wrapped) = 48),
  iv bytea not null check (octet_length(iv) = 12),
  rotated_at timestamptz
);
select app._secure('user_keys', 'select,insert,update,delete');

create table app.user_secrets (                   -- API keys and tokens, AES-256-GCM under the user's DEK; AAD = user id + name + dek_ver
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (name ~ '^[A-Za-z0-9_:.-]{1,80}$'),
  ct bytea not null check (octet_length(ct) between 17 and 16400),
  iv bytea not null check (octet_length(iv) = 12),
  dek_ver int not null check (dek_ver >= 1),
  last4 text check (last4 is null or length(last4) <= 4),
  updated_at timestamptz not null default now(),
  primary key (user_id, name)
);
select app._secure('user_secrets', 'select,insert,update,delete');

create table app.devices (                        -- notification-sync device tokens: only sha256(secret) is stored
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (id ~ '^[0-9a-f]{16}$'),
  name text not null check (length(name) between 1 and 40),
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  scopes text[] not null check (cardinality(scopes) between 1 and 8 and scopes <@ array['notif:push', 'notif:pull']::text[]),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  primary key (user_id, id)
);
select app._secure('devices', 'select,insert,update,delete');

create table app.audit_log (                      -- append-only for the user: select and insert, no update, no delete
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id bigint generated always as identity,
  at timestamptz not null default now(),
  actor text not null check (actor in ('user', 'admin', 'system')),
  actor_id uuid,
  action text not null check (length(action) between 1 and 100),
  target text check (target is null or length(target) <= 300),
  meta jsonb check (meta is null or pg_column_size(meta) <= 8000),
  primary key (user_id, id)
);
select app._secure('audit_log', 'select,insert');
-- a user (through the server) may only write entries about themselves or the system; entries by an admin come from definer functions
create policy audit_actor on app.audit_log as restrictive for insert to authenticated with check (actor in ('user', 'system'));

-- ------------------------------------------------------------------------------------------------------ the registry (docs section 7.1)
-- One row per table that holds a user's data. The tests compare this list with the real tables in both directions: a table without a row,
-- or a row without a table, fails the build. owner_column is the column that holds the user id (always user_id so far).
create table app.data_registry (
  table_name text primary key check (table_name ~ '^[a-z_][a-z0-9_]*$'),
  export_as text not null,                        -- file in the export zip, or 'none' (internal / key material)
  export_exclude text[] not null default '{}',    -- columns that never leave the database (ciphertext, hashes, wrapped keys)
  editable boolean not null,                      -- may the user change it from the "my data" screen
  owner_column text not null default 'user_id',
  delete_via text not null default 'cascade' check (delete_via in ('cascade', 'cascade+storage', 'cascade+external')),
  counts_storage boolean not null,                -- counts against the user's storage quota
  fixture_order smallint not null default 100,    -- tests insert fixtures in this order (parents first)
  fixture_sql text not null                       -- inserts one row for {{uid}} (replaced by a uuid literal); tests use it for isolation and deletion
);
select app._secure('data_registry', '', false);   -- platform metadata, no user_id, no policy: read by definer functions only

-- ------------------------------------------------------------------------------------------------------ functions
-- Every function here is SECURITY DEFINER with a fixed search_path and an explicit execute list (nothing for public / anon).
-- They run as the migration owner, which bypasses RLS (Supabase's `postgres` role has BYPASSRLS; a superuser does too).

-- First sign-in: create the caller's account row. Only for the caller (auth.uid()), idempotent.
create or replace function app.ensure_account() returns void
language plpgsql security definer set search_path = pg_catalog, app as $$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  insert into app.accounts (user_id) values (auth.uid()) on conflict (user_id) do nothing;
end $$;
revoke all on function app.ensure_account() from public, anon;
grant execute on function app.ensure_account() to authenticated;

-- Is the caller an admin (the second of the two checks; the first is the JWT claim). The admins table itself is not readable by anyone.
create or replace function app.is_admin() returns boolean
language sql stable security definer set search_path = pg_catalog, app as $$
  select exists (select 1 from app.admins where user_id = auth.uid());
$$;
revoke all on function app.is_admin() from public, anon;
grant execute on function app.is_admin() to authenticated;

-- Device-token login: the server knows only sha256(secret) and has no user yet, so this lookup is the one place a row is found without
-- a user context. Executable by elvar_app only (never by a signed-in user): it answers "whose token is this" for a 32-byte hash.
create or replace function app.device_lookup(p_hash bytea) returns table (user_id uuid, device_id text, scopes text[])
language sql stable security definer set search_path = pg_catalog, app as $$
  select d.user_id, d.id, d.scopes from app.devices d where d.token_hash = p_hash;
$$;
revoke all on function app.device_lookup(bytea) from public, anon, authenticated;
grant execute on function app.device_lookup(bytea) to elvar_app;

-- ------------------------------------------------------------------------------------------------------ registry rows
insert into app.data_registry (table_name, export_as, export_exclude, editable, counts_storage, fixture_order, fixture_sql) values
  ('accounts',   'account.json',  '{}', false, false, 10, $f$insert into app.accounts (user_id) values ({{uid}})$f$),
  ('admins',     'account.json',  '{}', false, false, 20, $f$insert into app.admins (user_id) values ({{uid}})$f$),
  ('profiles',   'profile.json',  '{}', true,  false, 30, $f$insert into app.profiles (user_id, profile) values ({{uid}}, '{"version":1,"owner":{"name":"fixture"}}'::jsonb)$f$),
  ('settings',   'settings.json', '{}', true,  false, 30, $f$insert into app.settings (user_id, settings) values ({{uid}}, '{"fixture":true}'::jsonb)$f$),
  ('user_keys',  'none',          '{}', false, false, 30, $f$insert into app.user_keys (user_id, kek_id, wrapped, iv) values ({{uid}}, 'fixture', decode(repeat('00', 48), 'hex'), decode(repeat('00', 12), 'hex'))$f$),
  ('user_secrets', 'secrets.json', '{ct,iv}', true, false, 30, $f$insert into app.user_secrets (user_id, name, ct, iv, dek_ver, last4) values ({{uid}}, 'GEMINI_API_KEY', decode(repeat('11', 32), 'hex'), decode(repeat('00', 12), 'hex'), 1, 'abcd')$f$),
  ('devices',    'devices.json',  '{token_hash}', true, false, 30, $f$insert into app.devices (user_id, id, name, token_hash, scopes) values ({{uid}}, '0123456789abcdef', 'fixture', sha256(convert_to('fixture-device-' || {{uid}}::text, 'UTF8')), array['notif:push'])$f$),
  ('audit_log',  'audit.json',    '{}', false, false, 30, $f$insert into app.audit_log (user_id, actor, actor_id, action, target) values ({{uid}}, 'user', {{uid}}, 'fixture', 'fixture')$f$);
