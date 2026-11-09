-- Review fix (P3 follow-up): an OAuth flow belongs to ONE kind of callback. The state of a connector (MCP) flow, found at the Google callback, used to be
-- accepted (the lookup was by the hash of the state only) and its stored token URL called with the wrong rules. The kind is now a column of its own, the
-- callback asks for ITS kind, and a state of another kind is "unknown" without being consumed.

alter table app.oauth_pending add column provider text not null default 'google' check (provider in ('google', 'mcp'));

drop function if exists app.oauth_pending_owner(bytea);
create function app.oauth_pending_owner(p_hash bytea, p_provider text) returns uuid
language sql stable security definer set search_path = pg_catalog, app as $$
  select p.user_id from app.oauth_pending p where p.state_hash = p_hash and p.provider = p_provider and p.expires_at > now();
$$;
revoke all on function app.oauth_pending_owner(bytea, text) from public, anon, authenticated;
grant execute on function app.oauth_pending_owner(bytea, text) to elvar_app;
