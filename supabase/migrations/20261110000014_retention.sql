-- P4 / migration 14: retention sweeps for the memory tables (docs/ELVAR_MULTIUSER.md 5.2), added to app.purge_expired() (migration 03; the server's daily cron
-- and any scheduler call it). The function runs as its owner, so it can see every user's rows; it only deletes by age and returns counts.
--   messages          older than the user's own MESSAGE_RETENTION_DAYS setting (default 180, 0 = keep); an empty conversation goes a day later
--   note_revisions    older than 90 days (the newest 30 per note are also enforced when a note is saved)
--   notes             in the trash for 30 days
--   notif_items       older than 3 days
-- Same contract as before: returns (table_name, deleted).

create or replace function app.purge_expired() returns table (table_name text, deleted bigint)
language plpgsql security definer set search_path = pg_catalog, app as $$
declare c bigint;
begin
  delete from app.kv_ephemeral where expires_at <= now(); get diagnostics c = row_count; table_name := 'kv_ephemeral'; deleted := c; return next;
  delete from app.rate_limits where expires_at <= now(); get diagnostics c = row_count; table_name := 'rate_limits'; deleted := c; return next;
  delete from app.ticket_uses where exp <= now(); get diagnostics c = row_count; table_name := 'ticket_uses'; deleted := c; return next;
  delete from app.oauth_pending where expires_at <= now(); get diagnostics c = row_count; table_name := 'oauth_pending'; deleted := c; return next;
  delete from app.notif_items where at <= now() - interval '3 days'; get diagnostics c = row_count; table_name := 'notif_items'; deleted := c; return next;
  delete from app.note_revisions where at <= now() - interval '90 days'; get diagnostics c = row_count; table_name := 'note_revisions'; deleted := c; return next;
  delete from app.notes where deleted_at is not null and deleted_at <= now() - interval '30 days'; get diagnostics c = row_count; table_name := 'notes'; deleted := c; return next;
  delete from app.messages m using (
      select u.user_id, case when s.settings->>'MESSAGE_RETENTION_DAYS' ~ '^[0-9]{1,5}$' then (s.settings->>'MESSAGE_RETENTION_DAYS')::int else 180 end as days
      from (select distinct x.user_id from app.messages x) u left join app.settings s on s.user_id = u.user_id) r
    where r.user_id = m.user_id and r.days > 0 and m.at < now() - make_interval(days => r.days);
  get diagnostics c = row_count; table_name := 'messages'; deleted := c; return next;
  delete from app.conversations v where v.last_at < now() - interval '1 day'
    and not exists (select 1 from app.messages m where m.user_id = v.user_id and m.conversation_id = v.id);
  get diagnostics c = row_count; table_name := 'conversations'; deleted := c; return next;
end $$;
revoke all on function app.purge_expired() from public, anon, authenticated;
grant execute on function app.purge_expired() to elvar_app;
