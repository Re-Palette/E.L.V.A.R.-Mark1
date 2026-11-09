-- P5 / migration 07: the per-user file vault (docs/ELVAR_MULTIUSER.md 3.3, 5.1, 6.2, 8.2). Principle 4: every file is the owner's alone; principle 6: the
-- storage quota is counted per user and enforced here, in the database, before an upload is allowed to start.
--
--   app.files       one row per file: metadata, the content hash (per-user dedupe), the "memory" the browser worker built (kind guess, keywords, tags, notes,
--                   version-similarity mark) and the place of the original in Storage (bucket user-files, users/<uid>/files/<fileId>/<sha256>)
--   app.file_texts  the extracted text of a file (searched on the server; counted against the quota)
--
-- The user can only READ these tables. Every change goes through a definer function that checks auth.uid() and the quota:
--   reserve_file      atomic: locks the account row, checks used + reserved + size (+ expected text) against the quota and the per-file limit, inserts a
--                     `pending` row with a 30 minute reservation. Only a path that has such a reservation may be written in Storage (policy files_upload).
--   finalize_file     the server has checked the real object (size and SHA-256): the row becomes `ready`, the reservation turns into used bytes
--   patch_file        names, tags, notes, kind label, the memory fields, the extracted text (re-reading, OCR)
--   begin_delete_file / finish_delete_file   two steps so a file whose Storage object could not be removed is not forgotten (status `deleting`, swept later)
-- storage_usage is kept by triggers on every table that counts (notes, note_revisions, messages, files, file_texts). reserved bytes are counted as used.

create table app.files (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200 and name !~ '[[:cntrl:]]' and name !~ '[/\\]'),
  mime text not null check (length(mime) between 3 and 100),
  kind text not null check (kind in ('pdf', 'image', 'text', 'office', 'other')),
  size_bytes bigint not null check (size_bytes between 1 and 62914560),                       -- O1: 60 MB per file at most
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  object_path text not null check (object_path = 'users/' || user_id::text || '/files/' || id::text || '/' || sha256),
  status text not null default 'pending' check (status in ('pending', 'ready', 'deleting')),
  reserved_bytes bigint not null default 0 check (reserved_bytes >= 0),                       -- size + the extracted text the client announced
  reserved_until timestamptz,                                                                  -- while pending: the upload must finish before this
  source text not null default 'picker' check (length(source) between 1 and 40),
  title text check (title is null or length(title) <= 200),
  doc_kind text check (doc_kind is null or length(doc_kind) <= 40),                            -- the browser's guess (a guess, never a fact)
  kind_label text check (kind_label is null or length(kind_label) <= 40),                      -- the owner's own label: wins over the guess
  tags text[] not null default '{}' check (cardinality(tags) <= 30),
  memo text not null default '' check (length(memo) <= 1000),
  keywords text[] not null default '{}' check (cardinality(keywords) <= 30),
  snippet text not null default '' check (length(snippet) <= 300),
  analysis jsonb not null default '{}'::jsonb check (jsonb_typeof(analysis) = 'object' and pg_column_size(analysis) <= 100000),   -- headings, dates, amounts, pages, AI summary ...
  related jsonb check (related is null or (jsonb_typeof(related) = 'object' and pg_column_size(related) <= 2000)),               -- version-similarity mark {id, name, score}
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  unique (user_id, object_path)
);
create index files_user_created on app.files (user_id, created_at desc);
create index files_user_sha on app.files (user_id, sha256);
select app._secure('files', 'select');

create table app.file_texts (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  file_id uuid not null,
  text text not null check (octet_length(text) <= 4000000),
  bytes int generated always as (octet_length(text)) stored,
  primary key (user_id, file_id),
  foreign key (user_id, file_id) references app.files (user_id, id) on delete cascade
);
select app._secure('file_texts', 'select');

-- ------------------------------------------------------------------------------------------------------ storage accounting (triggers)
-- One function for every counted table: the difference between the old and the new row is added to the owner's storage_usage row (created on first use,
-- but never for a user that is being deleted: the cascade of delete from auth.users fires these triggers after the user row is gone).
create function app._storage_track() returns trigger
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  u uuid;
  o_files bigint := 0; n_files bigint := 0; o_res bigint := 0; n_res bigint := 0; o_text bigint := 0; n_text bigint := 0;
  o_notes bigint := 0; n_notes bigint := 0; o_msgs bigint := 0; n_msgs bigint := 0;
begin
  u := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  if tg_table_name = 'notes' then
    if tg_op <> 'INSERT' then o_notes := old.bytes; end if;
    if tg_op <> 'DELETE' then n_notes := new.bytes; end if;
  elsif tg_table_name = 'note_revisions' then
    if tg_op <> 'INSERT' then o_notes := octet_length(old.content); end if;
    if tg_op <> 'DELETE' then n_notes := octet_length(new.content); end if;
  elsif tg_table_name = 'messages' then
    if tg_op <> 'INSERT' then o_msgs := octet_length(old.text); end if;
    if tg_op <> 'DELETE' then n_msgs := octet_length(new.text); end if;
  elsif tg_table_name = 'file_texts' then
    if tg_op <> 'INSERT' then o_text := old.bytes; end if;
    if tg_op <> 'DELETE' then n_text := new.bytes; end if;
  elsif tg_table_name = 'files' then
    if tg_op <> 'INSERT' then
      if old.status = 'pending' then o_res := old.reserved_bytes; else o_files := old.size_bytes; end if;   -- ready and deleting rows hold real bytes until they are removed
    end if;
    if tg_op <> 'DELETE' then
      if new.status = 'pending' then n_res := new.reserved_bytes; else n_files := new.size_bytes; end if;
    end if;
  end if;
  if o_files = n_files and o_res = n_res and o_text = n_text and o_notes = n_notes and o_msgs = n_msgs then return null; end if;
  update app.storage_usage set files_bytes = files_bytes + n_files - o_files, reserved_bytes = reserved_bytes + n_res - o_res, text_bytes = text_bytes + n_text - o_text,
    notes_bytes = notes_bytes + n_notes - o_notes, messages_bytes = messages_bytes + n_msgs - o_msgs where user_id = u;
  if not found then
    insert into app.storage_usage (user_id, files_bytes, reserved_bytes, text_bytes, notes_bytes, messages_bytes)
      select u, greatest(n_files - o_files, 0), greatest(n_res - o_res, 0), greatest(n_text - o_text, 0), greatest(n_notes - o_notes, 0), greatest(n_msgs - o_msgs, 0)
      where exists (select 1 from auth.users x where x.id = u) on conflict (user_id) do nothing;
  end if;
  return null;
end $$;
revoke all on function app._storage_track() from public, anon, authenticated;

create trigger storage_track after insert or update or delete on app.notes for each row execute function app._storage_track();
create trigger storage_track after insert or update or delete on app.note_revisions for each row execute function app._storage_track();
create trigger storage_track after insert or update or delete on app.messages for each row execute function app._storage_track();
create trigger storage_track after insert or update or delete on app.files for each row execute function app._storage_track();
create trigger storage_track after insert or update or delete on app.file_texts for each row execute function app._storage_track();

-- ------------------------------------------------------------------------------------------------------ reservation (atomic) and finalize
-- Error codes (SQLSTATE) the server maps: EQ001 storage quota exceeded (413), EQ002 file too large (413), EQ003 no live reservation (409).
create function app.reserve_file(p_name text, p_mime text, p_kind text, p_size bigint, p_sha256 text, p_text_bytes bigint default 0, p_source text default 'picker',
                                 p_allow_duplicate boolean default false) returns jsonb
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  uid uuid := auth.uid();
  acct app.accounts;
  maxf bigint; used bigint; dup record; fid uuid := gen_random_uuid(); path text; exp_at timestamptz := now() + interval '30 minutes'; live int;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_size is null or p_size < 1 or p_text_bytes is null or p_text_bytes < 0 or p_text_bytes > 4000000 or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
     or p_name is null or p_mime is null or p_kind is null then raise exception 'reserve_file: bad value' using errcode = '22023'; end if;
  insert into app.accounts (user_id) values (uid) on conflict (user_id) do nothing;
  insert into app.storage_usage (user_id) values (uid) on conflict (user_id) do nothing;
  select * into acct from app.accounts where user_id = uid for update;      -- one reservation at a time per user: the quota check below cannot race
  if acct.status <> 'active' then raise exception 'account is not active' using errcode = '55000'; end if;
  maxf := least(62914560, coalesce(case when acct.hard_limits->>'maxFileBytes' ~ '^[0-9]{1,15}$' then (acct.hard_limits->>'maxFileBytes')::bigint end, 62914560));
  if p_size > maxf then raise exception 'file too large' using errcode = 'EQ002'; end if;
  if not coalesce(p_allow_duplicate, false) then
    select f.id, f.name into dup from app.files f where f.user_id = uid and f.sha256 = p_sha256 and f.status = 'ready' order by f.created_at limit 1;
    if found then return jsonb_build_object('duplicate', jsonb_build_object('id', dup.id, 'name', dup.name)); end if;
  end if;
  select count(*) into live from app.files f where f.user_id = uid and f.status = 'pending' and f.reserved_until > now();
  if live >= 20 then raise exception 'too many uploads at once' using errcode = '55000'; end if;
  select s.files_bytes + s.text_bytes + s.notes_bytes + s.messages_bytes + s.reserved_bytes into used from app.storage_usage s where s.user_id = uid;
  if used + p_size + p_text_bytes > acct.storage_quota_bytes then raise exception 'storage quota exceeded' using errcode = 'EQ001'; end if;
  path := 'users/' || uid::text || '/files/' || fid::text || '/' || p_sha256;
  insert into app.files (user_id, id, name, mime, kind, size_bytes, sha256, object_path, status, reserved_bytes, reserved_until, source)
    values (uid, fid, p_name, p_mime, p_kind, p_size, p_sha256, path, 'pending', p_size + p_text_bytes, exp_at, left(coalesce(p_source, 'picker'), 40));
  return jsonb_build_object('fileId', fid, 'objectPath', path, 'reservedUntil', exp_at);
end $$;
revoke all on function app.reserve_file(text, text, text, bigint, text, bigint, text, boolean) from public, anon;
grant execute on function app.reserve_file(text, text, text, bigint, text, bigint, text, boolean) to authenticated;

-- The server has looked at the real object (size and SHA-256 equal the reservation) and sends what the browser read. The extracted text must fit in what
-- was reserved for it. Idempotent for a file that is already ready.
create function app.finalize_file(p_id uuid, p_size bigint, p_title text, p_doc_kind text, p_keywords text[], p_snippet text, p_analysis jsonb, p_related jsonb, p_text text)
returns void
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  uid uuid := auth.uid(); f app.files; tb bigint := octet_length(coalesce(p_text, ''));
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into f from app.files where user_id = uid and id = p_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if f.status = 'ready' then return; end if;
  if f.status <> 'pending' or f.reserved_until is null or f.reserved_until < now() then raise exception 'no live reservation' using errcode = 'EQ003'; end if;
  if p_size is distinct from f.size_bytes then raise exception 'size differs from the reservation' using errcode = 'EQ002'; end if;
  if tb > f.reserved_bytes - f.size_bytes then raise exception 'extracted text is larger than announced' using errcode = 'EQ001'; end if;
  update app.files set status = 'ready', finalized_at = now(), reserved_until = null, updated_at = now(),
    title = left(p_title, 200), doc_kind = left(p_doc_kind, 40), keywords = coalesce(p_keywords, '{}'), snippet = left(coalesce(p_snippet, ''), 300),
    analysis = coalesce(p_analysis, '{}'::jsonb), related = p_related
    where user_id = uid and id = p_id;
  if tb > 0 then insert into app.file_texts (user_id, file_id, text) values (uid, p_id, p_text) on conflict (user_id, file_id) do update set text = excluded.text; end if;
end $$;
revoke all on function app.finalize_file(uuid, bigint, text, text, text[], text, jsonb, jsonb, text) from public, anon;
grant execute on function app.finalize_file(uuid, bigint, text, text, text[], text, jsonb, jsonb, text) to authenticated;

-- The owner's own edits and the memory of a re-read file. p_patch may hold: name, tags, memo, kindLabel, title, docKind, keywords, snippet, related, analysis
-- (merged into the existing one). p_text with p_set_text replaces the extracted text ('' removes it); growth must fit in the quota.
create function app.patch_file(p_id uuid, p_patch jsonb, p_text text default null, p_set_text boolean default false) returns void
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  uid uuid := auth.uid(); f app.files; acct app.accounts; used bigint; old_b bigint := 0; new_b bigint := octet_length(coalesce(p_text, ''));
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'patch_file: bad value' using errcode = '22023'; end if;
  select * into f from app.files where user_id = uid and id = p_id and status = 'ready' for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if coalesce(p_set_text, false) then
    select * into acct from app.accounts where user_id = uid for update;
    select coalesce(max(t.bytes), 0) into old_b from app.file_texts t where t.user_id = uid and t.file_id = p_id;
    select s.files_bytes + s.text_bytes + s.notes_bytes + s.messages_bytes + s.reserved_bytes into used from app.storage_usage s where s.user_id = uid;
    if new_b > 4000000 then raise exception 'text too large' using errcode = 'EQ002'; end if;
    if new_b > old_b and used + (new_b - old_b) > coalesce(acct.storage_quota_bytes, 524288000) then raise exception 'storage quota exceeded' using errcode = 'EQ001'; end if;
    if new_b = 0 then delete from app.file_texts where user_id = uid and file_id = p_id;
    else insert into app.file_texts (user_id, file_id, text) values (uid, p_id, p_text) on conflict (user_id, file_id) do update set text = excluded.text; end if;
  end if;
  update app.files set
    name = case when p_patch ? 'name' then p_patch->>'name' else name end,
    tags = case when p_patch ? 'tags' then coalesce(array(select jsonb_array_elements_text(p_patch->'tags')), '{}') else tags end,
    memo = case when p_patch ? 'memo' then coalesce(p_patch->>'memo', '') else memo end,
    kind_label = case when p_patch ? 'kindLabel' then nullif(p_patch->>'kindLabel', '') else kind_label end,
    title = case when p_patch ? 'title' then p_patch->>'title' else title end,
    doc_kind = case when p_patch ? 'docKind' then p_patch->>'docKind' else doc_kind end,
    keywords = case when p_patch ? 'keywords' then coalesce(array(select jsonb_array_elements_text(p_patch->'keywords')), '{}') else keywords end,
    snippet = case when p_patch ? 'snippet' then coalesce(p_patch->>'snippet', '') else snippet end,
    related = case when p_patch ? 'related' then case when jsonb_typeof(p_patch->'related') = 'object' then p_patch->'related' else null end else related end,
    analysis = case when p_patch ? 'analysis' and jsonb_typeof(p_patch->'analysis') = 'object' then analysis || (p_patch->'analysis') else analysis end,
    updated_at = now()
    where user_id = uid and id = p_id;
end $$;
revoke all on function app.patch_file(uuid, jsonb, text, boolean) from public, anon;
grant execute on function app.patch_file(uuid, jsonb, text, boolean) to authenticated;

-- ------------------------------------------------------------------------------------------------------ delete (two steps) and stale reservations
-- Step 1 hides the file (status deleting) and returns where its original is; the server removes that Storage object as the user, then step 2 drops the
-- row (and with it the text) and the bytes are free. If step 2 never comes (the object could not be removed), the row stays `deleting` and is swept.
-- A pending upload can be cancelled the same way.
create function app.begin_delete_file(p_id uuid) returns text
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  uid uuid := auth.uid(); path text;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  update app.files set status = 'deleting', reserved_until = null, updated_at = now() where user_id = uid and id = p_id returning object_path into path;
  if path is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  return path;
end $$;
revoke all on function app.begin_delete_file(uuid) from public, anon;
grant execute on function app.begin_delete_file(uuid) to authenticated;

create function app.finish_delete_file(p_id uuid) returns boolean
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  uid uuid := auth.uid(); n int;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  delete from app.files where user_id = uid and id = p_id and (status = 'deleting' or (status = 'pending' and (reserved_until is null or reserved_until < now())));
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function app.finish_delete_file(uuid) from public, anon;
grant execute on function app.finish_delete_file(uuid) to authenticated;

-- The caller's own rows whose Storage object has to be removed before the row can go: deleting, or a reservation that ran out.
create function app.my_stale_files() returns table (id uuid, object_path text)
language sql stable security definer set search_path = pg_catalog, app as $$
  select f.id, f.object_path from app.files f where f.user_id = auth.uid() and (f.status = 'deleting' or (f.status = 'pending' and f.reserved_until < now()));
$$;
revoke all on function app.my_stale_files() from public, anon;
grant execute on function app.my_stale_files() to authenticated;

-- ...and the same across users, for the daily sweep (service role removes the objects, then drops the rows). elvar_app only.
create function app.stale_files(p_limit int default 200) returns table (user_id uuid, id uuid, object_path text)
language sql stable security definer set search_path = pg_catalog, app as $$
  select f.user_id, f.id, f.object_path from app.files f
  where f.status = 'deleting' or (f.status = 'pending' and f.reserved_until < now() - interval '5 minutes')
  order by f.updated_at limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;
revoke all on function app.stale_files(int) from public, anon, authenticated;
grant execute on function app.stale_files(int) to elvar_app;

create function app.drop_stale_file(p_user uuid, p_id uuid) returns boolean
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  n int;
begin
  delete from app.files where user_id = p_user and id = p_id and (status = 'deleting' or (status = 'pending' and reserved_until < now() - interval '5 minutes'));
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function app.drop_stale_file(uuid, uuid) from public, anon, authenticated;
grant execute on function app.drop_stale_file(uuid, uuid) to elvar_app;

-- ------------------------------------------------------------------------------------------------------ reconciliation
-- Recount every user's bytes from the tables and repair storage_usage where a counter drifted. Returns how many users were corrected. elvar_app only (daily cron).
create function app.reconcile_storage() returns int
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  n int;
begin
  with c as (
    select a.user_id,
      coalesce((select sum(f.size_bytes) from app.files f where f.user_id = a.user_id and f.status <> 'pending'), 0)::bigint as files_bytes,
      coalesce((select sum(f.reserved_bytes) from app.files f where f.user_id = a.user_id and f.status = 'pending'), 0)::bigint as reserved_bytes,
      coalesce((select sum(t.bytes) from app.file_texts t where t.user_id = a.user_id), 0)::bigint as text_bytes,
      (coalesce((select sum(x.bytes) from app.notes x where x.user_id = a.user_id), 0) + coalesce((select sum(octet_length(r.content)) from app.note_revisions r where r.user_id = a.user_id), 0))::bigint as notes_bytes,
      coalesce((select sum(octet_length(m.text)) from app.messages m where m.user_id = a.user_id), 0)::bigint as messages_bytes
    from app.storage_usage a)
  update app.storage_usage s set files_bytes = c.files_bytes, reserved_bytes = c.reserved_bytes, text_bytes = c.text_bytes, notes_bytes = c.notes_bytes, messages_bytes = c.messages_bytes
    from c where s.user_id = c.user_id and (s.files_bytes, s.reserved_bytes, s.text_bytes, s.notes_bytes, s.messages_bytes)
      is distinct from (c.files_bytes, c.reserved_bytes, c.text_bytes, c.notes_bytes, c.messages_bytes);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function app.reconcile_storage() from public, anon, authenticated;
grant execute on function app.reconcile_storage() to elvar_app;

-- The caller's own recount (what reconcile_storage does for everybody): the figures the screen shows can be refreshed and the tests can compare.
create function app.recount_my_storage() returns void
language plpgsql security definer set search_path = pg_catalog, app as $$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  insert into app.storage_usage (user_id) values (auth.uid()) on conflict (user_id) do nothing;
  update app.storage_usage s set
    files_bytes = coalesce((select sum(f.size_bytes) from app.files f where f.user_id = s.user_id and f.status <> 'pending'), 0),
    reserved_bytes = coalesce((select sum(f.reserved_bytes) from app.files f where f.user_id = s.user_id and f.status = 'pending'), 0),
    text_bytes = coalesce((select sum(t.bytes) from app.file_texts t where t.user_id = s.user_id), 0),
    notes_bytes = coalesce((select sum(x.bytes) from app.notes x where x.user_id = s.user_id), 0) + coalesce((select sum(octet_length(r.content)) from app.note_revisions r where r.user_id = s.user_id), 0),
    messages_bytes = coalesce((select sum(octet_length(m.text)) from app.messages m where m.user_id = s.user_id), 0)
    where s.user_id = auth.uid();
end $$;
revoke all on function app.recount_my_storage() from public, anon;
grant execute on function app.recount_my_storage() to authenticated;

-- ------------------------------------------------------------------------------------------------------ admin: the quota of one user (M11: a number, never content)
create function app.admin_set_quota(p_user uuid, p_bytes bigint) returns bigint
language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  cur bigint;
begin
  if not app.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_bytes is null or p_bytes < 0 or p_bytes > 1099511627776 then raise exception 'admin_set_quota: bad value' using errcode = '22023'; end if;
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'not_found' using errcode = 'P0002'; end if;
  insert into app.accounts (user_id) values (p_user) on conflict (user_id) do nothing;
  select storage_quota_bytes into cur from app.accounts where user_id = p_user for update;
  update app.accounts set storage_quota_bytes = p_bytes where user_id = p_user;
  insert into app.audit_log (user_id, actor, actor_id, action, meta)
    values (p_user, 'admin', auth.uid(), 'account.quota_changed', jsonb_build_object('from', cur, 'to', p_bytes));
  return p_bytes;
end $$;
revoke all on function app.admin_set_quota(uuid, bigint) from public, anon;
grant execute on function app.admin_set_quota(uuid, bigint) to authenticated;

-- ------------------------------------------------------------------------------------------------------ search over the user's own files
-- Same idea as the notes (migration 05): the function returns CANDIDATES (files whose extracted text contains at least one term); the server ranks them.
-- SECURITY INVOKER: Row Level Security keeps it inside the caller's own files.
do $mig$
begin
  create schema if not exists extensions;
  if exists (select 1 from pg_available_extensions where name = 'pgroonga') then
    create extension if not exists pgroonga with schema extensions;
    execute 'create index file_texts_fts on app.file_texts using pgroonga (text)';
    execute $f$
      create function app.search_files(p_terms text[], p_like text[], p_limit int default 200)
      returns table (id uuid, text text)
      language sql stable set search_path = pg_catalog, public, extensions as $q$
        select t.file_id, left(t.text, 200000) from app.file_texts t join app.files f on f.user_id = t.user_id and f.id = t.file_id
        where t.user_id = (select auth.uid()) and f.status = 'ready' and t.text &@| p_terms
        limit least(greatest(p_limit, 1), 300)
      $q$
    $f$;
  else
    create extension if not exists pg_trgm with schema extensions;
    execute 'create index file_texts_fts on app.file_texts using gin (text extensions.gin_trgm_ops)';
    execute $f$
      create function app.search_files(p_terms text[], p_like text[], p_limit int default 200)
      returns table (id uuid, text text)
      language sql stable set search_path = pg_catalog, public, extensions as $q$
        select t.file_id, left(t.text, 200000) from app.file_texts t join app.files f on f.user_id = t.user_id and f.id = t.file_id
        where t.user_id = (select auth.uid()) and f.status = 'ready' and t.text ilike any (p_like)
        limit least(greatest(p_limit, 1), 300)
      $q$
    $f$;
  end if;
end $mig$;
revoke all on function app.search_files(text[], text[], int) from public, anon, authenticated;
grant execute on function app.search_files(text[], text[], int) to authenticated;

-- ------------------------------------------------------------------------------------------------------ Storage: the private bucket and its policies
-- Bucket `user-files`: private, 60 MB per object. Object names are users/<uid>/files/<fileId>/<sha256>; only the owner can read or delete under users/<uid>/,
-- and only a path with a live reservation (a pending app.files row of the caller) can be written. There is no update policy: an object is never overwritten.
-- (supabase/config.toml declares the same bucket for `supabase start`; the insert makes a plain `db reset` / migration run sufficient.)
insert into storage.buckets (id, name, public, file_size_limit) values ('user-files', 'user-files', false, 62914560)
  on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- NOTE: inside the EXISTS the unqualified `name` would be app.files.name; the object's own name is always written objects.name.
create policy files_read on storage.objects for select to authenticated using (
  bucket_id = 'user-files' and (storage.foldername(objects.name))[1] = 'users' and (storage.foldername(objects.name))[2] = (select auth.uid())::text);
create policy files_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'user-files' and (storage.foldername(objects.name))[1] = 'users' and (storage.foldername(objects.name))[2] = (select auth.uid())::text
  and exists (select 1 from app.files f where f.user_id = (select auth.uid()) and f.object_path = objects.name and f.status = 'pending' and f.reserved_until > now()));
create policy files_delete on storage.objects for delete to authenticated using (
  bucket_id = 'user-files' and (storage.foldername(objects.name))[1] = 'users' and (storage.foldername(objects.name))[2] = (select auth.uid())::text);

-- ------------------------------------------------------------------------------------------------------ registry rows
insert into app.data_registry (table_name, export_as, export_exclude, editable, counts_storage, fixture_order, fixture_sql) values
  ('files', 'files.json', '{}', true, true, 30, $f$insert into app.files (user_id, id, name, mime, kind, size_bytes, sha256, object_path, status) values ({{uid}}, md5('fixture-file-' || {{uid}}::text)::uuid, 'fixture.txt', 'text/plain', 'text', 7, repeat('a', 64), 'users/' || {{uid}}::text || '/files/' || md5('fixture-file-' || {{uid}}::text)::uuid::text || '/' || repeat('a', 64), 'ready')$f$),
  ('file_texts', 'files.json', '{}', true, true, 40, $f$insert into app.file_texts (user_id, file_id, text) values ({{uid}}, md5('fixture-file-' || {{uid}}::text)::uuid, 'fixture text')$f$);
update app.data_registry set delete_via = 'cascade+storage' where table_name = 'files';
