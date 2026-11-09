-- P3 / migration 10 (first part): build requests (Claude Code through the user's OWN GitHub repository and token, docs/ELVAR_MULTIUSER.md 8.1).
-- One row per request the user approved, so the list is theirs and can be exported and deleted. The GitHub issue itself lives in the user's own repository
-- (their property: account deletion does not touch it). The inbox, notification and report tables of this migration group arrive with P4.

create table app.build_requests (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  repo text not null check (repo ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  target text not null default 'builds' check (target in ('builds', 'self')),
  issue_number int not null check (issue_number >= 1),
  pr_number int check (pr_number is null or pr_number >= 1),
  state text not null default 'queued' check (state in ('queued', 'working', 'review', 'done', 'failed')),
  title text not null check (length(title) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  unique (user_id, repo, issue_number)
);
select app._secure('build_requests', 'select,insert,update,delete');

insert into app.data_registry (table_name, export_as, export_exclude, editable, counts_storage, fixture_order, fixture_sql) values
  ('build_requests', 'builds.json', '{}', true, false, 30, $f$insert into app.build_requests (user_id, repo, issue_number, title) values ({{uid}}, 'fixture/repo', 1, 'fixture')$f$);
