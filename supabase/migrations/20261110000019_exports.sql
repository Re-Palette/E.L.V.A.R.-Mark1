-- P7 / migration 19: the asynchronous data export (docs/ELVAR_MULTIUSER.md 7.3, principle 7). A job is a row of app.export_jobs; its progress is written ONLY by the
-- server (definer functions for elvar_app), the user can read their own jobs. The zip parts live in the private bucket `user-exports` under users/<uid>/exports/<job>/,
-- written with the service key (the user gets no write access: nobody can tamper with an export) and handed out through signed links that expire.
--   export_job_create        one active job per account at a time (a second one is refused); returns the new job id
--   export_job_update        progress / done / failed, forward only (a finished job is never changed again)
--   export_jobs_expired      jobs to delete now: past expires_at, failed ones after 2 days, and jobs that stopped moving for 30 minutes (marked failed first)
--   export_job_drop          the row; the server removes the objects first
-- The bucket is created here too (supabase/config.toml declares it for `supabase start`).

alter table app.export_jobs add column updated_at timestamptz not null default now();

insert into storage.buckets (id, name, public, file_size_limit) values ('user-exports', 'user-exports', false, 536870912)
  on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;
-- read: the owner's own prefix only. No insert / update / delete policy: exports are written and removed with the service key.
create policy exports_read on storage.objects for select to authenticated using (
  bucket_id = 'user-exports' and (storage.foldername(objects.name))[1] = 'users' and (storage.foldername(objects.name))[2] = (select auth.uid())::text);

create function app.export_job_create(p_user uuid) returns uuid
language plpgsql security definer set search_path = pg_catalog, app as $$
declare new_id uuid;
begin
  if p_user is null or not exists (select 1 from auth.users where id = p_user) then raise exception 'not_found' using errcode = 'P0002'; end if;
  insert into app.accounts (user_id) values (p_user) on conflict (user_id) do nothing;
  perform 1 from app.accounts where user_id = p_user for update;          -- one creator at a time per account
  if exists (select 1 from app.export_jobs where user_id = p_user and status in ('queued', 'running')) then raise exception 'export already running' using errcode = '55000'; end if;
  insert into app.export_jobs (user_id, status) values (p_user, 'queued') returning export_jobs.id into new_id;
  insert into app.audit_log (user_id, actor, actor_id, action, target) values (p_user, 'user', p_user, 'export.requested', new_id::text);
  return new_id;
end $$;
revoke all on function app.export_job_create(uuid) from public, anon, authenticated;
grant execute on function app.export_job_create(uuid) to elvar_app;

create function app.export_job_update(p_user uuid, p_id uuid, p_status text, p_cursor jsonb, p_parts int, p_bytes bigint, p_error text, p_expires timestamptz) returns boolean
language plpgsql security definer set search_path = pg_catalog, app as $$
declare n int;
begin
  if p_status not in ('running', 'done', 'failed') or p_parts < 0 or p_bytes < 0 then raise exception 'export_job_update: bad value' using errcode = '22023'; end if;
  update app.export_jobs set status = p_status, cursor = p_cursor, parts = p_parts, bytes = p_bytes, error = left(p_error, 500),
      expires_at = case when p_status = 'done' then p_expires else expires_at end, updated_at = now()
    where user_id = p_user and id = p_id and status in ('queued', 'running');
  get diagnostics n = row_count;
  if n > 0 and p_status = 'done' then insert into app.audit_log (user_id, actor, actor_id, action, target, meta) values (p_user, 'system', null, 'export.completed', p_id::text, jsonb_build_object('parts', p_parts, 'bytes', p_bytes)); end if;
  return n > 0;
end $$;
revoke all on function app.export_job_update(uuid, uuid, text, jsonb, int, bigint, text, timestamptz) from public, anon, authenticated;
grant execute on function app.export_job_update(uuid, uuid, text, jsonb, int, bigint, text, timestamptz) to elvar_app;

create function app.export_jobs_expired(p_limit int default 100) returns table (user_id uuid, id uuid)
language plpgsql security definer set search_path = pg_catalog, app as $$
begin
  update app.export_jobs set status = 'failed', error = 'stalled', updated_at = now() where status in ('queued', 'running') and updated_at < now() - interval '30 minutes';
  return query select j.user_id, j.id from app.export_jobs j
    where (j.status = 'done' and j.expires_at <= now()) or (j.status in ('failed', 'expired') and j.updated_at < now() - interval '2 days')
    order by j.updated_at limit greatest(1, least(coalesce(p_limit, 100), 500));
end $$;
revoke all on function app.export_jobs_expired(int) from public, anon, authenticated;
grant execute on function app.export_jobs_expired(int) to elvar_app;

create function app.export_job_drop(p_user uuid, p_id uuid) returns boolean
language plpgsql security definer set search_path = pg_catalog, app as $$
declare n int;
begin
  delete from app.export_jobs where user_id = p_user and id = p_id;
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function app.export_job_drop(uuid, uuid) from public, anon, authenticated;
grant execute on function app.export_job_drop(uuid, uuid) to elvar_app;

-- Account deletion: the due list now also carries the address the user left for the confirmation mail (it is read once, used by the purge job for the optional receipt
-- hook, and dies with the request row when the account goes; deletion_receipts keeps neither the id nor the address).
drop function app.due_deletions(int);
create function app.due_deletions(p_limit int default 20) returns table (user_id uuid, grace_days smallint, email text)
language sql stable security definer set search_path = pg_catalog, app as $$
  select d.user_id, d.grace_days, d.email_for_receipt from app.deletion_requests d where d.purge_after <= now() order by d.purge_after limit greatest(1, least(coalesce(p_limit, 20), 200));
$$;
revoke all on function app.due_deletions(int) from public, anon, authenticated;
grant execute on function app.due_deletions(int) to elvar_app;
