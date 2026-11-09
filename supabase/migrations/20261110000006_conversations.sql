-- P4 / migration 06: the conversation log per user (short-term memory; docs/ELVAR_MULTIUSER.md 5.1, 5.2, 8.1). What the user and the assistant said,
-- as transcribed, replaces 会話/<日付>.md in the old GitHub repository. Secrets are masked by the server before they are stored (server/brain.js redactSecrets).
-- Retention: 180 days by default, the user may choose 7 days to unlimited (setting MESSAGE_RETENTION_DAYS, 0 = unlimited) or delete everything now
-- (migration 14 sweeps). Every message can be deleted one by one (principle 7).

create table app.conversations (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  channel text not null default 'voice' check (channel in ('voice', 'text', 'agent', 'import')),
  started_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index conversations_user_last on app.conversations (user_id, last_at desc);
select app._secure('conversations', 'select,insert,update,delete');

create table app.messages (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id bigint generated always as identity,
  conversation_id uuid not null,
  role text not null check (role in ('user', 'assistant', 'tool')),
  text text not null check (length(text) between 1 and 8000),
  at timestamptz not null,
  primary key (user_id, id),
  foreign key (user_id, conversation_id) references app.conversations (user_id, id) on delete cascade
);
create index messages_user_at on app.messages (user_id, at desc);
create index messages_conv on app.messages (user_id, conversation_id, id);
select app._secure('messages', 'select,insert,delete');

do $mig$
begin
  create schema if not exists extensions;
  if exists (select 1 from pg_available_extensions where name = 'pgroonga') then
    create extension if not exists pgroonga with schema extensions;
    execute 'create index messages_fts on app.messages using pgroonga (text)';
    execute $f$
      create function app.search_messages(p_terms text[], p_like text[], p_limit int default 50)
      returns table (id bigint, conversation_id uuid, role text, text text, at timestamptz)
      language sql stable set search_path = pg_catalog, public, extensions as $q$
        select m.id, m.conversation_id, m.role, m.text, m.at from app.messages m
        where m.user_id = (select auth.uid()) and m.text &@| p_terms
        order by m.at desc, m.id desc limit least(greatest(p_limit, 1), 200)
      $q$
    $f$;
  else
    create extension if not exists pg_trgm with schema extensions;
    execute 'create index messages_fts on app.messages using gin (text extensions.gin_trgm_ops)';
    execute $f$
      create function app.search_messages(p_terms text[], p_like text[], p_limit int default 50)
      returns table (id bigint, conversation_id uuid, role text, text text, at timestamptz)
      language sql stable set search_path = pg_catalog, public, extensions as $q$
        select m.id, m.conversation_id, m.role, m.text, m.at from app.messages m
        where m.user_id = (select auth.uid()) and m.text ilike any (p_like)
        order by m.at desc, m.id desc limit least(greatest(p_limit, 1), 200)
      $q$
    $f$;
  end if;
end $mig$;
revoke all on function app.search_messages(text[], text[], int) from public, anon, authenticated;
grant execute on function app.search_messages(text[], text[], int) to authenticated;

insert into app.data_registry (table_name, export_as, export_exclude, editable, counts_storage, fixture_order, fixture_sql) values
  ('conversations', 'conversations.json', '{}', true, false, 30, $f$insert into app.conversations (user_id, id) values ({{uid}}, md5('fixture-conv-' || {{uid}}::text)::uuid)$f$),
  ('messages', 'conversations.json', '{}', true, true, 40, $f$insert into app.messages (user_id, conversation_id, role, text, at) values ({{uid}}, md5('fixture-conv-' || {{uid}}::text)::uuid, 'user', 'fixture', now())$f$);
