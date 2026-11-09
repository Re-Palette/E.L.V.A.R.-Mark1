-- P3 / migration 04: connections to other services, per user (docs/ELVAR_MULTIUSER.md 5.1, 8.3; decision O2: every user brings their OWN Google OAuth client).
--   oauth_tokens     the OAuth tokens of the user's Google login ('google') and of their MCP connectors ('cx:<connector id>'), sealed under the user's DEK
--   connectors       the user's connector manifests (MCP servers and HTTP APIs)
--   connector_tools  each connector's tools: the pinned hash, the approval choice, the exposure (a tool whose hash changes waits for re-approval)
-- and the changes oauth_pending needs so that the OAuth callback (no token, only a single-use state) finds the flow of the user who started it.

create table app.oauth_tokens (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  provider text not null check (provider ~ '^(google|cx:[A-Za-z0-9_-]{1,40})$'),   -- 'google' | 'cx:<connector id>'
  ct bytea not null check (octet_length(ct) between 17 and 16400),                  -- AES-256-GCM(user DEK) of the token record (JSON); AAD = user id + "oauth:<provider>" + dek_ver
  iv bytea not null check (octet_length(iv) = 12),
  dek_ver int not null check (dek_ver >= 1),
  scopes text[] not null default '{}' check (cardinality(scopes) <= 40),             -- what the provider granted (not secret: the screens show it)
  status text not null default 'ok' check (status in ('ok', 'reauth_required')),     -- invalid_grant / revoked: the user must connect again
  reason text check (reason is null or length(reason) <= 60),
  revoke_url text check (revoke_url is null or (length(revoke_url) <= 500 and revoke_url ~ '^https?://')),   -- where the account deletion / disconnect revokes the token
  updated_at timestamptz not null default now(),
  primary key (user_id, provider),
  -- like user_secrets: a token can only exist under a DEK version that exists (checked at COMMIT; removing the key removes what it protected)
  foreign key (user_id, dek_ver) references app.user_keys (user_id, dek_ver) on delete cascade deferrable initially deferred
);
select app._secure('oauth_tokens', 'select,insert,update,delete');

create table app.connectors (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (id ~ '^[A-Za-z0-9_-]{1,40}$'),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object' and pg_column_size(manifest) <= 20000),   -- everything but the tools; no secret (those are in user_secrets as cx:<id>:*)
  enabled boolean not null default true,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
select app._secure('connectors', 'select,insert,update,delete');

create table app.connector_tools (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  connector_id text not null,
  name text not null check (length(name) between 1 and 100),
  def jsonb not null check (jsonb_typeof(def) = 'object' and pg_column_size(def) <= 40000),
  hash text not null check (length(hash) <= 100),                                    -- the pin: a change of what the tool says it does changes it
  enabled boolean not null default false,
  approval text check (approval is null or approval in ('ask', 'ask_high', 'auto', 'off')),
  expose text check (expose is null or expose in ('pinned', 'gateway')),
  pos int not null default 0 check (pos between 0 and 1000),                         -- the order the user sees (and the order pinned tools are allocated in)
  primary key (user_id, connector_id, name),
  foreign key (user_id, connector_id) references app.connectors (user_id, id) on delete cascade
);
select app._secure('connector_tools', 'select,insert,update,delete');

-- OAuth flows in progress (created in migration 03). `phase` lets the callback take the flow exactly once without opening the sealed record:
--   started -> exchanging (the callback holds it) -> done | error (the result waits for the user's claim)
alter table app.oauth_pending add column phase text not null default 'started' check (phase in ('started', 'exchanging', 'done', 'error'));

-- The OAuth callback comes back from another site with no access token, only the single-use `state`. This answers "whose flow is it" for the hash
-- of that state (the one place a row is found without a user context; executable by elvar_app only). Everything after it runs as THAT user.
create or replace function app.oauth_pending_owner(p_hash bytea) returns uuid
language sql stable security definer set search_path = pg_catalog, app as $$
  select p.user_id from app.oauth_pending p where p.state_hash = p_hash and p.expires_at > now();
$$;
revoke all on function app.oauth_pending_owner(bytea) from public, anon, authenticated;
grant execute on function app.oauth_pending_owner(bytea) to elvar_app;

-- ------------------------------------------------------------------------------------------------------ registry rows
-- oauth_tokens: exported as a list of connections (provider, scopes, status), never the ciphertext; deleting the account revokes them at the provider first.
insert into app.data_registry (table_name, export_as, export_exclude, editable, counts_storage, fixture_order, fixture_sql) values
  ('oauth_tokens', 'connections.json', '{ct,iv}', true, false, 35, $f$insert into app.oauth_tokens (user_id, provider, ct, iv, dek_ver, scopes) values ({{uid}}, 'google', decode(repeat('22', 32), 'hex'), decode(repeat('00', 12), 'hex'), 1, array['fixture'])$f$),
  ('connectors', 'connectors.json', '{}', true, false, 30, $f$insert into app.connectors (user_id, id, manifest, enabled) values ({{uid}}, 'cx_fixture', '{"id":"cx_fixture","name":"fixture","type":"http"}'::jsonb, true)$f$),
  ('connector_tools', 'connectors.json', '{}', true, false, 40, $f$insert into app.connector_tools (user_id, connector_id, name, def, hash, enabled) values ({{uid}}, 'cx_fixture', 'ping', '{"name":"ping"}'::jsonb, 'sha256:fixture', false)$f$);
update app.data_registry set delete_via = 'cascade+external' where table_name = 'oauth_tokens';
