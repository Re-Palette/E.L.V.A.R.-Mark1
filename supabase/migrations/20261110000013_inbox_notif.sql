-- P4 / migration 13 (part of the design's "10"): the notification box and the phone-notification relay, per user (docs/ELVAR_MULTIUSER.md 5.1, 8.4).
--   inbox_items  the bell panel: reports of finished sub-agent jobs, finished work, alerts. Read, marked read, deleted by the user.
--   notif_items  the relay of phone notifications to the PC. CIPHERTEXT ONLY (the phone encrypts with a key derived from the user's own NOTIF_SECRET; the
--                server never sees the text). Kept 3 days, at most 200 per user.

create table app.inbox_items (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  kind text not null default 'notice' check (kind in ('report', 'deliverable', 'build', 'alert', 'notice')),
  title text not null check (length(title) between 1 and 120),
  body text not null default '' check (length(body) <= 2000),
  url text check (url is null or (length(url) <= 500 and url ~ '^https?://')),
  note_path text check (note_path is null or length(note_path) <= 300),
  key text check (key is null or length(key) between 1 and 100),   -- the same key replaces the old item (an updated build is one item)
  at timestamptz not null default now(),
  read_at timestamptz,
  primary key (user_id, id)
);
create unique index inbox_items_key on app.inbox_items (user_id, key) where key is not null;
create index inbox_items_user_at on app.inbox_items (user_id, at desc);
select app._secure('inbox_items', 'select,insert,update,delete');

create table app.notif_items (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  at timestamptz not null,
  iv text not null check (length(iv) between 12 and 32 and iv ~ '^[A-Za-z0-9+/_=-]+$'),
  ct text not null check (length(ct) between 16 and 6000 and ct ~ '^[A-Za-z0-9+/_=-]+$'),
  primary key (user_id, id)
);
create index notif_items_user_at on app.notif_items (user_id, at);
select app._secure('notif_items', 'select,insert,delete');

insert into app.data_registry (table_name, export_as, export_exclude, editable, counts_storage, fixture_order, fixture_sql) values
  ('inbox_items', 'inbox.json', '{}', true, false, 30, $f$insert into app.inbox_items (user_id, title) values ({{uid}}, 'fixture')$f$),
  ('notif_items', 'notifications.json', '{ct,iv}', false, false, 30, $f$insert into app.notif_items (user_id, id, at, iv, ct) values ({{uid}}, 'n1-fixture', now(), 'AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAA')$f$);
