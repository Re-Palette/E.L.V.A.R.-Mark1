-- P4 / migration 05: the second brain per user (docs/ELVAR_MULTIUSER.md 5.1, 8.5). The Markdown notes (Obsidian-compatible paths) move from one GitHub
-- repository to the user's own rows. Finance, shifts, courses and projects stay ordinary notes (家計/, シフト/, 履修/, プロジェクト/).
--   notes           the current text of each note; `rev` counts the edits. Trash = deleted_at (30 days, then removed for good).
--   note_revisions  the text BEFORE each edit (the replacement for git history): the newest 30, at most 90 days
--
-- Japanese full text search: PGroonga where it exists (Supabase), otherwise a trigram index (plain Postgres, the test database). Either way the
-- application asks the same function, app.search_notes(terms, limit), for CANDIDATES (notes that contain at least one term) and scores them itself
-- (server/brain.js scoreNote), so the ranking does not depend on which engine is installed. The function is SECURITY INVOKER: Row Level Security
-- keeps it inside the caller's own notes. pgvector (embeddings) stays off until it is needed (docs 8.6).

create table app.notes (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  path text not null check (length(path) between 4 and 300 and path ~ '\.md$' and path !~ '[[:cntrl:]]' and path !~ '(^|/)\.' and path !~ '//' and path !~ '^/'),
  content text not null check (octet_length(content) <= 400000),
  bytes int generated always as (octet_length(content)) stored,
  tags text[] not null default '{}' check (cardinality(tags) <= 30),
  rev int not null default 1 check (rev >= 1),     -- +1 with every change of the text
  pushed_rev int check (pushed_rev is null or pushed_rev >= 0),   -- the rev last mirrored to the user's OWN GitHub repository (github-brain), if they turned that on
  deleted_at timestamptz,                          -- trash
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  unique (user_id, path)
);
create index notes_user_updated on app.notes (user_id, updated_at desc);
select app._secure('notes', 'select,insert,update,delete');

create table app.note_revisions (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  note_id uuid not null,
  rev int not null check (rev >= 0),
  content text not null check (octet_length(content) <= 400000),
  at timestamptz not null default now(),
  primary key (user_id, note_id, rev),
  foreign key (user_id, note_id) references app.notes (user_id, id) on delete cascade
);
select app._secure('note_revisions', 'select,insert,delete');

-- ------------------------------------------------------------------------------------------------------ full text search
do $mig$
begin
  create schema if not exists extensions;
  if exists (select 1 from pg_available_extensions where name = 'pgroonga') then
    create extension if not exists pgroonga with schema extensions;
    execute 'create index notes_fts on app.notes using pgroonga (content)';
    execute $f$
      create function app.search_notes(p_terms text[], p_like text[], p_limit int default 200)
      returns table (id uuid, path text, content text, updated_at timestamptz)
      language sql stable set search_path = pg_catalog, public, extensions as $q$
        select n.id, n.path, left(n.content, 60000), n.updated_at from app.notes n
        where n.user_id = (select auth.uid()) and n.deleted_at is null and (n.content &@| p_terms or n.path ilike any (p_like))
        order by n.updated_at desc limit least(greatest(p_limit, 1), 300)
      $q$
    $f$;
  else
    create extension if not exists pg_trgm with schema extensions;
    execute 'create index notes_fts on app.notes using gin (content extensions.gin_trgm_ops)';
    execute $f$
      create function app.search_notes(p_terms text[], p_like text[], p_limit int default 200)
      returns table (id uuid, path text, content text, updated_at timestamptz)
      language sql stable set search_path = pg_catalog, public, extensions as $q$
        select n.id, n.path, left(n.content, 60000), n.updated_at from app.notes n
        where n.user_id = (select auth.uid()) and n.deleted_at is null and (n.content ilike any (p_like) or n.path ilike any (p_like))
        order by n.updated_at desc limit least(greatest(p_limit, 1), 300)
      $q$
    $f$;
  end if;
end $mig$;
revoke all on function app.search_notes(text[], text[], int) from public, anon, authenticated;
grant execute on function app.search_notes(text[], text[], int) to authenticated;

-- ------------------------------------------------------------------------------------------------------ registry rows
-- A fixed note id per user (derived from the user id) lets the revision fixture point at it without a sub-select (which another user could not see).
insert into app.data_registry (table_name, export_as, export_exclude, editable, counts_storage, fixture_order, fixture_sql) values
  ('notes', 'notes.json', '{}', true, true, 30, $f$insert into app.notes (user_id, id, path, content) values ({{uid}}, md5('fixture-note-' || {{uid}}::text)::uuid, '好み/fixture.md', '# fixture')$f$),
  ('note_revisions', 'notes.json', '{}', false, true, 40, $f$insert into app.note_revisions (user_id, note_id, rev, content) values ({{uid}}, md5('fixture-note-' || {{uid}}::text)::uuid, 0, '# fixture (old)')$f$);
