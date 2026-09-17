-- ============================================================================
-- 0026 — the notification that does not cost anything
--
-- Phase 10. The build plan's phase 10 is "Capacitor, native push, App Store and
-- Play submission", and two thirds of that is a procurement exercise: an Apple
-- developer account, a Google Play account, signing certificates, review
-- queues. None of it is code and none of it is on the critical path.
--
-- THE PART THAT IS. Native push exists in the plan because SMS is the only
-- channel a cleaner has today, and SMS has two properties that matter here:
--
--   1. IT COSTS MONEY PER MESSAGE. A waterfall rung goes to every cleaner in a
--      tier, every sweep, and the whole design of the ladder is that most of
--      those offers are declined. The cost of announcing work scales with the
--      number of cleaners the marketplace is trying to grow.
--   2. IT IS SLOW AND IT IS IGNORED. A rung lives 8 to 15 minutes. A text
--      arrives in a thread alongside every other text she gets.
--
-- Web Push, to an installed PWA, is instant and free and lands as a
-- notification rather than a message. It works on Android, and on iOS 16.4+
-- ONCE THE APP IS ON THE HOME SCREEN — which is a real limitation and the
-- reason SMS stays the backstop rather than being replaced.
--
-- WHAT THIS DOES NOT DO. It does not replace the offer text. Both go out, and
-- the message log records both, because a cleaner who has not installed the app
-- must not silently stop being offered work.
-- ============================================================================

create or replace function app_schema_version() returns integer
language sql immutable as $$ select 26 $$;

/**
 * One row per browser, per device.
 *
 * A subscription is not a person: the same cleaner has one on her phone and one
 * on the tablet in the van, and both should ring. The endpoint is the identity,
 * because that is what the push service gave us and what it will tell us has
 * gone away.
 */
create table push_subscriptions (
  id          uuid primary key default uuid_generate_v4(),
  profile_id  uuid not null references profiles(id) on delete cascade,
  cleaner_id  uuid references cleaners(id) on delete cascade,
  endpoint    text not null unique,
  /**
   * The subscription's own keys. Stored because RFC 8291 payload encryption
   * would need them, and this system deliberately sends no payload — so today
   * they are unused. Kept anyway: re-asking every cleaner to re-subscribe
   * because we threw away half the subscription is not a migration anybody
   * should have to run.
   */
  p256dh      text,
  auth        text,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz,
  /**
   * Consecutive failures. A push service answers 404 or 410 when a
   * subscription is gone for good and that deletes the row outright; this
   * counts the other kind — the 500s and the timeouts — so a permanently
   * broken endpoint stops being tried rather than failing every sweep for ever.
   */
  failures    integer not null default 0
);

create index push_subscriptions_cleaner on push_subscriptions (cleaner_id);

alter table push_subscriptions enable row level security;

create policy push_subscriptions_admin_all on push_subscriptions for all
  using (is_admin()) with check (is_admin());

/**
 * A person may see and delete their OWN subscriptions and nobody else's.
 *
 * Writing is through the function below rather than through this policy: the
 * endpoint has to be unique and a conflict has to be an update rather than an
 * error, which a plain insert policy cannot express.
 */
create policy push_subscriptions_own on push_subscriptions for select
  using (profile_id = auth.uid());
create policy push_subscriptions_own_delete on push_subscriptions for delete
  using (profile_id = auth.uid());

/**
 * Save a subscription, or refresh the one that already exists.
 *
 * A BROWSER RE-SUBSCRIBES ON ITS OWN SCHEDULE — after a push service rotates
 * it, after the app is reinstalled, sometimes just because. Treating each one
 * as new would leave a table full of dead endpoints that every sweep tries and
 * every sweep fails on. The endpoint is the key, so a re-subscription updates.
 */
create or replace function save_push_subscription(
  p_profile_id uuid,
  p_endpoint   text,
  p_p256dh     text default null,
  p_auth       text default null,
  p_user_agent text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_cleaner uuid;
begin
  select id into v_cleaner from cleaners where profile_id = p_profile_id limit 1;

  insert into push_subscriptions (profile_id, cleaner_id, endpoint, p256dh, auth, user_agent)
  values (p_profile_id, v_cleaner, p_endpoint, p_p256dh, p_auth, p_user_agent)
  on conflict (endpoint) do update set
    profile_id = excluded.profile_id,
    cleaner_id = excluded.cleaner_id,
    p256dh     = coalesce(excluded.p256dh, push_subscriptions.p256dh),
    auth       = coalesce(excluded.auth, push_subscriptions.auth),
    user_agent = coalesce(excluded.user_agent, push_subscriptions.user_agent),
    -- A subscription that has just been re-established is not a failing one.
    failures   = 0
  returning id into v_id;

  return v_id;
end $$;

/** Gone for good — the push service said 404 or 410. */
create or replace function delete_push_subscription(p_endpoint text) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  delete from push_subscriptions where endpoint = p_endpoint;
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

/**
 * What happened to a push.
 *
 * Success resets the count and stamps the row, which is also how a dead
 * subscription is told apart from one nobody has needed to push to.
 */
create or replace function settle_push(p_endpoint text, p_ok boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  update push_subscriptions set
    last_used_at = case when p_ok then now() else last_used_at end,
    failures = case when p_ok then 0 else failures + 1 end
  where endpoint = p_endpoint;
end $$;

/**
 * Where to push, for a set of cleaners.
 *
 * Subscriptions that have failed repeatedly are left out rather than deleted: a
 * push service having a bad week is not a reason to make a cleaner re-enable
 * notifications, and the row coming back to life the next time she opens the
 * app costs nothing.
 */
create or replace function push_targets(p_cleaner_ids uuid[], p_max_failures integer default 5)
returns table (cleaner_id uuid, endpoint text)
language sql security definer set search_path = public as $$
  select ps.cleaner_id, ps.endpoint
    from push_subscriptions ps
   where ps.cleaner_id = any (p_cleaner_ids)
     and ps.failures < p_max_failures
$$;

revoke all on function save_push_subscription(uuid, text, text, text, text)
  from public, anon, authenticated;
revoke all on function delete_push_subscription(text) from public, anon, authenticated;
revoke all on function settle_push(text, boolean) from public, anon, authenticated;
revoke all on function push_targets(uuid[], integer) from public, anon, authenticated;

grant execute on function save_push_subscription(uuid, text, text, text, text) to service_role;
grant execute on function delete_push_subscription(text) to service_role;
grant execute on function settle_push(text, boolean) to service_role;
grant execute on function push_targets(uuid[], integer) to service_role;
