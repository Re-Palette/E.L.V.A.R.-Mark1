-- P8 review round 2 / migration 21: which of these ids are still accounts? The daily orphan sweep lists the owners found under users/ in every Storage bucket and removes the
-- objects of any owner that is no longer in auth.users (an upload or an export part that landed after the account was purged). elvar_app only; answers with ids, nothing else.
create function app.existing_users(p_ids uuid[]) returns setof uuid
language plpgsql stable security definer set search_path = pg_catalog, app as $$
begin
  if p_ids is null or cardinality(p_ids) > 1000 then raise exception 'existing_users: bad value' using errcode = '22023'; end if;
  return query select u.id from auth.users u where u.id = any (p_ids);
end $$;
revoke all on function app.existing_users(uuid[]) from public, anon, authenticated;
grant execute on function app.existing_users(uuid[]) to elvar_app;

-- The storage quota check of a note or a message (assertRoom in server/db/repos/pg.js) reads the counter and then writes: two requests of one user at the same moment could both
-- pass. reserve_file already serialises on the account row; this gives the other writers the same lock (held until their transaction ends). SELECT ... FOR UPDATE needs the
-- UPDATE privilege the user does not have on app.accounts, so it is a definer function that locks only the caller's own row.
create function app.lock_my_account() returns void
language plpgsql security definer set search_path = pg_catalog, app as $$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  perform 1 from app.accounts where user_id = auth.uid() for update;
end $$;
revoke all on function app.lock_my_account() from public, anon;
grant execute on function app.lock_my_account() to authenticated;
