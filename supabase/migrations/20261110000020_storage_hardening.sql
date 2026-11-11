-- P8 review round 2 / migration 20: the file-vault Storage policies, tightened (docs/ELVAR_MULTIUSER.md 19).
--   files_read    the owner can read an object only once its row is `ready` (the server has looked at the real bytes: size and SHA-256), or while it is `deleting`
--                 (a DELETE needs the SELECT policy to find the row, so the object of a row being deleted must be visible). A pending, unverified object cannot be
--                 downloaded or signed by its owner, and the finalize step reads it with the service key, not with the owner's token.
--   files_delete  the owner can delete an object only while its row is `deleting`. A live pending upload cannot be deleted and uploaded again (the "replace after the
--                 check" race), and a ready file cannot be removed behind the database's back (the row would stay counted). The object of an expired reservation is
--                 removed by the server with the service key (the owner's own sweep, the daily sweep): it is never readable by the owner.
--   files_upload  also requires an `active` account (a suspended or pending-deletion account cannot write into a reservation it made earlier).
--   reserve_file  a reservation lives 15 minutes (was 30): less time for an unverified object to sit in the bucket, and the stale sweep has less to do.
-- The per-object size cannot be tied to the reservation in a policy (the Storage API does not know the byte count when it checks the INSERT policy); the bucket's
-- file_size_limit (= max_file_bytes, see below) is the hard ceiling, finalize compares the real size with the reserved one, rejects and deletes anything else, and until finalize the reserved
-- size is what counts against the quota. docs 19 says so.

drop policy if exists files_read on storage.objects;
create policy files_read on storage.objects for select to authenticated using (
  bucket_id = 'user-files' and (storage.foldername(objects.name))[1] = 'users' and (storage.foldername(objects.name))[2] = (select auth.uid())::text
  and exists (select 1 from app.files f where f.user_id = (select auth.uid()) and f.object_path = objects.name and f.status in ('ready', 'deleting')));

drop policy if exists files_delete on storage.objects;
create policy files_delete on storage.objects for delete to authenticated using (
  bucket_id = 'user-files' and (storage.foldername(objects.name))[1] = 'users' and (storage.foldername(objects.name))[2] = (select auth.uid())::text
  and exists (select 1 from app.files f where f.user_id = (select auth.uid()) and f.object_path = objects.name and f.status = 'deleting'));

drop policy if exists files_upload on storage.objects;
create policy files_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'user-files' and (storage.foldername(objects.name))[1] = 'users' and (storage.foldername(objects.name))[2] = (select auth.uid())::text
  and exists (select 1 from app.accounts a where a.user_id = (select auth.uid()) and a.status = 'active')
  and exists (select 1 from app.files f where f.user_id = (select auth.uid()) and f.object_path = objects.name and f.status = 'pending' and f.reserved_until > now()));

-- The per-file limit of the whole platform (P8): app.platform_config key `max_file_bytes` (1 MB .. 60 MB; a row that is missing or not a number means 60 MB, decision O1; a larger number is clamped to the 60 MB ceiling that app.files.size_bytes enforces). The operator
-- sets it (SQL editor, or ELVAR_MAX_FILE_BYTES which the server writes through app.set_max_file_bytes), reserve_file enforces it, and a trigger keeps the bucket's file_size_limit
-- equal to it. The migration STARTS the platform at 50 MB (row inserted at the end of this section): the Supabase Free plan refuses any upload over 50 MB whatever the bucket says,
-- so a 60 MB start would let reserve_file accept files that Storage then rejects. On a paid plan raise it (ELVAR_MAX_FILE_BYTES=62914560); docs/DECISIONS.md O1.
create function app.platform_max_file_bytes() returns bigint
language sql stable security definer set search_path = pg_catalog, app as $$
  select least(62914560::bigint, greatest(1048576::bigint, coalesce((select case when c.value ~ '^[0-9]{1,12}$' then c.value::bigint end from app.platform_config c where c.key = 'max_file_bytes'), 62914560::bigint)));
$$;
revoke all on function app.platform_max_file_bytes() from public, anon;
grant execute on function app.platform_max_file_bytes() to authenticated, elvar_app;

create function app._sync_bucket_limit() returns trigger
language plpgsql security definer set search_path = pg_catalog, app as $$
begin
  if exists (select 1 from storage.buckets where id = 'user-files') then update storage.buckets set file_size_limit = app.platform_max_file_bytes() where id = 'user-files'; end if;
  return null;
end $$;
revoke all on function app._sync_bucket_limit() from public, anon, authenticated;
create trigger platform_max_file_sync after insert or update or delete on app.platform_config for each statement execute function app._sync_bucket_limit();

create function app.set_max_file_bytes(p_bytes bigint) returns bigint
language plpgsql security definer set search_path = pg_catalog, app as $$
begin
  if p_bytes is null or p_bytes < 1048576 then raise exception 'set_max_file_bytes: bad value' using errcode = '22023'; end if;   -- above the 60 MB ceiling (app.files.size_bytes check) the value is clamped by platform_max_file_bytes(), never refused
  insert into app.platform_config (key, value) values ('max_file_bytes', least(p_bytes, 62914560)::text) on conflict (key) do update set value = excluded.value, updated_at = now() where app.platform_config.value is distinct from excluded.value;
  return app.platform_max_file_bytes();
end $$;
revoke all on function app.set_max_file_bytes(bigint) from public, anon, authenticated;
grant execute on function app.set_max_file_bytes(bigint) to elvar_app;

-- The safe start (see above): 50 MB, unless an operator already set a value. The trigger copies it onto the bucket `user-files` in the same statement.
insert into app.platform_config (key, value) values ('max_file_bytes', '52428800') on conflict (key) do nothing;

-- A platform-wide ceiling on stored bytes (P8 abuse control; the Supabase Free plan has 1 GB of Storage): app.platform_config `max_total_storage_bytes` (unset = no ceiling). A
-- reservation that would take the sum of everybody's counted bytes over it is refused with EQ004. Notes and messages are small and bounded per user by the quota, so only the file vault checks it.
create function app._platform_storage_full(p_add bigint) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, app as $$
declare lim bigint;
begin
  select case when c.value ~ '^[0-9]{1,15}$' then c.value::bigint end into lim from app.platform_config c where c.key = 'max_total_storage_bytes';
  if lim is null then return false; end if;
  return coalesce((select sum(s.files_bytes + s.text_bytes + s.notes_bytes + s.messages_bytes + s.reserved_bytes) from app.storage_usage s), 0) + p_add > lim;
end $$;
revoke all on function app._platform_storage_full(bigint) from public, anon, authenticated;

create or replace function app.reserve_file(p_name text, p_mime text, p_kind text, p_size bigint, p_sha256 text, p_text_bytes bigint default 0, p_source text default 'picker',
                                 p_allow_duplicate boolean default false) returns jsonb
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  uid uuid := auth.uid();
  acct app.accounts;
  maxf bigint; used bigint; dup record; fid uuid := gen_random_uuid(); path text; exp_at timestamptz := now() + interval '15 minutes'; live int;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_size is null or p_size < 1 or p_text_bytes is null or p_text_bytes < 0 or p_text_bytes > 4000000 or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
     or p_name is null or p_mime is null or p_kind is null then raise exception 'reserve_file: bad value' using errcode = '22023'; end if;
  insert into app.accounts (user_id) values (uid) on conflict (user_id) do nothing;
  insert into app.storage_usage (user_id) values (uid) on conflict (user_id) do nothing;
  select * into acct from app.accounts where user_id = uid for update;      -- one reservation at a time per user: the quota check below cannot race
  if acct.status <> 'active' then raise exception 'account is not active' using errcode = '55000'; end if;
  maxf := least(app.platform_max_file_bytes(), coalesce(case when acct.hard_limits->>'maxFileBytes' ~ '^[0-9]{1,15}$' then (acct.hard_limits->>'maxFileBytes')::bigint end, app.platform_max_file_bytes()));
  if p_size > maxf then raise exception 'file too large' using errcode = 'EQ002'; end if;
  if not coalesce(p_allow_duplicate, false) then
    select f.id, f.name into dup from app.files f where f.user_id = uid and f.sha256 = p_sha256 and f.status = 'ready' order by f.created_at limit 1;
    if found then return jsonb_build_object('duplicate', jsonb_build_object('id', dup.id, 'name', dup.name)); end if;
  end if;
  select count(*) into live from app.files f where f.user_id = uid and f.status = 'pending' and f.reserved_until > now();
  if live >= 20 then raise exception 'too many uploads at once' using errcode = '55000'; end if;
  select s.files_bytes + s.text_bytes + s.notes_bytes + s.messages_bytes + s.reserved_bytes into used from app.storage_usage s where s.user_id = uid;
  if used + p_size + p_text_bytes > acct.storage_quota_bytes then raise exception 'storage quota exceeded' using errcode = 'EQ001'; end if;
  if app._platform_storage_full(p_size + p_text_bytes) then raise exception 'platform storage full' using errcode = 'EQ004'; end if;
  path := 'users/' || uid::text || '/files/' || fid::text || '/' || p_sha256;
  insert into app.files (user_id, id, name, mime, kind, size_bytes, sha256, object_path, status, reserved_bytes, reserved_until, source)
    values (uid, fid, p_name, p_mime, p_kind, p_size, p_sha256, path, 'pending', p_size + p_text_bytes, exp_at, left(coalesce(p_source, 'picker'), 40));
  return jsonb_build_object('fileId', fid, 'objectPath', path, 'reservedUntil', exp_at);
end $$;
revoke all on function app.reserve_file(text, text, text, bigint, text, bigint, text, boolean) from public, anon;
grant execute on function app.reserve_file(text, text, text, bigint, text, bigint, text, boolean) to authenticated;
