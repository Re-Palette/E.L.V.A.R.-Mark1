-- Test bootstrap for a PLAIN Postgres: the small part of Supabase that the migrations rely on. Not a migration, never shipped to a real project
-- (`supabase start` already has all of this). Roles, auth.users + auth.uid(), and the part of the storage schema the P5 policies and tests use:
-- storage.buckets, storage.objects (row level security ON, the same grants Supabase gives, so the policies of migration 07 are what decides) and storage.foldername().

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin noinherit; end if;
end $$;

create schema if not exists extensions;
-- Supabase grants this on every project (the extension operators the SECURITY INVOKER search functions use, e.g. PGroonga's &@|, are resolved in this schema as the caller)
grant usage on schema extensions to anon, authenticated, service_role;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  email_confirmed_at timestamptz default now(),
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now()
);

-- Same behaviour as Supabase: the signed-in user's id comes from the request.jwt.claims setting; unset or empty -> null (so RLS returns nothing).
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')), '')::text
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;

create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text not null, public boolean not null default false, file_size_limit bigint);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid default auth.uid(),
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table storage.objects enable row level security;
create unique index if not exists bucketid_objname on storage.objects (bucket_id, name);   -- Supabase has the same: a second object under a name is a duplicate (409), not an overwrite
-- Supabase grants every command on storage.objects to anon and authenticated and relies on the policies alone (there is no policy for anon here, so anon gets nothing)
grant select, insert, update, delete on storage.objects to anon, authenticated;
grant select on storage.buckets to anon, authenticated;
-- the real function: the folders of an object name, without the file name  ('users/<uid>/files/x/y' -> {users, <uid>, files, x})
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
  select case when position('/' in name) = 0 then '{}'::text[] else (string_to_array(name, '/'))[1:cardinality(string_to_array(name, '/')) - 1] end
$$;
grant usage on schema storage to anon, authenticated, service_role;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;
